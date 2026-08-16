-- ═══════════════════════════════════════════════════════════════════════
-- MIGRATION 0034 — the WhatsApp outbox drains itself
--
-- WHAT THIS ADDS
--   A pg_net nudge on every queued wa_outbox row, plus a per-minute cron
--   sweep as the backstop. Exactly the shape migration 0028 uses for
--   push_outbox — see that file for the full reasoning; the short version
--   is repeated below because the two must not drift.
--
-- WHY THIS IS NEEDED AT ALL
--   wa_outbox has been filling up since migration 0001. Every "car parked",
--   "car delivered", "not available" and "car returned" has been queued
--   correctly, in the same transaction as the state change, and NOTHING has
--   ever drained it — wa-dispatch did not exist. So the guest side of this
--   system has been silent from the start, with a perfect record of every
--   message it failed to send sitting in the table.
--
-- WHY A TRIGGER MAY MAKE AN HTTP CALL HERE
--   Migration 0014 forbids HTTP from triggers, and is right: a synchronous
--   call inside a transaction holds the write open for as long as the remote
--   end takes, so a slow third party becomes a slow check-in. pg_net does not
--   work that way — net.http_post queues the request in a background worker
--   and returns immediately. The transaction never waits on Meta.
--
-- WHY THE CRON SWEEP TOO
--   The nudge is best-effort and swallows its own errors on purpose. If
--   pg_net is down, or the function cold-starts past the timeout, the row
--   simply stays 'queued'. The sweep is what guarantees it eventually goes,
--   and it is also what retries rows that failed with attempts left.
--
-- NO SERVICE ROLE KEY ANYWHERE
--   The Edge Function is called without an Authorization header, so nothing
--   secret is written into a migration — this repo is public. wa-dispatch
--   must therefore be deployed with --no-verify-jwt, the same as wa-webhook.
-- ═══════════════════════════════════════════════════════════════════════

begin;

create extension if not exists pg_net with schema extensions;


-- One line to change if the Supabase project ever moves. Kept as a function
-- rather than inlined so the URL appears exactly once.
create or replace function public.wa_dispatch_url()
returns text
language sql
immutable
as $fn$
  select 'https://vyirixtdgheypbpffsct.supabase.co/functions/v1/wa-dispatch'
$fn$;

comment on function public.wa_dispatch_url() is
  'The wa-dispatch Edge Function endpoint. Change this one line if the Supabase project changes.';


-- ═══════════════════════════════════════════════════════════════════════
-- Ask the dispatcher to run.
--
-- Swallows every error, deliberately. A guest message that fails to be
-- REQUESTED must never take down the transaction that queued it: the operator
-- tapped "Car Parked", and that tap has to succeed even when messaging is
-- broken. The row stays 'queued' and the sweep collects it.
-- ═══════════════════════════════════════════════════════════════════════

create or replace function public.request_wa_dispatch()
returns void
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $fn$
begin
  perform net.http_post(
    url     := public.wa_dispatch_url(),
    headers := '{"Content-Type": "application/json"}'::jsonb,
    body    := '{}'::jsonb,
    timeout_milliseconds := 5000
  );
exception when others then
  raise warning 'request_wa_dispatch failed (row stays queued for the sweep): %', sqlerrm;
end $fn$;

comment on function public.request_wa_dispatch() is
  'Fire-and-forget nudge to the wa-dispatch Edge Function via pg_net. Never raises.';


create or replace function public.trg_wa_outbox_send()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
begin
  -- INSERT only, and only for rows actually waiting. wa-dispatch writes 'sent'
  -- and 'failed' back onto these same rows; firing on UPDATE too would have
  -- the function call itself forever.
  if new.status = 'queued' then
    perform public.request_wa_dispatch();
  end if;
  return null;
end $fn$;

drop trigger if exists wa_outbox_send on public.wa_outbox;
create trigger wa_outbox_send
  after insert on public.wa_outbox
  for each row
  execute function public.trg_wa_outbox_send();


-- ═══════════════════════════════════════════════════════════════════════
-- The sweep
-- ═══════════════════════════════════════════════════════════════════════

do $$
begin
  if not exists (select 1 from pg_extension where extname = 'pg_cron') then
    raise notice 'pg_cron is not installed — the trigger still nudges, but nothing retries';
    return;
  end if;

  perform cron.unschedule('drain-wa-outbox')
  where exists (select 1 from cron.job where jobname = 'drain-wa-outbox');

  perform cron.schedule(
    'drain-wa-outbox',
    '* * * * *',
    $cron$
      select public.request_wa_dispatch()
      where exists (select 1 from public.wa_outbox where status = 'queued');
    $cron$
  );

  raise notice 'cron job scheduled: drain-wa-outbox (every minute)';
end $$;

commit;
