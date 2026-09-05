-- ═══════════════════════════════════════════════════════════════════════
-- MIGRATION 0067 — tell a valet firm when they are given a booking
--
-- On request: a new booking in Ambria should reach the valet it was assigned
-- to, as a phone notification and as an in-app one.
--
-- ── WHY THIS IS A POLLER ──────────────────────────────────────────────
-- The bookings live in AMBRIA's database. Nothing there calls us, and no row
-- of ours changes when a booking is made — so there is no trigger to hang this
-- off. A cron job that looks is the only mechanism available without asking
-- the Ambria side for a webhook, which is a much larger conversation: an
-- endpoint here, a secret in both directions, and their booking form calling
-- us on save. Worth having if two minutes ever matters. It does not today.
--
-- ── WHY ONE INSERT PRODUCES BOTH NOTIFICATIONS ────────────────────────
-- push_outbox is the push queue AND the in-app bell's feed — NotificationBell
-- selects from that table directly and lets RLS scope it. So one row gives the
-- phone notification and the bell, and they cannot disagree about what
-- happened. The push_outbox_send trigger already nudges push-send over pg_net
-- on insert, so nothing new is needed for delivery.
--
-- The bell's policy is push_outbox_select_own (0015), which matches on
-- user_role_id and names no role — a vendor passes it without a change.
--
-- ── WHAT THIS MIGRATION DOES AND DOES NOT DO ──────────────────────────
-- It creates the memory and the schedule. The comparing is done by the
-- ambria-bookings-sync Edge Function, because the feed key lives in an Edge
-- Function secret and must never be in a migration — this repository is
-- public. Same division as push-send and wa-dispatch.
--
--     MUST ALSO BE DEPLOYED, or this schedule calls nothing:
--     supabase functions deploy ambria-bookings-sync --no-verify-jwt
--
-- ── WHY THE FUNCTION NEEDS NO JWT ─────────────────────────────────────
-- pg_net sends no Authorization header, exactly as it does not for push-send.
-- That makes the endpoint publicly callable, which is only acceptable because
-- it is idempotent: ambria_booking_seen is the record of what has already been
-- announced, so a second call finds nothing to do. The cost of a stranger
-- calling it is one feed read against Ambria.
-- ═══════════════════════════════════════════════════════════════════════

begin;

-- ── 1. WHAT HAS ALREADY BEEN ANNOUNCED ────────────────────────────────
create table if not exists public.ambria_booking_seen (
  -- Ambria's own id, a TEXT string like 'v_1784526630906_412' — not a uuid.
  booking_id  text primary key,
  -- WHO IT WAS ANNOUNCED TO, and the reason this column exists rather than the
  -- table being a bare list of ids: a booking can be moved from one firm to
  -- another in Ambria. Storing the phone means the sync can tell "already
  -- announced" from "announced to somebody else", and the newly-assigned firm
  -- is told. Null for a booking nobody is on yet.
  valet_phone text,
  event_date  date,
  notified_at timestamptz not null default now()
);

comment on table public.ambria_booking_seen is
  'One row per Ambria booking this system has already announced, and to whom. '
  'Written by the ambria-bookings-sync Edge Function. It exists so that '
  'function is idempotent: without it every run would re-announce every '
  'booking, every two minutes.';

-- ── RLS: NOBODY IN THE APP READS THIS ─────────────────────────────────
-- It is bookkeeping for a server-side job. The sync uses the service role,
-- which bypasses RLS; enabling it with no policy means a browser holding the
-- anon or an authenticated key sees nothing, which is correct. A table left
-- without RLS would be readable by every signed-in user.
alter table public.ambria_booking_seen enable row level security;

-- Old rows are dead weight: a booking six months past cannot be announced
-- again because it is outside the window the sync looks at.
create index if not exists ambria_booking_seen_date_idx
  on public.ambria_booking_seen(event_date);


-- ── 2. WHERE THE SYNC LIVES ───────────────────────────────────────────
-- One line to change if the project ref ever does, matching
-- push_sender_url() from migration 0028.
create or replace function public.ambria_sync_url()
returns text
language sql
immutable
as $fn$
  select 'https://vyirixtdgheypbpffsct.supabase.co/functions/v1/ambria-bookings-sync'
$fn$;

comment on function public.ambria_sync_url() is
  'The ambria-bookings-sync Edge Function endpoint. Change this one line if '
  'the Supabase project changes.';


-- ── 3. THE NUDGE ──────────────────────────────────────────────────────
create or replace function public.request_ambria_sync()
returns void
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $fn$
begin
  perform net.http_post(
    url     := public.ambria_sync_url(),
    headers := '{"Content-Type": "application/json"}'::jsonb,
    body    := '{}'::jsonb,
    -- Generous: the function reads a 400-day range from another project's
    -- database. A timeout here costs nothing — the next tick is two minutes
    -- away and the work is idempotent.
    timeout_milliseconds := 60000
  );
exception when others then
  -- Swallowed for the same reason request_push_send() swallows: a cron tick
  -- that cannot reach the function must not leave an error in the log that
  -- looks like data loss. Nothing was lost; the next tick tries again.
  raise warning 'request_ambria_sync failed (the next tick will retry): %', sqlerrm;
end $fn$;

revoke execute on function public.request_ambria_sync() from public, anon, authenticated;

commit;


-- ═══════════════════════════════════════════════════════════════════════
-- THE SCHEDULE — every two minutes
--
-- Not every 30 seconds. A booking is next week's work, not a car waiting at a
-- porch: two minutes of delay costs nobody anything, and each tick reads a
-- 400-day range out of somebody else's database.
--
-- Not every 15 minutes either. Somebody making a booking in Ambria and then
-- telephoning the valet firm about it should not get there first.
-- ═══════════════════════════════════════════════════════════════════════

do $$
begin
  if not exists (select 1 from pg_extension where extname = 'pg_cron') then
    raise notice 'pg_cron is not installed — request_ambria_sync() exists but nothing calls it';
    return;
  end if;

  perform cron.unschedule('ambria-bookings-sync')
  where exists (select 1 from cron.job where jobname = 'ambria-bookings-sync');

  perform cron.schedule(
    'ambria-bookings-sync',
    '*/2 * * * *',
    $cron$ select public.request_ambria_sync(); $cron$
  );
  raise notice 'cron job scheduled: ambria-bookings-sync (every 2 minutes)';
end $$;


-- ═══════════════════════════════════════════════════════════════════════
-- VERIFY — every row must read PASS
-- ═══════════════════════════════════════════════════════════════════════
select check_name, case when ok then 'PASS' else 'FAIL' end as result
from (
  select 'the seen table exists' as check_name,
         to_regclass('public.ambria_booking_seen') is not null as ok

  -- The phone column is what tells "already announced" from "moved to somebody
  -- else". Without it a reassignment would never reach the new firm.
  union all select 'it remembers who each was announced to',
         exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'ambria_booking_seen'
                    and column_name = 'valet_phone')

  -- TEXT, not uuid. Ambria's ids look like 'v_1784526630906_412'.
  union all select 'the booking id is text',
         (select data_type = 'text' from information_schema.columns
           where table_schema = 'public' and table_name = 'ambria_booking_seen'
             and column_name = 'booking_id')

  -- Primary key, or the upsert has nothing to conflict on and every run
  -- inserts duplicates instead of updating.
  union all select 'the booking id is the primary key',
         exists (select 1 from pg_constraint
                  where conrelid = 'public.ambria_booking_seen'::regclass
                    and contype = 'p')

  union all select 'no signed-in user can read it',
         (select relrowsecurity from pg_class
           where oid = 'public.ambria_booking_seen'::regclass)

  union all select 'and it has no policy letting them',
         not exists (select 1 from pg_policies
                      where schemaname = 'public' and tablename = 'ambria_booking_seen')

  -- ── THE PLUMBING ────────────────────────────────────────────────────
  union all select 'the sync url is defined',
         to_regprocedure('public.ambria_sync_url()') is not null

  union all select 'it points at ambria-bookings-sync',
         (select prosrc like '%ambria-bookings-sync%' from pg_proc
           where pronamespace = 'public'::regnamespace and proname = 'ambria_sync_url')

  union all select 'the nudge exists',
         to_regprocedure('public.request_ambria_sync()') is not null

  -- It must never raise: a cron tick that cannot reach the function is not an
  -- incident, and an exception here would fill the log as if it were.
  union all select 'the nudge cannot raise',
         (select prosrc like '%exception when others%' from pg_proc
           where pronamespace = 'public'::regnamespace and proname = 'request_ambria_sync')

  union all select 'staff cannot call the nudge',
         not has_function_privilege('authenticated', 'public.request_ambria_sync()', 'execute')

  union all select 'the job is scheduled',
         (select count(*) = 1 from cron.job where jobname = 'ambria-bookings-sync')

  union all select 'it runs every two minutes',
         (select schedule = '*/2 * * * *' from cron.job where jobname = 'ambria-bookings-sync')

  -- ── WHAT DELIVERY DEPENDS ON, UNCHANGED ─────────────────────────────
  -- The sync only inserts into push_outbox. If this trigger were gone the rows
  -- would sit queued until the next sweep and the notification would be late
  -- for a reason nothing here would explain.
  union all select 'push_outbox still nudges the sender on insert',
         exists (select 1 from pg_trigger
                  where tgrelid = 'public.push_outbox'::regclass
                    and tgname = 'push_outbox_send' and not tgisinternal)

  -- And the function it calls. Two checks because the names differ by a
  -- prefix — the trigger is push_outbox_send, the function it executes is
  -- trg_push_outbox_send — and asserting the wrong one is a check that fails
  -- while the code works.
  union all select 'and the function behind it is there',
         to_regprocedure('public.trg_push_outbox_send()') is not null

  -- The bell reads push_outbox under this policy, and it matches on
  -- user_role_id without naming a role — which is why a vendor sees their own
  -- notifications with no change to it.
  union all select 'the bell policy admits any role',
         exists (select 1 from pg_policies
                  where schemaname = 'public' and tablename = 'push_outbox'
                    and policyname = 'push_outbox_select_own')

  -- 0065/0066: without the role there is nobody to notify.
  union all select 'the vendor role exists',
         (select pg_get_constraintdef(oid) ilike '%valet_vendor%' from pg_constraint
           where conrelid = 'public.user_roles'::regclass
             and conname = 'user_roles_role_check')
) t
order by ok, check_name;
