-- ═══════════════════════════════════════════════════════════════════════
-- MIGRATION 0040 — the guest's rating, on the Records screen
--
-- Reviews arrive from WhatsApp when a guest taps Excellent / Good / Poor on the
-- "handed over" message. Until now there was nowhere for a system admin to read
-- them: admin/Reviews exists but is scoped to one property and was taken off
-- the nav, and nothing showed a rating beside the visit it belongs to.
--
-- ── WHY HERE AND NOT A REVIEWS SCREEN ─────────────────────────────────
-- Records already answers "which car, whose, and WHO FETCHED IT" — one row per
-- visit, with fetched_by on it. A rating is the missing column in that same
-- row, not a separate report. Adding it here means "how did operator X score"
-- is answered by sorting a table nobody had to build.
--
-- It also sidesteps a real bug rather than needing it fixed first:
-- reviews.operator_id exists and guest_record_review never populates it, so any
-- per-operator report built on that column reads empty. Reached through the
-- task, as below, the operator comes from the task itself and is already right.
--
-- ── WHY THE FUNCTION IS DROPPED AND NOT REPLACED ──────────────────────
-- A new column changes the RETURNS TABLE row type, and Postgres refuses that
-- with 42P13 ("cannot change return type of existing function") on a plain
-- CREATE OR REPLACE. It has to go and come back.
--
-- Everything except the two rating lines is migration 0037's text unchanged.
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
  parked_at        timestamptz,
  delivered_at     timestamptz,
  retrievals       bigint,
  no_shows         bigint,
  parked_by        text,
  parked_by_hi     text,
  fetched_by       text,
  fetched_by_hi    text,
  rating           text,
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
  select 'vehicle_records exists with its 6 args' as check_name,
         to_regprocedure('public.vehicle_records(date,date,uuid,text,int,int)')
           is not null as ok

  -- 22 now, not 21. A miscount here means a column was lost in the rewrite,
  -- and losing one silently shifts every column after it in the export.
  union all select 'it returns 22 columns',
         (select count(*) = 22 from unnest(
            (select proallargtypes from pg_proc
              where pronamespace = 'public'::regnamespace
                and proname = 'vehicle_records')) with ordinality o(t, n)
           where n > 6)

  union all select 'the rating column is populated from reviews',
         (select prosrc like '%public.reviews%' from pg_proc
           where pronamespace = 'public'::regnamespace
             and proname = 'vehicle_records')

  -- The three things the rewrite must not have dropped.
  union all select 'the service_role branch survived',
         (select prosrc like '%is_service_call%' from pg_proc
           where pronamespace = 'public'::regnamespace
             and proname = 'vehicle_records')

  union all select 'a valet_admin is still scoped to their property',
         (select prosrc like '%valet_admin%' from pg_proc
           where pronamespace = 'public'::regnamespace
             and proname = 'vehicle_records')

  union all select 'an operator is still refused',
         (select prosrc like '%only an admin can see the records%' from pg_proc
           where pronamespace = 'public'::regnamespace
             and proname = 'vehicle_records')

  union all select 'paging is still ordered stably',
         (select prosrc like '%order by v.service_date desc, v.token_number desc%'
            from pg_proc
           where pronamespace = 'public'::regnamespace
             and proname = 'vehicle_records')

  union all select 'both roles may still run it',
         has_function_privilege('authenticated',
           'public.vehicle_records(date,date,uuid,text,int,int)', 'execute')
         and has_function_privilege('service_role',
           'public.vehicle_records(date,date,uuid,text,int,int)', 'execute')

  union all select 'anon still may NOT run it',
         not has_function_privilege('anon',
           'public.vehicle_records(date,date,uuid,text,int,int)', 'execute')
) t
order by ok, check_name;
