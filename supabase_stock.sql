-- ============================================================
-- ระบบสต็อก (เจ้าของใช้ผ่าน stock.html) — รันใน SQL Editor ครั้งเดียว รันซ้ำได้
-- ต้องรัน supabase.sql และ supabase_report.sql มาก่อน (ใช้ "รหัสดูรายงาน" ตัวเดียวกัน)
--
-- แนวคิด
--  * รายการสต็อก (pos_stock_items): ชนิด raw = วัตถุดิบ (กก. ฟอง ฯลฯ) หรือ portion = จำนวนจานที่เตรียมขาย
--  * สูตร (pos_recipes): ขายเมนู 1 หน่วย ตัดสต็อกรายการไหนเท่าไร (ตามรหัสสินค้า เช่น JL2002)
--  * การเคลื่อนไหว (pos_stock_moves): in รับเข้า / count นับจริง / waste ของเสีย / adjust ปรับ(+/-)
--  * ยอดคงเหลือ = นับล่าสุด + รับเข้า/ปรับ − ของเสีย (หลังนับ) − ยอดที่ขายไปตามสูตร (หลังนับ)
--    บิลที่ยกเลิกไม่ตัดสต็อก และยอดขายจะเข้าหลังแอปที่ร้านส่งข้อมูล (ทุกชั่วโมง)
-- ============================================================

create table if not exists public.pos_stock_items (
  id         bigint generated always as identity primary key,
  branch_id  text not null references public.pos_branches(branch_id),
  name       text not null,
  unit       text not null default 'หน่วย',
  kind       text not null default 'raw' check (kind in ('raw','portion')),
  min_level  numeric(12,3) not null default 0,   -- ต่ำกว่านี้แจ้งเตือน
  active     boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists public.pos_recipes (
  stock_item_id bigint not null references public.pos_stock_items(id) on delete cascade,
  menu_code     text   not null,                  -- ตรงกับ item_code ของเมนู เช่น JL2002
  qty_per_unit  numeric(12,4) not null check (qty_per_unit > 0),
  primary key (stock_item_id, menu_code)
);

create table if not exists public.pos_stock_moves (
  id            bigint generated always as identity primary key,
  branch_id     text not null references public.pos_branches(branch_id),
  stock_item_id bigint not null references public.pos_stock_items(id) on delete cascade,
  kind          text not null check (kind in ('in','count','waste','adjust')),
  qty           numeric(12,3) not null,
  note          text,
  move_at       timestamptz not null default now()
);
create index if not exists pos_stock_moves_item_idx on public.pos_stock_moves (stock_item_id, move_at);

alter table public.pos_stock_items enable row level security;
alter table public.pos_recipes     enable row level security;
alter table public.pos_stock_moves enable row level security;
revoke all on public.pos_stock_items, public.pos_recipes, public.pos_stock_moves from anon, authenticated;

-- ---------- ตรวจรหัสดูรายงาน (ใช้ภายใน) ----------
create or replace function public.pos_check_owner(p_branch text, p_token text)
returns void language plpgsql security definer set search_path = public, extensions as $$
begin
  if not exists (
    select 1 from pos_branches
    where branch_id = p_branch and active and report_token_hash is not null
      and report_token_hash = encode(extensions.digest(coalesce(p_token, ''), 'sha256'), 'hex')
  ) then
    raise exception 'unauthorized' using errcode = '28000';
  end if;
end $$;
revoke all on function public.pos_check_owner(text, text) from public;

-- ---------- ภาพรวมสต็อก ----------
create or replace function public.stock_overview(p_branch text, p_token text)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare r jsonb; v_today date := (now() at time zone 'Asia/Bangkok')::date;
begin
  perform pos_check_owner(p_branch, p_token);
  select jsonb_build_object(
    'today', v_today,
    'items', coalesce((
      select jsonb_agg(x order by x.active desc, x.name) from (
        select i.id, i.name, i.unit, i.kind, i.min_level, i.active,
               lc.move_at as last_count_at,
               coalesce(lc.qty, 0)
                 + coalesce((select sum(case m.kind when 'in' then m.qty when 'adjust' then m.qty when 'waste' then -m.qty else 0 end)
                             from pos_stock_moves m
                             where m.stock_item_id = i.id and m.move_at > coalesce(lc.move_at, '-infinity')), 0)
                 - coalesce((select sum(l.qty * rc.qty_per_unit)
                             from pos_recipes rc
                             join pos_bill_lines l on l.item_code = rc.menu_code
                             join pos_bills b on b.id = l.bill_id
                             where rc.stock_item_id = i.id and b.branch_id = p_branch and b.status = 'ok'
                               and b.created_at > coalesce(lc.move_at, '-infinity')), 0) as balance,
               coalesce((select sum(l.qty * rc.qty_per_unit)
                         from pos_recipes rc
                         join pos_bill_lines l on l.item_code = rc.menu_code
                         join pos_bills b on b.id = l.bill_id
                         where rc.stock_item_id = i.id and b.branch_id = p_branch and b.status = 'ok'
                           and b.business_date = v_today), 0) as used_today
        from pos_stock_items i
        left join lateral (
          select m.qty, m.move_at from pos_stock_moves m
          where m.stock_item_id = i.id and m.kind = 'count'
          order by m.move_at desc limit 1) lc on true
        where i.branch_id = p_branch) x), '[]'::jsonb),
    'recipes', coalesce((
      select jsonb_agg(jsonb_build_object('stock_item_id', rc.stock_item_id, 'menu_code', rc.menu_code, 'qty', rc.qty_per_unit))
      from pos_recipes rc join pos_stock_items i on i.id = rc.stock_item_id where i.branch_id = p_branch), '[]'::jsonb),
    'moves', coalesce((
      select jsonb_agg(y order by y.move_at desc) from (
        select m.id, m.stock_item_id, i.name, i.unit, m.kind, m.qty, m.note, m.move_at
        from pos_stock_moves m join pos_stock_items i on i.id = m.stock_item_id
        where m.branch_id = p_branch order by m.move_at desc limit 40) y), '[]'::jsonb)
  ) into r;
  return r;
end $$;

-- ---------- เพิ่ม/แก้รายการสต็อก ----------
create or replace function public.stock_upsert_item(p_branch text, p_token text, p_item jsonb)
returns bigint language plpgsql security definer set search_path = public, extensions as $$
declare v_id bigint := nullif(p_item->>'id', '')::bigint;
begin
  perform pos_check_owner(p_branch, p_token);
  if v_id is null then
    insert into pos_stock_items (branch_id, name, unit, kind, min_level)
    values (p_branch, p_item->>'name', coalesce(nullif(p_item->>'unit',''), 'หน่วย'),
            coalesce(nullif(p_item->>'kind',''), 'raw'), coalesce(nullif(p_item->>'min_level','')::numeric, 0))
    returning id into v_id;
  else
    update pos_stock_items set
      name = coalesce(nullif(p_item->>'name',''), name),
      unit = coalesce(nullif(p_item->>'unit',''), unit),
      kind = coalesce(nullif(p_item->>'kind',''), kind),
      min_level = coalesce(nullif(p_item->>'min_level','')::numeric, min_level),
      active = coalesce((p_item->>'active')::boolean, active)
    where id = v_id and branch_id = p_branch;
  end if;
  return v_id;
end $$;

-- ---------- ตั้งสูตรตัดสต็อกของรายการหนึ่ง (แทนที่ทั้งชุด) ----------
create or replace function public.stock_set_recipes(p_branch text, p_token text, p_item_id bigint, p_rows jsonb)
returns integer language plpgsql security definer set search_path = public, extensions as $$
declare n int := 0; x jsonb;
begin
  perform pos_check_owner(p_branch, p_token);
  if not exists (select 1 from pos_stock_items where id = p_item_id and branch_id = p_branch) then
    raise exception 'item not found' using errcode = '22023';
  end if;
  delete from pos_recipes where stock_item_id = p_item_id;
  for x in select * from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) loop
    if coalesce((x->>'qty')::numeric, 0) > 0 and coalesce(x->>'menu_code','') <> '' then
      insert into pos_recipes (stock_item_id, menu_code, qty_per_unit)
      values (p_item_id, x->>'menu_code', (x->>'qty')::numeric)
      on conflict (stock_item_id, menu_code) do update set qty_per_unit = excluded.qty_per_unit;
      n := n + 1;
    end if;
  end loop;
  return n;
end $$;

-- ---------- บันทึกรับเข้า / นับจริง / ของเสีย / ปรับ ----------
create or replace function public.stock_add_move(p_branch text, p_token text, p_item_id bigint, p_kind text, p_qty numeric, p_note text)
returns bigint language plpgsql security definer set search_path = public, extensions as $$
declare v_id bigint;
begin
  perform pos_check_owner(p_branch, p_token);
  if p_kind not in ('in','count','waste','adjust') then raise exception 'bad kind' using errcode = '22023'; end if;
  if p_kind in ('in','waste','count') and p_qty < 0 then raise exception 'qty must be >= 0' using errcode = '22023'; end if;
  if not exists (select 1 from pos_stock_items where id = p_item_id and branch_id = p_branch) then
    raise exception 'item not found' using errcode = '22023';
  end if;
  insert into pos_stock_moves (branch_id, stock_item_id, kind, qty, note)
  values (p_branch, p_item_id, p_kind, p_qty, nullif(p_note, '')) returning id into v_id;
  return v_id;
end $$;

-- ---------- ลบรายการที่บันทึกผิด ----------
create or replace function public.stock_delete_move(p_branch text, p_token text, p_move_id bigint)
returns void language plpgsql security definer set search_path = public, extensions as $$
begin
  perform pos_check_owner(p_branch, p_token);
  delete from pos_stock_moves where id = p_move_id and branch_id = p_branch;
end $$;

revoke all on function public.stock_overview(text, text) from public;
revoke all on function public.stock_upsert_item(text, text, jsonb) from public;
revoke all on function public.stock_set_recipes(text, text, bigint, jsonb) from public;
revoke all on function public.stock_add_move(text, text, bigint, text, numeric, text) from public;
revoke all on function public.stock_delete_move(text, text, bigint) from public;
grant execute on function public.stock_overview(text, text) to anon, authenticated;
grant execute on function public.stock_upsert_item(text, text, jsonb) to anon, authenticated;
grant execute on function public.stock_set_recipes(text, text, bigint, jsonb) to anon, authenticated;
grant execute on function public.stock_add_move(text, text, bigint, text, numeric, text) to anon, authenticated;
grant execute on function public.stock_delete_move(text, text, bigint) to anon, authenticated;
