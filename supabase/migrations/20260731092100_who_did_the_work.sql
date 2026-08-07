-- ═══════════════════════════════════════════════════════════════════════
-- 0021 — WHO PARKED IT, WHO FETCHED IT
--
--   >>> RUN THIS IN THE SUPABASE SQL EDITOR, AFTER 0017 AND 0018. <<<
--
-- Safe to run more than once. Creates no tables and adds no columns; if the
-- editor warns about RLS, choose "Run without RLS".
--
--
-- ══ NO parked_by COLUMN, AND THAT IS THE POINT ══
--
-- The obvious move is to add parked_vehicles.parked_by and fill it in at
-- check-in. It is not done, for the same reason there is no cars_parked counter
-- on parking_spaces (migration 0020): the fact is ALREADY RECORDED, and a
-- second copy of a fact is a second thing that can be wrong.
--
-- valet_tasks already holds it. A parking task is created by CheckIn assigned to
-- the operator who took the keys, and nothing ever reassigns a parking task —
-- so its assigned_operator_id IS the record of who parked that car. A retrieval
-- task holds who fetched it, and that one CAN be reassigned, which is exactly
-- why reading it live is right: the column would hold whoever was assigned
-- first, and the join holds whoever actually finished it.
--
-- So this migration adds two derived columns to vehicle_records() and one new
-- function. No new state.
--
--
-- ══ WHY A SEPARATE FUNCTION FOR THE PER-OPERATOR VIEW ══
--
-- "Which operator did more" is not a filter on the records list — it is a
-- different shape of question. Counting it in the browser would mean pulling
-- every task for the period to group by operator, which is the mistake
-- migration 0011 already fixed for the other analytics.
--
-- It counts TASKS COMPLETED, not cars touched. A car assigned and then
-- reassigned would otherwise count for two people, and an operator who was
-- given a car and never finished it would score for it.
-- ═══════════════════════════════════════════════════════════════════════

begin;


-- ═══════════════════════════════════════════════════════════════════════
-- 1. vehicle_records — now says who parked it and who fetched it
--
-- Two more columns on the end, both derived. Everything else is unchanged from
-- 0017 and is repeated only because a plpgsql function is replaced whole.
--
-- ── THE DROP IS REQUIRED, NOT TIDINESS ─────────────────────────────────
--
-- CREATE OR REPLACE cannot change a function's RETURN TYPE, and a RETURNS TABLE
-- list IS the return type. Adding parked_by and fetched_by therefore fails with
--
--   42P13 cannot change return type of existing function
--   DETAIL: Row type defined by OUT parameters is different.
--
-- The argument list is unchanged, so the new definition does not become an
-- overload — it simply cannot be created until the old row type is gone.
--
-- Safe to drop: nothing in the database depends on this function. It is called
-- only over PostgREST from the Records page, and it is recreated three lines
-- later inside the same transaction, so there is no window where a request
-- could miss it.
-- ═══════════════════════════════════════════════════════════════════════

drop function if exists public.vehicle_records(date, date, uuid, text, int, int);

create or replace function public.vehicle_records(
  p_from        date default null,
  p_to          date default null,
  p_property_id uuid default null,
  p_query       text default null,
  p_limit       int  default 100,
  p_offset      int  default 0
)
returns table (
  id               uuid,
  service_date     date,
  property_id      uuid,
  property_name    text,
  token_number     int,
  guest_name       text,
  guest_phone      text,
  car_number       text,
  car_tier         text,
  parking_location text,
  notes            text,
  status           text,
  parked_at        timestamptz,
  delivered_at     timestamptz,
  retrievals       bigint,
  no_shows         bigint,
  parked_by        text,
  fetched_by       text,
  total_rows       bigint
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_role   text;
  v_mine   uuid;
  v_scope  uuid;
  v_to     date := coalesce(p_to, public.ist_today());
  v_from   date;
  v_limit  int  := least(greatest(coalesce(p_limit, 100), 1), 1000);
  v_offset int  := greatest(coalesce(p_offset, 0), 0);
  v_q      text := nullif(btrim(coalesce(p_query, '')), '');
  v_digits text;
  v_car    text;
  v_token  int;
  v_total  bigint;
begin
  select ur.role, ur.property_id into v_role, v_mine
  from public.user_roles ur
  where ur.user_id = auth.uid() and ur.is_active = true;

  if v_role is null then
    raise exception 'FORBIDDEN: you are not signed in as an active user';
  end if;

  if v_role = 'system_admin' then
    v_scope := p_property_id;
  elsif v_role = 'valet_admin' then
    v_scope := v_mine;
  else
    raise exception 'FORBIDDEN: only an admin can see the records';
  end if;

  v_from := coalesce(p_from, v_to - 29);

  if v_from > v_to then
    raise exception 'BAD_RANGE: the start date is after the end date';
  end if;

  v_digits := regexp_replace(coalesce(v_q, ''), '\D', '', 'g');
  v_car    := upper(regexp_replace(coalesce(v_q, ''), '[^A-Za-z0-9]', '', 'g'));
  v_token  := case when v_digits <> '' and length(v_digits) <= 6 then v_digits::int end;

  select count(*) into v_total
  from public.parked_vehicles v
  where v.service_date between v_from and v_to
    and (v_scope is null or v.property_id = v_scope)
    and (
      v_q is null
      or (v_token is not null and v.token_number = v_token)
      or (v_car <> '' and v.car_number like '%' || v_car || '%')
      or v.guest_name ilike '%' || v_q || '%'
      or (length(v_digits) >= 4 and v.guest_phone like '%' || v_digits || '%')
    );

  return query
  select
    v.id,
    v.service_date,
    v.property_id,
    p.name,
    v.token_number,
    v.guest_name,
    v.guest_phone,
    v.car_number,
    v.car_tier,
    v.parking_location,
    v.notes,
    v.status,
    v.parked_at,
    (select max(t.completed_at) from public.valet_tasks t
      where t.vehicle_id = v.id and t.task_type = 'retrieval'
        and t.status = 'completed')::timestamptz,
    (select count(*) from public.valet_tasks t
      where t.vehicle_id = v.id and t.task_type = 'retrieval')::bigint,
    (select coalesce(sum(t.return_count), 0) from public.valet_tasks t
      where t.vehicle_id = v.id)::bigint,
    -- WHO PARKED IT. Read from the parking task, not from a column on this row.
    -- CheckIn assigns that task to whoever took the keys and nothing ever
    -- reassigns it, so this is the record.
    (select ur.name from public.valet_tasks t
       join public.user_roles ur on ur.id = t.assigned_operator_id
      where t.vehicle_id = v.id and t.task_type = 'parking'
      order by t.created_at
      limit 1)::text,
    -- WHO FETCHED IT. The LAST completed retrieval, because a no-show means
    -- there were several and the one that finished is the one that counts. A
    -- stored column would hold whoever was assigned first.
    (select ur.name from public.valet_tasks t
       join public.user_roles ur on ur.id = t.assigned_operator_id
      where t.vehicle_id = v.id and t.task_type = 'retrieval'
        and t.status = 'completed'
      order by t.completed_at desc
      limit 1)::text,
    v_total::bigint
  from public.parked_vehicles v
  join public.properties p on p.id = v.property_id
  where v.service_date between v_from and v_to
    and (v_scope is null or v.property_id = v_scope)
    and (
      v_q is null
      or (v_token is not null and v.token_number = v_token)
      or (v_car <> '' and v.car_number like '%' || v_car || '%')
      or v.guest_name ilike '%' || v_q || '%'
      or (length(v_digits) >= 4 and v.guest_phone like '%' || v_digits || '%')
    )
  -- Newest first, token as the tie-break so paging is STABLE. Ordering on
  -- service_date alone lets rows shuffle between pages, which silently
  -- duplicates some and skips others in an export.
  order by v.service_date desc, v.token_number desc
  limit v_limit offset v_offset;
end $fn$;

revoke all    on function public.vehicle_records(date, date, uuid, text, int, int)
  from public, anon;
grant execute on function public.vehicle_records(date, date, uuid, text, int, int)
  to authenticated;


-- ═══════════════════════════════════════════════════════════════════════
-- 2. analytics_by_operator — who did how much
--
-- Counts COMPLETED tasks. Two reasons that matters:
--   - a retrieval that was reassigned would otherwise count for two people
--   - an operator handed a car who never finished it would score for it
--
-- Inactive staff are still listed if they did work in the period. Somebody who
-- left last week still parked two hundred cars, and dropping them would make
-- last month's totals stop adding up.
-- ═══════════════════════════════════════════════════════════════════════

-- CREATE OR REPLACE cannot change a function's RETURN TYPE, and a
-- RETURNS TABLE list IS the return type — so adding or removing a column
-- later fails with 42P13 unless the old row type is gone first. Dropping
-- here keeps this migration re-runnable in any order.
drop function if exists public.analytics_by_operator(date, date, uuid);

create or replace function public.analytics_by_operator(
  p_from        date default null,
  p_to          date default null,
  p_property_id uuid default null
)
returns table (
  operator_id     uuid,
  operator_name   text,
  is_active       boolean,
  parked          bigint,
  fetched         bigint,
  no_shows        bigint,
  retrieval_wait  numeric,
  total_tasks     bigint
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_scope uuid;
  v_to    date := coalesce(p_to, public.ist_today());
  v_from  date := coalesce(p_from, coalesce(p_to, public.ist_today()) - 29);
begin
  -- Same scoping as every other analytics read: a system_admin may ask about
  -- one property or all, a valet_admin is pinned to their own, an operator is
  -- refused. See analytics_scope() in migration 0011.
  v_scope := public.analytics_scope(p_property_id);

  if v_from > v_to then
    raise exception 'BAD_RANGE: the start date is after the end date';
  end if;

  if v_to - v_from > 730 then
    v_from := v_to - 730;
  end if;

  return query
  with vehicles as (
    select v.id, v.property_id
    from public.parked_vehicles v
    where v.service_date between v_from and v_to
      and (v_scope is null or v.property_id = v_scope)
  ),
  -- Reached THROUGH the vehicle so a task lands on the shift that handled the
  -- car: one checked in at 23:40 Friday and collected 00:20 Saturday is Friday's.
  done as (
    select t.assigned_operator_id as op,
           t.task_type,
           t.return_count,
           t.created_at,
           t.completed_at
    from public.valet_tasks t
    join vehicles v on v.id = t.vehicle_id
    where t.assigned_operator_id is not null
      and t.status = 'completed'
  )
  select
    ur.id::uuid,
    ur.name::text,
    ur.is_active::boolean,
    (select count(*) from done d where d.op = ur.id and d.task_type = 'parking')::bigint,
    (select count(*) from done d where d.op = ur.id and d.task_type = 'retrieval')::bigint,
    (select coalesce(sum(d.return_count), 0) from done d where d.op = ur.id)::bigint,
    -- Cast explicitly: percentile_cont returns double precision, and RETURN
    -- QUERY matches the declared numeric EXACTLY rather than applying the
    -- assignment cast an INSERT would. Without it the whole function fails with
    -- 42804 and PostgREST reports a bare 400 naming no column.
    (select percentile_cont(0.5) within group (
       order by extract(epoch from (d.completed_at - d.created_at)) / 60.0)
     from done d
     where d.op = ur.id and d.task_type = 'retrieval'
       and d.completed_at >= d.created_at)::numeric,
    (select count(*) from done d where d.op = ur.id)::bigint
  from public.user_roles ur
  where ur.role = 'operator'
    and (v_scope is null or ur.property_id = v_scope)
    -- Anyone who did nothing in the period is dropped, so a list of forty staff
    -- does not bury the eight who worked the shift.
    and exists (select 1 from done d where d.op = ur.id)
  order by (select count(*) from done d where d.op = ur.id) desc, ur.name;
end $fn$;

revoke all    on function public.analytics_by_operator(date, date, uuid) from public, anon;
grant execute on function public.analytics_by_operator(date, date, uuid) to authenticated;

commit;


-- ═══════════════════════════════════════════════════════════════════════
-- VERIFY — every row should say PASS.
--
-- Neither function is CALLED here: auth.uid() is NULL in the SQL Editor, so
-- both would raise FORBIDDEN and abort the block instead of printing a FAIL.
-- ═══════════════════════════════════════════════════════════════════════

with checks as (
  select 'analytics_by_operator exists' as item,
         to_regprocedure('public.analytics_by_operator(date,date,uuid)') is not null as ok
  union all select 'callable by authenticated',
         has_function_privilege('authenticated',
           'public.analytics_by_operator(date,date,uuid)', 'execute')
  union all select 'NOT callable by anon',
         not has_function_privilege('anon',
           'public.analytics_by_operator(date,date,uuid)', 'execute')
  union all select 'it counts only COMPLETED tasks',
         (select prosrc like '%t.status = ''completed''%'
          from pg_proc
          where oid = 'public.analytics_by_operator(date,date,uuid)'::regprocedure)
  union all select 'vehicle_records reports who parked it',
         (select prosrc like '%task_type = ''parking''%'
          from pg_proc
          where oid = 'public.vehicle_records(date,date,uuid,text,int,int)'::regprocedure)
  union all select 'vehicle_records reports who fetched it',
         (select prosrc like '%order by t.completed_at desc%'
          from pg_proc
          where oid = 'public.vehicle_records(date,date,uuid,text,int,int)'::regprocedure)
  -- The invariant this migration is built on: the fact lives in ONE place.
  union all select 'no parked_by column was added to parked_vehicles',
         not exists (select 1 from information_schema.columns
                     where table_schema = 'public' and table_name = 'parked_vehicles'
                       and column_name in ('parked_by', 'fetched_by', 'operator_id'))
)
select item, case when ok then 'PASS' else 'FAIL' end as result
from checks
order by result desc, item;


-- Who worked the last 30 days. Run signed in as an admin:
--
-- select operator_name, parked, fetched, total_tasks, retrieval_wait
-- from public.analytics_by_operator()
-- order by total_tasks desc;
