-- ═══════════════════════════════════════════════════════════════════════
-- 0012 — SCALE HARDENING
--
--   >>> RUN THIS IN THE SUPABASE SQL EDITOR. <<<
--
-- Safe to run more than once. Creates no tables; if the editor warns about
-- RLS, choose "Run without RLS".
--
--
-- WHAT THIS IS FOR
--
-- The token range is now 1000 a day per property and there are four
-- properties, so a busy event day is up to 4000 cars. Each car produces about
-- six row changes over its life — check-in, parked, requested, assigned, at
-- pickup, delivered — so the system has to absorb roughly 24,000 writes a
-- day, bunched into the dinner peak rather than spread evenly.
--
-- Nothing here changes behaviour. It removes four things that are invisible
-- at ten cars a day and become the whole problem at a thousand.
--
--
-- 1. THE EVERY-MINUTE CRON HAD NO INDEX
--
-- expire_stale_pickups() runs every minute, forever, and filters on
-- `status = 'at_pickup' and completed_at is null and pickup_started_at < …`.
-- No existing index starts with status: idx_tasks_property_status leads with
-- property_id, which that query does not mention at all.
--
-- So it was a sequential scan of valet_tasks, once a minute. At 10,000 rows
-- nobody notices. After a year of events valet_tasks holds millions, and this
-- becomes a full table scan 1440 times a day for the sake of the handful of
-- rows that are ever in 'at_pickup' at once. A partial index makes the cost
-- proportional to cars actually being handed over — usually nil.
--
--
-- 2. THE ADMIN QUEUE'S "IN PROGRESS" LIST HAD NO INDEX EITHER
--
-- Dashboard asks for property + status in (five active values). The existing
-- partial index is keyed on assigned_operator_id, which serves
-- get_available_operators() but not this. Also a partial index, because open
-- tasks are a tiny and roughly constant slice of a table that only grows.
--
--
-- 3. THE PROPERTIES SCREEN COUNTED ROWS IN THE BROWSER
--
-- It fetched every one of today's vehicles across ALL properties and counted
-- them in a loop. At 4000 cars that is 4000 rows over the wire to produce
-- four integers. property_overview() returns the four integers.
--
--
-- 4. TODAY'S CARS FETCHED THE WHOLE DAY, THEN SEARCHED IN JAVASCRIPT
--
-- Fine at 40 cars. At 1000 it is ~200kB to a phone on hotel wifi, and it
-- happens again on every realtime refetch. search_todays_cars() moves the
-- lookup to the database so the phone holds a page, not a day.
--
-- It is an RPC and not a PostgREST .or() filter on purpose: building an
-- or=(…) string from a text box in JavaScript means escaping commas, dots
-- and parentheses correctly forever. A parameter in a plpgsql query needs no
-- escaping because it is never text-substituted into SQL at all.
--
--
-- 5. wa_outbox GREW WITHOUT LIMIT
--
-- Every message ever sent stays. The queued lookup is a partial index so it
-- stays fast, but the table itself, its bloat and every backup grow forever
-- for data nobody reads after the day it was sent.
-- ═══════════════════════════════════════════════════════════════════════

begin;


-- ═══════════════════════════════════════════════════════════════════════
-- 1. INDEXES
--
-- Both are PARTIAL. An index over all of valet_tasks would grow with history
-- and be mostly completed rows, which no hot query ever wants — and every
-- extra byte of index is also a write cost on the porch, where latency is
-- felt. These stay roughly constant in size no matter how long the system
-- runs, because they only cover work that is currently open.
-- ═══════════════════════════════════════════════════════════════════════

create index if not exists valet_tasks_stale_pickup_idx
  on public.valet_tasks(pickup_started_at)
  where status = 'at_pickup' and completed_at is null;

create index if not exists valet_tasks_property_open_idx
  on public.valet_tasks(property_id, assigned_at)
  where status in ('assigned', 'in_progress', 'at_pickup', 're_parking', 'returned');


-- ═══════════════════════════════════════════════════════════════════════
-- 2. property_overview — the system admin's Properties screen
--
-- system_admin only: it deliberately crosses every property boundary, which
-- is exactly what no other read in this system is allowed to do.
-- ═══════════════════════════════════════════════════════════════════════

-- CREATE OR REPLACE cannot change a function's RETURN TYPE, and a
-- RETURNS TABLE list IS the return type — so adding or removing a column
-- later fails with 42P13 unless the old row type is gone first. Dropping
-- here keeps this migration re-runnable in any order.
drop function if exists public.property_overview();

create or replace function public.property_overview()
returns table (
  property_id uuid,
  cars_today  bigint,
  operators   bigint,
  admins      bigint
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $fn$
begin
  if not public.is_system_admin() then
    raise exception 'FORBIDDEN: only a system admin can see every property';
  end if;

  return query
  select
    p.id::uuid,
    (select count(*) from public.parked_vehicles v
      where v.property_id = p.id and v.service_date = public.ist_today())::bigint,
    (select count(*) from public.user_roles ur
      where ur.property_id = p.id and ur.role = 'operator' and ur.is_active = true)::bigint,
    (select count(*) from public.user_roles ur
      where ur.property_id = p.id and ur.role = 'valet_admin' and ur.is_active = true)::bigint
  from public.properties p;
end $fn$;

revoke all    on function public.property_overview() from public, anon;
grant execute on function public.property_overview() to authenticated;


-- ═══════════════════════════════════════════════════════════════════════
-- 3. search_todays_cars — one page of today's cars, or a search across it
--
-- p_query null  -> the most recent p_limit cars, newest token first
-- p_query set   -> matches on token, car number, guest name or guest phone
--
-- Scoped to the caller's own property. A system_admin has no property, so
-- they get nothing rather than everything: this feeds an operator screen,
-- and "every car at every site" is not a page anyone asked for.
-- ═══════════════════════════════════════════════════════════════════════

-- CREATE OR REPLACE cannot change a function's RETURN TYPE, and a
-- RETURNS TABLE list IS the return type — so adding or removing a column
-- later fails with 42P13 unless the old row type is gone first. Dropping
-- here keeps this migration re-runnable in any order.
drop function if exists public.search_todays_cars(text, int);

create or replace function public.search_todays_cars(
  p_query text default null,
  p_limit int  default 200
)
returns table (
  id               uuid,
  token_number     int,
  car_number       text,
  car_tier         text,
  guest_name       text,
  guest_phone      text,
  parking_location text,
  notes            text,
  status           text,
  parked_at        timestamptz,
  total_today      bigint
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_prop   uuid := public.my_property_id();
  v_limit  int  := least(greatest(coalesce(p_limit, 200), 1), 500);
  v_q      text := nullif(btrim(coalesce(p_query, '')), '');
  v_digits text;
  v_car    text;
  v_token  int;
  v_total  bigint;
begin
  if v_prop is null then
    raise exception 'PROPERTY_REQUIRED: no property is linked to your account';
  end if;

  v_digits := regexp_replace(coalesce(v_q, ''), '\D', '', 'g');

  -- Car numbers are stored without separators, so the term is stripped the
  -- same way or "DL8C AF" would never match "DL8CAF1234".
  v_car := upper(regexp_replace(coalesce(v_q, ''), '[^A-Za-z0-9]', '', 'g'));

  -- Only treat it as a token if it could actually BE one. Without the length
  -- guard, pasting a 20-digit string would overflow the int cast and turn a
  -- harmless typo into an error.
  v_token := case
    when v_digits <> '' and length(v_digits) <= 6 then v_digits::int
    else null
  end;

  -- The count is the same for every row and is returned on each one so the
  -- page can say "showing 200 of 964" without a second round trip.
  select count(*) into v_total
  from public.parked_vehicles v
  where v.property_id = v_prop and v.service_date = public.ist_today();

  return query
  select v.id, v.token_number, v.car_number, v.car_tier, v.guest_name,
         v.guest_phone, v.parking_location, v.notes, v.status, v.parked_at,
         v_total
  from public.parked_vehicles v
  where v.property_id  = v_prop
    and v.service_date = public.ist_today()
    and (
      v_q is null
      or (v_token is not null and v.token_number = v_token)
      -- `like`, not `ilike`: car_number is stored already uppercased and
      -- v_car is uppercased above, so a case-insensitive scan would only cost
      -- more for a comparison that cannot differ.
      or (v_car <> '' and v.car_number like '%' || v_car || '%')
      or v.guest_name ilike '%' || v_q || '%'
      or (length(v_digits) >= 4 and v.guest_phone like '%' || v_digits || '%')
    )
  order by v.token_number desc
  limit v_limit;
end $fn$;

revoke all    on function public.search_todays_cars(text, int) from public, anon;
grant execute on function public.search_todays_cars(text, int) to authenticated;


-- ═══════════════════════════════════════════════════════════════════════
-- 4. prune_wa_outbox — retention for the message log
--
-- Only rows that have reached a terminal state, and only past the cutoff. A
-- queued or retrying message is never touched however old it looks: age is
-- not proof it was handled, and deleting one would silently lose a guest's
-- notification.
-- ═══════════════════════════════════════════════════════════════════════

create or replace function public.prune_wa_outbox(p_keep_days int default 30)
returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_days    int := greatest(coalesce(p_keep_days, 30), 7);
  v_deleted int;
begin
  delete from public.wa_outbox
   where status in ('sent', 'failed')
     and created_at < now() - make_interval(days => v_days);

  get diagnostics v_deleted = row_count;
  return v_deleted;
end $fn$;

revoke execute on function public.prune_wa_outbox(int) from public, anon, authenticated;

commit;


-- ═══════════════════════════════════════════════════════════════════════
-- 5. SCHEDULE THE PRUNE
--
-- Weekly, not nightly: it is housekeeping, and a delete that touches a lot of
-- rows is exactly what should not run during a dinner service. 20:00 UTC on
-- Sunday is 01:30 IST Monday — the quietest hour of the quietest night.
-- ═══════════════════════════════════════════════════════════════════════

do $$
begin
  if not exists (select 1 from pg_extension where extname = 'pg_cron') then
    raise notice 'pg_cron is NOT enabled — wa_outbox will grow without limit.';
    raise notice 'Enable it: Dashboard -> Database -> Extensions -> pg_cron,';
    raise notice 'then re-run this migration.';
    return;
  end if;

  -- Idempotent: unschedule first, or re-running stacks duplicate jobs.
  perform cron.unschedule(j.jobname)
  from cron.job j
  where j.jobname = 'prune-wa-outbox';

  perform cron.schedule(
    'prune-wa-outbox',
    '0 20 * * 0',
    $cron$ select public.prune_wa_outbox(30); $cron$
  );

  raise notice 'cron job scheduled: prune-wa-outbox (weekly)';
end $$;


-- ═══════════════════════════════════════════════════════════════════════
-- VERIFY — every row should say PASS.
-- ═══════════════════════════════════════════════════════════════════════

with checks as (
  select 'stale-pickup index exists (the every-minute cron)' as item,
         exists (select 1 from pg_indexes where schemaname = 'public'
                 and indexname = 'valet_tasks_stale_pickup_idx') as ok
  union all select 'property-open-tasks index exists',
         exists (select 1 from pg_indexes where schemaname = 'public'
                 and indexname = 'valet_tasks_property_open_idx')
  union all select 'property_overview exists',
         to_regprocedure('public.property_overview()') is not null
  union all select 'search_todays_cars exists',
         to_regprocedure('public.search_todays_cars(text,int)') is not null
  union all select 'prune_wa_outbox exists',
         to_regprocedure('public.prune_wa_outbox(int)') is not null
  union all select 'prune_wa_outbox NOT callable by authenticated',
         not has_function_privilege('authenticated', 'public.prune_wa_outbox(int)', 'execute')
  union all select 'search_todays_cars IS callable by authenticated',
         has_function_privilege('authenticated', 'public.search_todays_cars(text,int)', 'execute')
  union all select 'weekly prune is scheduled',
         not exists (select 1 from pg_extension where extname = 'pg_cron')
      or exists (select 1 from cron.job where jobname = 'prune-wa-outbox')
)
select item, case when ok then 'PASS' else 'FAIL' end as result
from checks
order by result desc, item;


-- The every-minute cron, proven to use its new index. Expect
-- "Index Scan using valet_tasks_stale_pickup_idx", not "Seq Scan":
--
-- explain analyze
-- select id from public.valet_tasks
--  where status = 'at_pickup' and completed_at is null
--    and pickup_started_at < now() - interval '10 minutes';
