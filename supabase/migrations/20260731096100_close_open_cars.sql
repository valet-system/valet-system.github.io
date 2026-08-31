-- ═══════════════════════════════════════════════════════════════════════
-- MIGRATION 0061 — close out the night's open cars before the day turns
--
-- On request. Half an hour before the token reset, any car still open — parked,
-- being fetched, standing at the door, waiting to be re-parked — is marked
-- delivered so the night's work reaches the reports. Silently: no WhatsApp to
-- the guest, and no push to anybody.
--
-- ── THE TIMING ────────────────────────────────────────────────────────
-- Supabase cron runs in UTC, and every schedule in this project has to be read
-- that way or it lands seven hours out.
--
--     daily-token-reset   05 00 * * *  UTC  =  05:35 IST   (service day turns)
--     this job            35 23 * * *  UTC  =  05:05 IST   (thirty minutes before)
--
-- 05:05 IST is still INSIDE the service day that began at 05:30 the previous
-- morning, which is the whole point: the night's cars are closed while they
-- still belong to the night, not attributed to the day about to start.
--
-- ── WHY ANYTHING NEEDS CLOSING ────────────────────────────────────────
-- Nothing else ever does. A car whose hand-over was never tapped — the
-- operator forgot, the app closed mid-flow, the guest took the keys off the
-- desk — stays 'parked' for ever. It sits in occupancy counts, it never
-- appears as delivered, and the night it belonged to reads as unfinished
-- business in every report that touches it.
--
-- ── WHY THE PUSHES HAVE TO BE DELETED, NOT PREVENTED ──────────────────
-- Setting a task to 'completed' fires trg_task_push, whose "Car delivered"
-- branch pushes every valet admin at the property. Unhandled, this job would
-- wake every admin at five past five with one notification per car.
--
-- The clean-looking fix is a switch the trigger checks. That means editing
-- enqueue_task_push — two hundred lines and six branches, last rewritten in
-- 0025 — to add a condition used by one caller once a day. The riskier change
-- is the tidier-looking one.
--
-- So the rows are inserted and then deleted, inside the same transaction. It
-- reads oddly and it is the smaller change: neither trigger is touched, and
-- the deletion is precise because now() is constant across a transaction — the
-- trigger's rows carry exactly the timestamp this function started with.
--
-- Nothing is sent in the meantime. request_push_send() fires over pg_net after
-- commit, and by then the rows are gone, so push-send finds an empty queue.
--
-- ── WHY WhatsApp NEEDS NO SUCH CARE ───────────────────────────────────
-- Checked rather than assumed: every insert into wa_outbox in this schema is
-- an explicit line inside an RPC. No trigger writes to it. So a status change
-- cannot message a guest, and this function does not write to it either.
--
-- ── WHAT THIS COSTS THE NUMBERS, ON THE RECORD ────────────────────────
-- These cars were NOT handed over. Marking them delivered puts them in the
-- delivered count and the delivery rate, which now includes cars nobody
-- collected. That is the trade being asked for — the alternative is them
-- missing from the reports entirely — but it should not be invisible.
--
-- Hence auto_closed_at. Every row this job touches carries the timestamp, so
-- any report can separate "handed to a guest" from "closed by the clock", and
-- the honest version of the number stays recoverable. Nothing reads it today.
-- ═══════════════════════════════════════════════════════════════════════

begin;

-- ── 1. THE MARKER ─────────────────────────────────────────────────────
alter table public.parked_vehicles
  add column if not exists auto_closed_at timestamptz;

comment on column public.parked_vehicles.auto_closed_at is
  'Set when close_open_cars() marked this delivered at the end of a service '
  'day, rather than an operator handing the car over. Null on a real '
  'hand-over. Nothing reads it yet; it exists so the delivered count can be '
  'told apart from the genuinely-delivered one later.';


-- ── 2. THE SWEEP ──────────────────────────────────────────────────────
create or replace function public.close_open_cars()
returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  -- Captured once. now() does not move inside a transaction, so this is also
  -- exactly what the push trigger will stamp on the rows it creates — which is
  -- what makes the deletion below precise rather than approximate.
  v_at    timestamptz := now();
  v_count int := 0;
begin
  -- Which cars. Everything that is not already handed over, whatever day it
  -- came from: a car left open three nights ago is exactly the kind of ghost
  -- this exists to clear.
  create temporary table closing on commit drop as
  select id from public.parked_vehicles
  where status <> 'delivered';

  select count(*) into v_count from closing;
  if v_count = 0 then
    return 0;
  end if;

  update public.parked_vehicles
     set status         = 'delivered',
         auto_closed_at = v_at
   where id in (select id from closing);

  -- Tasks LAST, because this is the update that fires the push triggers, and
  -- doing it last keeps the window between the inserts and the delete below as
  -- small as it can be.
  update public.valet_tasks
     set status       = 'completed',
         completed_at = coalesce(completed_at, v_at)
   where vehicle_id in (select id from closing)
     and status <> 'completed';

  -- ── AND UNDO WHAT THE TRIGGERS QUEUED ───────────────────────────────
  -- See the header. Only rows for THESE tasks, only still-queued ones, and
  -- only those stamped with this transaction's now() — so a notification that
  -- was already waiting for one of these cars before the sweep ran is left
  -- alone rather than swallowed.
  delete from public.push_outbox
  where status = 'queued'
    and created_at = v_at
    and task_id in (
      select t.id from public.valet_tasks t
      where t.vehicle_id in (select id from closing)
    );

  -- Deliberately NO insert into wa_outbox. The guest is told nothing: they
  -- either drove away hours ago or never came, and a "your car has been handed
  -- over" at five in the morning would be a lie arriving in the dark.

  return v_count;
end $fn$;

revoke execute on function public.close_open_cars() from public, anon, authenticated;

commit;


-- ═══════════════════════════════════════════════════════════════════════
-- THE SCHEDULE — 23:35 UTC = 05:05 IST, thirty minutes before the reset
-- ═══════════════════════════════════════════════════════════════════════

do $$
begin
  if not exists (select 1 from pg_extension where extname = 'pg_cron') then
    raise notice 'pg_cron is not installed — close_open_cars() exists but nothing calls it';
    return;
  end if;

  perform cron.unschedule('close-open-cars')
  where exists (select 1 from cron.job where jobname = 'close-open-cars');

  perform cron.schedule(
    'close-open-cars',
    '35 23 * * *',
    $cron$ select public.close_open_cars(); $cron$
  );
  raise notice 'cron job scheduled: close-open-cars (23:35 UTC = 05:05 IST)';
end $$;


-- ═══════════════════════════════════════════════════════════════════════
-- VERIFY — every row must read PASS
-- ═══════════════════════════════════════════════════════════════════════
select check_name, case when ok then 'PASS' else 'FAIL' end as result
from (
  select 'auto_closed_at exists' as check_name,
         exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'parked_vehicles'
                    and column_name = 'auto_closed_at') as ok

  union all select 'close_open_cars exists',
         to_regprocedure('public.close_open_cars()') is not null

  -- THE TWO THINGS THAT MAKE IT SILENT.
  -- COMMENTS STRIPPED FIRST. The body says "Deliberately NO insert into
  -- wa_outbox" — naming the very thing being checked for — and prosrc includes
  -- comments, so a plain `not like` would fail on the sentence explaining why
  -- it passes. The 'n' flag stops . at a line end, so '--.*' is one comment.
  union all select 'it sends the guest nothing',
         (select regexp_replace(prosrc, '--.*', '', 'gn') not like '%wa_outbox%'
            from pg_proc
           where pronamespace = 'public'::regnamespace and proname = 'close_open_cars')

  union all select 'it removes the pushes the triggers queued',
         (select prosrc like '%delete from public.push_outbox%' from pg_proc
           where pronamespace = 'public'::regnamespace and proname = 'close_open_cars')

  -- Scoped to this transaction's own rows, or it would swallow a notification
  -- that was already waiting.
  union all select 'and only this run''s pushes',
         (select prosrc like '%created_at = v_at%' from pg_proc
           where pronamespace = 'public'::regnamespace and proname = 'close_open_cars')

  union all select 'it marks what it touched',
         (select prosrc like '%auto_closed_at = v_at%' from pg_proc
           where pronamespace = 'public'::regnamespace and proname = 'close_open_cars')

  -- TIMING. 23:35 UTC, and it must be BEFORE the token reset at 00:05 UTC.
  union all select 'the job is scheduled',
         (select count(*) = 1 from cron.job where jobname = 'close-open-cars')

  union all select 'it runs at 23:35 UTC (05:05 IST)',
         (select schedule = '35 23 * * *' from cron.job where jobname = 'close-open-cars')

  union all select 'the token reset still exists to run after it',
         (select count(*) = 1 from cron.job where jobname = 'daily-token-reset')

  union all select 'nobody may call it by hand from the app',
         not has_function_privilege('authenticated', 'public.close_open_cars()', 'execute')

  -- The triggers it works around must still be there — if one were removed the
  -- delete becomes dead code and the next reader would wonder why it exists.
  union all select 'the push trigger it compensates for is still there',
         exists (select 1 from pg_trigger
                  where tgrelid = 'public.valet_tasks'::regclass
                    and tgname = 'trg_task_push' and not tgisinternal)
) t
order by ok, check_name;
