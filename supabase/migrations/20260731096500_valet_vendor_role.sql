-- ═══════════════════════════════════════════════════════════════════════
-- MIGRATION 0065 — a fourth role: valet_vendor
--
-- On request. An outside staffing supplier who needs to see what Ambria has
-- booked so they can put people on it, and nothing else. In the app they get
-- the Valet Bookings screen and no other route.
--
-- ── WHY THIS MIGRATION IS SHORT ───────────────────────────────────────
-- Because every role gate in this schema was written as an ALLOW-LIST rather
-- than as "not an operator". operator_check_in wants ('operator',
-- 'valet_admin'); admin_delete_staff wants 'system_admin'; the analytics RPCs
-- name theirs. A role that appears in none of those lists is refused by all of
-- them without a line being touched.
--
-- Had those guards been written as denials, adding a role here would have
-- silently granted it everything nobody had thought to exclude.
--
-- ── WHY A VENDOR HAS A PROPERTY ───────────────────────────────────────
-- The bookings screen is cross-venue and ignores it, so on the face of it a
-- vendor needs no property. They get one anyway, because both functions below
-- demand it of every role except system_admin:
--
--     admin_create_staff    BAD_SCOPE: choose a property for this user
--     admin_set_staff_role  PROPERTY_REQUIRED: choose a property for this role
--
-- Exempting a second role would mean editing both of those branches to buy a
-- null in a column nothing reads. The property is the vendor's administrative
-- home and affects nothing they see.
--
-- user_roles_property_scope_chk enforces the same thing in the schema, and it
-- IS present on this database despite migration 0013's comment claiming
-- otherwise — that comment is stale, and 0002 adds the constraint inside a DO
-- block that only skips it when existing rows already violate it.
--
-- ── WHY THE FIRST VERSION OF THIS VERIFY BLOCK FAILED ─────────────────
-- It asserted that constraint with
--
--     pg_get_constraintdef(oid) like '%property_id is not null%'
--
-- and came back FAIL while the constraint was sitting right there.
-- pg_get_constraintdef does not return the text anybody typed: it deparses the
-- stored expression tree, and that output UPPERCASES keywords —
-- `property_id IS NOT NULL`. A lowercase LIKE can never match it.
--
-- Written down because it is a trap with no symptom other than a check that
-- looks wrong about working code: every constraint assertion in this project
-- must be case-insensitive, or match the deparsed form exactly.
--
-- ── HOW THE TWO FUNCTIONS BELOW WERE PRODUCED ─────────────────────────
-- Extracted from the migrations that define them and patched at one line each,
-- rather than retyped:
--
--     admin_create_staff    from 0006 (viewable_pins)
--     admin_set_staff_role  from 0013 (staff_role_change)
--
-- A valet_admin still cannot create a vendor. That branch of
-- admin_create_staff hardcodes 'operator' and never consults the allow-list.
-- ═══════════════════════════════════════════════════════════════════════

begin;

-- ── 1. THE COLUMN MAY HOLD IT ─────────────────────────────────────────
alter table public.user_roles drop constraint if exists user_roles_role_check;

alter table public.user_roles
  add constraint user_roles_role_check
  check (role in ('system_admin', 'valet_admin', 'operator', 'valet_vendor'));


-- ── 2. IT CAN BE ASSIGNED AT CREATION ─────────────────────────────────
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
  v_caller_id       uuid;
  v_role            text;
  v_property        uuid;
  v_phone           text;
  v_email           text;
  v_uid             uuid := gen_random_uuid();
  v_new_role_id     uuid;
  v_pin_error       text;
  v_clash           text;
  v_identity        jsonb;
  v_row             jsonb;
  v_existing        text;
  v_extra_cols      text := '';
  v_extra_vals      text := '';
  v_sql             text;
  c                 text;
begin
  select ur.id, ur.role, ur.property_id
    into v_caller_id, v_caller_role, v_caller_property
  from public.user_roles ur
  where ur.user_id = auth.uid() and ur.is_active = true;

  if v_caller_role is null then
    raise exception 'FORBIDDEN: you are not signed in as an active user';
  end if;

  if v_caller_role = 'system_admin' then
    v_role     := coalesce(p_role, 'operator');
    v_property := p_property_id;

    -- 'valet_vendor' added by migration 0065. Everything else in this
    -- function is what migration 0006 left: it was EXTRACTED from that file
    -- rather than retyped, because this is the function that writes
    -- auth.users through a dynamic column list, handles two shapes of
    -- auth.identities and stores the encrypted PIN. The verify block at the
    -- end of this migration asserts those parts survived the move.
    if v_role not in ('system_admin', 'valet_admin', 'operator', 'valet_vendor') then
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
    v_role     := 'operator';
    v_property := v_caller_property;

  else
    raise exception 'FORBIDDEN: you do not have permission to manage users';
  end if;

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

  -- NEW: reject a PIN already held by someone else.
  v_clash := public.pin_in_use(p_pin, null);
  if v_clash is not null then
    raise exception 'PIN_TAKEN: that PIN is already used by %. Choose a different one.', v_clash;
  end if;

  select ur.name into v_existing from public.user_roles ur where ur.phone = v_phone;
  if v_existing is not null then
    raise exception 'PHONE_TAKEN: that number is already registered to %', v_existing;
  end if;

  v_email := v_phone || '@phone.invalid';
  if exists (select 1 from auth.users u where u.email = v_email) then
    raise exception 'PHONE_TAKEN: an account already exists for that number';
  end if;

  -- Dynamic column list — see migration 0006 for why.
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
      now(), now(), now(), $5, $6%s
    )$fmt$, v_extra_cols, v_extra_vals);

  execute v_sql using
    '00000000-0000-0000-0000-000000000000'::uuid,
    v_uid,
    v_email,
    crypt(p_pin, gen_salt('bf', 10)),
    '{"provider":"email","providers":["email"]}'::jsonb,
    jsonb_build_object('name', p_name, 'phone', v_phone);

  v_identity := jsonb_build_object(
    'sub', v_uid::text, 'email', v_email,
    'email_verified', true, 'phone_verified', false
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

  insert into public.user_roles (user_id, property_id, role, name, phone, is_active)
  values (v_uid, v_property, v_role, p_name, v_phone, true)
  returning id, to_jsonb(user_roles.*) into v_new_role_id, v_row;

  -- NEW: store the PIN so an admin can read it back later.
  insert into public.staff_pins (user_role_id, pin_encrypted, updated_by, set_by_self)
  values (v_new_role_id, public.encrypt_pin(p_pin), v_caller_id, false);

  -- Prove the account can actually log in. Raising rolls everything back.
  if not exists (
    select 1 from auth.users u
    where u.id = v_uid
      and u.email = v_email
      and u.email_confirmed_at is not null
      and left(u.encrypted_password, 1) = '$'
      and length(u.encrypted_password) >= 55
  ) then
    raise exception 'AUTH_WRITE_FAILED: the auth account was not written correctly. Run: select * from public.check_auth_schema_compat();';
  end if;

  if not exists (
    select 1 from auth.identities i where i.user_id = v_uid and i.provider = 'email'
  ) then
    raise exception 'AUTH_WRITE_FAILED: the identity row is missing, so this user could not sign in.';
  end if;

  return jsonb_build_object('user', v_row, 'pin', p_pin);
end $$;

-- ── 3. AND CHANGED ON AN EXISTING USER ────────────────────────────────
create or replace function public.admin_set_staff_role(
  p_user_role_id uuid,
  p_role         text,
  p_property_id  uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_me            uuid;
  v_my_role       text;
  v_target        record;
  v_role          text := nullif(btrim(coalesce(p_role, '')), '');
  v_property      uuid := p_property_id;
  v_open          int;
  v_other_admins  int;
  v_property_name text;
begin
  -- ── who is asking ───────────────────────────────────────────────────
  select ur.id, ur.role into v_me, v_my_role
  from public.user_roles ur
  where ur.user_id = auth.uid() and ur.is_active = true;

  if v_my_role is null then
    raise exception 'FORBIDDEN: you are not signed in as an active user';
  end if;

  -- Not can_manage_staff(): that grants a valet_admin their own operators,
  -- which is right for names and PINs and wrong for permissions.
  if v_my_role <> 'system_admin' then
    raise exception 'FORBIDDEN: only a system admin can change a role or property';
  end if;

  -- ── the target ──────────────────────────────────────────────────────
  select ur.id, ur.name, ur.role, ur.property_id into v_target
  from public.user_roles ur
  where ur.id = p_user_role_id
  for update;

  if v_target.id is null then
    raise exception 'NOT_FOUND: that user no longer exists';
  end if;

  -- ── validate the requested role ──────────────────────────────────────
  -- 'valet_vendor' added by migration 0065.
  if v_role is null
     or v_role not in ('system_admin', 'valet_admin', 'operator', 'valet_vendor') then
    raise exception 'BAD_ROLE: choose Operator, Valet Vendor, Valet Admin or System Admin';
  end if;

  -- A system_admin belongs to no single property; everyone else must have one.
  -- There is no CHECK constraint enforcing this on user_roles, so it is
  -- enforced here and in admin_create_staff — the only two paths that write it.
  if v_role = 'system_admin' then
    v_property := null;
  else
    if v_property is null then
      raise exception 'PROPERTY_REQUIRED: choose a property for this role';
    end if;

    select p.name into v_property_name
    from public.properties p where p.id = v_property;

    if v_property_name is null then
      raise exception 'NOT_FOUND: that property does not exist';
    end if;
  end if;

  -- ── nothing to do ───────────────────────────────────────────────────
  -- Checked BEFORE the guards below, so re-saving an unchanged form never
  -- fails just because the person happens to be parking a car right now.
  if v_target.role = v_role and v_target.property_id is not distinct from v_property then
    return jsonb_build_object('changed', false, 'name', v_target.name);
  end if;

  -- ── guard: an open task would be orphaned ───────────────────────────
  select count(*) into v_open
  from public.valet_tasks t
  where t.assigned_operator_id = v_target.id
    and t.status in ('assigned', 'in_progress', 'at_pickup', 're_parking', 'returned');

  if v_open > 0 then
    raise exception
      'HAS_OPEN_TASKS: % still has % car% in hand. Wait until it is finished — moving them now would leave that car assigned to somebody who can no longer complete it.',
      v_target.name, v_open, case when v_open = 1 then '' else 's' end;
  end if;

  -- ── guard: do not remove the last system admin ──────────────────────
  if v_target.role = 'system_admin' and v_role <> 'system_admin' then
    select count(*) into v_other_admins
    from public.user_roles ur
    where ur.role = 'system_admin'
      and ur.is_active = true
      and ur.id <> v_target.id;

    if v_other_admins = 0 then
      raise exception
        'LAST_SYSTEM_ADMIN: % is the only system admin. Promote somebody else first, or nobody will be able to manage roles or properties at all.',
        v_target.name;
    end if;
  end if;

  -- ── write ───────────────────────────────────────────────────────────
  update public.user_roles
     set role        = v_role,
         property_id = v_property
   where id = v_target.id;

  return jsonb_build_object(
    'changed',       true,
    'name',          v_target.name,
    'role',          v_role,
    'property_id',   v_property,
    'property_name', v_property_name,
    'was_self',      v_target.id = v_me
  );
end $fn$;

commit;


-- ═══════════════════════════════════════════════════════════════════════
-- VERIFY — every row must read PASS
-- ═══════════════════════════════════════════════════════════════════════
select check_name, case when ok then 'PASS' else 'FAIL' end as result
from (
  select 'the column accepts valet_vendor' as check_name,
         (select pg_get_constraintdef(oid) like '%valet_vendor%' from pg_constraint
           where conrelid = 'public.user_roles'::regclass
             and conname = 'user_roles_role_check') as ok

  -- The three already allowed must survive, or every existing account becomes
  -- unwritable.
  union all select 'system_admin is still allowed',
         (select pg_get_constraintdef(oid) like '%system_admin%' from pg_constraint
           where conrelid = 'public.user_roles'::regclass and conname = 'user_roles_role_check')
  union all select 'valet_admin is still allowed',
         (select pg_get_constraintdef(oid) like '%valet_admin%' from pg_constraint
           where conrelid = 'public.user_roles'::regclass and conname = 'user_roles_role_check')
  union all select 'operator is still allowed',
         (select pg_get_constraintdef(oid) like '%operator%' from pg_constraint
           where conrelid = 'public.user_roles'::regclass and conname = 'user_roles_role_check')

  union all select 'a vendor can be created',
         (select prosrc like '%valet_vendor%' from pg_proc
           where pronamespace = 'public'::regnamespace and proname = 'admin_create_staff')

  union all select 'an existing user can be made a vendor',
         (select prosrc like '%valet_vendor%' from pg_proc
           where pronamespace = 'public'::regnamespace and proname = 'admin_set_staff_role')

  -- ── admin_create_staff CAME ACROSS WHOLE ────────────────────────────
  -- The landmarks that make it the fragile one. If any is missing, the
  -- extraction lost part of the body and new accounts would fail in a way that
  -- only shows up the next time somebody is hired.
  union all select 'it still writes the auth account',
         (select prosrc like '%insert into auth.users%' from pg_proc
           where pronamespace = 'public'::regnamespace and proname = 'admin_create_staff')

  union all select 'it still writes the auth identity',
         (select prosrc like '%auth.identities%' from pg_proc
           where pronamespace = 'public'::regnamespace and proname = 'admin_create_staff')

  union all select 'it still stores the encrypted PIN',
         (select prosrc like '%staff_pins%' from pg_proc
           where pronamespace = 'public'::regnamespace and proname = 'admin_create_staff')

  union all select 'it still builds the column list dynamically',
         (select prosrc like '%v_extra_cols%' from pg_proc
           where pronamespace = 'public'::regnamespace and proname = 'admin_create_staff')

  -- ── AND THE GUARDS DID NOT LOOSEN ───────────────────────────────────
  union all select 'a valet admin can still only create operators',
         (select prosrc like '%v_role     := ''operator'';%' from pg_proc
           where pronamespace = 'public'::regnamespace and proname = 'admin_create_staff')

  -- ILIKE, not LIKE. pg_get_constraintdef deparses the stored expression and
  -- uppercases its keywords, so the lowercase LIKE this check started with
  -- could never match `property_id IS NOT NULL`. See the header.
  union all select 'the schema still requires a property of every non-admin',
         (select pg_get_constraintdef(oid) ilike '%property_id is not null%'
            from pg_constraint
           where conrelid = 'public.user_roles'::regclass
             and conname = 'user_roles_property_scope_chk')

  -- And the two write paths refuse it too, which is what actually produces the
  -- message an admin sees.
  union all select 'a vendor must still be given a property',
         (select prosrc like '%choose a property for this user%' from pg_proc
           where pronamespace = 'public'::regnamespace and proname = 'admin_create_staff')

  union all select 'and cannot be moved off one later',
         (select prosrc like '%PROPERTY_REQUIRED%' from pg_proc
           where pronamespace = 'public'::regnamespace and proname = 'admin_set_staff_role')

  -- The operator flow must not have opened up. Its allow-list names two roles
  -- and a vendor is in neither.
  union all select 'check-in still refuses a vendor',
         (select prosrc not like '%valet_vendor%' from pg_proc
           where pronamespace = 'public'::regnamespace and proname = 'operator_check_in')

  union all select 'deleting a user is still system admin only',
         (select prosrc not like '%valet_vendor%' from pg_proc
           where pronamespace = 'public'::regnamespace and proname = 'admin_delete_staff')

  -- No existing row was disturbed.
  union all select 'no row holds an unknown role',
         not exists (select 1 from public.user_roles
                      where role not in
                        ('system_admin', 'valet_admin', 'operator', 'valet_vendor'))
) t
order by ok, check_name;
