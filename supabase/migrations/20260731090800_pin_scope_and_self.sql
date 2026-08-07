-- ═══════════════════════════════════════════════════════════════════════
-- 0009 — PIN SCOPE: ONE DOOR, AND YOUR OWN ROW
--
--   >>> RUN THIS IN THE SUPABASE SQL EDITOR, AFTER 0007 AND 0008. <<<
--
-- Safe to run more than once. If the editor warns about RLS, choose
-- "Run without RLS" — this migration creates no tables.
--
--
-- WHAT CHANGES
--
-- The bulk "Show PINs" button is gone from the UI, and with it the reason for
-- a function that decrypts EVERY PIN the caller may see in one call. Reading
-- a PIN is now something you do to ONE person, inside their Edit dialog.
--
-- That is a better shape for the thing the audit log is supposed to prove.
-- "viewed 12 PINs" tells you almost nothing after the fact; "viewed Rahul's
-- PIN at 21:04" is evidence. staff_pin_access gains a column to record it.
--
--
-- THE SCOPE RULES, IN ONE PLACE
--
--                        may VIEW a PIN                may SET a PIN
--   system_admin         anyone, including self        anyone, including self
--   valet_admin          self + operators at own       same
--                        property
--   operator             self only                     nobody — they use
--                                                      change_my_pin instead
--
-- Two functions rather than one, because those two columns genuinely differ
-- for an operator, and a single function with a boolean flag is how that
-- difference eventually gets passed wrong.
--
--
-- WHY AN OPERATOR STILL CANNOT SET A PIN THROUGH THIS DOOR
--
-- admin_set_staff_pin() does not ask for the current PIN. change_my_pin()
-- does. An operator's phone spends the shift unlocked on a porch counter, so
-- if they could reach admin_set_staff_pin() for their own row, anyone who
-- picked up that phone could lock them out of their own account without
-- knowing anything. Admins work at a desk, and the trade below is already
-- accepted for them.
--
--
-- THE TRADE THIS MAKES — READ IT BEFORE APPROVING
--
-- Until now, admin_set_staff_pin() refused to touch the CALLER's own row:
-- your own PIN had to go through Change PIN, which verifies the current one
-- first. That guard existed so that someone at an unattended admin laptop
-- could not silently lock the real admin out.
--
-- This migration removes it, because the request is for an admin to see and
-- change their own PIN in the same dialog as everyone else's.
--
-- Be clear that the guard is not merely being relaxed, it is being made
-- pointless: once the dialog DISPLAYS your current PIN, anyone sitting at
-- your unlocked laptop can read it and then walk through Change PIN anyway.
-- Showing the PIN is what removes the protection; allowing the write adds no
-- new exposure on top of that. It is one decision, not two.
--
-- What still holds: every view is logged with the viewer, the subject and the
-- timestamp, so this is detectable after the fact even though it is no longer
-- preventable.
-- ═══════════════════════════════════════════════════════════════════════

begin;


-- ═══════════════════════════════════════════════════════════════════════
-- 1. The access log learns WHOSE pin was read
--
-- Nullable, because rows written by the old bulk reader covered several
-- people at once and there is no honest single value to backfill them with.
-- A NULL here means "an old bulk view, subject not recorded" — which is the
-- truth, and better than inventing one.
-- ═══════════════════════════════════════════════════════════════════════

alter table public.staff_pin_access
  add column if not exists viewed_user_role_id uuid references public.user_roles(id);

create index if not exists staff_pin_access_subject_idx
  on public.staff_pin_access(viewed_user_role_id, viewed_at desc);


-- ═══════════════════════════════════════════════════════════════════════
-- 2. can_manage_staff — the WRITE scope
--
-- Unchanged except that an admin may now target their own row. Operators are
-- still refused outright: this is the administer-someone door, and an
-- operator administers nobody, including themselves.
-- ═══════════════════════════════════════════════════════════════════════

create or replace function public.can_manage_staff(p_target_user_role_id uuid)
returns text
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_me       uuid;
  v_role     text;
  v_property uuid;
  v_target   record;
begin
  select ur.id, ur.role, ur.property_id
    into v_me, v_role, v_property
  from public.user_roles ur
  where ur.user_id = auth.uid() and ur.is_active = true;

  if v_role is null then return 'you are not signed in as an active user'; end if;
  if v_role = 'system_admin' then return null; end if;
  if v_role <> 'valet_admin' then return 'you do not have permission to manage users'; end if;

  if p_target_user_role_id is null then return null; end if;   -- listing only

  -- NEW: a valet_admin may act on their own row. Previously this fell through
  -- to the "you can only manage operators" branch below and was refused,
  -- because a valet_admin is not an operator.
  if p_target_user_role_id = v_me then return null; end if;

  select ur.role, ur.property_id into v_target
  from public.user_roles ur where ur.id = p_target_user_role_id;

  if v_target.role is null           then return 'that user no longer exists';    end if;
  if v_target.role <> 'operator'     then return 'you can only manage operators'; end if;
  if v_target.property_id is distinct from v_property
                                     then return 'that user is not at your property'; end if;

  return null;
end $fn$;

revoke all    on function public.can_manage_staff(uuid) from public, anon;
grant execute on function public.can_manage_staff(uuid) to authenticated;


-- ═══════════════════════════════════════════════════════════════════════
-- 3. can_view_staff_pin — the READ scope
--
-- Everything the write scope allows, plus your own row for ANY role. An
-- operator reading back a PIN they already know and can already use is not a
-- disclosure; refusing it would only mean they cannot check what they typed.
-- ═══════════════════════════════════════════════════════════════════════

create or replace function public.can_view_staff_pin(p_target_user_role_id uuid)
returns text
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_me uuid;
begin
  select ur.id into v_me
  from public.user_roles ur
  where ur.user_id = auth.uid() and ur.is_active = true;

  if v_me is null then return 'you are not signed in as an active user'; end if;
  if p_target_user_role_id is null then return 'no user was given'; end if;
  if p_target_user_role_id = v_me then return null; end if;

  return public.can_manage_staff(p_target_user_role_id);
end $fn$;

revoke all    on function public.can_view_staff_pin(uuid) from public, anon;
grant execute on function public.can_view_staff_pin(uuid) to authenticated;


-- ═══════════════════════════════════════════════════════════════════════
-- 4. admin_staff_pin — read ONE person's PIN, and say so in the log
--
-- Replaces admin_staff_pins() (plural), dropped below.
--
-- Returns { pin, stored, set_by_self, updated_at }. `stored` is false for
-- anyone created before migration 0007: their PIN exists only as a bcrypt
-- hash, which cannot be reversed, so the dialog offers a new one instead of
-- pretending the field is empty.
-- ═══════════════════════════════════════════════════════════════════════

create or replace function public.admin_staff_pin(p_user_role_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $fn$
declare
  v_denied text;
  v_me     uuid;
  v_row    record;
begin
  v_denied := public.can_view_staff_pin(p_user_role_id);
  if v_denied is not null then
    raise exception 'FORBIDDEN: %', v_denied;
  end if;

  select ur.id into v_me
  from public.user_roles ur
  where ur.user_id = auth.uid() and ur.is_active = true;

  select sp.pin_encrypted, sp.set_by_self, sp.updated_at
    into v_row
  from public.staff_pins sp
  where sp.user_role_id = p_user_role_id;

  -- Logged BEFORE returning, and logged even when there is no PIN to show:
  -- the attempt is the thing worth recording, and a log that only captures
  -- successful reads is one an attacker can shape by failing.
  insert into public.staff_pin_access (viewer_id, viewed_user_role_id, viewed_count)
  values (v_me, p_user_role_id, case when v_row.pin_encrypted is null then 0 else 1 end);

  if v_row.pin_encrypted is null then
    return jsonb_build_object('stored', false, 'pin', null);
  end if;

  return jsonb_build_object(
    'stored',      true,
    'pin',         public.decrypt_pin(v_row.pin_encrypted),
    'set_by_self', v_row.set_by_self,
    'updated_at',  v_row.updated_at
  );
end $fn$;

revoke all    on function public.admin_staff_pin(uuid) from public, anon;
grant execute on function public.admin_staff_pin(uuid) to authenticated;


-- ═══════════════════════════════════════════════════════════════════════
-- 5. admin_set_staff_pin — self allowed, operators still refused
--
-- Two changes from 0007:
--   - the USE_CHANGE_PIN guard on your own row is gone (see the header)
--   - set_by_self is now recorded truthfully instead of always false
-- ═══════════════════════════════════════════════════════════════════════

create or replace function public.admin_set_staff_pin(
  p_user_role_id uuid,
  p_pin          text
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $fn$
declare
  v_denied    text;
  v_pin_error text;
  v_clash     text;
  v_me        uuid;
  v_my_role   text;
  v_target    record;
  v_is_self   boolean;
begin
  v_denied := public.can_manage_staff(p_user_role_id);
  if v_denied is not null then
    raise exception 'FORBIDDEN: %', v_denied;
  end if;

  select ur.id, ur.role into v_me, v_my_role
  from public.user_roles ur
  where ur.user_id = auth.uid() and ur.is_active = true;

  -- Belt and braces. can_manage_staff already refuses operators, but this is
  -- the function that can lock someone out of their own account, so the rule
  -- that protects the most exposed device in the system is restated where it
  -- applies rather than inherited from two functions away.
  if v_my_role = 'operator' then
    raise exception 'USE_CHANGE_PIN: use Change PIN to change your own PIN';
  end if;

  select ur.id, ur.user_id, ur.name into v_target
  from public.user_roles ur where ur.id = p_user_role_id;

  if v_target.id is null then
    raise exception 'NOT_FOUND: that user no longer exists';
  end if;

  v_is_self := v_target.id = v_me;

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
  values (p_user_role_id, public.encrypt_pin(p_pin), now(), v_me, v_is_self)
  on conflict (user_role_id) do update
    set pin_encrypted = excluded.pin_encrypted,
        updated_at    = now(),
        updated_by    = excluded.updated_by,
        set_by_self   = excluded.set_by_self;

  return jsonb_build_object('pin', p_pin, 'name', v_target.name, 'is_self', v_is_self);
end $fn$;

revoke all    on function public.admin_set_staff_pin(uuid, text) from public, anon;
grant execute on function public.admin_set_staff_pin(uuid, text) to authenticated;


-- ═══════════════════════════════════════════════════════════════════════
-- 6. Retire the bulk reader
--
-- Nothing calls it any more. Leaving a granted function that decrypts every
-- PIN the caller may see, for no feature, is free attack surface — and it is
-- the one function whose audit trail cannot say who was looked at.
-- ═══════════════════════════════════════════════════════════════════════

drop function if exists public.admin_staff_pins();

commit;


-- ═══════════════════════════════════════════════════════════════════════
-- VERIFY — every row should say PASS.
-- ═══════════════════════════════════════════════════════════════════════

with checks as (
  select 'admin_staff_pin (singular) exists' as item,
         to_regprocedure('public.admin_staff_pin(uuid)') is not null as ok
  union all select 'admin_staff_pins (bulk) is gone',
         to_regprocedure('public.admin_staff_pins()') is null
  union all select 'can_view_staff_pin exists',
         to_regprocedure('public.can_view_staff_pin(uuid)') is not null
  union all select 'access log records the subject',
         exists (select 1 from information_schema.columns
                 where table_schema = 'public' and table_name = 'staff_pin_access'
                   and column_name = 'viewed_user_role_id')
  union all select 'admin_set_staff_pin no longer blocks your own row',
         (select prosrc not like '%v_target.id = v_me then%'
          from pg_proc where oid = 'public.admin_set_staff_pin(uuid,text)'::regprocedure)
  union all select 'admin_set_staff_pin still blocks operators',
         (select prosrc like '%v_my_role = ''operator''%'
          from pg_proc where oid = 'public.admin_set_staff_pin(uuid,text)'::regprocedure)
  union all select 'admin_staff_pin IS callable by authenticated',
         has_function_privilege('authenticated', 'public.admin_staff_pin(uuid)', 'execute')
)
select item, case when ok then 'PASS' else 'FAIL' end as result
from checks
order by result desc, item;
