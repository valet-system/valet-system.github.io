-- ═══════════════════════════════════════════════════════════════════════
-- 0005 — STAFF MANAGEMENT WITHOUT AN EDGE FUNCTION
--
--   >>> RUN THIS IN THE SUPABASE SQL EDITOR, AFTER 0004. <<<
--
-- Safe to run more than once.
--
-- ── WHY THIS EXISTS ────────────────────────────────────────────────────
--
-- Creating a staff member needs TWO things written together:
--     1. an auth account   — holds the bcrypt-hashed PIN
--     2. a user_roles row  — holds name, role, property
--
-- Normally (1) requires the service_role key, which must never reach a
-- browser, so the work is done in an Edge Function. That means installing the
-- Supabase CLI, authenticating the right account, and deploying — a whole
-- toolchain just to add a valet.
--
-- These functions do the same job INSIDE POSTGRES instead. A SECURITY DEFINER
-- function already runs with the privileges of its owner (postgres), so it can
-- write to the auth schema without any key being handed to anyone. The browser
-- calls it with supabase.rpc(), authenticated by the ordinary user JWT it
-- already has.
--
-- Net effect: no CLI, no login, no access token, nothing to deploy.
--
-- ── IT IS ALSO SAFER IN ONE IMPORTANT WAY ──────────────────────────────
--
-- A Postgres function is ONE TRANSACTION. If the user_roles insert fails, the
-- auth.users insert is rolled back automatically by the database.
--
-- The Edge Function version cannot do that — GoTrue and Postgres are separate
-- systems with no shared transaction — so it has to delete the auth user by
-- hand on failure, and if THAT delete fails you are left with an orphan
-- account that can log in, sees "Account not ready" forever, and whose number
-- is now taken so the retry fails too. Here that state is impossible.
--
-- ── THE TRADE-OFF, STATED PLAINLY ──────────────────────────────────────
--
-- These functions INSERT INTO auth.users and auth.identities directly, which
-- Supabase advises against because that schema belongs to GoTrue and can
-- change between releases. If a future GoTrue adds a NOT NULL column with no
-- default, creating a user starts failing.
--
-- Mitigations: the identities insert adapts to both known table shapes (see
-- below), and the failure mode is loud — the create fails with a clear
-- Postgres error rather than producing a broken account. If it ever does
-- break, supabase/functions/admin-users/ is still in this repo and can be
-- deployed instead; the frontend switch is one file (src/lib/adminApi.js).
--
-- ── TEST IT IMMEDIATELY ────────────────────────────────────────────────
-- After running this, create ONE user through the app and log in as them.
-- That single round trip proves the auth rows were written in the shape GoTrue
-- expects. Do not create ten users before testing one.
-- ═══════════════════════════════════════════════════════════════════════

begin;

-- pgcrypto gives us crypt() and gen_salt(), which produce bcrypt hashes —
-- the same algorithm Supabase Auth uses, so a PIN written here verifies
-- normally at login.
create extension if not exists pgcrypto;


-- ═══════════════════════════════════════════════════════════════════════
-- PIN VALIDATION
--
-- Mirrors isPinAcceptable() in src/lib/phoneAuth.js. Duplicated on purpose:
-- the browser copy is for instant feedback, THIS one is the one that counts.
-- A request crafted by hand never runs the frontend's checks at all.
--
-- Why bother at all: this system has no login lockout, so a guessable PIN is
-- the one realistic way in. '111111' falls in the first few attempts rather
-- than the 500,000th, which makes the million-combination space irrelevant.
-- ═══════════════════════════════════════════════════════════════════════

create or replace function public.is_pin_acceptable(p_pin text)
returns text
language plpgsql
immutable
as $$
declare
  v_weak text[] := array[
    '123456','654321','111111','000000','121212','112233','123123',
    '789456','159753','147258','102030','135790','246800','696969',
    '123321','456654','999999','888888','777777','666666','555555',
    '444444','333333','222222','101010','010101','123654','321123',
    '520520','143143','786786','420420','007007','100100','110011',
    '200000','201010','202020','199999','151515'
  ];
  v_asc  boolean := true;
  v_desc boolean := true;
  i int;
begin
  if p_pin is null or p_pin !~ '^[0-9]{6}$' then
    return 'PIN must be exactly 6 digits.';
  end if;

  if p_pin = any(v_weak) then
    return 'That PIN is too common. Choose a different one.';
  end if;

  -- All the same digit.
  if p_pin ~ '^(.)\1{5}$' then
    return 'PIN cannot be the same digit repeated.';
  end if;

  -- Straight runs, up or down.
  for i in 2..6 loop
    if substr(p_pin, i, 1)::int <> substr(p_pin, i - 1, 1)::int + 1 then v_asc := false; end if;
    if substr(p_pin, i, 1)::int <> substr(p_pin, i - 1, 1)::int - 1 then v_desc := false; end if;
  end loop;

  if v_asc or v_desc then
    return 'PIN cannot be consecutive digits.';
  end if;

  return null;  -- null means acceptable
end $$;


-- ═══════════════════════════════════════════════════════════════════════
-- admin_create_staff — the whole "Add valet" operation, atomically
--
-- AUTHORISATION, and the one rule that matters:
--   A valet_admin's requested role and property are NOT VALIDATED — they are
--   DISCARDED and replaced with 'operator' and the caller's own property.
--
--   That distinction is the difference between safe and trivially
--   escalatable. Validating means there is a check to get wrong; discarding
--   means there is nothing to get wrong. Without it, a valet_admin at Ambria
--   Restro calls this with role => 'system_admin' and owns all four
--   properties — a two-line request from the browser console.
-- ═══════════════════════════════════════════════════════════════════════

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
begin
  -- ── 1. who is calling? read from the DB, never from arguments ────────
  select ur.role, ur.property_id
    into v_caller_role, v_caller_property
  from public.user_roles ur
  where ur.user_id = auth.uid()
    and ur.is_active = true;

  if v_caller_role is null then
    raise exception 'FORBIDDEN: you are not signed in as an active user';
  end if;

  -- ── 2. decide role + property server-side ───────────────────────────
  if v_caller_role = 'system_admin' then
    v_role     := coalesce(p_role, 'operator');
    v_property := p_property_id;

    if v_role not in ('system_admin', 'valet_admin', 'operator') then
      raise exception 'BAD_ROLE: unknown role %', v_role;
    end if;
    -- Mirrors constraint user_roles_property_scope_chk, checked here so the
    -- admin gets a sentence instead of a raw constraint violation.
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
    -- p_role and p_property_id are IGNORED here. See the header.
    v_role     := 'operator';
    v_property := v_caller_property;

  else
    raise exception 'FORBIDDEN: you do not have permission to manage users';
  end if;

  -- ── 3. validate the parts the caller does choose ────────────────────
  p_name := btrim(coalesce(p_name, ''));
  if length(p_name) < 2 then
    raise exception 'BAD_NAME: enter the person''s name';
  end if;
  if length(p_name) > 80 then
    raise exception 'BAD_NAME: name is too long';
  end if;

  v_phone := regexp_replace(coalesce(p_phone, ''), '\D', '', 'g');
  if v_phone !~ '^[6-9][0-9]{9}$' then
    raise exception 'BAD_PHONE: enter a valid 10-digit mobile number starting 6-9';
  end if;

  v_pin_error := public.is_pin_acceptable(p_pin);
  if v_pin_error is not null then
    raise exception 'BAD_PIN: %', v_pin_error;
  end if;

  -- ── 4. is the number already taken? ─────────────────────────────────
  -- Checked explicitly so the admin sees a name rather than a unique-index
  -- error naming a constraint they have never heard of.
  select ur.name into v_existing from public.user_roles ur where ur.phone = v_phone;
  if v_existing is not null then
    raise exception 'PHONE_TAKEN: that number is already registered to %', v_existing;
  end if;

  -- Same derivation as phoneToAuthEmail() in src/lib/phoneAuth.js. If these
  -- two ever disagree the account is created at one address and looked up at
  -- another, and the only symptom is "wrong PIN" on a correct PIN.
  v_email := v_phone || '@phone.invalid';

  if exists (select 1 from auth.users u where u.email = v_email) then
    raise exception 'PHONE_TAKEN: an account already exists for that number';
  end if;

  -- ── 5. the auth account ─────────────────────────────────────────────
  --
  -- email_confirmed_at is set NOW, deliberately. The derived address can never
  -- receive mail, so an unconfirmed account could never be confirmed and every
  -- login would fail with "Email not confirmed".
  --
  -- The token columns are set to '' rather than left out: across GoTrue
  -- versions they are variously nullable or NOT NULL DEFAULT '', and '' is
  -- valid in both.
  insert into auth.users (
    instance_id, id, aud, role, email, encrypted_password,
    email_confirmed_at, created_at, updated_at,
    raw_app_meta_data, raw_user_meta_data,
    confirmation_token, recovery_token, email_change_token_new, email_change
  ) values (
    '00000000-0000-0000-0000-000000000000',
    v_uid,
    'authenticated',
    'authenticated',
    v_email,
    crypt(p_pin, gen_salt('bf', 10)),   -- cost 10, matching GoTrue's default
    now(), now(), now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    jsonb_build_object('name', p_name, 'phone', v_phone),
    '', '', '', ''
  );

  -- ── 6. the identity row ─────────────────────────────────────────────
  --
  -- GoTrue looks users up through auth.identities. Skip this and the account
  -- exists, looks perfectly healthy in the dashboard, and cannot log in.
  --
  -- The table has had two shapes: newer GoTrue has a uuid `id` plus a
  -- `provider_id` text column; older versions used a text `id` holding the
  -- sub. Both are handled — plpgsql only parses the branch it executes, so the
  -- statement for the absent shape is never compiled.
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
    insert into auth.identities (
      id, provider_id, user_id, identity_data, provider,
      last_sign_in_at, created_at, updated_at
    ) values (
      gen_random_uuid(), v_uid::text, v_uid, v_identity, 'email',
      now(), now(), now()
    );
  else
    insert into auth.identities (
      id, user_id, identity_data, provider,
      last_sign_in_at, created_at, updated_at
    ) values (
      v_uid::text, v_uid, v_identity, 'email',
      now(), now(), now()
    );
  end if;

  -- ── 7. the role row ─────────────────────────────────────────────────
  -- If this fails, steps 5 and 6 roll back with it. That is the whole
  -- advantage of doing this inside one transaction.
  insert into public.user_roles (user_id, property_id, role, name, phone, is_active)
  values (v_uid, v_property, v_role, p_name, v_phone, true)
  returning to_jsonb(user_roles.*) into v_row;

  return jsonb_build_object('user', v_row, 'pin', p_pin);
end $$;


-- ═══════════════════════════════════════════════════════════════════════
-- admin_reset_staff_pin — the answer to "operator forgot their PIN"
--
-- A PIN cannot be read back; Supabase stores only a bcrypt hash. So it is
-- replaced, not recovered.
-- ═══════════════════════════════════════════════════════════════════════

create or replace function public.admin_reset_staff_pin(
  p_user_role_id uuid,
  p_pin          text
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_caller_role     text;
  v_caller_property uuid;
  v_caller_row_id   uuid;
  v_target          record;
  v_pin_error       text;
begin
  select ur.id, ur.role, ur.property_id
    into v_caller_row_id, v_caller_role, v_caller_property
  from public.user_roles ur
  where ur.user_id = auth.uid() and ur.is_active = true;

  if v_caller_role is null then
    raise exception 'FORBIDDEN: you are not signed in as an active user';
  end if;

  v_pin_error := public.is_pin_acceptable(p_pin);
  if v_pin_error is not null then
    raise exception 'BAD_PIN: %', v_pin_error;
  end if;

  select ur.id, ur.user_id, ur.name, ur.role, ur.property_id
    into v_target
  from public.user_roles ur
  where ur.id = p_user_role_id;

  if v_target.id is null then
    raise exception 'NOT_FOUND: that user no longer exists';
  end if;

  -- Wrong door for your own PIN. Change PIN verifies the CURRENT one first;
  -- this does not. Someone at an unattended admin laptop could otherwise lock
  -- the real admin out of their own account.
  if v_target.id = v_caller_row_id then
    raise exception 'USE_CHANGE_PIN: use Change PIN to change your own PIN';
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

  update auth.users
  set encrypted_password = crypt(p_pin, gen_salt('bf', 10)),
      email_confirmed_at = coalesce(email_confirmed_at, now()),
      updated_at         = now()
  where id = v_target.user_id;

  return jsonb_build_object('pin', p_pin, 'name', v_target.name);
end $$;


-- ═══════════════════════════════════════════════════════════════════════
-- admin_set_staff_active — deactivate / reactivate
--
-- Never deletes. is_active = false makes my_role() return NULL for that
-- person, so every RLS policy denies them and they cannot sign in — while
-- every task and car they ever handled stays attributable. Deleting the row
-- would orphan months of valet_tasks.
-- ═══════════════════════════════════════════════════════════════════════

create or replace function public.admin_set_staff_active(
  p_user_role_id uuid,
  p_is_active    boolean
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_caller_role     text;
  v_caller_property uuid;
  v_caller_row_id   uuid;
  v_target          record;
  v_active_tasks    int;
  v_row             jsonb;
begin
  select ur.id, ur.role, ur.property_id
    into v_caller_row_id, v_caller_role, v_caller_property
  from public.user_roles ur
  where ur.user_id = auth.uid() and ur.is_active = true;

  if v_caller_role is null then
    raise exception 'FORBIDDEN: you are not signed in as an active user';
  end if;

  select ur.id, ur.name, ur.role, ur.property_id into v_target
  from public.user_roles ur where ur.id = p_user_role_id;

  if v_target.id is null then
    raise exception 'NOT_FOUND: that user no longer exists';
  end if;

  -- Locking yourself out is not recoverable from inside the app.
  if v_target.id = v_caller_row_id then
    raise exception 'SELF: you cannot deactivate your own account';
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

  -- An operator mid-task would vanish from the assignment list while still
  -- holding a guest's car keys. Make the admin resolve the task first.
  if p_is_active = false then
    select count(*) into v_active_tasks
    from public.valet_tasks vt
    where vt.assigned_operator_id = v_target.id
      and vt.status in ('assigned', 'in_progress', 'at_pickup', 're_parking');

    if v_active_tasks > 0 then
      raise exception 'HAS_ACTIVE_TASKS: % has % task(s) in progress. Finish or reassign them first.',
        v_target.name, v_active_tasks;
    end if;
  end if;

  update public.user_roles
  set is_active = p_is_active
  where id = p_user_role_id
  returning to_jsonb(user_roles.*) into v_row;

  return jsonb_build_object('user', v_row);
end $$;


-- ═══════════════════════════════════════════════════════════════════════
-- admin_update_staff — name and/or login number
--
-- The number IS the login, so changing it is not an ordinary field edit. Both
-- records must move together: user_roles.phone AND the derived auth email.
-- Update one only and that person can never sign in again, with no error
-- explaining why. Inside one transaction, that split is impossible.
-- ═══════════════════════════════════════════════════════════════════════

create or replace function public.admin_update_staff(
  p_user_role_id uuid,
  p_name         text default null,
  p_phone        text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_caller_role     text;
  v_caller_property uuid;
  v_target          record;
  v_phone           text;
  v_email           text;
  v_existing        text;
  v_row             jsonb;
begin
  select ur.role, ur.property_id into v_caller_role, v_caller_property
  from public.user_roles ur
  where ur.user_id = auth.uid() and ur.is_active = true;

  if v_caller_role is null then
    raise exception 'FORBIDDEN: you are not signed in as an active user';
  end if;

  select ur.id, ur.user_id, ur.name, ur.phone, ur.role, ur.property_id into v_target
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

  -- ── name ────────────────────────────────────────────────────────────
  if p_name is not null then
    p_name := btrim(p_name);
    if length(p_name) < 2 then
      raise exception 'BAD_NAME: enter a name';
    end if;
    if length(p_name) > 80 then
      raise exception 'BAD_NAME: name is too long';
    end if;
  end if;

  -- ── phone ───────────────────────────────────────────────────────────
  if p_phone is not null then
    v_phone := regexp_replace(p_phone, '\D', '', 'g');
    if v_phone !~ '^[6-9][0-9]{9}$' then
      raise exception 'BAD_PHONE: enter a valid 10-digit mobile number starting 6-9';
    end if;

    if v_phone <> v_target.phone then
      select ur.name into v_existing
      from public.user_roles ur
      where ur.phone = v_phone and ur.id <> p_user_role_id;

      if v_existing is not null then
        raise exception 'PHONE_TAKEN: that number is already registered to %', v_existing;
      end if;

      v_email := v_phone || '@phone.invalid';

      update auth.users
      set email              = v_email,
          email_confirmed_at = coalesce(email_confirmed_at, now()),
          updated_at         = now()
      where id = v_target.user_id;

      -- The identity carries its own copy of the email. Leave it stale and
      -- GoTrue can resolve the account inconsistently between lookups.
      update auth.identities
      set identity_data = identity_data || jsonb_build_object('email', v_email),
          updated_at    = now()
      where user_id = v_target.user_id and provider = 'email';
    end if;
  end if;

  update public.user_roles
  set name  = coalesce(p_name, name),
      phone = coalesce(v_phone, phone)
  where id = p_user_role_id
  returning to_jsonb(user_roles.*) into v_row;

  return jsonb_build_object('user', v_row);
end $$;


-- ═══════════════════════════════════════════════════════════════════════
-- GRANTS
--
-- Exposed to authenticated only. Every function reads the caller's role from
-- the database via auth.uid() and refuses anyone who is not an admin, so
-- granting EXECUTE broadly is safe — an operator calling admin_create_staff
-- gets 'FORBIDDEN' immediately.
--
-- anon gets nothing: an unauthenticated caller has no auth.uid(), so the role
-- lookup returns NULL and the function raises FORBIDDEN. Revoked anyway.
-- ═══════════════════════════════════════════════════════════════════════

revoke all on function public.admin_create_staff(text, text, text, text, uuid)  from public, anon;
revoke all on function public.admin_reset_staff_pin(uuid, text)                 from public, anon;
revoke all on function public.admin_set_staff_active(uuid, boolean)             from public, anon;
revoke all on function public.admin_update_staff(uuid, text, text)              from public, anon;
revoke all on function public.is_pin_acceptable(text)                           from public, anon;

grant execute on function public.admin_create_staff(text, text, text, text, uuid) to authenticated;
grant execute on function public.admin_reset_staff_pin(uuid, text)               to authenticated;
grant execute on function public.admin_set_staff_active(uuid, boolean)           to authenticated;
grant execute on function public.admin_update_staff(uuid, text, text)            to authenticated;
grant execute on function public.is_pin_acceptable(text)                         to authenticated;

commit;

-- ═══════════════════════════════════════════════════════════════════════
-- VERIFY
-- ═══════════════════════════════════════════════════════════════════════
--
-- -- 1. PIN rules work (expect: null, then three refusals)
-- select public.is_pin_acceptable('573914') as should_be_null,
--        public.is_pin_acceptable('111111') as repeated,
--        public.is_pin_acceptable('123456') as sequential,
--        public.is_pin_acceptable('1234')   as too_short;
--
-- -- 2. All four admin functions exist (expect 4 rows)
-- select proname from pg_proc p
-- join pg_namespace n on n.oid = p.pronamespace
-- where n.nspname = 'public' and proname like 'admin_%'
-- order by proname;
--
-- -- 3. AFTER creating one user through the app, check the auth rows are
-- --    complete. All three columns must be true, or that user cannot log in.
-- select ur.name,
--        ur.phone,
--        u.email,
--        u.email_confirmed_at is not null                as confirmed,
--        u.encrypted_password like '$2%'                 as bcrypt_ok,
--        exists (select 1 from auth.identities i
--                where i.user_id = u.id and i.provider = 'email') as has_identity
-- from public.user_roles ur
-- join auth.users u on u.id = ur.user_id
-- order by ur.created_at desc;
