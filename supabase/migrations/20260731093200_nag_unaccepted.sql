-- ═══════════════════════════════════════════════════════════════════════
-- MIGRATION 0032 — keep pushing until the operator accepts
--
-- WHAT THIS ADDS
--   nag_unaccepted_retrievals(), plus a cron job that runs it every 30
--   seconds. Each run queues a fresh push for every retrieval still sitting
--   in 'assigned' — dispatched, but not acknowledged.
--
-- WHY
--   MyTasks now sounds a continuous alarm while a dispatch is unaccepted,
--   but only while that screen is open. With the app closed the only channel
--   is web push, and a service worker cannot hold a sound: it has no
--   AudioContext and the browser kills it seconds after the push event. The
--   sound the phone makes is the OS notification sound, once per
--   notification.
--
--   So "continuous while closed" is not achievable. Repeating is. This is
--   that repeat: one notification every 30s until accepted, which is as
--   close as a PWA gets.
--
-- ── WHY EACH NAG GETS A UNIQUE TAG ────────────────────────────────────
--   A notification re-using an existing tag REPLACES the old one and, on
--   Chrome/Android, does so SILENTLY — no sound, no buzz — unless the
--   `renotify` option is set. And renotify is one of the options that
--   public/sw.js deliberately removed: dropping them is what finally made
--   push arrive on a closed iPhone and Android, and that file carries an
--   explicit warning against adding them back without device testing.
--
--   Re-using the tag would therefore produce a silent repeat, which is
--   worse than useless — it would look like it was working. A unique tag
--   makes each nag a genuinely new notification, which always alerts,
--   without touching the option set at all. The stacking that would
--   normally cause is handled in the service worker, which closes the
--   earlier notification for the same task before showing the next.
--
-- ── WHY IT STOPS AFTER TEN MINUTES ────────────────────────────────────
--   "Until they accept" is the intent, but an unbounded nag is a real
--   hazard: a task assigned to someone whose shift ended would push every
--   30 seconds all night, flattening a battery and burning FCM quota for
--   nobody. Ten minutes is twenty notifications — far past the point where
--   the problem stopped being "the operator did not notice" and became one
--   for the admin to reassign. Change NAG_WINDOW below if that is wrong;
--   it is a judgement call, not a constraint.
-- ═══════════════════════════════════════════════════════════════════════

begin;

-- The dedupe check below looks up "was there a push for this task recently".
-- Without this it is a sequential scan of every push ever queued, every 30
-- seconds, forever.
create index if not exists push_outbox_task_recent_idx
  on public.push_outbox(task_id, created_at desc);


create or replace function public.nag_unaccepted_retrievals()
returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  -- How long a task keeps being nagged about. See the header.
  c_nag_window   constant interval := interval '10 minutes';
  -- Guards against a double-run queueing two pushes for one task. Slightly
  -- under the 30s cron period so a run that fires a moment early still counts
  -- as due rather than being skipped until the next one.
  c_min_gap      constant interval := interval '25 seconds';
  v_count int := 0;
begin
  insert into public.push_outbox (user_role_id, title, body, url, tag, critical, task_id)
  select t.assigned_operator_id,
         'Car still waiting',
         'Token ' || coalesce(v.token_number::text, '?') ||
           ' · ' || coalesce(v.car_number, 'car') ||
           case when v.parking_location is not null
                then ' · ' || v.parking_location else '' end,
         '/operator/tasks',
         -- Unique per nag — see the header. The service worker keys on
         -- data.taskId to close the previous one, not on this.
         'valet-nag-' || t.id::text || '-' || extract(epoch from now())::bigint::text,
         true,
         t.id
  from public.valet_tasks t
  join public.parked_vehicles v on v.id = t.vehicle_id
  where t.task_type           = 'retrieval'
    and t.status              = 'assigned'
    and t.assigned_operator_id is not null
    and t.assigned_at         > now() - c_nag_window
    -- Not if anything was queued for this task a moment ago. This also stops
    -- the first nag landing on top of the dispatch push the trigger already
    -- sent, which would be two notifications for the same event.
    and not exists (
      select 1
      from public.push_outbox p
      where p.task_id = t.id
        and p.created_at > now() - c_min_gap
    );

  get diagnostics v_count = row_count;
  return v_count;
end $fn$;

revoke execute on function public.nag_unaccepted_retrievals() from public, anon, authenticated;


-- ═══════════════════════════════════════════════════════════════════════
-- THE SCHEDULE
--
-- Sub-minute cron needs pg_cron 1.5 or newer. On anything older the finest
-- available is once a minute, so the job still works — it just nags half as
-- often. Better to install with a slower cadence and say so than to fail the
-- migration over a scheduling detail.
-- ═══════════════════════════════════════════════════════════════════════

do $$
declare
  v_version text;
  v_parts   int[];
begin
  select extversion into v_version from pg_extension where extname = 'pg_cron';

  if v_version is null then
    raise notice 'pg_cron is not installed — nag_unaccepted_retrievals() exists but nothing calls it';
    return;
  end if;

  -- Re-running this migration must not stack duplicate jobs.
  perform cron.unschedule('nag-unaccepted-retrievals')
  where exists (select 1 from cron.job where jobname = 'nag-unaccepted-retrievals');

  v_parts := string_to_array(split_part(v_version, '-', 1), '.')::int[];

  if v_parts[1] > 1 or (v_parts[1] = 1 and v_parts[2] >= 5) then
    perform cron.schedule(
      'nag-unaccepted-retrievals',
      '30 seconds',
      $cron$ select public.nag_unaccepted_retrievals(); $cron$
    );
    raise notice 'cron job scheduled: nag-unaccepted-retrievals (every 30 seconds)';
  else
    perform cron.schedule(
      'nag-unaccepted-retrievals',
      '* * * * *',
      $cron$ select public.nag_unaccepted_retrievals(); $cron$
    );
    raise notice 'pg_cron % is older than 1.5 — scheduled once a MINUTE instead of every 30s', v_version;
  end if;
end $$;

commit;
