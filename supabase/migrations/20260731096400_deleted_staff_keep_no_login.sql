-- ═══════════════════════════════════════════════════════════════════════
-- MIGRATION 0064 — let a deleted user have no login
--
-- FIXES A BUG IN 0063. admin_delete_staff() has never worked: every call
-- raises 23502 and the screen says "Something went wrong."
--
-- ── WHAT 0063 GOT WRONG ───────────────────────────────────────────────
-- Its whole design is that the user_roles row SURVIVES a delete — Records
-- reads "who parked this car" through a live join on it, so removing the row
-- would blank the operator's name across their entire history — and that what
-- actually gets destroyed is the LOGIN:
--
--     update public.user_roles
--        set user_id = null,        -- belongs to no auth account any more
--            phone   = null,        -- the number frees up for the next hire
--            deleted_at = now()
--
-- Both of those columns are NOT NULL, and have been since long before 0063:
--
--     0002 fixes_and_hardening   alter column user_id set not null
--     0004 phone_pin_login       alter column phone   set not null
--
-- I did not check, and neither constraint is anywhere near the code I was
-- reading. The function is otherwise right; it simply cannot run.
--
-- ── WHY THE CONSTRAINTS ARE NOT JUST DROPPED ──────────────────────────
-- They are load-bearing for every LIVE row and were added deliberately:
--
--   user_id  a role row with no auth account is a person who can never sign
--            in and whom no admin can fix from the UI — 0002 added this after
--            exactly that state existed.
--   phone    the phone IS the login identity here. A live row without one
--            cannot authenticate and cannot be found by the admin searching
--            for them.
--
-- Dropping them outright would let the next bug write a null into an ACTIVE
-- row and reintroduce precisely what those migrations closed off.
--
-- So the guarantee is narrowed rather than removed: it now applies to every
-- row that is not a tombstone. A deleted row may have neither; a live row must
-- have both, and the database still refuses anything else.
--
-- ── THE PHONE FORMAT CHECK NEEDS NO CHANGE ────────────────────────────
-- 0004 also added
--
--     check (phone ~ '^[6-9][0-9]{9}$')
--
-- and a null phone passes it already: `null ~ anything` is NULL, and a CHECK
-- rejects only an outright false. Verified below rather than assumed.
--
-- ── NULLS AND UNIQUENESS ──────────────────────────────────────────────
-- Postgres treats nulls as distinct in a unique index, so any number of
-- deleted rows can hold null user_id and null phone without colliding. That is
-- what makes this work for more than the first deletion.
-- ═══════════════════════════════════════════════════════════════════════

begin;

-- ── 1. ALLOW THE TOMBSTONE ────────────────────────────────────────────
alter table public.user_roles alter column user_id drop not null;
alter table public.user_roles alter column phone   drop not null;


-- ── 2. AND KEEP THE GUARANTEE WHERE IT MATTERS ────────────────────────
-- NOT VALID is deliberately NOT used: this must apply to the rows already in
-- the table too, and if any existing row somehow breaks it, that is something
-- to find out now rather than at the next unrelated write.
alter table public.user_roles
  drop constraint if exists user_roles_live_identity_chk;

alter table public.user_roles
  add constraint user_roles_live_identity_chk check (
    deleted_at is not null
    or (user_id is not null and phone is not null)
  );

comment on constraint user_roles_live_identity_chk on public.user_roles is
  'A live staff row must have both an auth account and a phone number — the '
  'two halves of being able to sign in. Only a row deleted by '
  'admin_delete_staff() (deleted_at set) may have neither: its login was '
  'destroyed on purpose and its number released for the next hire, while the '
  'row itself stays so parked_by / fetched_by keep resolving for every car '
  'that person handled.';

commit;


-- ═══════════════════════════════════════════════════════════════════════
-- VERIFY — every row must read PASS
-- ═══════════════════════════════════════════════════════════════════════
select check_name, case when ok then 'PASS' else 'FAIL' end as result
from (
  -- ── THE BUG IS GONE ─────────────────────────────────────────────────
  select 'user_id may now be null' as check_name,
         (select not attnotnull from pg_attribute
           where attrelid = 'public.user_roles'::regclass
             and attname = 'user_id' and attnum > 0) as ok

  union all select 'phone may now be null',
         (select not attnotnull from pg_attribute
           where attrelid = 'public.user_roles'::regclass
             and attname = 'phone' and attnum > 0)

  -- ── AND THE GUARANTEE SURVIVED ──────────────────────────────────────
  union all select 'the live-row identity check exists',
         exists (select 1 from pg_constraint
                  where conrelid = 'public.user_roles'::regclass
                    and conname = 'user_roles_live_identity_chk')

  union all select 'it is validated against existing rows',
         (select convalidated from pg_constraint
           where conrelid = 'public.user_roles'::regclass
             and conname = 'user_roles_live_identity_chk')

  -- The check must mention deleted_at, or it is not scoped to tombstones and
  -- would reject the very update it exists to permit.
  union all select 'it exempts deleted rows only',
         (select pg_get_constraintdef(oid) like '%deleted_at%' from pg_constraint
           where conrelid = 'public.user_roles'::regclass
             and conname = 'user_roles_live_identity_chk')

  -- ── NOTHING LIVE IS BROKEN RIGHT NOW ────────────────────────────────
  union all select 'no live row is missing its login',
         not exists (select 1 from public.user_roles
                      where deleted_at is null
                        and (user_id is null or phone is null))

  -- ── THE DEPENDENCIES 0063 NEEDS ─────────────────────────────────────
  union all select '0063 is applied: deleted_at exists',
         exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'user_roles'
                    and column_name = 'deleted_at')

  union all select '0063 is applied: admin_delete_staff exists',
         to_regprocedure('public.admin_delete_staff(uuid)') is not null

  -- The function still nulls both. If a later edit stops doing that, this
  -- migration is dead weight and the next reader should be told so.
  union all select 'the delete still detaches the login',
         (select regexp_replace(prosrc, '--.*', '', 'gn') like '%user_id    = null%'
            from pg_proc
           where pronamespace = 'public'::regnamespace and proname = 'admin_delete_staff')

  union all select 'the delete still releases the number',
         (select regexp_replace(prosrc, '--.*', '', 'gn') like '%phone      = null%'
            from pg_proc
           where pronamespace = 'public'::regnamespace and proname = 'admin_delete_staff')

  -- ── THE FORMAT CHECK STILL TOLERATES NULL ───────────────────────────
  -- Asserted, not assumed: if this ever became `phone is not null and phone ~
  -- ...`, deletion would start failing again with a different code.
  union all select 'a null phone passes the format check',
         (select coalesce((null::text ~ '^[6-9][0-9]{9}$') is not false, false))

  union all select 'the format check is still there for real numbers',
         exists (select 1 from pg_constraint
                  where conrelid = 'public.user_roles'::regclass
                    and conname = 'user_roles_phone_format_chk')
) t
order by ok, check_name;
