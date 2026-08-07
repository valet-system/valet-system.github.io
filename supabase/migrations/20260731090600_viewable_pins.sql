-- ═══════════════════════════════════════════════════════════════════════
-- 0007 — ADMIN-VIEWABLE PINs
--
--   >>> RUN THIS IN THE SUPABASE SQL EDITOR, AFTER 0006. <<<
--   >>> The editor will warn about RLS on auth.identities. FALSE POSITIVE.
--   >>> Choose "Run without RLS".
--
-- Safe to run more than once.
--
-- ── WHAT THIS CHANGES, AND THE TRADE IT MAKES ──────────────────────────
--
-- Requested: an admin should be able to SEE each valet's current PIN, type a
-- new one by hand, and be told when a PIN is already in use.
--
-- Seeing a PIN means keeping it in recoverable form. A bcrypt hash cannot be
-- read back — that is the point of a hash — so until now the only copy was the
-- hash in auth.users and a forgotten PIN could only be REPLACED.
--
-- The cost, stated plainly: anyone who obtains the stored PINs can sign in as
-- any valet. And because real people reuse PINs on their bank and UPI apps, the
-- blast radius is wider than this app.
--
-- ── SO IT IS ENCRYPTED, NOT PLAINTEXT ──────────────────────────────────
--
-- Three things reduce the exposure without changing the requested behaviour:
--
--   1. ENCRYPTED AT REST with pgcrypto, using a key held in Supabase Vault.
--      Vault keeps the key OUTSIDE the database, so a `pg_dump` contains only
--      ciphertext. A leaked backup is useless on its own — which is the most
--      likely way a database gets out.
--
--   2. A SEPARATE TABLE with no grants at all. PINs do not live on user_roles,
--      the row every screen reads. Even a broad RLS mistake on user_roles
--      cannot expose them; the only way in is the functions below.
--
--   3. EVERY VIEW IS LOGGED. staff_pin_access records who looked at whose PIN
--      and when, so misuse leaves a trail.
--
-- What this does NOT defend against: a compromised admin account. An admin
-- being able to read PINs is the requirement, so nothing can stop that. Give
-- the system_admin account a strong PIN and treat it like a root password.
--
-- ── AND ONE THING THAT HAD TO BE FIXED ALONGSIDE ────────────────────────
--
-- When an operator changes their own PIN from the Change PIN screen, the app
-- was calling supabase.auth.updateUser() directly. That updates auth.users and
-- nothing else — so the admin's view would keep showing the OLD PIN forever,
-- silently wrong. Worse than no feature.
--
-- change_my_pin() below replaces it: one function, verifies the current PIN
-- server-side, then updates the auth password and the stored copy together.
-- ═══════════════════════════════════════════════════════════════════════

begin;

create extension if not exists pgcrypto;


-- ═══════════════════════════════════════════════════════════════════════
-- 1. THE ENCRYPTION KEY
--
-- Vault first, because it stores the key outside the database. If this project
-- has no Vault, a key is generated into a table that has zero grants — still
-- far better than plaintext (ciphertext in the column, key unreachable except
-- from the definer functions), but it WOULD travel in a full pg_dump. The
-- NOTICE says which one you got.
-- ═══════════════════════════════════════════════════════════════════════

create table if not exists public.app_secrets (
  name       text primary key,
  value      text not null,
  created_at timestamptz not null default now()
);

alter table public.app_secrets enable row level security;
revoke all on public.app_secrets from anon, authenticated;
-- No policies, no grants. Reachable only by SECURITY DEFINER functions and
-- service_role. Nothing in the app ever selects from it.

do $$
declare v_has_vault boolean;
begin
  select exists (
    select 1 from pg_extension where extname = 'supabase_vault'
  ) into v_has_vault;

  if v_has_vault then
    if not exists (select 1 from vault.secrets where name = 'valet_pin_key') then
      perform vault.create_secret(
        encode(gen_random_bytes(32), 'hex'),
        'valet_pin_key',
        'Symmetric key for encrypting staff PINs (migration 0007)'
      );
      raise notice 'PIN key created in Supabase Vault — a pg_dump will NOT contain it.';
    else
      raise notice 'PIN key already exists in Vault.';
    end if;
  else
    insert into public.app_secrets (name, value)
    values ('valet_pin_key', encode(gen_random_bytes(32), 'hex'))
    on conflict (name) do nothing;
    raise notice 'Vault not available — PIN key stored in public.app_secrets.';
    raise notice 'WEAKER: a full pg_dump would include this key. Enable the';
    raise notice 'supabase_vault extension and re-run to upgrade.';
  end if;
end $$;

-- Reads the key from whichever store holds it. SECURITY DEFINER, and never
-- granted to anyone — only the functions below call it.
create or replace function public.pin_key()
returns text
language plpgsql
stable
security definer
set search_path = public, extensions, vault, pg_temp
as $$
declare v_key text;
begin
  if exists (select 1 from pg_extension where extname = 'supabase_vault') then
    select decrypted_secret into v_key
    from vault.decrypted_secrets where name = 'valet_pin_key';
  end if;

  if v_key is null then
    select value into v_key from public.app_secrets where name = 'valet_pin_key';
  end if;

  if v_key is null then
    raise exception 'PIN_KEY_MISSING: re-run migration 0007';
  end if;

  return v_key;
end $$;

revoke all on function public.pin_key() from public, anon, authenticated;


-- ═══════════════════════════════════════════════════════════════════════
-- 2. THE PIN STORE
--
-- Deliberately NOT a column on user_roles. Every screen reads user_roles; a
-- PIN column there would ride along in every select, land in browser memory,
-- and be one RLS mistake away from being readable by an operator.
-- ═══════════════════════════════════════════════════════════════════════

create table if not exists public.staff_pins (
  user_role_id  uuid primary key references public.user_roles(id) on delete cascade,
  pin_encrypted bytea not null,
  updated_at    timestamptz not null default now(),
  -- who last set it: an admin (user_roles.id) or the person themselves
  updated_by    uuid references public.user_roles(id),
  set_by_self   boolean not null default false
);

alter table public.staff_pins enable row level security;
revoke all on public.staff_pins from anon, authenticated;
-- No policies. Functions only.

-- Audit: who read whose PIN. Cheap, and the only deterrent against an admin
-- browsing PINs out of curiosity.
create table if not exists public.staff_pin_access (
  id            bigserial primary key,
  viewer_id     uuid references public.user_roles(id),
  viewed_count  int not null,
  viewed_at     timestamptz not null default now()
);

alter table public.staff_pin_access enable row level security;
revoke all on public.staff_pin_access from anon, authenticated;

comment on table public.staff_pins is
  'Encrypted staff PINs so an admin can read them back. See migration 0007 for the trade-off.';


-- ═══════════════════════════════════════════════════════════════════════
-- 3. HELPERS
-- ═══════════════════════════════════════════════════════════════════════

create or replace function public.encrypt_pin(p_pin text)
returns bytea
language sql
security definer
set search_path = public, extensions, pg_temp
as $$ select pgp_sym_encrypt(p_pin, public.pin_key()) $$;

create or replace function public.decrypt_pin(p_cipher bytea)
returns text
language sql
security definer
set search_path = public, extensions, pg_temp
as $$ select pgp_sym_decrypt(p_cipher, public.pin_key()) $$;

revoke all on function public.encrypt_pin(text)  from public, anon, authenticated;
revoke all on function public.decrypt_pin(bytea) from public, anon, authenticated;

/**
 * Is this PIN already used by someone else?
 *
 * Requested behaviour: tell the admin when a PIN is taken. That is only
 * possible because PINs are now recoverable — with hashes alone you would have
 * to bcrypt-compare against every stored hash.
 *
 * Decrypt-and-compare over ~30 rows is trivial. A separate hash column would
 * be faster but would add a second, weaker copy of the secret.
 */
create or replace function public.pin_in_use(p_pin text, p_exclude_user_role_id uuid default null)
returns text
language plpgsql
stable
security definer
set search_path = public, extensions, pg_temp
as $$
declare r record;
begin
  for r in
    select sp.user_role_id, sp.pin_encrypted, ur.name
    from public.staff_pins sp
    join public.user_roles ur on ur.id = sp.user_role_id
    where p_exclude_user_role_id is null or sp.user_role_id <> p_exclude_user_role_id
  loop
    if public.decrypt_pin(r.pin_encrypted) = p_pin then
      return r.name;          -- returns WHOSE it is, so the message can name them
    end if;
  end loop;
  return null;                -- null = free
end $$;

revoke all on function public.pin_in_use(text, uuid) from public, anon, authenticated;


-- ═══════════════════════════════════════════════════════════════════════
-- 4. AUTHORISATION — one place, so the three functions below cannot drift
--
-- Returns null when allowed, or an error message.
-- ═══════════════════════════════════════════════════════════════════════

create or replace function public.can_manage_staff(p_target_user_role_id uuid)
returns text
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_role     text;
  v_property uuid;
  v_target   record;
begin
  select ur.role, ur.property_id into v_role, v_property
  from public.user_roles ur
  where ur.user_id = auth.uid() and ur.is_active = true;

  if v_role is null then return 'you are not signed in as an active user'; end if;
  if v_role = 'system_admin' then return null; end if;
  if v_role <> 'valet_admin' then return 'you do not have permission to manage users'; end if;

  if p_target_user_role_id is null then return null; end if;   -- listing only

  select ur.role, ur.property_id into v_target
  from public.user_roles ur where ur.id = p_target_user_role_id;

  if v_target.role is null           then return 'that user no longer exists';    end if;
  if v_target.role <> 'operator'     then return 'you can only manage operators'; end if;
  if v_target.property_id is distinct from v_property
                                     then return 'that user is not at your property'; end if;

  return null;
end $$;

revoke all on function public.can_manage_staff(uuid) from public, anon;
grant execute on function public.can_manage_staff(uuid) to authenticated;


-- ═══════════════════════════════════════════════════════════════════════
-- 5. admin_staff_pins — the admin's view
--
-- Returns the PINs of staff this caller may manage, and logs the access.
-- A valet_admin gets their own property's operators; a system_admin gets
-- everyone. Never their own row — an admin reads their own PIN from their own
-- memory, and excluding it keeps the audit log meaningful.
-- ═══════════════════════════════════════════════════════════════════════

-- CREATE OR REPLACE cannot change a function's RETURN TYPE, and a
-- RETURNS TABLE list IS the return type — so adding or removing a column
-- later fails with 42P13 unless the old row type is gone first. Dropping
-- here keeps this migration re-runnable in any order.
drop function if exists public.admin_staff_pins();

create or replace function public.admin_staff_pins()
returns table (user_role_id uuid, pin text, set_by_self boolean, updated_at timestamptz)
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_denied  text;
  v_role    text;
  v_prop    uuid;
  v_me      uuid;
  v_count   int;
begin
  v_denied := public.can_manage_staff(null);
  if v_denied is not null then
    raise exception 'FORBIDDEN: %', v_denied;
  end if;

  select ur.id, ur.role, ur.property_id into v_me, v_role, v_prop
  from public.user_roles ur
  where ur.user_id = auth.uid() and ur.is_active = true;

  create temp table if not exists _pins_out (
    user_role_id uuid, pin text, set_by_self boolean, updated_at timestamptz
  ) on commit drop;

  -- `where true` is not noise, it is required. This project has Supabase's
  -- safeupdate extension enabled, which rejects any DELETE or UPDATE with no
  -- WHERE clause — SQLSTATE 21000, "DELETE requires a WHERE clause". It does
  -- not exempt temp tables. Without this the whole function fails and the
  -- admin sees "Something went wrong" with no way to guess why.
  --
  -- The delete is belt-and-braces in the first place: ON COMMIT DROP means
  -- the table is gone by the end of every call, so IF NOT EXISTS creates a
  -- fresh empty one each time. It stays in case that ever stops being true,
  -- because leaking one admin's PIN list into another's would be far worse
  -- than a redundant statement.
  delete from _pins_out where true;

  insert into _pins_out
  select sp.user_role_id,
         public.decrypt_pin(sp.pin_encrypted),
         sp.set_by_self,
         sp.updated_at
  from public.staff_pins sp
  join public.user_roles ur on ur.id = sp.user_role_id
  where ur.id <> v_me
    and (
      v_role = 'system_admin'
      or (ur.role = 'operator' and ur.property_id = v_prop)
    );

  select count(*) into v_count from _pins_out;

  insert into public.staff_pin_access (viewer_id, viewed_count)
  values (v_me, v_count);

  return query select * from _pins_out;
end $$;

revoke all on function public.admin_staff_pins() from public, anon;
grant execute on function public.admin_staff_pins() to authenticated;


-- ═══════════════════════════════════════════════════════════════════════
-- 6. admin_set_staff_pin — admin types a new PIN by hand
--
-- Replaces the generated-PIN flow. Updates the auth password AND the stored
-- copy in one transaction, so the two can never disagree.
-- ═══════════════════════════════════════════════════════════════════════

create or replace function public.admin_set_staff_pin(
  p_user_role_id uuid,
  p_pin          text
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_denied    text;
  v_pin_error text;
  v_clash     text;
  v_me        uuid;
  v_target    record;
begin
  v_denied := public.can_manage_staff(p_user_role_id);
  if v_denied is not null then
    raise exception 'FORBIDDEN: %', v_denied;
  end if;

  select ur.id into v_me from public.user_roles ur
  where ur.user_id = auth.uid() and ur.is_active = true;

  select ur.id, ur.user_id, ur.name into v_target
  from public.user_roles ur where ur.id = p_user_role_id;

  -- Your own PIN goes through Change PIN, which verifies the current one first.
  if v_target.id = v_me then
    raise exception 'USE_CHANGE_PIN: use Change PIN to change your own PIN';
  end if;

  v_pin_error := public.is_pin_acceptable(p_pin);
  if v_pin_error is not null then
    raise exception 'BAD_PIN: %', v_pin_error;
  end if;

  v_clash := public.pin_in_use(p_pin, p_user_role_id);
  if v_clash is not null then
    raise exception 'PIN_TAKEN: that PIN is already used by %. Choose a different one.', v_clash;
  end if;

  update auth.users
  set encrypted_password = crypt(p_pin, gen_salt('bf', 10)),
      email_confirmed_at = coalesce(email_confirmed_at, now()),
      updated_at         = now()
  where id = v_target.user_id;

  insert into public.staff_pins (user_role_id, pin_encrypted, updated_at, updated_by, set_by_self)
  values (p_user_role_id, public.encrypt_pin(p_pin), now(), v_me, false)
  on conflict (user_role_id) do update
    set pin_encrypted = excluded.pin_encrypted,
        updated_at    = now(),
        updated_by    = excluded.updated_by,
        set_by_self   = false;

  return jsonb_build_object('pin', p_pin, 'name', v_target.name);
end $$;

revoke all on function public.admin_set_staff_pin(uuid, text) from public, anon;
grant execute on function public.admin_set_staff_pin(uuid, text) to authenticated;

-- Keep the old name working so nothing breaks mid-deploy.
create or replace function public.admin_reset_staff_pin(p_user_role_id uuid, p_pin text)
returns jsonb
language sql
security definer
set search_path = public, extensions, pg_temp
as $$ select public.admin_set_staff_pin(p_user_role_id, p_pin) $$;

revoke all on function public.admin_reset_staff_pin(uuid, text) from public, anon;
grant execute on function public.admin_reset_staff_pin(uuid, text) to authenticated;


-- ═══════════════════════════════════════════════════════════════════════
-- 7. change_my_pin — the operator changes their own
--
-- REPLACES the client-side supabase.auth.updateUser() call, which updated
-- auth.users and nothing else — leaving the admin's view showing the old PIN
-- forever. Silently wrong data is worse than no feature.
--
-- Verifying the current PIN here rather than in the browser is also better:
-- updateUser() does not require the old password, it trusts the session, and
-- operators leave phones unlocked on a porch for eight hours.
-- ═══════════════════════════════════════════════════════════════════════

create or replace function public.change_my_pin(p_current text, p_new text)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_me        record;
  v_pin_error text;
  v_clash     text;
  v_ok        boolean;
begin
  select ur.id, ur.user_id, ur.name into v_me
  from public.user_roles ur
  where ur.user_id = auth.uid() and ur.is_active = true;

  if v_me.id is null then
    raise exception 'FORBIDDEN: you are not signed in as an active user';
  end if;

  -- Verify the current PIN against the bcrypt hash. crypt(candidate, hash)
  -- re-hashes with the salt embedded in the stored hash, so equality means the
  -- candidate is correct.
  select (u.encrypted_password = crypt(p_current, u.encrypted_password))
    into v_ok
  from auth.users u where u.id = v_me.user_id;

  if v_ok is not true then
    raise exception 'WRONG_PIN: your current PIN is wrong';
  end if;

  if p_new = p_current then
    raise exception 'BAD_PIN: your new PIN must be different from your current one';
  end if;

  v_pin_error := public.is_pin_acceptable(p_new);
  if v_pin_error is not null then
    raise exception 'BAD_PIN: %', v_pin_error;
  end if;

  -- Same uniqueness rule as the admin path, but the message does NOT name the
  -- other person — an operator has no business learning who holds which PIN.
  v_clash := public.pin_in_use(p_new, v_me.id);
  if v_clash is not null then
    raise exception 'PIN_TAKEN: that PIN is already in use. Choose a different one.';
  end if;

  update auth.users
  set encrypted_password = crypt(p_new, gen_salt('bf', 10)),
      updated_at         = now()
  where id = v_me.user_id;

  insert into public.staff_pins (user_role_id, pin_encrypted, updated_at, updated_by, set_by_self)
  values (v_me.id, public.encrypt_pin(p_new), now(), v_me.id, true)
  on conflict (user_role_id) do update
    set pin_encrypted = excluded.pin_encrypted,
        updated_at    = now(),
        updated_by    = excluded.updated_by,
        set_by_self   = true;

  return jsonb_build_object('ok', true);
end $$;

revoke all on function public.change_my_pin(text, text) from public, anon;
grant execute on function public.change_my_pin(text, text) to authenticated;


-- ═══════════════════════════════════════════════════════════════════════
-- 8. admin_create_staff — now also stores the PIN and checks uniqueness
--
-- Only two things changed from 0006: a PIN_TAKEN check before creating, and the
-- encrypted PIN saved at the end. Authorisation and validation are identical —
-- a valet_admin's requested role and property are still DISCARDED, not
-- validated, and replaced with 'operator' plus their own property.
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

revoke all   on function public.admin_create_staff(text, text, text, text, uuid) from public, anon;
grant execute on function public.admin_create_staff(text, text, text, text, uuid) to authenticated;


-- ═══════════════════════════════════════════════════════════════════════
-- 9. BACKFILL
--
-- Users created before this migration have no stored PIN — their PIN exists
-- only as a bcrypt hash, which cannot be reversed. The admin view will show
-- "not recorded" for them until someone sets a new one. Nothing to do; this
-- block only documents why.
-- ═══════════════════════════════════════════════════════════════════════

commit;

-- ═══════════════════════════════════════════════════════════════════════
-- VERIFY
-- ═══════════════════════════════════════════════════════════════════════
--
-- -- 1. Where did the key land? (Vault is the stronger option)
-- select case when exists (select 1 from vault.secrets where name = 'valet_pin_key')
--             then 'Vault (strong)'
--             when exists (select 1 from public.app_secrets where name = 'valet_pin_key')
--             then 'app_secrets (weaker — enable supabase_vault and re-run)'
--             else 'MISSING' end as pin_key_location;
--
-- -- 2. Round-trip encryption (expect 573914):
-- select public.decrypt_pin(public.encrypt_pin('573914')) as should_be_573914;
--
-- -- 3. Nothing is readable without the functions (expect zero rows):
-- select grantee, table_name from information_schema.role_table_grants
-- where table_schema = 'public'
--   and table_name in ('staff_pins','app_secrets','staff_pin_access')
--   and grantee in ('anon','authenticated');
--
-- -- 4. Who has a stored PIN yet:
-- select ur.name, ur.phone,
--        (sp.user_role_id is not null) as pin_recorded
-- from public.user_roles ur
-- left join public.staff_pins sp on sp.user_role_id = ur.id
-- order by ur.name;
