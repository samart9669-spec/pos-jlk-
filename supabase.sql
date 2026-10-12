-- ============================================================
-- หมูพริ้ว POS — ตารางบน Supabase (รันใน SQL Editor ครั้งเดียว รันซ้ำได้ ไม่ทับข้อมูล)
-- ตารางทั้งหมดขึ้นต้นด้วย pos_ ไม่ยุ่งกับตารางของโปรแกรมอื่นในโปรเจกต์เดียวกัน
-- ความปลอดภัย: แอปบนมือถือ "เขียนได้อย่างเดียว" ผ่านฟังก์ชัน submit_bills พร้อมรหัสลับของสาขา
--              อ่านตารางตรงๆ ไม่ได้ (ปิด RLS สิทธิ์ anon/authenticated ทั้งหมด)
-- ============================================================

create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;

-- ---------- สาขา + รหัสลับ ----------
create table if not exists public.pos_branches (
  branch_id   text primary key,            -- รหัสสั้น เช่น 'jlk' (ตรงกับในหน้าตั้งค่าของแอป)
  branch_name text not null,               -- ชื่อสาขาที่ออกใน CSV (ต้องตรงกับชื่อในชีท)
  token_hash  text not null,               -- sha256 ของรหัสลับ (ไม่เก็บรหัสจริง)
  active      boolean not null default true
);

-- ---------- บิล + รายการในบิล ----------
create table if not exists public.pos_bills (
  id            uuid primary key,          -- สร้างจากมือถือ ใช้กันบิลซ้ำเวลาส่งซ้ำ
  branch_id     text not null references public.pos_branches(branch_id),
  device        text,
  business_date date not null,             -- วันที่ขาย (เวลาไทย)
  created_at    timestamptz not null,
  updated_at    timestamptz not null,      -- เปลี่ยนเมื่อยกเลิกบิล
  received_at   timestamptz not null default now(),
  payment_code  int,
  payment_name  text,
  total         numeric(12,2) not null,
  status        text not null check (status in ('ok','void'))
);
create index if not exists pos_bills_branch_date_idx on public.pos_bills (branch_id, business_date);

create table if not exists public.pos_bill_lines (
  bill_id     uuid not null references public.pos_bills(id) on delete cascade,
  line_no     int  not null,
  item_code   text,                        -- รหัสระบบ (ตรงกับ Item_Code ใน Item Master)
  keypad_code text,                        -- เลขที่กดบนเครื่อง
  item_name   text not null,
  price       numeric(10,2) not null,
  qty         int not null check (qty > 0),
  primary key (bill_id, line_no)
);

-- ---------- ปิดสิทธิ์: ไม่มีใครอ่าน/เขียนตารางตรงๆ ได้ นอกจากเจ้าของโปรเจกต์ ----------
alter table public.pos_branches   enable row level security;
alter table public.pos_bills      enable row level security;
alter table public.pos_bill_lines enable row level security;
revoke all on public.pos_branches, public.pos_bills, public.pos_bill_lines from anon, authenticated;

-- ---------- ฟังก์ชันรับบิลจากมือถือ ----------
create or replace function public.submit_bills(p_branch text, p_token text, p_bills jsonb)
returns integer
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  b jsonb;
  n int := 0;
  v_id uuid;
begin
  if not exists (
    select 1 from pos_branches
    where branch_id = p_branch and active
      and token_hash = encode(extensions.digest(coalesce(p_token, ''), 'sha256'), 'hex')
  ) then
    raise exception 'unauthorized' using errcode = '28000';
  end if;

  if p_bills is null or jsonb_typeof(p_bills) <> 'array' or jsonb_array_length(p_bills) > 200 then
    raise exception 'bad payload' using errcode = '22023';
  end if;

  for b in select * from jsonb_array_elements(p_bills) loop
    v_id := (b->>'id')::uuid;

    insert into pos_bills (id, branch_id, device, business_date, created_at, updated_at,
                           payment_code, payment_name, total, status)
    values (v_id, p_branch, b->>'device', (b->>'business_date')::date,
            (b->>'created_at')::timestamptz, (b->>'updated_at')::timestamptz,
            nullif(b->>'payment_code','')::int, b->>'payment_name',
            (b->>'total')::numeric, b->>'status')
    on conflict (id) do update
      set status = excluded.status, total = excluded.total, updated_at = excluded.updated_at,
          payment_code = excluded.payment_code, payment_name = excluded.payment_name, device = excluded.device
      where pos_bills.branch_id = excluded.branch_id
        and pos_bills.updated_at <= excluded.updated_at;       -- ส่งซ้ำ/เก่ากว่า = ไม่ทำอะไร

    if found then                                              -- เพิ่งสร้างหรือเพิ่งอัปเดตจริง
      delete from pos_bill_lines where bill_id = v_id;
      insert into pos_bill_lines (bill_id, line_no, item_code, keypad_code, item_name, price, qty)
      select v_id, x.line_no, x.item_code, x.keypad_code, x.item_name, x.price, x.qty
      from jsonb_to_recordset(b->'lines')
        as x(line_no int, item_code text, keypad_code text, item_name text, price numeric, qty int);
    end if;
    n := n + 1;
  end loop;
  return n;
end;
$$;

revoke all on function public.submit_bills(text, text, jsonb) from public;
grant execute on function public.submit_bills(text, text, jsonb) to anon, authenticated;

-- ---------- view สำหรับออก CSV (รูปแบบเดียวกับแท็บ Data ในชีท) ----------
-- date, branch, item_code, item_name, price, qty, amount  (ไม่นับบิลที่ยกเลิก)
create or replace view public.pos_daily_item_summary with (security_invoker = true) as
select b.business_date as date,
       br.branch_name  as branch,
       l.item_code,
       l.item_name,
       l.price,
       sum(l.qty)::int          as qty,
       sum(l.price * l.qty)     as amount
from pos_bills b
join pos_branches br on br.branch_id = b.branch_id
join pos_bill_lines l on l.bill_id = b.id
where b.status = 'ok'
group by 1, 2, 3, 4, 5;

-- ยอดรายชั่วโมง ไว้ดูระหว่างวัน
create or replace view public.pos_hourly_summary with (security_invoker = true) as
select b.business_date as date,
       br.branch_name  as branch,
       extract(hour from b.created_at at time zone 'Asia/Bangkok')::int as hour,
       count(*)        as bills,
       sum(b.total)    as amount
from pos_bills b
join pos_branches br on br.branch_id = b.branch_id
where b.status = 'ok'
group by 1, 2, 3;

-- ยอดแยกช่องทางชำระเงินรายวัน
create or replace view public.pos_payment_summary with (security_invoker = true) as
select b.business_date as date,
       br.branch_name  as branch,
       b.payment_name,
       count(*)        as bills,
       sum(b.total)    as amount
from pos_bills b
join pos_branches br on br.branch_id = b.branch_id
where b.status = 'ok'
group by 1, 2, 3;

revoke all on public.pos_daily_item_summary, public.pos_hourly_summary, public.pos_payment_summary from anon, authenticated;

-- ---------- สาขาเริ่มต้น ----------
-- รหัสลับเริ่มต้นคือ  CHANGE-ME-jlk  (เปลี่ยนก่อนใช้งานจริง!)
insert into public.pos_branches (branch_id, branch_name, token_hash)
values ('jlk', 'JLK Tower', encode(extensions.digest('CHANGE-ME-jlk', 'sha256'), 'hex'))
on conflict (branch_id) do nothing;

-- เปลี่ยนรหัสลับ:
--   update public.pos_branches set token_hash = encode(extensions.digest('Kang1111','sha256'),'hex') where branch_id = 'jlk';
-- เปลี่ยนชื่อสาขาที่ออกใน CSV:
--   update public.pos_branches set branch_name = 'JLK Tower' where branch_id = 'jlk';
