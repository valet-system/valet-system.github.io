-- ═══════════════════════════════════════════════════════════════════════
-- 0028 — THE OUTBOX SENDS ITSELF. NO DASHBOARD WEBHOOK REQUIRED.
--
-- ══ THE BUG THIS FIXES ══
--
-- push_outbox rows were being written correctly and NOTHING WAS SENDING THEM.
-- The design expected a Supabase Database Webhook, configured by hand in the
-- dashboard, to call the push-send function on every INSERT. That webhook was
-- never working: a manual call to push-send answered
--
--     {"ok":true,"sent":0,"failed":1,"no_device":6,"batch":7}
--
-- and a batch of 7 is the proof. If a webhook had been firing per INSERT, rows
-- could never have accumulated — each would have been drained as it arrived.
-- They had been piling up since the feature was built.
--
-- So notifications never reached a closed app on ANY platform. That looked like
-- an Android battery-saver quirk and then like an iOS limitation, and it was
-- neither: the sender was simply never called.
--
-- ══ WHY A TRIGGER MAY MAKE AN HTTP CALL HERE, WHEN 0014 SAID IT MUST NOT ══
--
-- Migration 0014 refused to let a trigger call out, for a good reason: a
-- SYNCHRONOUS request holds its transaction open across the network, so a slow
-- push service would slow down — or roll back — an operator's tap on "Car
-- Parked".
--
-- pg_net is not synchronous. net.http_post() only WRITES A ROW to pg_net's own
-- queue and returns immediately; a background worker performs the request after
-- the transaction has committed. The objection does not apply, and the outbox
-- stays exactly where it was — this only rings the bell that someone should
-- come and drain it.
--
-- ══ WHY NO KEY APPEARS IN THIS FILE ══
--
-- push-send is deployed with verify_jwt = false (see supabase/config.toml for
-- why that is required and what it does and does not expose), so this call
-- needs no Authorization header at all. That matters because THIS REPOSITORY IS
-- PUBLIC: a Database Webhook created in the dashboard stores the service_role
-- key inside the trigger definition, and the equivalent migration would have
-- committed that key to GitHub. The service_role key bypasses every RLS policy
-- in the database.
--
-- ══ BELT AND BRACES ══
--
-- The trigger fires per row, which is instant. A once-a-minute cron job then
-- sweeps anything the trigger missed — pg_net dropping a request, the function
-- cold-starting past its timeout, a burst larger than one batch of 50. Without
-- the sweep a single lost request means a car nobody is told about.
--
-- Safe to re-run.
-- ═══════════════════════════════════════════════════════════════════════

begin;

-- ═══════════════════════════════════════════════════════════════════════
-- pg_net
-- ═══════════════════════════════════════════════════════════════════════

create extension if not exists pg_net with schema extensions;


-- ═══════════════════════════════════════════════════════════════════════
-- Where push-send lives.
--
-- Kept in a function rather than repeated at both call sites, so moving the
-- project means editing ONE line. Not a secret: the endpoint is public by
-- design, and all an unwanted caller can make it do is deliver messages that
-- are already queued to the devices they were already addressed to.
-- ═══════════════════════════════════════════════════════════════════════

create or replace function public.push_sender_url()
returns text
language sql
immutable
as $fn$
  select 'https://vyirixtdgheypbpffsct.supabase.co/functions/v1/push-send'
$fn$;

comment on function public.push_sender_url() is
  'The push-send Edge Function endpoint. Change this one line if the Supabase project changes.';


-- ═══════════════════════════════════════════════════════════════════════
-- Ask the sender to run.
--
-- Deliberately swallows every error. A push that fails to be REQUESTED must
-- never take down the transaction that queued it: the operator tapped "Car
-- Parked", and that tap has to succeed even if notifications are broken. The
-- row stays 'queued' and the cron sweep will pick it up.
-- ═══════════════════════════════════════════════════════════════════════

create or replace function public.request_push_send()
returns void
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $fn$
begin
  perform net.http_post(
    url     := public.push_sender_url(),
    headers := '{"Content-Type": "application/json"}'::jsonb,
    body    := '{}'::jsonb,
    -- Milliseconds. The function answers in well under a second when warm; a
    -- cold start is slower, and a timeout here only means the cron sweep
    -- delivers instead.
    timeout_milliseconds := 5000
  );
exception when others then
  raise warning 'request_push_send failed (row stays queued for the sweep): %', sqlerrm;
end $fn$;

comment on function public.request_push_send() is
  'Fire-and-forget nudge to the push-send Edge Function via pg_net. Never raises.';


-- ═══════════════════════════════════════════════════════════════════════
-- The trigger — one nudge per queued message
-- ═══════════════════════════════════════════════════════════════════════

create or replace function public.trg_push_outbox_send()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
begin
  -- INSERT only, and only for rows that are actually waiting. push-send writes
  -- 'sent' back onto these same rows; firing on UPDATE too would have the
  -- function call itself for ever.
  if new.status = 'queued' then
    perform public.request_push_send();
  end if;
  return null;
end $fn$;

drop trigger if exists push_outbox_send on public.push_outbox;

create trigger push_outbox_send
  after insert on public.push_outbox
  for each row
  execute function public.trg_push_outbox_send();


-- ═══════════════════════════════════════════════════════════════════════
-- The sweep — catches anything the trigger did not
-- ═══════════════════════════════════════════════════════════════════════

do $$
begin
  if not exists (select 1 from pg_extension where extname = 'pg_cron') then
    raise notice 'pg_cron is NOT enabled — the trigger still works, but a lost request will not be retried.';
    return;
  end if;

  perform cron.unschedule(j.jobname)
  from cron.job j where j.jobname = 'drain-push-outbox';

  -- Every minute. Rows the trigger already delivered are gone from 'queued', so
  -- a sweep with nothing to do costs one request that returns "queue empty".
  perform cron.schedule(
    'drain-push-outbox',
    '* * * * *',
    $cron$
      select public.request_push_send()
      where exists (select 1 from public.push_outbox where status = 'queued');
    $cron$
  );

  raise notice 'cron job scheduled: drain-push-outbox (every minute)';
end $$;

commit;


-- ═══════════════════════════════════════════════════════════════════════
-- VERIFY — every row must read PASS
-- ═══════════════════════════════════════════════════════════════════════
select check_name, case when ok then 'PASS' else 'FAIL' end as result
from (
  select 'pg_net is installed' as check_name,
         exists (select 1 from pg_extension where extname = 'pg_net') as ok

  union all select 'net.http_post is reachable',
         to_regprocedure('net.http_post(text,jsonb,jsonb,jsonb,integer)') is not null
         or exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                     where n.nspname = 'net' and p.proname = 'http_post')

  union all select 'push_sender_url() exists',
         to_regprocedure('public.push_sender_url()') is not null

  union all select 'the url is this project, not the template',
         public.push_sender_url() like 'https://%.supabase.co/functions/v1/push-send'

  union all select 'request_push_send() exists',
         to_regprocedure('public.request_push_send()') is not null

  union all select 'the trigger is on push_outbox',
         exists (select 1 from pg_trigger
                  where tgname = 'push_outbox_send'
                    and tgrelid = 'public.push_outbox'::regclass
                    and not tgisinternal)

  union all select 'it fires on INSERT only, never UPDATE (or it would loop)',
         (select tgtype & 4 = 4 and tgtype & 16 = 0 from pg_trigger
           where tgname = 'push_outbox_send'
             and tgrelid = 'public.push_outbox'::regclass)

  union all select 'the minute sweep is scheduled',
         not exists (select 1 from pg_extension where extname = 'pg_cron')
         or exists (select 1 from cron.job where jobname = 'drain-push-outbox')
) t
order by check_name;
