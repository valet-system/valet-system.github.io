-- ═══════════════════════════════════════════════════════════════════════
-- 0006 — AUTH SCHEMA HARDENING + CRON REPAIR
--
--   >>> RUN THIS IN THE SUPABASE SQL EDITOR, AFTER 0005. <<<
--
-- Safe to run more than once.
--
-- Two unrelated things, both surfaced by the health check:
--   PART A — the cron jobs were never scheduled
--   PART B — make admin_create_staff resilient to GoTrue schema changes
-- ═══════════════════════════════════════════════════════════════════════

begin;


-- ═══════════════════════════════════════════════════════════════════════
-- PART A — SCHEDULE THE CRON JOBS
--
-- The health check reported "Cron jobs scheduled (need 3): FAIL" while
-- "pg_cron extension: PASS". That combination has one cause: pg_cron was
-- enabled AFTER migration 0002 ran. 0002's scheduling block checks for the
-- extension first and skips with a NOTICE if it is missing, so the jobs were
-- never created.
--
-- WHY THIS MATTERS — it is not cosmetic:
--   check-expired-pickups is the ONLY thing that fires when an operator's
--   phone is locked or the app is closed. Without it, a guest who does not
--   turn up at the delivery point leaves the task stuck in 'at_pickup'
--   forever: the operator is never told to re-park, the car never returns to
--   'parked', and the guest is never messaged. The frontend countdown only
--   runs while the screen is open, which is exactly when it is not needed.
-- ═══════════════════════════════════════════════════════════════════════

do $$
declare j record;
begin
  if not exists (select 1 from pg_extension where extname = 'pg_cron') then
    raise notice 'pg_cron is NOT enabled — jobs not scheduled.';
    return;
  end if;

  -- Remove any earlier version of these jobs so re-running is clean.
  for j in
    select jobname from cron.job
    where jobname in ('check-expired-pickups', 'daily-token-reset', 'purge-login-attempts')
  loop
    perform cron.unschedule(j.jobname);
  end loop;

  -- Every minute: the safety net for a closed app.
  perform cron.schedule(
    'check-expired-pickups',
    '* * * * *',
    $cron$ select public.expire_stale_pickups(10); $cron$
  );

  -- 18:35 UTC = 00:05 IST, just after the Indian business day starts.
  perform cron.schedule(
    'daily-token-reset',
    '35 18 * * *',
    $cron$ select public.reset_daily_tokens(); $cron$
  );

  raise notice 'Scheduled: check-expired-pickups, daily-token-reset';
end $$;

-- Make sure today has token ranges right now, regardless of cron.
select public.reset_daily_tokens();


-- ═══════════════════════════════════════════════════════════════════════
-- PART B — MAKE THE AUTH WRITES RESILIENT
--
-- ── THE RISK, RE-ASSESSED HONESTLY ─────────────────────────────────────
--
-- admin_create_staff() inserts into auth.users and auth.identities, which
-- belong to GoTrue and can change between Supabase releases.
--
-- But the risk is narrower than it first appears. If GoTrue ADDS a NOT NULL
-- column, their own migration must supply a DEFAULT — otherwise it could not
-- apply to existing rows. So a new column cannot break an INSERT that simply
-- omits it.
--
-- The real exposure is the opposite: a column WE NAME being REMOVED or
-- renamed. The four legacy token columns are the candidates —
-- confirmation_token, recovery_token, email_change_token_new, email_change.
-- They exist today, are vestigial, and are the sort of thing that gets dropped.
--
-- ── THE FIX ────────────────────────────────────────────────────────────
--
-- Build the column list at run time from what actually exists. Required
-- columns are named directly (if one of those disappears, Supabase Auth itself
-- is broken and we want a loud failure). Optional ones are included only when
-- present, so their removal becomes a non-event.
--
-- Also added: a post-insert integrity assertion. Previously a partial write
-- could in principle return success; now the function re-reads what it wrote
-- and raises if anything is missing, so a broken account can never be
-- reported as created.
--
-- And check_auth_schema_compat(), below, turns a future surprise into
-- something you can check on purpose.
-- ═══════════════════════════════════════════════════════════════════════

-- ── B1. compatibility checker ─────────────────────────────────────────
--
-- Run this after any Supabase platform upgrade. It reports whether every
-- column admin_create_staff depends on is still present, WITHOUT creating a
-- user — so you find out on your terms rather than while an admin is trying to
-- add a valet on a Saturday night.

-- CREATE OR REPLACE cannot change a function's RETURN TYPE, and a
-- RETURNS TABLE list IS the return type — so adding or removing a column
-- later fails with 42P13 unless the old row type is gone first. Dropping
-- here keeps this migration re-runnable in any order.
drop function if exists public.check_auth_schema_compat();

create or replace function public.check_auth_schema_compat()
returns table (item text, result text)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  c            text;
  v_missing    text[] := '{}';
  v_required   text[] := array[
    'id','instance_id','aud','role','email','encrypted_password',
    'email_confirmed_at','created_at','updated_at',
    'raw_app_meta_data','raw_user_meta_data'
  ];
  v_optional   text[] := array[
    'confirmation_token','recovery_token','email_change_token_new','email_change'
  ];
  v_present    text[] := '{}';
begin
  -- required columns on auth.users
  foreach c in array v_required loop
    if not exists (
      select 1 from information_schema.columns
      where table_schema = 'auth' and table_name = 'users' and column_name = c
    ) then
      v_missing := v_missing || c;
    end if;
  end loop;

  return query select
    'auth.users required columns'::text,
    case when array_length(v_missing, 1) is null
         then 'PASS'
         else 'FAIL  missing: ' || array_to_string(v_missing, ', ')
              || '  -> deploy the admin-users Edge Function instead' end;

  -- optional columns, reported for information only
  foreach c in array v_optional loop
    if exists (
      select 1 from information_schema.columns
      where table_schema = 'auth' and table_name = 'users' and column_name = c
    ) then
      v_present := v_present || c;
    end if;
  end loop;

  return query select
    'auth.users optional columns'::text,
    'OK  present: ' || coalesce(nullif(array_to_string(v_present, ', '), ''), 'none')
    || '  (handled either way)';

  -- any NOT NULL column with no default would break an INSERT that omits it.
  -- Listed so the cause is obvious rather than a bare constraint error.
  return query select
    'auth.users unexpected NOT NULL columns'::text,
    coalesce(
      (select 'FAIL  ' || string_agg(column_name, ', ')
         || '  are NOT NULL with no default and not written by us'
       from information_schema.columns
       where table_schema = 'auth' and table_name = 'users'
         and is_nullable = 'NO'
         and column_default is null
         and column_name <> all (v_required || v_optional)),
      'PASS');

  -- identities shape
  return query select
    'auth.identities shape'::text,
    case when exists (
           select 1 from information_schema.columns
           where table_schema = 'auth' and table_name = 'identities'
             and column_name = 'provider_id')
         then 'PASS  modern (uuid id + provider_id)'
         when exists (
           select 1 from information_schema.columns
           where table_schema = 'auth' and table_name = 'identities'
             and column_name = 'identity_data')
         then 'PASS  legacy (text id)'
         else 'FAIL  unrecognised — deploy the Edge Function instead' end;

  -- can crypt() still be reached?
  return query select
    'pgcrypto crypt() reachable'::text,
    case when exists (
           select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where p.proname = 'crypt' and n.nspname in ('public', 'extensions'))
         then 'PASS' else 'FAIL  run: create extension pgcrypto;' end;
end $$;

revoke all on function public.check_auth_schema_compat() from public, anon;
grant execute on function public.check_auth_schema_compat() to authenticated;


-- ── B2. admin_create_staff, hardened ──────────────────────────────────
--
-- Same authorisation and validation as 0005 — unchanged, and still the rule
-- that matters: a valet_admin's requested role and property are DISCARDED, not
-- validated, and replaced with 'operator' plus their own property.
--
-- What changed is only HOW the auth rows are written.

create or replace function public.admin_create_staff(
  p_name        text,
  p_phone       text,
  p_pin         text,
  p_role        text default 'operator',
  p_property_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_caller_role     text;
  v_caller_property uuid;
  v_role            text;
  v_property        uuid;
  v_phone           text;
  v_email           text;
  v_uid             uuid := gen_random_uuid();
  v_pin_error       text;
  v_identity        jsonb;
  v_row             jsonb;
  v_existing        text;
  v_extra_cols      text := '';
  v_extra_vals      text := '';
  v_sql             text;
  c                 text;
begin
  -- ── 1. who is calling? read from the DB, never from arguments ────────
  select ur.role, ur.property_id
    into v_caller_role, v_caller_property
  from public.user_roles ur
  where ur.user_id = auth.uid() and ur.is_active = true;

  if v_caller_role is null then
    raise exception 'FORBIDDEN: you are not signed in as an active user';
  end if;

  -- ── 2. decide role + property SERVER-SIDE ───────────────────────────
  if v_caller_role = 'system_admin' then
    v_role     := coalesce(p_role, 'operator');
    v_property := p_property_id;

    if v_role not in ('system_admin', 'valet_admin', 'operator') then
      raise exception 'BAD_ROLE: unknown role %', v_role;
    end if;
    if v_role = 'system_admin' and v_property is not null then
      raise exception 'BAD_SCOPE: a system admin cannot belong to a property';
    end if;
    if v_role <> 'system_admin' and v_property is null then
      raise exception 'BAD_SCOPE: choose a property for this user';
    end if;

  elsif v_caller_role = 'valet_admin' then
    if v_caller_property is null then
      raise exception 'BAD_SCOPE: your account has no property assigned';
    end if;
    -- p_role and p_property_id are IGNORED. Not validated — ignored.
    v_role     := 'operator';
    v_property := v_caller_property;

  else
    raise exception 'FORBIDDEN: you do not have permission to manage users';
  end if;

  -- ── 3. validate what the caller does choose ─────────────────────────
  p_name := btrim(coalesce(p_name, ''));
  if length(p_name) < 2  then raise exception 'BAD_NAME: enter the person''s name'; end if;
  if length(p_name) > 80 then raise exception 'BAD_NAME: name is too long';        end if;

  v_phone := regexp_replace(coalesce(p_phone, ''), '\D', '', 'g');
  if v_phone !~ '^[6-9][0-9]{9}$' then
    raise exception 'BAD_PHONE: enter a valid 10-digit mobile number starting 6-9';
  end if;

  v_pin_error := public.is_pin_acceptable(p_pin);
  if v_pin_error is not null then
    raise exception 'BAD_PIN: %', v_pin_error;
  end if;

  -- ── 4. number already taken? ────────────────────────────────────────
  select ur.name into v_existing from public.user_roles ur where ur.phone = v_phone;
  if v_existing is not null then
    raise exception 'PHONE_TAKEN: that number is already registered to %', v_existing;
  end if;

  -- Must match phoneToAuthEmail() in src/lib/phoneAuth.js exactly.
  v_email := v_phone || '@phone.invalid';

  if exists (select 1 from auth.users u where u.email = v_email) then
    raise exception 'PHONE_TAKEN: an account already exists for that number';
  end if;

  -- ── 5. the auth account, with a DYNAMIC column list ─────────────────
  --
  -- The four legacy token columns are vestigial and could be dropped by a
  -- future GoTrue. Naming them only when they exist means their removal costs
  -- us nothing. Required columns stay named directly: if one of those ever
  -- disappears, Supabase Auth itself has changed fundamentally and we want a
  -- loud failure, not a silent workaround.
  foreach c in array array['confirmation_token','recovery_token','email_change_token_new','email_change']
  loop
    if exists (
      select 1 from information_schema.columns
      where table_schema = 'auth' and table_name = 'users' and column_name = c
    ) then
      v_extra_cols := v_extra_cols || ', ' || quote_ident(c);
      v_extra_vals := v_extra_vals || ', ''''';
    end if;
  end loop;

  v_sql := format($fmt$
    insert into auth.users (
      instance_id, id, aud, role, email, encrypted_password,
      email_confirmed_at, created_at, updated_at,
      raw_app_meta_data, raw_user_meta_data%s
    ) values (
      $1, $2, 'authenticated', 'authenticated', $3, $4,
      now(), now(), now(),
      $5, $6%s
    )$fmt$, v_extra_cols, v_extra_vals);

  -- Values passed with USING, never interpolated — the name and phone are
  -- user input, and format() with %L would still be one careless edit away
  -- from an injection.
  execute v_sql using
    '00000000-0000-0000-0000-000000000000'::uuid,
    v_uid,
    v_email,
    crypt(p_pin, gen_salt('bf', 10)),          -- cost 10, matching GoTrue
    '{"provider":"email","providers":["email"]}'::jsonb,
    jsonb_build_object('name', p_name, 'phone', v_phone);

  -- ── 6. the identity row ─────────────────────────────────────────────
  --
  -- GoTrue resolves users through auth.identities. Skip this and the account
  -- looks perfectly healthy in the dashboard and simply cannot log in — the
  -- single hardest failure here to diagnose.
  v_identity := jsonb_build_object(
    'sub', v_uid::text,
    'email', v_email,
    'email_verified', true,
    'phone_verified', false
  );

  if exists (
    select 1 from information_schema.columns
    where table_schema = 'auth' and table_name = 'identities' and column_name = 'provider_id'
  ) then
    insert into auth.identities (id, provider_id, user_id, identity_data, provider,
                                 last_sign_in_at, created_at, updated_at)
    values (gen_random_uuid(), v_uid::text, v_uid, v_identity, 'email', now(), now(), now());
  else
    insert into auth.identities (id, user_id, identity_data, provider,
                                 last_sign_in_at, created_at, updated_at)
    values (v_uid::text, v_uid, v_identity, 'email', now(), now(), now());
  end if;

  -- ── 7. the role row ─────────────────────────────────────────────────
  insert into public.user_roles (user_id, property_id, role, name, phone, is_active)
  values (v_uid, v_property, v_role, p_name, v_phone, true)
  returning to_jsonb(user_roles.*) into v_row;

  -- ── 8. PROVE the account can actually log in ────────────────────────
  --
  -- Re-read what we just wrote. Without this, a schema surprise could leave a
  -- half-written account and this function would still return success — the
  -- admin reads the PIN out to a new valet who then cannot sign in, and nobody
  -- knows why. Raising here rolls back all of steps 5-7 together.
  if not exists (
    select 1 from auth.users u
    where u.id = v_uid
      and u.email = v_email
      and u.email_confirmed_at is not null
      -- A real bcrypt hash begins with a dollar sign and is about 60
      -- characters. Checked with left()/length() rather than a LIKE pattern,
      -- because a dollar sign followed by a digit reads ambiguously next to
      -- the EXECUTE placeholders above.
      and left(u.encrypted_password, 1) = '$'
      and length(u.encrypted_password) >= 55
  ) then
    raise exception 'AUTH_WRITE_FAILED: the auth account was not written correctly. Run: select * from public.check_auth_schema_compat();';
  end if;

  if not exists (
    select 1 from auth.identities i
    where i.user_id = v_uid and i.provider = 'email'
  ) then
    raise exception 'AUTH_WRITE_FAILED: the identity row is missing, so this user could not sign in. Run: select * from public.check_auth_schema_compat();';
  end if;

  return jsonb_build_object('user', v_row, 'pin', p_pin);
end $$;

revoke all   on function public.admin_create_staff(text, text, text, text, uuid) from public, anon;
grant execute on function public.admin_create_staff(text, text, text, text, uuid) to authenticated;


-- ── B3. repair any user already created that cannot log in ────────────
--
-- Nothing should need this — the health check reported all users healthy — but
-- it makes a broken account fixable without hand-writing SQL under pressure.
-- Only ever ADDS what is missing; it never touches a PIN.

-- CREATE OR REPLACE cannot change a function's RETURN TYPE, and a
-- RETURNS TABLE list IS the return type — so adding or removing a column
-- later fails with 42P13 unless the old row type is gone first. Dropping
-- here keeps this migration re-runnable in any order.
drop function if exists public.repair_auth_accounts();

create or replace function public.repair_auth_accounts()
returns table (phone text, name text, action text)
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare r record;
begin
  if not public.is_system_admin() then
    raise exception 'FORBIDDEN: system admin only';
  end if;

  for r in
    select ur.phone, ur.name, u.id as uid, u.email, u.email_confirmed_at
    from public.user_roles ur
    join auth.users u on u.id = ur.user_id
  loop
    -- unconfirmed -> confirm (the derived address can never receive mail)
    if r.email_confirmed_at is null then
      update auth.users set email_confirmed_at = now(), updated_at = now() where id = r.uid;
      return query select r.phone, r.name, 'confirmed email'::text;
    end if;

    -- email out of step with the phone -> the person cannot log in at all
    if r.email <> r.phone || '@phone.invalid' then
      update auth.users
      set email = r.phone || '@phone.invalid', updated_at = now()
      where id = r.uid;
      update auth.identities
      set identity_data = identity_data || jsonb_build_object('email', r.phone || '@phone.invalid'),
          updated_at = now()
      where user_id = r.uid and provider = 'email';
      return query select r.phone, r.name, 'email realigned to phone'::text;
    end if;

    -- missing identity -> account exists but login always fails
    if not exists (select 1 from auth.identities i
                   where i.user_id = r.uid and i.provider = 'email') then
      if exists (select 1 from information_schema.columns
                 where table_schema='auth' and table_name='identities' and column_name='provider_id') then
        insert into auth.identities (id, provider_id, user_id, identity_data, provider,
                                     last_sign_in_at, created_at, updated_at)
        values (gen_random_uuid(), r.uid::text, r.uid,
                jsonb_build_object('sub', r.uid::text, 'email', r.email,
                                   'email_verified', true, 'phone_verified', false),
                'email', now(), now(), now());
      else
        insert into auth.identities (id, user_id, identity_data, provider,
                                     last_sign_in_at, created_at, updated_at)
        values (r.uid::text, r.uid,
                jsonb_build_object('sub', r.uid::text, 'email', r.email,
                                   'email_verified', true, 'phone_verified', false),
                'email', now(), now(), now());
      end if;
      return query select r.phone, r.name, 'identity row created'::text;
    end if;
  end loop;
end $$;

revoke all   on function public.repair_auth_accounts() from public, anon;
grant execute on function public.repair_auth_accounts() to authenticated;

commit;

-- ═══════════════════════════════════════════════════════════════════════
-- VERIFY — run both
-- ═══════════════════════════════════════════════════════════════════════
--
-- -- 1. Cron jobs now exist (expect 2 or 3 rows):
-- select jobname, schedule, active from cron.job order by jobname;
--
-- -- 2. Auth schema is compatible (expect all PASS / OK):
-- select * from public.check_auth_schema_compat();
