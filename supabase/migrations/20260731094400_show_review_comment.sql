-- ═══════════════════════════════════════════════════════════════════════
-- MIGRATION 0044 — show what the guest actually WROTE
--
-- Migration 0041 gave a guest who rates Poor a way to say why, and stored it in
-- reviews.comment. Migrations 0040 and 0042 then put the RATING on the Records
-- table and the Car Status card — and left the comment behind.
--
-- So the answer to "why did they rate us Poor" was being collected, saved, and
-- shown to nobody. It existed only to a person willing to write SQL. That is
-- worse than not collecting it: the guest was asked to take the trouble, and
-- their answer went into a hole.
--
-- ── WHY THE COLUMN IS CALLED review_comment ───────────────────────────
-- Not `comment`. COMMENT is a Postgres statement (COMMENT ON COLUMN …), and a
-- returned column named that has to be quoted at every single use, forever, by
-- everyone. The table column stays `comment` because it is already there and
-- qualified as r.comment; only what these functions RETURN is renamed.
--
-- ── WHY IT IS NULL ON ALMOST EVERY ROW ────────────────────────────────
-- It is only ever set for a 'poor' rating — guest_add_comment refuses to attach
-- text to anything else. So most rows have a rating and no comment, and most
-- have neither. The UI shows it only when it is there.
--
-- Both functions are 0040's and 0042's text with two lines added each: the
-- returned column, and the subquery that fills it.
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


drop function if exists public.search_todays_cars(text, int);

create function public.search_todays_cars(
  p_query text default null,
  p_limit int  default 200
)
returns table (
  id               uuid,
  token_number     int,
  car_number       text,
  car_tier         text,
  guest_name       text,
  guest_name_hi    text,
  guest_phone      text,
  parking_location text,
  notes            text,
  status           text,
  parked_at        timestamptz,
  rating           text,
  review_comment   text,
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
         v.guest_name_hi, v.guest_phone, v.parking_location, v.notes, v.status,
         v.parked_at,
         -- The guest's rating for this visit, if they gave one. Reached through
         -- the TASK because reviews.task_id is what the button tap records —
         -- a review carries no vehicle_id. A no-show leaves several retrieval
         -- tasks and at most one is rated, so this looks across all of them.
         (select r.rating from public.reviews r
            join public.valet_tasks rt on rt.id = r.task_id
           where rt.vehicle_id = v.id
           order by r.created_at desc
           limit 1)::text,
         -- What the guest typed after rating Poor. See vehicle_records for why
         -- it is review_comment and not comment.
         (select r.comment from public.reviews r
            join public.valet_tasks rt on rt.id = r.task_id
           where rt.vehicle_id = v.id
           order by r.created_at desc
           limit 1)::text,
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
      -- The HINDI name is searchable too. An operator reading a Hindi screen
      -- will type what they see; without this, searching the name they were just
      -- shown would find nothing.
      or (v.guest_name_hi is not null and v.guest_name_hi ilike '%' || v_q || '%')
      or (length(v_digits) >= 4 and v.guest_phone like '%' || v_digits || '%')
    )
  order by v.token_number desc
  limit v_limit;
end $fn$;

revoke all    on function public.search_todays_cars(text, int) from public, anon;
grant execute on function public.search_todays_cars(text, int) to authenticated;

commit;


-- ═══════════════════════════════════════════════════════════════════════
-- VERIFY — every row must read PASS
-- ═══════════════════════════════════════════════════════════════════════
select check_name, case when ok then 'PASS' else 'FAIL' end as result
from (
  -- 23 now: 21 original + rating + review_comment.
  select 'vehicle_records returns 23 columns' as check_name,
         (select count(*) = 23 from unnest(
            (select proallargtypes from pg_proc
              where pronamespace = 'public'::regnamespace
                and proname = 'vehicle_records')) with ordinality o(t, n)
           where n > 6) as ok

  -- 14 now: 12 original + rating + review_comment.
  union all select 'search_todays_cars returns 14 columns',
         (select count(*) = 14 from unnest(
            (select proallargtypes from pg_proc
              where pronamespace = 'public'::regnamespace
                and proname = 'search_todays_cars')) with ordinality o(t, n)
           where n > 2)

  union all select 'vehicle_records reads reviews.comment',
         (select prosrc like '%r.comment%' from pg_proc
           where pronamespace = 'public'::regnamespace
             and proname = 'vehicle_records')

  union all select 'search_todays_cars reads reviews.comment',
         (select prosrc like '%r.comment%' from pg_proc
           where pronamespace = 'public'::regnamespace
             and proname = 'search_todays_cars')

  -- Both still return the rating. Adding one column by losing another would
  -- pass a column count and break every card and row.
  union all select 'both still return the rating',
         (select count(*) = 2 from pg_proc
           where pronamespace = 'public'::regnamespace
             and proname in ('vehicle_records', 'search_todays_cars')
             and prosrc like '%r.rating%')

  -- The scoping that must survive a rewrite. Losing either would show one
  -- property's cars to another property's admin.
  union all select 'vehicle_records still scopes by role',
         (select prosrc like '%valet_admin%' and prosrc like '%is_service_call%'
            from pg_proc
           where pronamespace = 'public'::regnamespace
             and proname = 'vehicle_records')

  union all select 'search_todays_cars still scopes to property and today',
         (select prosrc like '%v.property_id%' and prosrc like '%ist_today()%'
            from pg_proc
           where pronamespace = 'public'::regnamespace
             and proname = 'search_todays_cars')

  union all select 'stable paging survived',
         (select prosrc like '%order by v.service_date desc, v.token_number desc%'
            from pg_proc
           where pronamespace = 'public'::regnamespace
             and proname = 'vehicle_records')

  union all select 'grants are as they were',
         has_function_privilege('authenticated',
           'public.vehicle_records(date,date,uuid,text,int,int)', 'execute')
         and has_function_privilege('service_role',
           'public.vehicle_records(date,date,uuid,text,int,int)', 'execute')
         and has_function_privilege('authenticated',
           'public.search_todays_cars(text,int)', 'execute')

  union all select 'anon still shut out of both',
         not has_function_privilege('anon',
           'public.vehicle_records(date,date,uuid,text,int,int)', 'execute')
         and not has_function_privilege('anon',
           'public.search_todays_cars(text,int)', 'execute')
) t
order by ok, check_name;
