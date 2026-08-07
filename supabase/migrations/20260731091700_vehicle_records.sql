-- ═══════════════════════════════════════════════════════════════════════
-- 0017 — THE RECORDS VIEW
--
--   >>> RUN THIS IN THE SUPABASE SQL EDITOR. <<<
--
--   ⚠ MIGRATION 0021 REPLACES vehicle_records() WITH A WIDER VERSION.
--     Run these IN ORDER — 0017 then 0021 — or run 0021 alone. Running 0017
--     AFTER 0021 succeeds and silently DOWNGRADES the function back to this
--     narrower row type, which drops parked_by / fetched_by and leaves the
--     Records page showing empty "Handled by" cells with no error anywhere.
--
-- Safe to run more than once. Creates no tables; if the editor warns about
-- RLS, choose "Run without RLS".
--
--
-- WHAT THIS IS FOR
--
-- Every guest name, number, car, tier and where it was parked is ALREADY
-- stored — parked_vehicles has held all of it since migration 0001. What did
-- not exist was a way for a system admin to look across every property and
-- take the result away as a spreadsheet.
--
-- So this adds no columns and no table. It adds the one query that view needs.
--
--
-- WHY AN RPC AND NOT A FILTERED SELECT FROM THE BROWSER
--
--   1. It spans properties. Every other read in this system is scoped to one
--      site by RLS; this is the one place allowed to cross that line, so the
--      permission check belongs in a single function rather than in a policy
--      that has to stay permissive enough for it.
--
--   2. It has to be PAGED, and the page has to know the total. Four properties
--      at a thousand cars a day is ~120,000 rows a month. A browser cannot
--      hold that, and — worse — a PostgREST row ceiling would return a SHORT
--      LIST WITH NO ERROR, so the page would show a confident, wrong count.
--
--   3. Search across name, number, car and token is one expression here.
--      Built as a PostgREST `or=(…)` string in JavaScript it would mean
--      escaping commas, dots and parentheses out of a text box forever. A
--      plpgsql parameter is never text-substituted into SQL at all.
--
--
-- THE GUEST'S NUMBER IS RETURNED IN FULL, UNLIKE Reviews
--
-- admin/Reviews masks it, because judging service quality needs no way to
-- contact anybody. This screen is the opposite: it is the record of who handed
-- over which car, so the number IS the record. The operator already sees it in
-- full on Today's Cars, so this exposes nothing new — it just makes it
-- exportable, which is the request.
-- ═══════════════════════════════════════════════════════════════════════

begin;


-- CREATE OR REPLACE cannot change a function's RETURN TYPE, and a
-- RETURNS TABLE list IS the return type — so adding or removing a column
-- later fails with 42P13 unless the old row type is gone first. Dropping
-- here keeps this migration re-runnable in any order.
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

  -- A system_admin may ask for one property or for all of them (null). A
  -- valet_admin is pinned to their own regardless of what they pass, so there
  -- is no argument that widens their view. An operator gets nothing: this is a
  -- records screen, not part of the porch flow.
  if v_role = 'system_admin' then
    v_scope := p_property_id;
  elsif v_role = 'valet_admin' then
    v_scope := v_mine;
  else
    raise exception 'FORBIDDEN: only an admin can see the records';
  end if;

  -- Default to the last 30 days rather than to everything. An unbounded first
  -- load on a table with months of history is a slow query nobody asked for.
  v_from := coalesce(p_from, v_to - 29);

  if v_from > v_to then
    raise exception 'BAD_RANGE: the start date is after the end date';
  end if;

  v_digits := regexp_replace(coalesce(v_q, ''), '\D', '', 'g');
  -- Car numbers are stored without separators, so the term is stripped the same
  -- way or "DL8C AF" would never match "DL8CAF1234".
  v_car    := upper(regexp_replace(coalesce(v_q, ''), '[^A-Za-z0-9]', '', 'g'));
  -- Only treat it as a token if it could be one. Without the length guard a
  -- pasted 20-digit string overflows the int cast and turns a typo into an error.
  v_token  := case when v_digits <> '' and length(v_digits) <= 6 then v_digits::int end;

  -- Counted with the same predicate as the page below, so "showing 100 of 8,412"
  -- can never disagree with the rows on screen.
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
    -- When the guest actually got the car back. Taken from the completed
    -- retrieval task rather than from the vehicle row, which has no such column.
    --
    -- Every computed column is cast explicitly. RETURN QUERY matches the query
    -- against RETURNS TABLE exactly and does NOT apply the assignment casts a
    -- plain INSERT would — a mismatch fails the whole function with
    -- "42804 structure of query does not match function result type", which
    -- PostgREST surfaces as a bare 400 naming no column.
    (select max(t.completed_at) from public.valet_tasks t
      where t.vehicle_id = v.id and t.task_type = 'retrieval'
        and t.status = 'completed')::timestamptz,
    (select count(*) from public.valet_tasks t
      where t.vehicle_id = v.id and t.task_type = 'retrieval')::bigint,
    (select coalesce(sum(t.return_count), 0) from public.valet_tasks t
      where t.vehicle_id = v.id)::bigint,
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
  -- Newest first, and token as the tie-break so paging is STABLE. Ordering on
  -- service_date alone would let rows shuffle between pages, which silently
  -- duplicates some and skips others in an export.
  order by v.service_date desc, v.token_number desc
  limit v_limit offset v_offset;
end $fn$;

revoke all    on function public.vehicle_records(date, date, uuid, text, int, int)
  from public, anon;
grant execute on function public.vehicle_records(date, date, uuid, text, int, int)
  to authenticated;

commit;


-- ═══════════════════════════════════════════════════════════════════════
-- VERIFY — every row should say PASS.
--
-- The function is not CALLED here: auth.uid() is NULL in the SQL Editor, so it
-- would raise FORBIDDEN and abort the whole block instead of printing a FAIL.
-- ═══════════════════════════════════════════════════════════════════════

with checks as (
  select 'vehicle_records exists' as item,
         to_regprocedure('public.vehicle_records(date,date,uuid,text,int,int)') is not null as ok
  union all select 'callable by authenticated',
         has_function_privilege('authenticated',
           'public.vehicle_records(date,date,uuid,text,int,int)', 'execute')
  union all select 'NOT callable by anon',
         not has_function_privilege('anon',
           'public.vehicle_records(date,date,uuid,text,int,int)', 'execute')
  union all select 'operators are refused',
         (select prosrc like '%only an admin can see the records%'
          from pg_proc
          where oid = 'public.vehicle_records(date,date,uuid,text,int,int)'::regprocedure)
  union all select 'paging is ordered on a unique-enough tuple',
         (select prosrc like '%order by v.service_date desc, v.token_number desc%'
          from pg_proc
          where oid = 'public.vehicle_records(date,date,uuid,text,int,int)'::regprocedure)
  union all select 'the service_date index this scans on exists',
         exists (select 1 from pg_indexes where schemaname = 'public'
                 and indexname = 'parked_vehicles_service_date_idx')
)
select item, case when ok then 'PASS' else 'FAIL' end as result
from checks
order by result desc, item;
