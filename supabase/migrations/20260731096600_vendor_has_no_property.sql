-- ═══════════════════════════════════════════════════════════════════════
-- MIGRATION 0066 — a valet vendor belongs to no property
--
-- CORRECTS A SHORTCUT IN 0065. That migration gave vendors a property_id
-- because the constraint and both write functions demanded one of every role
-- except system_admin, and I judged the change "a null in a column nothing
-- reads" — not worth touching three things for.
--
-- The bill arrived at the Add-user form. It asks "Choose a property" and will
-- not submit without an answer, so creating a vendor means picking a venue for
-- an account that sees all five. There is no right answer to give it, and
-- whichever is picked is a value the app then ignores — which is exactly the
-- kind of field that teaches people the screen is lying to them.
--
-- So the rule now matches the truth: a vendor has no property, like a system
-- admin.
--
-- ── EXISTING VENDORS ARE CLEARED FIRST ────────────────────────────────
-- Any vendor created under 0065 holds a property, and the widened constraint
-- rejects exactly that. `add constraint` validates existing rows, so without
-- the UPDATE below this migration fails on its own data — the same trap that
-- made 0002 skip this constraint entirely on some databases.
--
-- ── THE CONSTRAINT IS REALLY THERE ────────────────────────────────────
-- Worth stating because 0013 says otherwise in a comment and 0065's first
-- verify block believed it: user_roles_property_scope_chk EXISTS on this
-- database. What misled that check was pg_get_constraintdef, which deparses
-- the stored expression and UPPERCASES its keywords — a lowercase LIKE for
-- `property_id is not null` can never match `property_id IS NOT NULL`. Every
-- constraint assertion below uses ILIKE.
--
-- ── THE FUNCTIONS ─────────────────────────────────────────────────────
-- Extracted from 0065 and patched at one branch each, not retyped.
-- admin_create_staff writes auth.users through a dynamic column list, handles
-- two shapes of auth.identities and stores the encrypted PIN; the verify block
-- asserts those landmarks survived the move, as it did in 0065.
-- ═══════════════════════════════════════════════════════════════════════

begin;

-- ── 1. CLEAR THE VENDORS THAT ALREADY HAVE ONE ────────────────────────
update public.user_roles
   set property_id = null
 where role = 'valet_vendor'
   and property_id is not null;


-- ── 2. THE SCHEMA'S RULE ──────────────────────────────────────────────
alter table public.user_roles drop constraint if exists user_roles_property_scope_chk;

alter table public.user_roles
  add constraint user_roles_property_scope_chk check (
    (role in ('system_admin', 'valet_vendor') and property_id is null) or
    (role not in ('system_admin', 'valet_vendor') and property_id is not null)
  );

comment on constraint user_roles_property_scope_chk on public.user_roles is
  'A system admin and a valet vendor belong to every property, so they carry '
  'none. Everyone else is scoped to exactly one: an operator without a '
  'property cannot be given a car, and a valet admin without one cannot see a '
  'queue.';


-- ── 3. AND THE TWO PATHS THAT WRITE IT ────────────────────────────────
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
    -- WIDENED BY 0066. A valet_vendor is scoped like a system admin: neither
    -- belongs to one venue, so neither may carry a property_id.
    --
    -- Still a REFUSAL rather than a silent `v_property := null`. If a caller
    -- sent a property for one of these roles it misunderstood something, and
    -- swallowing it would hide that until somebody wondered why the value never
    -- stuck.
    if v_role in ('system_admin', 'valet_vendor') and v_property is not null then
      raise exception 'BAD_SCOPE: a % does not belong to a single property', v_role;
    end if;
    if v_role not in ('system_admin', 'valet_vendor') and v_property is null then
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

-- ── 4. ─────────────────────────────────────────────────────────────────
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
  -- WIDENED BY 0066: a valet_vendor loses its property here too, so promoting
  -- an operator to vendor clears the venue they used to be tied to instead of
  -- leaving a stale one behind on a row nothing reads.
  if v_role in ('system_admin', 'valet_vendor') then
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
  -- ── THE NEW RULE ────────────────────────────────────────────────────
  -- ILIKE throughout: pg_get_constraintdef uppercases keywords. See the header.
  select 'a vendor may now have no property' as check_name,
         (select pg_get_constraintdef(oid) ilike '%valet_vendor%'
            from pg_constraint
           where conrelid = 'public.user_roles'::regclass
             and conname = 'user_roles_property_scope_chk') as ok

  union all select 'and everyone else still must have one',
         (select pg_get_constraintdef(oid) ilike '%property_id is not null%'
            from pg_constraint
           where conrelid = 'public.user_roles'::regclass
             and conname = 'user_roles_property_scope_chk')

  -- ── NO ROW BREAKS IT ────────────────────────────────────────────────
  union all select 'no vendor is left holding a property',
         not exists (select 1 from public.user_roles
                      where role = 'valet_vendor' and property_id is not null)

  union all select 'every operator still has one',
         not exists (select 1 from public.user_roles
                      where role = 'operator' and property_id is null
                        and deleted_at is null)

  union all select 'every valet admin still has one',
         not exists (select 1 from public.user_roles
                      where role = 'valet_admin' and property_id is null
                        and deleted_at is null)

  -- ── THE WRITE PATHS AGREE WITH THE SCHEMA ───────────────────────────
  union all select 'creating a vendor refuses a property',
         (select prosrc like '%does not belong to a single property%' from pg_proc
           where pronamespace = 'public'::regnamespace and proname = 'admin_create_staff')

  union all select 'promoting to vendor clears the property',
         (select prosrc like '%in (''system_admin'', ''valet_vendor'')%' from pg_proc
           where pronamespace = 'public'::regnamespace and proname = 'admin_set_staff_role')

  union all select 'an operator still needs one at creation',
         (select prosrc like '%choose a property for this user%' from pg_proc
           where pronamespace = 'public'::regnamespace and proname = 'admin_create_staff')

  -- ── admin_create_staff CAME ACROSS WHOLE ────────────────────────────
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

  union all select 'a valet admin can still only create operators',
         (select prosrc like '%v_role     := ''operator'';%' from pg_proc
           where pronamespace = 'public'::regnamespace and proname = 'admin_create_staff')

  -- ── AND 0065 IS STILL IN FORCE ──────────────────────────────────────
  union all select 'the role itself is still allowed',
         (select pg_get_constraintdef(oid) ilike '%valet_vendor%' from pg_constraint
           where conrelid = 'public.user_roles'::regclass
             and conname = 'user_roles_role_check')
) t
order by ok, check_name;
