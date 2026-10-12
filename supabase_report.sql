-- ============================================================
-- หน้ารายงานเจ้าของร้าน (report.html) — รันใน SQL Editor ครั้งเดียว รันซ้ำได้
-- ใช้ "รหัสดูรายงาน" แยกจากรหัสลับของแอปมือถือ (พนักงานที่มีรหัสแอปจะดูรายงานไม่ได้)
-- ============================================================

alter table public.pos_branches add column if not exists report_token_hash text;

create or replace function public.get_report(p_branch text, p_report_token text, p_date date)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare r jsonb;
begin
  if not exists (
    select 1 from pos_branches
    where branch_id = p_branch and active and report_token_hash is not null
      and report_token_hash = encode(extensions.digest(coalesce(p_report_token, ''), 'sha256'), 'hex')
  ) then
    raise exception 'unauthorized' using errcode = '28000';
  end if;

  select jsonb_build_object(
    'date', p_date,
    'branch', (select branch_name from pos_branches where branch_id = p_branch),
    'bills', (select count(*) from pos_bills where branch_id = p_branch and business_date = p_date and status = 'ok'),
    'voids', (select count(*) from pos_bills where branch_id = p_branch and business_date = p_date and status = 'void'),
    'total', coalesce((select sum(total) from pos_bills where branch_id = p_branch and business_date = p_date and status = 'ok'), 0),
    'last_received', (select max(received_at) from pos_bills where branch_id = p_branch and business_date = p_date),
    'hourly', coalesce((
      select jsonb_agg(x order by x.hour) from (
        select extract(hour from created_at at time zone 'Asia/Bangkok')::int as hour,
               count(*) as bills, sum(total) as amount
        from pos_bills
        where branch_id = p_branch and business_date = p_date and status = 'ok'
        group by 1) x), '[]'::jsonb),
    'payments', coalesce((
      select jsonb_agg(x order by x.amount desc) from (
        select coalesce(payment_name, '-') as name, count(*) as bills, sum(total) as amount
        from pos_bills
        where branch_id = p_branch and business_date = p_date and status = 'ok'
        group by 1) x), '[]'::jsonb),
    'items', coalesce((
      select jsonb_agg(x order by x.qty desc, x.name) from (
        select l.item_code as code, l.item_name as name, l.price,
               sum(l.qty)::int as qty, sum(l.price * l.qty) as amount
        from pos_bills b join pos_bill_lines l on l.bill_id = b.id
        where b.branch_id = p_branch and b.business_date = p_date and b.status = 'ok'
        group by 1, 2, 3) x), '[]'::jsonb)
  ) into r;
  return r;
end;
$$;

revoke all on function public.get_report(text, text, date) from public;
grant execute on function public.get_report(text, text, date) to anon, authenticated;

-- ตั้ง "รหัสดูรายงาน" (เปลี่ยน รหัสดูรายงานของคุณ เป็นรหัสที่ต้องการ แล้วกด Run)
--   update public.pos_branches
--   set report_token_hash = encode(extensions.digest('รหัสดูรายงานของคุณ','sha256'),'hex')
--   where branch_id = 'jlk';
