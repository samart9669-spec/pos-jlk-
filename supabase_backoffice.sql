-- ============================================================
-- หลังบ้านรวม (admin.html) — รันใน SQL Editor ครั้งเดียว รันซ้ำได้ ไม่ทับข้อมูล
-- ต้องรัน supabase.sql มาก่อน แล้วรันไฟล์นี้ (แทน supabase_report.sql และ supabase_stock.sql เดิม)
--
-- ล็อกอินด้วยบัญชี Supabase Auth (อีเมล+รหัสผ่าน) และสิทธิ์ต่อสาขา:
--   owner   = ทุกอย่าง รวมจัดการทีมงาน
--   manager = ยอดขาย สต็อก เมนู/ราคา
--   staff   = ดู/บันทึกสต็อก (รับเข้า นับ ของเสีย) และดูเมนู
-- คนที่ไม่มีแถวใน pos_staff จะเข้าอะไรไม่ได้เลย แม้มีบัญชีอยู่ในโปรเจกต์ (เช่น ผู้ใช้ของแอป elevation)
-- ============================================================

create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;

-- ---------- เลิกใช้ "รหัสดูรายงาน" แบบเดิม ----------
drop function if exists public.get_report(text, text, date);
drop function if exists public.stock_overview(text, text);
drop function if exists public.stock_upsert_item(text, text, jsonb);
drop function if exists public.stock_set_recipes(text, text, bigint, jsonb);
drop function if exists public.stock_add_move(text, text, bigint, text, numeric, text);
drop function if exists public.stock_delete_move(text, text, bigint);
drop function if exists public.pos_check_owner(text, text);
alter table public.pos_branches drop column if exists report_token_hash;

-- ---------- ทีมงานและสิทธิ์ ----------
create table if not exists public.pos_staff (
  user_id    uuid not null,                       -- = auth.users.id
  branch_id  text not null references public.pos_branches(branch_id),
  role       text not null check (role in ('owner','manager','staff')),
  name       text,
  active     boolean not null default true,
  created_at timestamptz not null default now(),
  primary key (user_id, branch_id)
);

-- ---------- เมนู/ราคา (master กลาง) ----------
create table if not exists public.pos_menu_items (
  branch_id  text not null references public.pos_branches(branch_id),
  item_code  text not null,                       -- รหัสสินค้าในระบบ/ชีท เช่น JL2002
  keypad     text not null,                       -- เลขที่กดบนเครื่องคิดเงิน
  name       text not null,
  price      numeric(10,2) not null check (price >= 0),
  grp        text not null default 'เมนู',
  sort       int  not null default 0,
  active     boolean not null default true,
  updated_at timestamptz not null default now(),
  primary key (branch_id, item_code)
);

-- ---------- สต็อก ----------
create table if not exists public.pos_stock_items (
  id         bigint generated always as identity primary key,
  branch_id  text not null references public.pos_branches(branch_id),
  name       text not null,
  unit       text not null default 'หน่วย',
  kind       text not null default 'raw' check (kind in ('raw','portion')),
  min_level  numeric(12,3) not null default 0,
  active     boolean not null default true,
  created_at timestamptz not null default now()
);
create table if not exists public.pos_recipes (
  stock_item_id bigint not null references public.pos_stock_items(id) on delete cascade,
  menu_code     text   not null,
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
  by_user       uuid,
  move_at       timestamptz not null default now()
);
create index if not exists pos_stock_moves_item_idx on public.pos_stock_moves (stock_item_id, move_at);
alter table public.pos_stock_moves add column if not exists by_user uuid;

alter table public.pos_staff       enable row level security;
alter table public.pos_menu_items  enable row level security;
alter table public.pos_stock_items enable row level security;
alter table public.pos_recipes     enable row level security;
alter table public.pos_stock_moves enable row level security;
revoke all on public.pos_staff, public.pos_menu_items, public.pos_stock_items, public.pos_recipes, public.pos_stock_moves from anon, authenticated;

-- ---------- ตรวจสิทธิ์ (ใช้ภายใน) ระดับ: staff=1 manager=2 owner=3 ----------
create or replace function public.pos_check_access(p_branch text, p_min int)
returns void language plpgsql security definer set search_path = public, extensions as $$
declare v_rank int;
begin
  select case role when 'owner' then 3 when 'manager' then 2 else 1 end into v_rank
  from pos_staff where user_id = auth.uid() and branch_id = p_branch and active;
  if v_rank is null or v_rank < p_min then
    raise exception 'unauthorized' using errcode = '28000';
  end if;
end $$;
revoke all on function public.pos_check_access(text, int) from public;

-- ---------- ฉันเป็นใคร / เข้าสาขาไหนได้ ----------
create or replace function public.my_access()
returns jsonb language sql security definer set search_path = public, extensions as $$
  select coalesce(jsonb_agg(jsonb_build_object('branch_id', s.branch_id, 'branch_name', b.branch_name, 'role', s.role, 'name', s.name)), '[]'::jsonb)
  from pos_staff s join pos_branches b on b.branch_id = s.branch_id
  where s.user_id = auth.uid() and s.active and b.active;
$$;

-- ---------- รายงานยอดขายรายวัน ----------
create or replace function public.get_report(p_branch text, p_date date)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare r jsonb;
begin
  perform pos_check_access(p_branch, 2);
  select jsonb_build_object(
    'date', p_date,
    'branch', (select branch_name from pos_branches where branch_id = p_branch),
    'bills', (select count(*) from pos_bills where branch_id = p_branch and business_date = p_date and status = 'ok'),
    'voids', (select count(*) from pos_bills where branch_id = p_branch and business_date = p_date and status = 'void'),
    'total', coalesce((select sum(total) from pos_bills where branch_id = p_branch and business_date = p_date and status = 'ok'), 0),
    'last_received', (select max(received_at) from pos_bills where branch_id = p_branch and business_date = p_date),
    'hourly', coalesce((
      select jsonb_agg(x order by x.hour) from (
        select extract(hour from created_at at time zone 'Asia/Bangkok')::int as hour, count(*) as bills, sum(total) as amount
        from pos_bills where branch_id = p_branch and business_date = p_date and status = 'ok' group by 1) x), '[]'::jsonb),
    'payments', coalesce((
      select jsonb_agg(x order by x.amount desc) from (
        select coalesce(payment_name, '-') as name, count(*) as bills, sum(total) as amount
        from pos_bills where branch_id = p_branch and business_date = p_date and status = 'ok' group by 1) x), '[]'::jsonb),
    'items', coalesce((
      select jsonb_agg(x order by x.qty desc, x.name) from (
        select l.item_code as code, l.item_name as name, l.price, sum(l.qty)::int as qty, sum(l.price * l.qty) as amount
        from pos_bills b join pos_bill_lines l on l.bill_id = b.id
        where b.branch_id = p_branch and b.business_date = p_date and b.status = 'ok'
        group by 1, 2, 3) x), '[]'::jsonb)
  ) into r;
  return r;
end $$;

-- ---------- แนวโน้มยอดขายย้อนหลัง ----------
create or replace function public.sales_trend(p_branch text, p_days int default 14)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare v_today date := (now() at time zone 'Asia/Bangkok')::date;
begin
  perform pos_check_access(p_branch, 2);
  p_days := least(greatest(coalesce(p_days, 14), 1), 120);
  return coalesce((
    select jsonb_agg(jsonb_build_object('date', d::date, 'bills', coalesce(t.bills, 0), 'total', coalesce(t.total, 0)) order by d)
    from generate_series(v_today - (p_days - 1), v_today, interval '1 day') d
    left join (select business_date, count(*) as bills, sum(total) as total
               from pos_bills where branch_id = p_branch and status = 'ok' group by 1) t on t.business_date = d::date
  ), '[]'::jsonb);
end $$;

-- ---------- เมนู/ราคา ----------
create or replace function public.menu_list(p_branch text)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
begin
  perform pos_check_access(p_branch, 1);
  return coalesce((select jsonb_agg(jsonb_build_object('code', item_code, 'keypad', keypad, 'name', name, 'price', price, 'group', grp, 'active', active) order by sort, keypad::int)
                   from pos_menu_items where branch_id = p_branch), '[]'::jsonb);
end $$;

create or replace function public.menu_save(p_branch text, p_items jsonb)
returns integer language plpgsql security definer set search_path = public, extensions as $$
declare x jsonb; n int := 0; v_codes text[];
begin
  perform pos_check_access(p_branch, 2);
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) > 300 then
    raise exception 'bad payload' using errcode = '22023';
  end if;
  select coalesce(array_agg(e->>'code'), '{}') into v_codes from jsonb_array_elements(p_items) e;
  delete from pos_menu_items where branch_id = p_branch and not (item_code = any(v_codes));
  for x in select * from jsonb_array_elements(p_items) loop
    insert into pos_menu_items (branch_id, item_code, keypad, name, price, grp, sort, active, updated_at)
    values (p_branch, trim(x->>'code'), trim(x->>'keypad'), trim(x->>'name'), (x->>'price')::numeric,
            coalesce(nullif(trim(x->>'group'), ''), 'เมนู'), n, coalesce((x->>'active')::boolean, true), now())
    on conflict (branch_id, item_code) do update
      set keypad = excluded.keypad, name = excluded.name, price = excluded.price, grp = excluded.grp,
          sort = excluded.sort, active = excluded.active, updated_at = now();
    n := n + 1;
  end loop;
  return n;
end $$;

-- แอปมือถือที่ร้านดึงเมนู (ใช้รหัสลับสาขาเดิมของแอป)
create or replace function public.device_get_menu(p_branch text, p_token text)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
begin
  if not exists (select 1 from pos_branches where branch_id = p_branch and active
                 and token_hash = encode(extensions.digest(coalesce(p_token, ''), 'sha256'), 'hex')) then
    raise exception 'unauthorized' using errcode = '28000';
  end if;
  return jsonb_build_object(
    'updated_at', (select max(updated_at) from pos_menu_items where branch_id = p_branch),
    'items', coalesce((select jsonb_agg(jsonb_build_object('keypad', keypad, 'code', item_code, 'name', name, 'price', price, 'group', grp) order by sort, keypad::int)
                       from pos_menu_items where branch_id = p_branch and active), '[]'::jsonb));
end $$;

-- ---------- สต็อก ----------
create or replace function public.stock_overview(p_branch text)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare r jsonb; v_today date := (now() at time zone 'Asia/Bangkok')::date;
begin
  perform pos_check_access(p_branch, 1);
  select jsonb_build_object(
    'today', v_today,
    'items', coalesce((
      select jsonb_agg(x order by x.active desc, x.name) from (
        select i.id, i.name, i.unit, i.kind, i.min_level, i.active, lc.move_at as last_count_at,
               coalesce(lc.qty, 0)
                 + coalesce((select sum(case m.kind when 'in' then m.qty when 'adjust' then m.qty when 'waste' then -m.qty else 0 end)
                             from pos_stock_moves m where m.stock_item_id = i.id and m.move_at > coalesce(lc.move_at, '-infinity')), 0)
                 - coalesce((select sum(l.qty * rc.qty_per_unit)
                             from pos_recipes rc join pos_bill_lines l on l.item_code = rc.menu_code join pos_bills b on b.id = l.bill_id
                             where rc.stock_item_id = i.id and b.branch_id = p_branch and b.status = 'ok'
                               and b.created_at > coalesce(lc.move_at, '-infinity')), 0) as balance,
               coalesce((select sum(l.qty * rc.qty_per_unit)
                         from pos_recipes rc join pos_bill_lines l on l.item_code = rc.menu_code join pos_bills b on b.id = l.bill_id
                         where rc.stock_item_id = i.id and b.branch_id = p_branch and b.status = 'ok' and b.business_date = v_today), 0) as used_today
        from pos_stock_items i
        left join lateral (select m.qty, m.move_at from pos_stock_moves m where m.stock_item_id = i.id and m.kind = 'count'
                           order by m.move_at desc limit 1) lc on true
        where i.branch_id = p_branch) x), '[]'::jsonb),
    'recipes', coalesce((select jsonb_agg(jsonb_build_object('stock_item_id', rc.stock_item_id, 'menu_code', rc.menu_code, 'qty', rc.qty_per_unit))
                         from pos_recipes rc join pos_stock_items i on i.id = rc.stock_item_id where i.branch_id = p_branch), '[]'::jsonb),
    'moves', coalesce((
      select jsonb_agg(y order by y.move_at desc) from (
        select m.id, m.stock_item_id, i.name, i.unit, m.kind, m.qty, m.note, m.move_at, s.name as by_name
        from pos_stock_moves m join pos_stock_items i on i.id = m.stock_item_id
        left join pos_staff s on s.user_id = m.by_user and s.branch_id = m.branch_id
        where m.branch_id = p_branch order by m.move_at desc limit 40) y), '[]'::jsonb)
  ) into r;
  return r;
end $$;

create or replace function public.stock_upsert_item(p_branch text, p_item jsonb)
returns bigint language plpgsql security definer set search_path = public, extensions as $$
declare v_id bigint := nullif(p_item->>'id', '')::bigint;
begin
  perform pos_check_access(p_branch, 2);
  if v_id is null then
    insert into pos_stock_items (branch_id, name, unit, kind, min_level)
    values (p_branch, p_item->>'name', coalesce(nullif(p_item->>'unit',''), 'หน่วย'),
            coalesce(nullif(p_item->>'kind',''), 'raw'), coalesce(nullif(p_item->>'min_level','')::numeric, 0))
    returning id into v_id;
  else
    update pos_stock_items set
      name = coalesce(nullif(p_item->>'name',''), name), unit = coalesce(nullif(p_item->>'unit',''), unit),
      kind = coalesce(nullif(p_item->>'kind',''), kind), min_level = coalesce(nullif(p_item->>'min_level','')::numeric, min_level),
      active = coalesce((p_item->>'active')::boolean, active)
    where id = v_id and branch_id = p_branch;
  end if;
  return v_id;
end $$;

create or replace function public.stock_set_recipes(p_branch text, p_item_id bigint, p_rows jsonb)
returns integer language plpgsql security definer set search_path = public, extensions as $$
declare n int := 0; x jsonb;
begin
  perform pos_check_access(p_branch, 2);
  if not exists (select 1 from pos_stock_items where id = p_item_id and branch_id = p_branch) then
    raise exception 'item not found' using errcode = '22023';
  end if;
  delete from pos_recipes where stock_item_id = p_item_id;
  for x in select * from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) loop
    if coalesce((x->>'qty')::numeric, 0) > 0 and coalesce(x->>'menu_code','') <> '' then
      insert into pos_recipes (stock_item_id, menu_code, qty_per_unit) values (p_item_id, x->>'menu_code', (x->>'qty')::numeric)
      on conflict (stock_item_id, menu_code) do update set qty_per_unit = excluded.qty_per_unit;
      n := n + 1;
    end if;
  end loop;
  return n;
end $$;

create or replace function public.stock_add_move(p_branch text, p_item_id bigint, p_kind text, p_qty numeric, p_note text)
returns bigint language plpgsql security definer set search_path = public, extensions as $$
declare v_id bigint;
begin
  perform pos_check_access(p_branch, 1);
  if p_kind not in ('in','count','waste','adjust') then raise exception 'bad kind' using errcode = '22023'; end if;
  if p_kind in ('in','waste','count') and p_qty < 0 then raise exception 'qty must be >= 0' using errcode = '22023'; end if;
  if not exists (select 1 from pos_stock_items where id = p_item_id and branch_id = p_branch) then
    raise exception 'item not found' using errcode = '22023';
  end if;
  insert into pos_stock_moves (branch_id, stock_item_id, kind, qty, note, by_user)
  values (p_branch, p_item_id, p_kind, p_qty, nullif(p_note, ''), auth.uid()) returning id into v_id;
  return v_id;
end $$;

create or replace function public.stock_delete_move(p_branch text, p_move_id bigint)
returns void language plpgsql security definer set search_path = public, extensions as $$
begin
  perform pos_check_access(p_branch, 2);
  delete from pos_stock_moves where id = p_move_id and branch_id = p_branch;
end $$;

-- ---------- จัดการทีมงาน (owner) ----------
create or replace function public.staff_list(p_branch text)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
begin
  perform pos_check_access(p_branch, 3);
  return coalesce((select jsonb_agg(jsonb_build_object('user_id', s.user_id, 'email', u.email, 'name', s.name, 'role', s.role, 'active', s.active) order by s.role desc, u.email)
                   from pos_staff s join auth.users u on u.id = s.user_id where s.branch_id = p_branch), '[]'::jsonb);
end $$;

-- เพิ่ม/แก้ทีมงานจากอีเมล (ต้องสร้างบัญชีใน Supabase → Authentication → Users ก่อน)
create or replace function public.staff_set(p_branch text, p_email text, p_role text, p_name text, p_active boolean default true)
returns void language plpgsql security definer set search_path = public, extensions as $$
declare v_uid uuid;
begin
  perform pos_check_access(p_branch, 3);
  if p_role not in ('owner','manager','staff') then raise exception 'bad role' using errcode = '22023'; end if;
  select id into v_uid from auth.users where lower(email) = lower(trim(p_email)) limit 1;
  if v_uid is null then raise exception 'user not found' using errcode = 'P0002'; end if;
  if v_uid = auth.uid() and (p_role <> 'owner' or not coalesce(p_active, true)) then
    raise exception 'cannot demote yourself' using errcode = '22023';
  end if;
  insert into pos_staff (user_id, branch_id, role, name, active)
  values (v_uid, p_branch, p_role, nullif(trim(p_name), ''), coalesce(p_active, true))
  on conflict (user_id, branch_id) do update
    set role = excluded.role, name = coalesce(excluded.name, pos_staff.name), active = excluded.active;
end $$;

-- ---------- สิทธิ์เรียกใช้ ----------
do $$
declare f text;
begin
  foreach f in array array[
    'my_access()', 'get_report(text,date)', 'sales_trend(text,int)', 'menu_list(text)', 'menu_save(text,jsonb)',
    'stock_overview(text)', 'stock_upsert_item(text,jsonb)', 'stock_set_recipes(text,bigint,jsonb)',
    'stock_add_move(text,bigint,text,numeric,text)', 'stock_delete_move(text,bigint)',
    'staff_list(text)', 'staff_set(text,text,text,text,boolean)'] loop
    execute format('revoke all on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $$;
revoke all on function public.device_get_menu(text, text) from public;
grant execute on function public.device_get_menu(text, text) to anon, authenticated;

-- ---------- เมนูเริ่มต้นของ JLK Tower (ตรงกับแอป) ----------
insert into public.pos_menu_items (branch_id, item_code, keypad, name, price, grp, sort) values
 ('jlk','JL2001','1','ข้าวขาหมูมหาชน (อิ่มพอดี)',50,'ข้าวขาหมู',1),
 ('jlk','JL2002','2','ข้าวขาหมู',70,'ข้าวขาหมู',2),
 ('jlk','JL2003','3','ข้าวกะเพราขาหมู',70,'ข้าวขาหมู',3),
 ('jlk','JL2004','4','ข้าวขาหมูลืน',80,'ข้าวขาหมู',4),
 ('jlk','JL2005','5','ข้าวขาหมูรวมพล (เนื้อ คากิ ไส้ ไข่)',90,'ข้าวขาหมู',5),
 ('jlk','JL2006','6','ขาหมูรวมพล (เนื้อ คากิ ไส้ ไข่)',160,'ขาหมูเปล่า',6),
 ('jlk','JL2007','7','ข้าวหมูทอด',65,'ข้าวหมู',7),
 ('jlk','JL2008','8','ข้าวหมู2สหาย',80,'ข้าวหมู',8),
 ('jlk','JL2009','9','ข้าวหมูทอดพริกเกลือ',65,'ข้าวหมู',9),
 ('jlk','JL2010','10','เพิ่ม ข้าวเปล่า',10,'เพิ่ม',10),
 ('jlk','JL2011','11','เพิ่ม ไส้พะโล้',15,'เพิ่ม',11),
 ('jlk','JL2012','12','เพิ่ม ไข่พะโล้',10,'เพิ่ม',12),
 ('jlk','JL2013','13','เพิ่ม พิเศษ',10,'เพิ่ม',13),
 ('jlk','JL2014','14','เพิ่มหมูทอด',15,'เพิ่ม',14),
 ('jlk','JL2015','15','เพิ่มกานาฉ่าย',10,'เพิ่ม',15),
 ('jlk','JL2016','16','น้ำเปล่า',10,'อื่นๆ',16),
 ('jlk','JL2017','17','ใส่กล่อง',5,'อื่นๆ',17)
on conflict (branch_id, item_code) do nothing;

-- ---------- ตั้งเจ้าของคนแรก (ทำหลังสร้างบัญชีใน Authentication → Users แล้ว) ----------
--   insert into public.pos_staff (user_id, branch_id, role, name)
--   select id, 'jlk', 'owner', 'Samart' from auth.users where lower(email) = lower('อีเมลที่สร้าง')
--   on conflict (user_id, branch_id) do update set role = 'owner', active = true;
