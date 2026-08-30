-- ═══════════════════════════════════════════════════════════════════════
-- MIGRATION 0056 — the queued notice actually lands at three minutes
--
-- Reported: it arrives much later than the three minutes it promises.
--
-- ── WHERE THE EXTRA TIME WAS ──────────────────────────────────────────
-- Not in the wait. queue_waiting_notices() has always looked for requests
-- older than exactly three minutes, and that is unchanged here.
--
-- It was in how often anybody LOOKED. The sweep was scheduled '* * * * *' —
-- once a minute — so a request that crossed three minutes at 14:02:05 was not
-- noticed until 14:03:00. Fifty-five seconds of silence, invisible in the code,
-- because the delay lives in the schedule rather than in the function.
--
--     wait          3:00
--     + sweep gap   0:00 .. 0:59      <- this
--     + send        ~0:03
--     ---------------------------
--     total         3:03 .. 4:02
--
-- ── WHAT CHANGES ──────────────────────────────────────────────────────
-- The schedule only. Every ten seconds instead of every minute:
--
--     total         3:03 .. 3:13
--
-- The function, the three minutes, and the once-per-task rule are all
-- untouched — this migration reschedules and nothing else.
--
-- ── WHY NOT EXACTLY 3:00 ──────────────────────────────────────────────
-- Worth saying plainly, because "3 minutes" and "at most 3:13" are different
-- promises. This is a polling design: something has to come and look, and
-- whatever the interval, a request can cross the line just after a look and
-- wait for the next one. Ten seconds makes that gap small enough to stop
-- mattering; it does not remove it.
--
-- Removing it entirely would mean scheduling a job per request — one timer per
-- guest, cancelled when the admin assigns — which is a great deal of machinery
-- for ten seconds.
--
-- ── WHY TEN AND NOT FIVE ──────────────────────────────────────────────
-- The nag already runs every five seconds, so five is available. But this query
-- is a scan for pending retrievals rather than a lookup on one task, and ten
-- seconds halves how often it runs for a difference nobody standing at a porch
-- can feel.
--
-- ── IF IT IS STILL LATE AFTER THIS ────────────────────────────────────
-- Then the time was never in the sweep, and this migration will not have helped.
-- The other place it can hide is the SEND: request_wa_dispatch() fires on insert
-- but deliberately does not raise on failure — it warns and leaves the row
-- queued for the once-a-minute drain to retry. So a failing pg_net call turns a
-- three-second send into a sixty-second one, silently.
--
-- Measure before changing anything else:
--
--   select round(extract(epoch from w.created_at - t.created_at)) as tap_to_queue,
--          round(extract(epoch from w.sent_at    - w.created_at)) as queue_to_sent
--   from public.wa_outbox w
--   join public.valet_tasks t on t.id = w.task_id
--   where w.message_type = 'queued'
--   order by w.created_at desc limit 10;
--
-- tap_to_queue should now be 180-190. queue_to_sent should be 1-3, and if it is
-- nearer 60 the problem is the send, not this.
-- ═══════════════════════════════════════════════════════════════════════

do $$
declare
  v_version text;
  v_parts   int[];
begin
  select extversion into v_version from pg_extension where extname = 'pg_cron';

  if v_version is null then
    raise notice 'pg_cron is not installed — nothing to reschedule';
    return;
  end if;

  perform cron.unschedule('queue-waiting-notices')
  where exists (select 1 from cron.job where jobname = 'queue-waiting-notices');

  v_parts := string_to_array(split_part(v_version, '-', 1), '.')::int[];

  -- Sub-minute schedules need pg_cron 1.5. On anything older the finest
  -- available is a minute, which is what 0055 already had — so the job still
  -- works, it just keeps the old slack, and the notice says so rather than the
  -- migration failing over a scheduling detail.
  if v_parts[1] > 1 or (v_parts[1] = 1 and v_parts[2] >= 5) then
    perform cron.schedule(
      'queue-waiting-notices',
      '10 seconds',
      $cron$ select public.queue_waiting_notices(); $cron$
    );
    raise notice 'cron job rescheduled: queue-waiting-notices (every 10 SECONDS)';
  else
    perform cron.schedule(
      'queue-waiting-notices',
      '* * * * *',
      $cron$ select public.queue_waiting_notices(); $cron$
    );
    raise notice 'pg_cron % is older than 1.5 — left at once a MINUTE, so the notice can still be up to a minute late', v_version;
  end if;
end $$;


-- ═══════════════════════════════════════════════════════════════════════
-- VERIFY — every row must read PASS
-- ═══════════════════════════════════════════════════════════════════════
select check_name, case when ok then 'PASS' else 'FAIL' end as result
from (
  select 'the sweep runs every 10 seconds (or the documented fallback)' as check_name,
         (select schedule in ('10 seconds', '* * * * *')
            from cron.job where jobname = 'queue-waiting-notices') as ok

  -- One job. A missed unschedule would double the sweeps — harmless for
  -- correctness, since the not-exists still sends once, but it doubles the load
  -- and hides the next scheduling mistake.
  union all select 'exactly one sweep job is scheduled',
         (select count(*) = 1 from cron.job where jobname = 'queue-waiting-notices')

  union all select 'the sweep job is active',
         (select active from cron.job where jobname = 'queue-waiting-notices')

  -- THE WAIT IS UNCHANGED. This migration is about how often anybody looks,
  -- not about how long a guest waits before being told.
  union all select 'it still waits three minutes',
         (select prosrc like '%interval ''3 minutes''%' from pg_proc
           where pronamespace = 'public'::regnamespace and proname = 'queue_waiting_notices')

  union all select 'it still sends only once per request',
         (select prosrc like '%not exists%' from pg_proc
           where pronamespace = 'public'::regnamespace and proname = 'queue_waiting_notices')

  union all select 'it still only looks at unassigned requests',
         (select prosrc like '%t.status    = ''pending''%' from pg_proc
           where pronamespace = 'public'::regnamespace and proname = 'queue_waiting_notices')

  -- The other half of the chain has to be alive or the row sits in the outbox.
  union all select 'the outbox drain job is still scheduled',
         (select count(*) = 1 from cron.job where jobname = 'drain-wa-outbox')

  union all select 'the send-on-insert trigger is still there',
         exists (select 1 from pg_trigger
                  where tgrelid = 'public.wa_outbox'::regclass
                    and tgname = 'wa_outbox_send' and not tgisinternal)
) t
order by ok, check_name;
