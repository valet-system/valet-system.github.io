-- ═══════════════════════════════════════════════════════════════════════
-- MIGRATION 0055 — tell a guest their request is queued
--
-- On request. A guest taps "Get My Car"; if nobody has been sent for it three
-- minutes later, they get a message saying so. Everything after that is
-- unchanged: the admin assigns, the operator fetches, and the existing
-- car_at_pickup / car_delivered messages go out exactly as they do today.
--
-- ═══════════════════════════════════════════════════════════════════════
-- WHY IT FIRES ON A DELAY AND NOT ON "EVERY OPERATOR IS BUSY"
-- ═══════════════════════════════════════════════════════════════════════
-- The obvious implementation checks, at the moment of the tap, whether any
-- operator is free — and messages the guest if none is. That test is a
-- PREDICTION, and it is wrong in both directions:
--
--   every operator busy, one finishes 20 seconds later
--     -> the guest has already been told to wait. The car arrives. The message
--        was a lie, and it is the message they will remember.
--
--   an operator IS free, but the admin's phone is in a pocket
--     -> nothing is sent, and the guest stands there for fifteen minutes with
--        no word at all. This is the case that actually happens.
--
-- Waiting three minutes and looking is not a prediction. It asks the only
-- question that matters — has anybody been sent? — and it catches a delay
-- whatever caused it. It also needs to know nothing about who is busy, which
-- is why this function never looks at user_roles.
--
-- ── WHY THREE MINUTES ─────────────────────────────────────────────────
-- Long enough that ordinary service finishes inside it and nothing is sent;
-- short enough that a guest who IS waiting hears something before they walk
-- back to the desk to ask. It is one constant, below, if that turns out wrong.
--
-- ── WHY IT SENDS ONCE ─────────────────────────────────────────────────
-- `not exists` against wa_outbox is the whole mechanism: a row for this task
-- already being there means it has been said. Repeating "you are still waiting"
-- every few minutes does not help somebody who is already waiting; it irritates
-- them, and after 1 October 2026 it also bills for the privilege.
--
-- ── PLAIN TEXT, NOT A TEMPLATE ────────────────────────────────────────
-- The guest messaged US three minutes ago, which opens the 24-hour customer
-- service window, and free-form text is allowed inside it. So this needs no
-- Meta review and its wording can be changed whenever, unlike car_parked which
-- goes out at check-in when no window exists and therefore must be a template.
--
-- From 1 October 2026 both cost the same (₹0.115 in India), so there is no
-- price argument for turning it into one either.
-- ═══════════════════════════════════════════════════════════════════════

begin;

-- ── 1. THE NEW MESSAGE TYPE ───────────────────────────────────────────
alter table public.wa_outbox
  drop constraint if exists wa_outbox_message_type_check;

alter table public.wa_outbox
  add constraint wa_outbox_message_type_check
  check (message_type in (
    'car_parked',
    'car_at_pickup',
    'car_delivered',
    'not_available',
    'car_returned',
    'queued'           -- new: nobody has been sent for this car yet
  ));


-- ── 2. THE SWEEP ──────────────────────────────────────────────────────
create or replace function public.queue_waiting_notices()
returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  -- How long a request may sit unassigned before the guest is told.
  c_wait constant interval := interval '3 minutes';
  v_count int := 0;
begin
  insert into public.wa_outbox (property_id, vehicle_id, task_id, message_type)
  select t.property_id, t.vehicle_id, t.id, 'queued'
  from public.valet_tasks t
  where t.task_type = 'retrieval'
    -- STILL PENDING. The moment an admin assigns, the status leaves 'pending'
    -- and this stops matching — which is the entire test.
    and t.status    = 'pending'
    and t.created_at < now() - c_wait
    -- Said once per task, for ever. Not "once in the last N minutes": a row
    -- here is a permanent record that this guest has been told.
    and not exists (
      select 1 from public.wa_outbox w
      where w.task_id = t.id and w.message_type = 'queued'
    );

  get diagnostics v_count = row_count;
  return v_count;
end $fn$;

revoke execute on function public.queue_waiting_notices() from public, anon, authenticated;

commit;


-- ═══════════════════════════════════════════════════════════════════════
-- THE SCHEDULE
--
-- Every minute. The wait is three minutes and the check is cheap, so a
-- once-a-minute sweep means a guest hears at worst a minute late — and the
-- exact second is not worth a sub-minute job on a table this size.
-- ═══════════════════════════════════════════════════════════════════════

do $$
begin
  if not exists (select 1 from pg_extension where extname = 'pg_cron') then
    raise notice 'pg_cron is not installed — queue_waiting_notices() exists but nothing calls it';
    return;
  end if;

  -- Re-running this migration must not stack duplicate jobs.
  perform cron.unschedule('queue-waiting-notices')
  where exists (select 1 from cron.job where jobname = 'queue-waiting-notices');

  perform cron.schedule(
    'queue-waiting-notices',
    '* * * * *',
    $cron$ select public.queue_waiting_notices(); $cron$
  );
  raise notice 'cron job scheduled: queue-waiting-notices (every minute)';
end $$;


-- ═══════════════════════════════════════════════════════════════════════
-- VERIFY — every row must read PASS
-- ═══════════════════════════════════════════════════════════════════════
select check_name, case when ok then 'PASS' else 'FAIL' end as result
from (
  select 'queued is an allowed message type' as check_name,
         (select pg_get_constraintdef(oid) like '%queued%' from pg_constraint
           where conname = 'wa_outbox_message_type_check') as ok

  -- The five that were already there must still be, or this migration has
  -- silently stopped every other message in the system.
  union all select 'car_parked is still allowed',
         (select pg_get_constraintdef(oid) like '%car_parked%' from pg_constraint
           where conname = 'wa_outbox_message_type_check')

  union all select 'car_at_pickup is still allowed',
         (select pg_get_constraintdef(oid) like '%car_at_pickup%' from pg_constraint
           where conname = 'wa_outbox_message_type_check')

  union all select 'car_delivered is still allowed',
         (select pg_get_constraintdef(oid) like '%car_delivered%' from pg_constraint
           where conname = 'wa_outbox_message_type_check')

  union all select 'not_available is still allowed',
         (select pg_get_constraintdef(oid) like '%not_available%' from pg_constraint
           where conname = 'wa_outbox_message_type_check')

  union all select 'car_returned is still allowed',
         (select pg_get_constraintdef(oid) like '%car_returned%' from pg_constraint
           where conname = 'wa_outbox_message_type_check')

  union all select 'queue_waiting_notices exists',
         to_regprocedure('public.queue_waiting_notices()') is not null

  -- The three conditions that ARE the design.
  union all select 'it waits three minutes',
         (select prosrc like '%interval ''3 minutes''%' from pg_proc
           where pronamespace = 'public'::regnamespace and proname = 'queue_waiting_notices')

  union all select 'it only looks at requests nobody has been sent for',
         (select prosrc like '%t.status    = ''pending''%' from pg_proc
           where pronamespace = 'public'::regnamespace and proname = 'queue_waiting_notices')

  union all select 'it never messages the same task twice',
         (select prosrc like '%not exists%' from pg_proc
           where pronamespace = 'public'::regnamespace and proname = 'queue_waiting_notices')

  -- It must NOT have grown an availability check. That was the design that was
  -- rejected, and re-adding it would make the message fire on a guess again.
  union all select 'it does not check who is busy',
         (select prosrc not like '%user_roles%' from pg_proc
           where pronamespace = 'public'::regnamespace and proname = 'queue_waiting_notices')

  union all select 'exactly one sweep job is scheduled',
         (select count(*) = 1 from cron.job where jobname = 'queue-waiting-notices')

  union all select 'nobody may call the sweep directly',
         not has_function_privilege('authenticated', 'public.queue_waiting_notices()', 'execute')

  -- The dispatcher has to be able to pick the row up.
  union all select 'the outbox drain job still exists',
         (select count(*) = 1 from cron.job where jobname = 'drain-wa-outbox')
) t
order by ok, check_name;
