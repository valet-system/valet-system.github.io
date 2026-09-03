-- ═══════════════════════════════════════════════════════════════════════
-- MIGRATION 0063 — a system admin can delete an inactive user
--
-- On request: once a valet admin or a system admin has deactivated somebody,
-- the system admin should be able to remove them from the Inactive list for
-- good, rather than leaving that list to grow for ever.
--
-- ── WHY THE ROW IS NOT ACTUALLY DELETED ───────────────────────────────
-- Because deleting it destroys the record of every car that person handled,
-- and it does so silently.
--
-- vehicle_records does not store who parked a car. Migration 0021 decided that
-- deliberately — "a second copy of a fact is a second thing that can be wrong"
-- — so parked_by and fetched_by are read live:
--
--     select ur.name from valet_tasks t
--       join user_roles ur on ur.id = t.assigned_operator_id
--      where t.vehicle_id = v.id and t.task_type = 'parking'
--
-- That join is the only place the name exists. Take the row away and every car
-- they ever parked reads a dash in Records, in Analytics and in the report API
-- — for the whole history, not just recent days.
--
-- A real DELETE cannot even reach that point. Five foreign keys point at
-- user_roles with no ON DELETE clause:
--
--     valet_tasks.assigned_operator_id      who parked / fetched
--     reviews.operator_id                   whose work was rated
--     staff_pins.updated_by                 who set a PIN
--     staff_pin_access.viewer_id            who looked at a PIN
--     staff_pin_access.viewed_user_role_id  whose PIN was looked at
--
-- So `delete from user_roles` raises 23503 for anybody who has ever touched a
-- car — which is every operator worth removing. The feature would refuse in
-- exactly the cases it is wanted for.
--
-- ── WHAT IS DELETED INSTEAD: THE ACCOUNT ──────────────────────────────
-- What the admin wants gone is the PERSON — off the list, unable to sign in,
-- their phone number free for the next hire. None of that is the user_roles
-- row; all of it is the login attached to it. So this takes the login apart
-- and leaves the historical record standing:
--
--     user_id     -> null       the row belongs to no login any more
--     auth.users  DELETED       they cannot sign in, and the email frees up
--     phone       -> null       admin_create_staff can reuse the number
--     staff_pins  DELETED       the PIN went with the login it opened
--     push subs   DELETED       no notification reaches their old device
--     deleted_at  -> now()      the row stops appearing in the staff list
--
-- ── ORDER IS LOAD-BEARING ─────────────────────────────────────────────
-- user_roles.user_id references auth.users ON DELETE CASCADE. Delete the auth
-- row first and the user_roles row goes with it — the exact outcome this
-- migration exists to avoid. So user_id is nulled FIRST, and only then is the
-- auth row removed. Both happen in one transaction, so there is no moment when
-- a live login points at a row that is already gone.
--
-- ── WHY THE PHONE HAS TO BE CLEARED ───────────────────────────────────
-- admin_create_staff refuses a number on two separate counts, and both have to
-- be cleared or the number is burned for ever:
--
--     select ur.name ... where ur.phone = v_phone    -> PHONE_TAKEN
--     exists (... auth.users where email = ...)      -> PHONE_TAKEN
--
-- Leaving either behind gives the next admin "that number is already
-- registered to Lakshman" while no Lakshman is visible anywhere — a dead end
-- with no way out through the UI.
--
-- ── WHAT THIS IS NOT ──────────────────────────────────────────────────
-- Not reversible. The login is gone; re-adding the person creates a new
-- account with a new PIN, and their old cars stay attached to the old row.
--
-- Not a way to hide somebody from the records. The name still stands against
-- every car they handled, which is the whole point of keeping the row.
-- ═══════════════════════════════════════════════════════════════════════

begin;

-- ── 1. THE MARKER ─────────────────────────────────────────────────────
alter table public.user_roles
  add column if not exists deleted_at timestamptz;

comment on column public.user_roles.deleted_at is
  'Set by admin_delete_staff(). The login has been destroyed and the row is '
  'hidden from the staff list, but the row itself is kept so parked_by and '
  'fetched_by still resolve for every car this person handled. Never set by '
  'hand.';

-- The staff list reads user_roles directly and now filters on this column.
create index if not exists user_roles_live_idx
  on public.user_roles(role, name)
  where deleted_at is null;


-- ── 2. THE DELETE ─────────────────────────────────────────────────────
create or replace function public.admin_delete_staff(p_user_role_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_caller_id   uuid;
  v_caller_role text;
  v_target      record;
  v_cars        bigint;
begin
  -- ── WHO IS ASKING ───────────────────────────────────────────────────
  select ur.id, ur.role
    into v_caller_id, v_caller_role
  from public.user_roles ur
  where ur.user_id = auth.uid()
    and ur.is_active = true
    and ur.deleted_at is null;

  if v_caller_role is null then
    raise exception 'FORBIDDEN: you are not signed in as an active user';
  end if;

  -- SYSTEM ADMIN ONLY. A valet admin can deactivate somebody, and that is
  -- undone with one tap. Destroying a login is not, so it sits one level up —
  -- which is what was asked for.
  if v_caller_role <> 'system_admin' then
    raise exception 'FORBIDDEN: only a system admin can delete a user';
  end if;

  select ur.id, ur.name, ur.role, ur.user_id, ur.phone, ur.is_active, ur.deleted_at
    into v_target
  from public.user_roles ur
  where ur.id = p_user_role_id;

  if v_target.id is null then
    raise exception 'NOT_FOUND: that user no longer exists';
  end if;

  -- Idempotent rather than an error: two admins on the list at once, or one
  -- double tap on a slow connection, should not report a failure for work that
  -- is already done.
  if v_target.deleted_at is not null then
    return jsonb_build_object('code', 'already_deleted', 'name', v_target.name);
  end if;

  -- INACTIVE ONLY. The button lives in the Inactive list, and deactivation is
  -- the deliberate step before this one: somebody decided this person is
  -- finished before anybody decided to erase their login.
  if v_target.is_active then
    raise exception 'STILL_ACTIVE: deactivate % first', v_target.name;
  end if;

  -- Not yourself. A signed-in system admin is never inactive, so the UI cannot
  -- produce this; it is here because the RPC is reachable without the UI.
  if v_target.id = v_caller_id then
    raise exception 'FORBIDDEN: you cannot delete your own account';
  end if;

  -- ── HOW MUCH HISTORY STAYS BEHIND ───────────────────────────────────
  -- Counted for the caller, not as a veto. The cars are not going anywhere and
  -- neither is the name against them; the number is returned so the screen can
  -- say what was kept, instead of leaving the admin to wonder whether the
  -- records went too.
  select count(*) into v_cars
  from public.valet_tasks t
  where t.assigned_operator_id = v_target.id;

  -- ── TAKE THE LOGIN APART ────────────────────────────────────────────
  -- user_id FIRST — see the header. auth.users cascades to this row, so
  -- deleting the auth account before this update takes the history with it.
  update public.user_roles
     set user_id    = null,
         phone      = null,
         is_active  = false,
         deleted_at = now()
   where id = v_target.id;

  -- Now the login itself. Nothing points at it any more.
  if v_target.user_id is not null then
    delete from auth.users where id = v_target.user_id;
  end if;

  -- The PIN opened a login that no longer exists.
  delete from public.staff_pins where user_role_id = v_target.id;

  -- Their phone must stop buzzing. These rows are keyed on the user_role,
  -- which survives, so nothing else would ever remove them.
  delete from public.push_subscriptions where user_role_id = v_target.id;
  delete from public.push_outbox
   where user_role_id = v_target.id
     and status in ('queued', 'sending');

  -- staff_pin_access is deliberately LEFT ALONE. It records who looked at
  -- whose PIN, and an audit trail the most privileged account can erase is not
  -- an audit trail.

  return jsonb_build_object(
    'code',      'deleted',
    'name',      v_target.name,
    'role',      v_target.role,
    'cars_kept', v_cars
  );
end $fn$;

revoke all    on function public.admin_delete_staff(uuid) from public, anon;
grant execute on function public.admin_delete_staff(uuid) to authenticated;

commit;


-- ═══════════════════════════════════════════════════════════════════════
-- VERIFY — every row must read PASS
-- ═══════════════════════════════════════════════════════════════════════
select check_name, case when ok then 'PASS' else 'FAIL' end as result
from (
  select 'deleted_at exists' as check_name,
         exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'user_roles'
                    and column_name = 'deleted_at') as ok

  union all select 'admin_delete_staff exists',
         to_regprocedure('public.admin_delete_staff(uuid)') is not null

  union all select 'the partial index exists',
         exists (select 1 from pg_indexes
                  where schemaname = 'public' and indexname = 'user_roles_live_idx')

  -- ── THE GUARDS ──────────────────────────────────────────────────────
  -- Comments stripped: the header and the body both discuss these strings, and
  -- prosrc includes comments, so a plain `like` would pass on the prose that
  -- explains the check rather than on the check itself. The 'n' flag stops the
  -- dot at a line end, so '--.*' is exactly one comment.
  union all select 'only a system admin may delete',
         (select regexp_replace(prosrc, '--.*', '', 'gn')
                   like '%v_caller_role <> ''system_admin''%'
            from pg_proc
           where pronamespace = 'public'::regnamespace and proname = 'admin_delete_staff')

  union all select 'an active user cannot be deleted',
         (select regexp_replace(prosrc, '--.*', '', 'gn') like '%STILL_ACTIVE%'
            from pg_proc
           where pronamespace = 'public'::regnamespace and proname = 'admin_delete_staff')

  union all select 'you cannot delete yourself',
         (select regexp_replace(prosrc, '--.*', '', 'gn')
                   like '%v_target.id = v_caller_id%'
            from pg_proc
           where pronamespace = 'public'::regnamespace and proname = 'admin_delete_staff')

  -- ── THE ORDER THAT SAVES THE HISTORY ────────────────────────────────
  -- user_id must be nulled BEFORE the auth row goes, or the cascade takes the
  -- user_roles row and every parked_by with it. Asserted by position, because
  -- both statements existing in either order looks identical otherwise.
  union all select 'user_id is nulled before the auth row is deleted',
         (select position('user_id    = null' in regexp_replace(prosrc, '--.*', '', 'gn'))
                 < position('delete from auth.users' in regexp_replace(prosrc, '--.*', '', 'gn'))
            from pg_proc
           where pronamespace = 'public'::regnamespace and proname = 'admin_delete_staff')

  union all select 'the login is actually destroyed',
         (select regexp_replace(prosrc, '--.*', '', 'gn') like '%delete from auth.users%'
            from pg_proc
           where pronamespace = 'public'::regnamespace and proname = 'admin_delete_staff')

  -- ── WHAT MUST NOT HAPPEN ────────────────────────────────────────────
  -- The whole design rests on the user_roles row surviving. If a future edit
  -- adds a real delete, parked_by breaks for that person's entire history.
  union all select 'it never deletes the user_roles row',
         (select regexp_replace(prosrc, '--.*', '', 'gn') not like '%delete from public.user_roles%'
            from pg_proc
           where pronamespace = 'public'::regnamespace and proname = 'admin_delete_staff')

  -- The audit trail is not the admin's to erase.
  union all select 'it never touches staff_pin_access',
         (select regexp_replace(prosrc, '--.*', '', 'gn') not like '%delete from public.staff_pin_access%'
            from pg_proc
           where pronamespace = 'public'::regnamespace and proname = 'admin_delete_staff')

  -- ── THE NUMBER MUST COME FREE ───────────────────────────────────────
  -- Both PHONE_TAKEN checks in admin_create_staff have to be cleared, or the
  -- next hire cannot be given that number and nothing on screen says why.
  union all select 'the phone number is released',
         (select regexp_replace(prosrc, '--.*', '', 'gn') like '%phone      = null%'
            from pg_proc
           where pronamespace = 'public'::regnamespace and proname = 'admin_delete_staff')

  union all select 'the PIN is released',
         (select regexp_replace(prosrc, '--.*', '', 'gn') like '%delete from public.staff_pins%'
            from pg_proc
           where pronamespace = 'public'::regnamespace and proname = 'admin_delete_staff')

  union all select 'their device stops receiving pushes',
         (select regexp_replace(prosrc, '--.*', '', 'gn') like '%delete from public.push_subscriptions%'
            from pg_proc
           where pronamespace = 'public'::regnamespace and proname = 'admin_delete_staff')

  -- ── PERMISSIONS ─────────────────────────────────────────────────────
  -- Staff must be able to call it (the role check inside decides), and the
  -- public internet must not.
  union all select 'signed-in staff may call it',
         has_function_privilege('authenticated', 'public.admin_delete_staff(uuid)', 'execute')

  union all select 'anon may NOT call it',
         not has_function_privilege('anon', 'public.admin_delete_staff(uuid)', 'execute')

  -- ── THE DEPENDENCY THE WHOLE THING PROTECTS ─────────────────────────
  -- If vehicle_records ever stops joining user_roles, this design is moot and
  -- the next reader should know it changed.
  union all select 'vehicle_records still reads the name from user_roles',
         (select prosrc like '%join public.user_roles ur on ur.id = t.assigned_operator_id%'
            from pg_proc
           where pronamespace = 'public'::regnamespace and proname = 'vehicle_records')

  -- Nothing should be deleted yet.
  union all select 'no user is marked deleted yet',
         not exists (select 1 from public.user_roles where deleted_at is not null)
) t
order by ok, check_name;
