-- ═══════════════════════════════════════════════════════════════════════
-- 0011 — ANALYTICS IN POSTGRES, NOT IN THE BROWSER
--
--   >>> RUN THIS IN THE SUPABASE SQL EDITOR. <<<
--
-- Safe to run more than once. Creates no tables; if the editor warns about
-- RLS, choose "Run without RLS".
--
--
-- WHY THIS EXISTS
--
-- admin/Analytics originally totalled everything in JavaScript: fetch every
-- parked_vehicles row for the period, then count in a loop. That is fine for
-- a week and wrong for a quarter.
--
-- A property now hands out up to 1000 tokens a day. Ninety days of one busy
-- property is tens of thousands of rows, and the group view is four
-- properties at once — pulled over hotel wifi to a browser, so it can
-- produce eight numbers and two bar charts. Postgres can do the same work
-- next to the data and send back a few hundred bytes.
--
-- There is a sharper reason than payload. PostgREST can be configured with a
-- row ceiling, and a query that hits it returns a SHORT LIST WITH NO ERROR.
-- The page would render a confident, wrong "cars per day" and nothing on
-- screen would look broken. Aggregating in SQL removes the possibility
-- rather than relying on the limit staying unset.
--
--
-- EVERYTHING IS ATTRIBUTED TO THE CAR'S SERVICE DATE
--
-- Not to the task's own timestamp. A car checked in at 23:40 Friday and
-- collected at 00:20 Saturday belongs to FRIDAY's shift — that is the shift
-- that was staffed for it, and the one whose numbers a manager is reading.
-- Splitting it across two days would understate both.
--
-- service_date is already the IST business date (migration 0002), so this
-- also keeps every figure on the same calendar the operators work to.
--
--
-- MEDIANS, NOT AVERAGES
--
-- One car left overnight because a guest went home in a taxi drags a mean
-- anywhere it likes. The median answers the question actually being asked —
-- "how long does a normal guest wait" — and every median here is returned
-- with the count it came from, because a median of four is not a fact.
-- ═══════════════════════════════════════════════════════════════════════

begin;


-- ═══════════════════════════════════════════════════════════════════════
-- 1. analytics_scope — which property may this caller ask about?
--
-- Returns the property_id to use, or raises. NULL from a system_admin means
-- "all properties" and is passed straight through; NULL from anyone else is
-- replaced by their own property rather than refused, so the same page code
-- serves both without branching on role.
-- ═══════════════════════════════════════════════════════════════════════

create or replace function public.analytics_scope(p_property_id uuid)
returns uuid
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_role text;
  v_mine uuid;
begin
  select ur.role, ur.property_id into v_role, v_mine
  from public.user_roles ur
  where ur.user_id = auth.uid() and ur.is_active = true;

  if v_role is null then
    raise exception 'FORBIDDEN: you are not signed in as an active user';
  end if;

  if v_role = 'system_admin' then
    return p_property_id;                       -- null = every property
  end if;

  if p_property_id is not null and p_property_id <> v_mine then
    raise exception 'FORBIDDEN_PROPERTY';
  end if;

  return v_mine;
end $fn$;

revoke all    on function public.analytics_scope(uuid) from public, anon;
grant execute on function public.analytics_scope(uuid) to authenticated;


-- ═══════════════════════════════════════════════════════════════════════
-- 2. analytics_summary — everything one page needs, in one round trip
--
-- p_property_id null + system_admin = all properties combined.
-- ═══════════════════════════════════════════════════════════════════════

create or replace function public.analytics_summary(
  p_property_id uuid default null,
  p_days        int  default 30
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_scope uuid;
  v_days  int  := least(greatest(coalesce(p_days, 30), 1), 365);
  v_to    date := public.ist_today();
  v_from  date;
  v_result jsonb;
begin
  v_scope := public.analytics_scope(p_property_id);
  v_from  := v_to - (v_days - 1);

  with vehicles as (
    select v.*
    from public.parked_vehicles v
    where v.service_date between v_from and v_to
      and (v_scope is null or v.property_id = v_scope)
  ),
  -- Tasks are reached THROUGH the vehicle, so they inherit its service_date
  -- and land on the shift that handled the car. See the header.
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
  -- Bucket ONCE, then join the 24 slots onto the result. The obvious version
  -- — generate_series(0,23) cross joined to every vehicle with a FILTER —
  -- reads each row 24 times, so a busy quarter turns 30k rows into 720k.
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

revoke all    on function public.analytics_summary(uuid, int) from public, anon;
grant execute on function public.analytics_summary(uuid, int) to authenticated;


-- ═══════════════════════════════════════════════════════════════════════
-- 3. analytics_by_property — the group comparison
--
-- system_admin only. A valet_admin comparing their site against the other
-- three is not something anyone has asked for, and it would leak another
-- property's volume through a screen that is supposed to be scoped.
-- ═══════════════════════════════════════════════════════════════════════

-- CREATE OR REPLACE cannot change a function's RETURN TYPE, and a
-- RETURNS TABLE list IS the return type — so adding or removing a column
-- later fails with 42P13 unless the old row type is gone first. Dropping
-- here keeps this migration re-runnable in any order.
drop function if exists public.analytics_by_property(int);

create or replace function public.analytics_by_property(p_days int default 30)
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
  v_days int  := least(greatest(coalesce(p_days, 30), 1), 365);
  v_to   date := public.ist_today();
  v_from date;
begin
  if not public.is_system_admin() then
    raise exception 'FORBIDDEN: only a system admin can compare properties';
  end if;

  v_from := v_to - (v_days - 1);

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
  -- EVERY column is cast to its declared type on purpose.
  --
  -- RETURN QUERY matches the query's types against the RETURNS TABLE list
  -- EXACTLY — it does not apply the assignment casts a plain INSERT would.
  -- percentile_cont() returns double precision, so a column declared numeric
  -- fails the whole function with
  --   42804 structure of query does not match function result type
  -- and PostgREST surfaces that as a 400 with no hint about which column.
  -- The casts make the contract explicit instead of implied.
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

revoke all    on function public.analytics_by_property(int) from public, anon;
grant execute on function public.analytics_by_property(int) to authenticated;


-- ═══════════════════════════════════════════════════════════════════════
-- 4. INDEX — the shape every query above scans on
-- ═══════════════════════════════════════════════════════════════════════

create index if not exists parked_vehicles_service_date_idx
  on public.parked_vehicles(service_date, property_id);

create index if not exists valet_tasks_vehicle_idx
  on public.valet_tasks(vehicle_id);

commit;


-- ═══════════════════════════════════════════════════════════════════════
-- VERIFY — every row should say PASS.
--
-- Note what is NOT checked here: the functions are not CALLED. auth.uid() is
-- NULL in the SQL Editor, so analytics_scope() would raise FORBIDDEN and the
-- whole block would abort with an error instead of printing a FAIL row —
-- which reads as "the migration broke" rather than "this check cannot run
-- from here". Behaviour is verified from the app, signed in.
-- ═══════════════════════════════════════════════════════════════════════

with checks as (
  select 'analytics_summary exists' as item,
         to_regprocedure('public.analytics_summary(uuid,int)') is not null as ok
  union all select 'analytics_by_property exists',
         to_regprocedure('public.analytics_by_property(int)') is not null
  union all select 'analytics_scope exists',
         to_regprocedure('public.analytics_scope(uuid)') is not null
  union all select 'summary is callable by authenticated',
         has_function_privilege('authenticated', 'public.analytics_summary(uuid,int)', 'execute')
  union all select 'by_property is callable by authenticated',
         has_function_privilege('authenticated', 'public.analytics_by_property(int)', 'execute')
  union all select 'anon can call neither',
         not has_function_privilege('anon', 'public.analytics_summary(uuid,int)', 'execute')
     and not has_function_privilege('anon', 'public.analytics_by_property(int)', 'execute')
  union all select 'service_date index exists',
         exists (select 1 from pg_indexes where schemaname = 'public'
                 and indexname = 'parked_vehicles_service_date_idx')
  union all select 'task-by-vehicle index exists',
         exists (select 1 from pg_indexes where schemaname = 'public'
                 and indexname = 'valet_tasks_vehicle_idx')
)
select item, case when ok then 'PASS' else 'FAIL' end as result
from checks
order by result desc, item;
