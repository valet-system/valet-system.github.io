-- ═══════════════════════════════════════════════════════════════════════
-- 0022 — STAFF NAMES IN HINDI
--
-- Adds user_roles.name_hi and threads it through the two reporting functions
-- that hand a staff name back to the browser.
--
-- ══ WHY A STORED COLUMN AND NOT A TRANSLATION AT READ TIME ══
--
-- A name is DATA. Nothing turns "Rajesh Kumar" into "राजेश कुमार" reliably —
-- and it is TRANSLITERATION that is wanted there, not translation, because
-- translating "Kumar" gives a word meaning "prince". The app must never guess:
-- a valet whose name is rendered wrong on the screen his shift lead reads is
-- worse off than one whose name is in English. So the Hindi spelling is
-- stored, once, and stays editable by the admin who typed it. The browser
-- offers a machine transliteration as a FIRST DRAFT (src/lib/hindiText.js) and
-- whatever is in the box at save time is what gets stored.
--
-- ══ WHY IT IS NULLABLE, AND WHY THAT IS THE WHOLE DESIGN ══
--
-- NULL means "no Hindi spelling yet" and every reader falls back to `name`.
-- That is what makes this safe to run on a live table with staff already in
-- it: nothing to backfill, nothing breaks, and admins fill them in as they go.
-- Do NOT add a NOT NULL or a default.
--
-- ══ WHY admin_create_staff AND admin_update_staff ARE NOT TOUCHED ══
--
-- admin_create_staff is the most fragile function in this project: it writes
-- auth.users through a dynamically built column list, handles two shapes of
-- auth.identities, stores the encrypted PIN and then verifies the account can
-- actually sign in. Adding a parameter would mean DROPping and re-creating all
-- of that — an overload cannot be used, because PostgREST could not tell the
-- two apart — and a transcription slip anywhere in it breaks account creation.
--
-- The Hindi name is an optional label. It does not justify that risk. So it
-- gets its own small function below, with the same permission rules, and the
-- client calls it right after creating or saving. If that second call fails
-- the person still exists, still signs in, and simply has no Hindi spelling
-- yet — which is the same state as every row that existed before today.
--
-- Safe to re-run.
-- ═══════════════════════════════════════════════════════════════════════

begin;

-- ── the column ────────────────────────────────────────────────────────
alter table public.user_roles
  add column if not exists name_hi text;

comment on column public.user_roles.name_hi is
  'Optional Hindi spelling of name. NULL means none yet; every reader falls back to name. Written by an admin — machine transliteration is only the first draft.';

-- Length only. Deliberately NO check that it contains Devanagari: an admin may
-- legitimately want a different Latin spelling here for a name with no natural
-- Devanagari form, and a constraint refusing that would just make them leave
-- the field empty, which helps nobody.
alter table public.user_roles
  drop constraint if exists user_roles_name_hi_len_chk;
alter table public.user_roles
  add constraint user_roles_name_hi_len_chk
  check (name_hi is null or length(btrim(name_hi)) between 1 and 80);


-- ═══════════════════════════════════════════════════════════════════════
-- admin_set_staff_name_hi — the only writer
--
-- Permission rules copied from admin_update_staff, deliberately identical:
--   system_admin  anyone
--   valet_admin   operators at their own property
--   anyone else   refused
--
-- Passing '' or whitespace CLEARS it. There has to be a way back: an admin who
-- accepts a bad machine transliteration must be able to remove it, not only
-- overwrite it with another guess.
-- ═══════════════════════════════════════════════════════════════════════

create or replace function public.admin_set_staff_name_hi(
  p_user_role_id uuid,
  p_name_hi      text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_caller_role     text;
  v_caller_property uuid;
  v_target          record;
  v_value           text;
  v_row             jsonb;
begin
  select ur.role, ur.property_id into v_caller_role, v_caller_property
  from public.user_roles ur
  where ur.user_id = auth.uid() and ur.is_active = true;

  if v_caller_role is null then
    raise exception 'FORBIDDEN: you are not signed in as an active user';
  end if;

  select ur.id, ur.role, ur.property_id into v_target
  from public.user_roles ur where ur.id = p_user_role_id;

  if v_target.id is null then
    raise exception 'NOT_FOUND: that user no longer exists';
  end if;

  if v_caller_role = 'valet_admin' then
    if v_target.role <> 'operator' then
      raise exception 'FORBIDDEN: you can only manage operators';
    end if;
    if v_target.property_id is distinct from v_caller_property then
      raise exception 'FORBIDDEN: that user is not at your property';
    end if;
  elsif v_caller_role <> 'system_admin' then
    raise exception 'FORBIDDEN: you do not have permission to manage users';
  end if;

  -- Blank and whitespace both collapse to NULL, so "no Hindi spelling" has
  -- exactly one representation in the column and the fallback is unambiguous.
  v_value := nullif(btrim(coalesce(p_name_hi, '')), '');

  if v_value is not null and length(v_value) > 80 then
    raise exception 'BAD_NAME: the Hindi name is too long';
  end if;

  update public.user_roles
  set name_hi = v_value
  where id = p_user_role_id
  returning to_jsonb(user_roles.*) into v_row;

  return jsonb_build_object('user', v_row);
end $fn$;

revoke all    on function public.admin_set_staff_name_hi(uuid, text) from public, anon;
grant execute on function public.admin_set_staff_name_hi(uuid, text) to authenticated;


-- ═══════════════════════════════════════════════════════════════════════
-- analytics_by_operator — carries the Hindi name alongside the English one
--
-- Body is migration 0021's, unchanged, with one column added. It returns BOTH
-- names rather than picking: the function has no idea which language the
-- person reading the table chose, and a p_lang argument would put a display
-- concern inside a reporting query. The browser picks — personName() in
-- src/utils/format.
--
-- CREATE OR REPLACE cannot change a RETURNS TABLE list, because that list IS
-- the return type. Adding operator_name_hi without this drop fails with 42P13.
-- ═══════════════════════════════════════════════════════════════════════

drop function if exists public.analytics_by_operator(date, date, uuid);

create function public.analytics_by_operator(
  p_from        date default null,
  p_to          date default null,
  p_property_id uuid default null
)
returns table (
  operator_id      uuid,
  operator_name    text,
  operator_name_hi text,
  is_active        boolean,
  parked           bigint,
  fetched          bigint,
  no_shows         bigint,
  retrieval_wait   numeric,
  total_tasks      bigint
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
    ur.name_hi::text,
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


-- ═══════════════════════════════════════════════════════════════════════
-- vehicle_records — the same, for Records → "Handled by"
--
-- Body is migration 0021's with two columns added. parked_by / fetched_by stay
-- DERIVED from the tasks (0021's header explains why there is no stored
-- column); the Hindi spelling comes off the same joined row, so it can never
-- disagree with the English one printed beside it.
-- ═══════════════════════════════════════════════════════════════════════

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
-- get_available_operators — the Retrieval Queue's "assign to" dropdown
--
-- Body is migration 0008's, unchanged, with name_hi added. Small enough to
-- carry safely; the drop is needed for the same 42P13 reason as above.
--
-- assign_retrieval is deliberately NOT touched, even though its "Sent to X"
-- toast names the operator: the Dashboard already holds this list, so it looks
-- the Hindi spelling up locally by id and falls back to the server's name.
-- Rewriting a large operator-flow function for one toast is not a trade worth
-- making.
-- ═══════════════════════════════════════════════════════════════════════

drop function if exists public.get_available_operators(uuid);

create function public.get_available_operators(p_property_id uuid)
returns table (id uuid, name text, name_hi text, phone text)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $fn$
begin
  if not (public.is_system_admin() or p_property_id = public.my_property_id()) then
    raise exception 'FORBIDDEN_PROPERTY';
  end if;

  return query
    select ur.id, ur.name, ur.name_hi, ur.phone
    from public.user_roles ur
    where ur.property_id = p_property_id
      and ur.role        = 'operator'
      and ur.is_active   = true
      and not exists (
        select 1
        from public.valet_tasks vt
        where vt.assigned_operator_id = ur.id
          and vt.property_id          = p_property_id
          and vt.status in ('assigned', 'in_progress', 'at_pickup', 're_parking', 'returned')
      )
    order by ur.name;
end $fn$;

revoke execute on function public.get_available_operators(uuid) from public, anon;
grant  execute on function public.get_available_operators(uuid) to authenticated;


commit;


-- ═══════════════════════════════════════════════════════════════════════
-- VERIFY — every row must read PASS
--
-- Nothing is CALLED here: auth.uid() is NULL in the SQL Editor, so every one
-- of these functions would raise FORBIDDEN and abort the block instead of
-- printing a FAIL. The catalog is checked instead.
-- ═══════════════════════════════════════════════════════════════════════
select check_name, case when ok then 'PASS' else 'FAIL' end as result
from (
  select 'user_roles.name_hi exists' as check_name,
         exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'user_roles'
                    and column_name = 'name_hi') as ok

  union all select 'name_hi is NULLABLE — existing staff must not need a backfill',
                   (select is_nullable = 'YES' from information_schema.columns
                     where table_schema = 'public' and table_name = 'user_roles'
                       and column_name = 'name_hi')

  union all select 'admin_set_staff_name_hi exists',
                   exists (select 1 from pg_proc
                            where pronamespace = 'public'::regnamespace
                              and proname = 'admin_set_staff_name_hi')

  union all select 'admin_create_staff was NOT modified — still exactly one, still 5 args',
                   (select count(*) = 1 and max(pronargs) = 5 from pg_proc
                     where pronamespace = 'public'::regnamespace
                       and proname = 'admin_create_staff')

  union all select 'admin_update_staff was NOT modified — still exactly one, still 3 args',
                   (select count(*) = 1 and max(pronargs) = 3 from pg_proc
                     where pronamespace = 'public'::regnamespace
                       and proname = 'admin_update_staff')

  union all select 'analytics_by_operator returns operator_name_hi',
                   (select 'operator_name_hi' = any(proargnames) from pg_proc
                     where pronamespace = 'public'::regnamespace
                       and proname = 'analytics_by_operator')

  union all select 'vehicle_records returns parked_by_hi and fetched_by_hi',
                   (select 'parked_by_hi' = any(proargnames)
                       and 'fetched_by_hi' = any(proargnames) from pg_proc
                     where pronamespace = 'public'::regnamespace
                       and proname = 'vehicle_records')

  union all select 'get_available_operators returns name_hi',
                   (select 'name_hi' = any(proargnames) from pg_proc
                     where pronamespace = 'public'::regnamespace
                       and proname = 'get_available_operators')

  union all select 'vehicle_records still returns its original 17 columns plus the 2 new',
                   (select count(*) = 21 from unnest(
                      (select proargnames from pg_proc
                        where pronamespace = 'public'::regnamespace
                          and proname = 'vehicle_records')) x
                     where x not like 'p\_%')
) t
order by check_name;
