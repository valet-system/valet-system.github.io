-- ═══════════════════════════════════════════════════════════════════════
-- MIGRATION 0076 — EMAIL LAST MONTH'S GUESTS ON THE 2ND
--
--   >>> RUN THIS IN THE SUPABASE SQL EDITOR. <<<
--
-- Safe to run more than once.
--
-- On request: on the 2nd of every month, a CSV of every guest who came the
-- month before — name and phone (+91…) — goes to sales@ambria.in.
--
-- ── DIVISION OF LABOUR ────────────────────────────────────────────────
-- This migration is the memory and the schedule. Reading the guests, building
-- the file and talking to Resend is the guest-export Edge Function, because
-- the Resend API key lives in an Edge Function secret and must never be in a
-- migration — this repository is public. Same split as ambria-bookings-sync.
--
--     MUST ALSO BE DEPLOYED, or this schedule calls nothing:
--     supabase functions deploy guest-export --no-verify-jwt
--
--     SECRETS (Supabase → Edge Functions → Secrets):
--       RESEND_API_KEY, GUEST_EXPORT_FROM, and optionally GUEST_EXPORT_TO
--       (defaults to sales@ambria.in) and GUEST_EXPORT_KEY (manual runs).
--
-- ── WHY THE SCHEDULE FIRES SEVERAL TIMES ON THE 2ND ───────────────────
-- Five ticks, hourly from 10:00 to 14:00 IST (04:30–08:30 UTC). The function
-- records each month in guest_export_log, so the first success wins and the
-- rest find 'sent' and do nothing. The extra ticks are the retry: if Resend
-- is down at ten, the file still goes out at eleven without anyone noticing.
-- A failed attempt is marked 'failed' and the next tick takes it over.
--
-- ── WHY THE FUNCTION NEEDS NO JWT ─────────────────────────────────────
-- pg_net sends no Authorization header. The function is idempotent per month
-- and its recipient is fixed in a secret, so a stranger calling it can cause
-- at most the one send that was due anyway. See the function's header.
-- ═══════════════════════════════════════════════════════════════════════

begin;

-- ── 1. WHAT HAS ALREADY BEEN SENT ─────────────────────────────────────
create table if not exists public.guest_export_log (
  -- The first day of the month the file COVERS, not the day it was sent.
  month       date primary key,
  status      text not null default 'sending'
              check (status in ('sending', 'sent', 'failed')),
  claimed_at  timestamptz not null default now(),
  sent_at     timestamptz,
  row_count   int,
  recipient   text,
  provider_id text,
  error       text
);

comment on table public.guest_export_log is
  'One row per month the guest CSV was attempted. Written by the guest-export '
  'Edge Function. It is what makes that function idempotent: a second call for '
  'the same month finds status = sent and does nothing.';

-- RLS on, no policy: nobody in the app reads this. The Edge Function uses the
-- service role, which bypasses RLS.
alter table public.guest_export_log enable row level security;


-- ── 2. WHERE THE FUNCTION LIVES ───────────────────────────────────────
create or replace function public.guest_export_url()
returns text
language sql
immutable
as $fn$
  select 'https://vyirixtdgheypbpffsct.supabase.co/functions/v1/guest-export'
$fn$;


-- ── 3. THE NUDGE ──────────────────────────────────────────────────────
create or replace function public.request_guest_export()
returns void
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $fn$
begin
  perform net.http_post(
    url     := public.guest_export_url(),
    headers := '{"Content-Type": "application/json"}'::jsonb,
    body    := '{}'::jsonb,
    timeout_milliseconds := 60000
  );
exception when others then
  -- A tick that cannot reach the function loses nothing: the next one is an
  -- hour away and the work is idempotent.
  raise warning 'request_guest_export failed (the next tick will retry): %', sqlerrm;
end $fn$;

revoke execute on function public.request_guest_export() from public, anon, authenticated;

commit;


-- ═══════════════════════════════════════════════════════════════════════
-- THE SCHEDULE — 2nd of the month, hourly 04:30–08:30 UTC (10:00–14:00 IST)
-- ═══════════════════════════════════════════════════════════════════════

do $$
begin
  if not exists (select 1 from pg_extension where extname = 'pg_cron') then
    raise notice 'pg_cron is not installed — request_guest_export() exists but nothing calls it';
    return;
  end if;

  perform cron.unschedule('guest-export-monthly')
  where exists (select 1 from cron.job where jobname = 'guest-export-monthly');

  perform cron.schedule(
    'guest-export-monthly',
    '30 4-8 2 * *',
    $cron$ select public.request_guest_export(); $cron$
  );
  raise notice 'cron job scheduled: guest-export-monthly (2nd of the month, hourly 10:00-14:00 IST)';
end $$;


-- ═══════════════════════════════════════════════════════════════════════
-- VERIFY — every row must read PASS
-- ═══════════════════════════════════════════════════════════════════════
select check_name, case when ok then 'PASS' else 'FAIL' end as result
from (
  select 'the send log exists' as check_name,
         to_regclass('public.guest_export_log') is not null as ok

  union all select 'the month is the primary key',
         exists (select 1 from pg_constraint
                  where conrelid = 'public.guest_export_log'::regclass
                    and contype = 'p')

  union all select 'no signed-in user can read the log',
         (select relrowsecurity from pg_class
           where oid = 'public.guest_export_log'::regclass)

  union all select 'and it has no policy letting them',
         not exists (select 1 from pg_policies
                      where schemaname = 'public' and tablename = 'guest_export_log')

  union all select 'the url points at guest-export',
         (select prosrc ilike '%/guest-export%' from pg_proc
           where pronamespace = 'public'::regnamespace and proname = 'guest_export_url')

  union all select 'the nudge exists',
         to_regprocedure('public.request_guest_export()') is not null

  -- Comments stripped first: prosrc includes them, and a mention of "exception"
  -- in a comment would otherwise pass this on its own.
  union all select 'the nudge cannot raise',
         (select regexp_replace(prosrc, '--[^\n]*', '', 'g') ilike '%exception when others%'
            from pg_proc
           where pronamespace = 'public'::regnamespace and proname = 'request_guest_export')

  union all select 'staff cannot call the nudge',
         not has_function_privilege('authenticated', 'public.request_guest_export()', 'execute')

  union all select 'the job is scheduled',
         (select count(*) = 1 from cron.job where jobname = 'guest-export-monthly')

  union all select 'it runs on the 2nd only',
         (select schedule = '30 4-8 2 * *' from cron.job where jobname = 'guest-export-monthly')
) t
order by ok, check_name;
