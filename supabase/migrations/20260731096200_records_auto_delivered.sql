-- ═══════════════════════════════════════════════════════════════════════
-- MIGRATION 0062 — Records says "auto delivered" when nobody handed it over
--
-- Migration 0061 closes out the night's open cars half an hour before the token
-- reset, and stamps auto_closed_at on each one so the truth stays recoverable.
-- Nothing read that column. This surfaces it.
--
-- ── WHY IT HAS TO BE VISIBLE ──────────────────────────────────────────
-- Without it those cars read as delivered, indistinguishably from cars a guest
-- actually drove away in. The delivered count already includes them — that is
-- the trade 0061 makes deliberately — but a row that says only "delivered"
-- about a car nobody collected is the report lying with a straight face.
--
-- One boolean on the row and the reader can tell. It also makes the numbers
-- auditable: anybody asking "how many of these were real hand-overs" can now
-- answer it.
--
-- ── A BOOLEAN, NOT THE TIMESTAMP ──────────────────────────────────────
-- Every reader of this RPC wants the same thing — was this a real hand-over —
-- and none of them wants the second it happened at. auto_closed_at stays on
-- parked_vehicles for anybody who ever does.
--
-- ── WHY THE FUNCTION IS REPRINTED ─────────────────────────────────────
-- `create or replace` cannot change a RETURNS TABLE row type; Postgres answers
-- 42P13. So the function is dropped and recreated, which is what 0044 also had
-- to do.
--
-- The body below was extracted from 0044 programmatically and had two lines
-- added — a column in the returns table, and its value in the select, in the
-- same position. It was NOT retyped. Reproducing two hundred lines by hand is
-- how a subquery quietly loses a condition, and this file is the reason to say
-- so: if you are here to add a column, do the same.
--
-- Column count: 0044 returned 23. This returns 24.
-- ═══════════════════════════════════════════════════════════════════════

begin;

drop function if exists public.vehicle_records(date, date, uuid, text, int, int);

create function public.vehicle_records(
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
  auto_delivered   boolean,
  parked_at        timestamptz,
  delivered_at     timestamptz,
  retrievals       bigint,
  no_shows         bigint,
  parked_by        text,
  parked_by_hi     text,
  fetched_by       text,
  fetched_by_hi    text,
  rating           text,
  review_comment   text,
  total_count      bigint
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
  -- A trusted server states the property it wants and is taken at its word.
  -- Answered FIRST because a service call has no auth.uid(), so the user_roles
  -- lookup below would refuse it. null keeps its meaning: every property.
  if public.is_service_call() then
    v_scope := p_property_id;
  else
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
    p.name::text,
    v.token_number,
    v.guest_name,
    v.guest_phone,
    v.car_number,
    v.car_tier,
    v.parking_location,
    v.notes,
    v.status,
    -- AUTO-DELIVERED, not handed over. close_open_cars() stamps
    -- auto_closed_at half an hour before the token reset on anything still
    -- open, so the night's cars reach the reports. A boolean rather than the
    -- timestamp: every reader wants "was this a real hand-over", and the exact
    -- second is on parked_vehicles for anybody who needs it.
    (v.auto_closed_at is not null)::boolean,
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
    (select ur.name_hi from public.valet_tasks t
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
    (select ur.name_hi from public.valet_tasks t
       join public.user_roles ur on ur.id = t.assigned_operator_id
      where t.vehicle_id = v.id and t.task_type = 'retrieval'
        and t.status = 'completed'
      order by t.completed_at desc
      limit 1)::text,
    -- THE GUEST'S RATING for this visit, if they gave one.
    --
    -- Reached through the TASK, because reviews.task_id is what the guest's
    -- button tap records — there is no vehicle_id on a review. A car with a
    -- no-show has several retrieval tasks and at most one of them is rated,
    -- so this finds the rating on any of them rather than assuming which.
    --
    -- Newest first and limit 1: the unique index on reviews.task_id already
    -- makes a second rating per task impossible, but the ordering makes the
    -- result deterministic if that ever changes.
    (select r.rating from public.reviews r
       join public.valet_tasks rt on rt.id = r.task_id
      where rt.vehicle_id = v.id
      order by r.created_at desc
      limit 1)::text,
    -- What the guest TYPED after rating Poor. Only ever set for 'poor', so on
    -- every other row this is null — the rating is the summary and this is the
    -- reason, and a reason with no complaint attached would be confusing.
    --
    -- Named review_comment, not comment: `comment` is a Postgres keyword (it is
    -- the COMMENT ON statement) and a column called that has to be quoted
    -- everywhere it appears, forever.
    (select r.comment from public.reviews r
       join public.valet_tasks rt on rt.id = r.task_id
      where rt.vehicle_id = v.id
      order by r.created_at desc
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
grant  execute on function public.vehicle_records(date, date, uuid, text, int, int)
  to authenticated, service_role;

commit;


-- ═══════════════════════════════════════════════════════════════════════
-- VERIFY — every row must read PASS
-- ═══════════════════════════════════════════════════════════════════════
select check_name, case when ok then 'PASS' else 'FAIL' end as result
from (
  select 'the report returns auto_delivered' as check_name,
         (select pg_get_function_result(oid) like '%auto_delivered boolean%'
            from pg_proc
           where pronamespace = 'public'::regnamespace
             and proname = 'vehicle_records') as ok

  -- 23 -> 24. The whole risk of reprinting is losing a column, so the count is
  -- asserted rather than eyeballed.
  union all select 'it returns 24 columns, not 23',
         (select (length(pg_get_function_result(oid))
                  - length(replace(pg_get_function_result(oid), ',', ''))) = 23
            from pg_proc
           where pronamespace = 'public'::regnamespace and proname = 'vehicle_records')

  -- And the ones that carry the report named individually, because a count
  -- alone would pass if one were duplicated and another dropped.
  union all select 'rating survived the reprint',
         (select pg_get_function_result(oid) like '%rating text%' from pg_proc
           where pronamespace = 'public'::regnamespace and proname = 'vehicle_records')

  union all select 'review_comment survived',
         (select pg_get_function_result(oid) like '%review_comment text%' from pg_proc
           where pronamespace = 'public'::regnamespace and proname = 'vehicle_records')

  union all select 'fetched_by survived',
         (select pg_get_function_result(oid) like '%fetched_by text%' from pg_proc
           where pronamespace = 'public'::regnamespace and proname = 'vehicle_records')

  union all select 'parked_by survived',
         (select pg_get_function_result(oid) like '%parked_by text%' from pg_proc
           where pronamespace = 'public'::regnamespace and proname = 'vehicle_records')

  union all select 'total_count survived',
         (select pg_get_function_result(oid) like '%total_count bigint%' from pg_proc
           where pronamespace = 'public'::regnamespace and proname = 'vehicle_records')

  -- It must read the column 0061 stamps, not invent its own rule.
  union all select 'it reads auto_closed_at',
         (select prosrc like '%auto_closed_at is not null%' from pg_proc
           where pronamespace = 'public'::regnamespace and proname = 'vehicle_records')

  union all select '0061 is applied: auto_closed_at exists',
         exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'parked_vehicles'
                    and column_name = 'auto_closed_at')

  -- Grants unchanged: staff read it on Records, and the report API reads it as
  -- service_role. Neither may become anon.
  union all select 'staff may still read records',
         has_function_privilege('authenticated',
           'public.vehicle_records(date,date,uuid,text,int,int)', 'execute')

  union all select 'anon may NOT read records',
         not has_function_privilege('anon',
           'public.vehicle_records(date,date,uuid,text,int,int)', 'execute')
) t
order by ok, check_name;
