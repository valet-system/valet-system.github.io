-- ═══════════════════════════════════════════════════════════════════════
-- 0018 — ANALYTICS TAKES A DATE RANGE, NOT A NUMBER OF DAYS
--
--   >>> RUN THIS IN THE SUPABASE SQL EDITOR, AFTER 0011. <<<
--
-- Safe to run more than once. Creates no tables; if the editor warns about
-- RLS, choose "Run without RLS".
--
--
-- WHY
--
-- The functions took `p_days` and always ended at today. That answers "the last
-- 30 days" and nothing else — it cannot answer "last Saturday", "the wedding
-- weekend" or "September", which is what somebody comparing two periods
-- actually asks. A from/to pair answers all of them, and "the last 30 days" is
-- just one pair the UI happens to compute.
--
--
-- THE OLD SIGNATURES ARE DROPPED, NOT LEFT ALONGSIDE
--
-- Postgres would happily keep analytics_summary(uuid, int) next to
-- analytics_summary(uuid, date, date) as an overload. That is the trap: a
-- caller passing the wrong shape would silently resolve to the old function
-- and get a different period than the screen claims, with no error. One
-- signature per function.
--
--
-- THE SPAN IS CAPPED SERVER-SIDE
--
-- A from/to pair accepts anything, including 1900-01-01. The cap is not about
-- protecting the browser — it is that an unbounded range on a table with years
-- of history is a query that ties up a connection for the whole app while it
-- runs. 731 days lets somebody compare two full years and stops there.
-- ═══════════════════════════════════════════════════════════════════════

begin;

-- Drop first. See the header — an overload left behind is worse than no
-- function at all, because it fails silently rather than loudly.
drop function if exists public.analytics_summary(uuid, int);
drop function if exists public.analytics_by_property(int);


-- ═══════════════════════════════════════════════════════════════════════
-- 1. analytics_summary — one property, or all of them, over a date range
-- ═══════════════════════════════════════════════════════════════════════

create or replace function public.analytics_summary(
  p_property_id uuid default null,
  p_from        date default null,
  p_to          date default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_scope  uuid;
  v_to     date := coalesce(p_to, public.ist_today());
  v_from   date := coalesce(p_from, coalesce(p_to, public.ist_today()) - 29);
  v_days   int;
  v_result jsonb;
begin
  v_scope := public.analytics_scope(p_property_id);

  if v_from > v_to then
    raise exception 'BAD_RANGE: the start date is after the end date';
  end if;

  -- Clamp rather than refuse. Somebody who typed 2019 wants "as far back as you
  -- go", and returning 731 days of real numbers is more useful than an error
  -- about a limit they did not know existed.
  if v_to - v_from > 730 then
    v_from := v_to - 730;
  end if;

  -- Inclusive of both ends, so a single day is 1 and not 0 — the "cars a day"
  -- figure divides by this.
  v_days := (v_to - v_from) + 1;

  with vehicles as (
    select v.*
    from public.parked_vehicles v
    where v.service_date between v_from and v_to
      and (v_scope is null or v.property_id = v_scope)
  ),
  -- Tasks are reached THROUGH the vehicle, so they inherit its service_date and
  -- land on the shift that handled the car. A car checked in at 23:40 Friday and
  -- collected at 00:20 Saturday belongs to Friday.
  tasks as (
    select t.*, v.service_date
    from public.valet_tasks t
    join vehicles v on v.id = t.vehicle_id
  ),
  per_day as (
    select d::date as day, count(v.id) as cars
    from generate_series(v_from, v_to, interval '1 day') d
    left join vehicles v on v.service_date = d::date
    group by d
    order by d
  ),
  -- Bucket ONCE, then join the 24 slots onto the result. Cross joining every
  -- vehicle to generate_series(0,23) reads each row 24 times.
  hour_counts as (
    select extract(hour from v.parked_at at time zone 'Asia/Kolkata')::int as hour,
           count(*) as cars
    from vehicles v
    group by 1
  ),
  per_hour as (
    select h.hour, coalesce(c.cars, 0) as cars
    from generate_series(0, 23) as h(hour)
    left join hour_counts c on c.hour = h.hour
    order by h.hour
  ),
  retrievals as (
    select extract(epoch from (t.completed_at - t.created_at)) / 60.0 as minutes
    from tasks t
    where t.task_type = 'retrieval'
      and t.completed_at is not null
      and t.completed_at >= t.created_at
  ),
  parkings as (
    select extract(epoch from (t.completed_at - t.created_at)) / 60.0 as minutes
    from tasks t
    where t.task_type = 'parking'
      and t.completed_at is not null
      and t.completed_at >= t.created_at
  )
  select jsonb_build_object(
    'from',      v_from,
    'to',        v_to,
    'days',      v_days,
    'cars',      (select count(*) from vehicles),
    'delivered', (select count(*) from vehicles where status = 'delivered'),
    'parked',    (select count(*) from vehicles where status in ('parked', 'returned')),
    'no_shows',  (select coalesce(sum(return_count), 0) from tasks),
    'tiers', (
      select coalesce(jsonb_object_agg(car_tier, n), '{}'::jsonb)
      from (select car_tier, count(*) as n from vehicles group by car_tier) x
    ),
    'retrieval_wait',  (select percentile_cont(0.5) within group (order by minutes) from retrievals),
    'retrieval_count', (select count(*) from retrievals),
    'parking_time',    (select percentile_cont(0.5) within group (order by minutes) from parkings),
    'parking_count',   (select count(*) from parkings),
    'per_day',  (select coalesce(jsonb_agg(jsonb_build_object('d', day, 'cars', cars) order by day), '[]'::jsonb) from per_day),
    'per_hour', (select coalesce(jsonb_agg(jsonb_build_object('h', hour, 'cars', cars) order by hour), '[]'::jsonb) from per_hour)
  )
  into v_result;

  return v_result;
end $fn$;

revoke all    on function public.analytics_summary(uuid, date, date) from public, anon;
grant execute on function public.analytics_summary(uuid, date, date) to authenticated;


-- ═══════════════════════════════════════════════════════════════════════
-- 2. analytics_by_property — the group comparison, same range
-- ═══════════════════════════════════════════════════════════════════════

create or replace function public.analytics_by_property(
  p_from date default null,
  p_to   date default null
)
returns table (
  property_id     uuid,
  property_name   text,
  is_active       boolean,
  cars            bigint,
  delivered       bigint,
  no_shows        bigint,
  retrieval_wait  numeric,
  retrieval_count bigint,
  operators       bigint
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_to   date := coalesce(p_to, public.ist_today());
  v_from date := coalesce(p_from, coalesce(p_to, public.ist_today()) - 29);
begin
  if not public.is_system_admin() then
    raise exception 'FORBIDDEN: only a system admin can compare properties';
  end if;

  if v_from > v_to then
    raise exception 'BAD_RANGE: the start date is after the end date';
  end if;

  if v_to - v_from > 730 then
    v_from := v_to - 730;
  end if;

  return query
  with vehicles as (
    select v.id, v.property_id, v.status
    from public.parked_vehicles v
    where v.service_date between v_from and v_to
  ),
  tasks as (
    select t.property_id, t.task_type, t.return_count, t.created_at, t.completed_at
    from public.valet_tasks t
    join vehicles v on v.id = t.vehicle_id
  )
  -- Every column cast explicitly. RETURN QUERY matches types EXACTLY and does
  -- not apply the assignment casts a plain INSERT would — percentile_cont()
  -- returns double precision, so a numeric column without the cast fails the
  -- whole function with 42804 and PostgREST reports a bare 400.
  select
    p.id::uuid,
    p.name::text,
    p.is_active::boolean,
    (select count(*) from vehicles v where v.property_id = p.id)::bigint,
    (select count(*) from vehicles v
      where v.property_id = p.id and v.status = 'delivered')::bigint,
    (select coalesce(sum(t.return_count), 0) from tasks t where t.property_id = p.id)::bigint,
    (select percentile_cont(0.5) within group (
       order by extract(epoch from (t.completed_at - t.created_at)) / 60.0)
     from tasks t
     where t.property_id = p.id
       and t.task_type = 'retrieval'
       and t.completed_at is not null
       and t.completed_at >= t.created_at)::numeric,
    (select count(*) from tasks t
     where t.property_id = p.id
       and t.task_type = 'retrieval'
       and t.completed_at is not null
       and t.completed_at >= t.created_at)::bigint,
    (select count(*) from public.user_roles ur
     where ur.property_id = p.id and ur.role = 'operator' and ur.is_active = true)::bigint
  from public.properties p
  order by p.name;
end $fn$;

revoke all    on function public.analytics_by_property(date, date) from public, anon;
grant execute on function public.analytics_by_property(date, date) to authenticated;

commit;


-- ═══════════════════════════════════════════════════════════════════════
-- VERIFY — every row should say PASS.
--
-- The functions are not CALLED here: auth.uid() is NULL in the SQL Editor, so
-- analytics_scope() would raise FORBIDDEN and abort the whole block instead of
-- printing a FAIL row.
-- ═══════════════════════════════════════════════════════════════════════

with checks as (
  select 'analytics_summary takes (uuid, date, date)' as item,
         to_regprocedure('public.analytics_summary(uuid,date,date)') is not null as ok
  union all select 'analytics_by_property takes (date, date)',
         to_regprocedure('public.analytics_by_property(date,date)') is not null
  union all select 'the old p_days summary is GONE (no silent overload)',
         to_regprocedure('public.analytics_summary(uuid,int)') is null
  union all select 'the old p_days comparison is GONE',
         to_regprocedure('public.analytics_by_property(int)') is null
  union all select 'summary is callable by authenticated',
         has_function_privilege('authenticated',
           'public.analytics_summary(uuid,date,date)', 'execute')
  union all select 'by_property is callable by authenticated',
         has_function_privilege('authenticated',
           'public.analytics_by_property(date,date)', 'execute')
  union all select 'anon can call neither',
         not has_function_privilege('anon', 'public.analytics_summary(uuid,date,date)', 'execute')
     and not has_function_privilege('anon', 'public.analytics_by_property(date,date)', 'execute')
  union all select 'the span is capped',
         (select prosrc like '%730%'
          from pg_proc where oid = 'public.analytics_summary(uuid,date,date)'::regprocedure)
)
select item, case when ok then 'PASS' else 'FAIL' end as result
from checks
order by result desc, item;
