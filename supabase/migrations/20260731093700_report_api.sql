-- ═══════════════════════════════════════════════════════════════════════
-- MIGRATION 0037 — let a TRUSTED SERVER read the analytics
--
-- Ambria Admin (the ambria-workforce app) is a SEPARATE Supabase project.
-- Its users' JWTs are signed by a different project, so inside this database
-- auth.uid() is null for them and there is no row in user_roles to find. Every
-- reporting function therefore refuses them:
--
--     analytics_scope()  ->  FORBIDDEN: you are not signed in as an active user
--
-- That is correct for a browser and wrong for a server. This migration adds one
-- branch: a caller holding the service_role key states which property it wants
-- and is taken at its word.
--
-- ── WHY THIS IS NOT A PRIVILEGE ESCALATION ────────────────────────────
-- It grants nothing that was not already granted. service_role bypasses RLS
-- entirely and has `grant all on all tables` (migration 0002), so it can
-- already `select * from parked_vehicles`. The only thing it could not reach
-- was the AGGREGATION — it was being forced to re-implement medians and
-- per-hour buckets outside the database, which is the exact mistake migration
-- 0011 exists to prevent, and which fails silently when a row ceiling is hit.
--
-- So the choice is not "may a server see this data" (it already can). It is
-- "should a server compute it correctly or badly".
--
-- ── WHAT PROTECTS IT INSTEAD ──────────────────────────────────────────
-- The service_role key never reaches a browser. It lives as an Edge Function
-- secret, and the only caller is functions/valet_report, which demands its own
-- REPORT_API_KEY before it will run. Two secrets, both server-side.
--
-- If the service_role key is ever pasted into a VITE_ variable, this branch
-- becomes "anyone may read every property" — but so does every table in the
-- database, with or without this migration. See VALET_REPORT_API.md.
--
-- ── WHY A HELPER AND NOT auth.role() ──────────────────────────────────
-- auth.role() is a Supabase-supplied wrapper that has moved between schemas
-- across platform versions, and these functions run `set search_path = public,
-- pg_temp` — so a bare reference to it is a resolution risk in something that
-- decides access. Reading the claim PostgREST sets is one built-in call and
-- depends on nothing that can be relocated underneath us.
--
-- ── WHY THERE ARE TWO PLACES TO PATCH, NOT ONE ────────────────────────
-- The three analytics reads all call analytics_scope(), so one branch there
-- unlocks all three. The spreadsheet export reads vehicle_records(), which
-- decides scope INLINE instead of calling that helper — so it needs the same
-- branch again, and Postgres cannot edit a function body in place, which is why
-- section 4 re-issues the whole thing.
--
-- Section 4 is the 0022 text with ONLY the auth block changed. That was checked
-- by diffing the two, not by reading them: the diff is confined to those lines
-- and touches nothing in the count, the query, or the ordering.
-- ═══════════════════════════════════════════════════════════════════════

begin;

-- ═══════════════════════════════════════════════════════════════════════
-- 1. is_service_call — "did this arrive with the service_role key?"
--
-- PostgREST puts the verified JWT's claims in request.jwt.claims. The
-- service_role key carries role=service_role and NO sub, which is exactly why
-- auth.uid() is null for it.
--
-- The `true` second argument to current_setting means "return null rather than
-- raise if the setting is missing" — it IS missing in a direct psql session,
-- which must read as false rather than error.
--
-- Deliberately NOT security definer: it reads a session setting and must report
-- on the CALLER, not on the owner.
-- ═══════════════════════════════════════════════════════════════════════

create or replace function public.is_service_call()
returns boolean
language sql
stable
set search_path = public, pg_temp
as $fn$
  select coalesce(
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role',
    ''
  ) = 'service_role'
$fn$;

comment on function public.is_service_call() is
  'True when the caller presented the service_role key (an Edge Function) '
  'rather than a signed-in user. Lets a trusted server pass an explicit '
  'property to the reporting functions.';

revoke all    on function public.is_service_call() from public, anon;
grant execute on function public.is_service_call() to authenticated, service_role;


-- ═══════════════════════════════════════════════════════════════════════
-- 2. analytics_scope — one new branch at the top
--
-- This single function decides scope for analytics_summary,
-- analytics_by_operator AND analytics_by_property, so all three start working
-- for a server here. That is precisely why it was extracted in 0011.
--
-- Everything below the new branch is migration 0011's body, unchanged.
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
  -- A trusted server has no row in user_roles and no auth.uid(), so it has to
  -- be answered BEFORE the lookup rather than by it. null keeps the meaning it
  -- has for a system_admin: every property, combined.
  if public.is_service_call() then
    return p_property_id;
  end if;

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
grant execute on function public.analytics_scope(uuid) to authenticated, service_role;


-- ═══════════════════════════════════════════════════════════════════════
-- 3. The three reads a server may now make.
--
-- Their bodies are untouched — they already call analytics_scope(). All that
-- was missing was permission for the service_role to execute them at all,
-- since 0011 and 0018 granted them to `authenticated` only.
-- ═══════════════════════════════════════════════════════════════════════

grant execute on function public.analytics_summary(uuid, date, date)     to service_role;
grant execute on function public.analytics_by_operator(date, date, uuid) to service_role;
grant execute on function public.analytics_by_property(date, date)       to service_role;

-- The property list, so the calling app can offer a picker without hardcoding
-- four uuids that differ between one project and another.
--
-- Strictly redundant: migration 0002 already did `grant all on all tables in
-- schema public to service_role`. Restated because that blanket grant is the
-- kind of thing that gets narrowed later by someone tightening permissions, and
-- this is a named dependency rather than an incidental beneficiary of it.
grant select on public.properties to service_role;


-- ═══════════════════════════════════════════════════════════════════════
-- 4. vehicle_records — the same branch, for the spreadsheet export
--
-- This one does NOT call analytics_scope(); it decides scope inline. So the
-- branch above does not reach it, and it has to be re-issued in full —
-- Postgres cannot edit a function body in place.
--
-- Everything except the auth block is migration 0022's text unchanged: the
-- count, the search parsing, the who-parked-it and who-fetched-it subqueries,
-- the stable ordering. Verified by diffing the two, not by reading them.
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
  select 'is_service_call exists' as check_name,
         to_regprocedure('public.is_service_call()') is not null as ok

  -- Pinned to the public schema: an extension supplying a same-named function
  -- would otherwise give a false PASS here.
  union all select 'is_service_call reads the PostgREST claim',
         (select prosrc like '%request.jwt.claims%' from pg_proc
           where pronamespace = 'public'::regnamespace
             and proname = 'is_service_call')

  union all select 'is_service_call is false in a plain psql session',
         public.is_service_call() = false

  union all select 'analytics_scope now has a service branch',
         (select prosrc like '%is_service_call%' from pg_proc
           where pronamespace = 'public'::regnamespace
             and proname = 'analytics_scope')

  union all select 'analytics_scope still refuses an unknown user',
         (select prosrc like '%FORBIDDEN: you are not signed in%' from pg_proc
           where pronamespace = 'public'::regnamespace
             and proname = 'analytics_scope')

  union all select 'analytics_scope still guards another property',
         (select prosrc like '%FORBIDDEN_PROPERTY%' from pg_proc
           where pronamespace = 'public'::regnamespace
             and proname = 'analytics_scope')

  -- has_function_privilege and NOT information_schema.role_routine_grants:
  -- that view only lists grants whose grantor or grantee is a role the current
  -- user belongs to, so it can come back empty for a reason that has nothing to
  -- do with the grant existing — a FAIL that sends you looking in the wrong
  -- place. This asks the question directly.
  union all select 'service_role may run analytics_summary',
         has_function_privilege('service_role',
           'public.analytics_summary(uuid,date,date)', 'execute')

  union all select 'service_role may run analytics_by_operator',
         has_function_privilege('service_role',
           'public.analytics_by_operator(date,date,uuid)', 'execute')

  union all select 'service_role may run analytics_by_property',
         has_function_privilege('service_role',
           'public.analytics_by_property(date,date)', 'execute')

  union all select 'anon still may NOT run analytics_summary',
         not has_function_privilege('anon',
           'public.analytics_summary(uuid,date,date)', 'execute')

  union all select 'anon still may NOT run is_service_call',
         not has_function_privilege('anon', 'public.is_service_call()', 'execute')

  -- ── vehicle_records, the export ─────────────────────────────────────
  union all select 'vehicle_records still takes its 6 args',
         to_regprocedure('public.vehicle_records(date,date,uuid,text,int,int)') is not null

  union all select 'vehicle_records has a service branch',
         (select prosrc like '%is_service_call%' from pg_proc
           where pronamespace = 'public'::regnamespace
             and proname = 'vehicle_records')

  -- The recreation must not have dropped the human path. A server-only
  -- vehicle_records would break the valet app's own Records screen.
  union all select 'vehicle_records still scopes a valet_admin',
         (select prosrc like '%valet_admin%' from pg_proc
           where pronamespace = 'public'::regnamespace
             and proname = 'vehicle_records')

  union all select 'vehicle_records still refuses an operator',
         (select prosrc like '%only an admin can see the records%' from pg_proc
           where pronamespace = 'public'::regnamespace
             and proname = 'vehicle_records')

  -- 21 columns. Dropping one silently shifts every column after it in the
  -- spreadsheet, which reads as scrambled data rather than as a missing field.
  union all select 'vehicle_records still returns 21 columns',
         (select count(*) = 21 from unnest(
            (select proallargtypes from pg_proc
              where pronamespace = 'public'::regnamespace
                and proname = 'vehicle_records')) with ordinality o(t, n)
           where n > 6)

  union all select 'vehicle_records still ordered for stable paging',
         (select prosrc like '%order by v.service_date desc, v.token_number desc%'
            from pg_proc
           where pronamespace = 'public'::regnamespace
             and proname = 'vehicle_records')

  union all select 'both roles may run vehicle_records',
         has_function_privilege('service_role',
           'public.vehicle_records(date,date,uuid,text,int,int)', 'execute')
         and has_function_privilege('authenticated',
           'public.vehicle_records(date,date,uuid,text,int,int)', 'execute')

  union all select 'anon still may NOT run vehicle_records',
         not has_function_privilege('anon',
           'public.vehicle_records(date,date,uuid,text,int,int)', 'execute')
) t
order by ok, check_name;
