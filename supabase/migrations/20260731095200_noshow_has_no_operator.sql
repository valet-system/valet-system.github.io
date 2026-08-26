-- ═══════════════════════════════════════════════════════════════════════
-- MIGRATION 0052 — a no-show belongs to nobody until the admin sends someone
--
-- Reported: the operator who brought the car to the entrance still gets a
-- "Park this car again" card the moment the admin taps "Guest not here". He
-- should not. His job ended at the entrance; the admin decides who parks it.
--
-- ── WHY IT WAS SHOWING ────────────────────────────────────────────────
-- Nothing put it there on purpose. The retrieval task has carried his name in
-- assigned_operator_id since he was dispatched to fetch the car, and MyTasks
-- lists "my open tasks" — so when the status flipped to 're_parking' the task
-- was still his by that column, and the card appeared.
--
-- There was no way for the screen to tell "he fetched this" apart from "he was
-- sent to re-park this", because both are the same column.
--
-- ── THE FIX ───────────────────────────────────────────────────────────
-- Clear assigned_operator_id when a task becomes a no-show. Then:
--
--   operator     sees nothing — MyTasks filters on assigned_operator_id
--   admin        still sees it — the Dashboard fetches by PROPERTY, not by
--                operator, so the "Needs parking again" card is unaffected
--   busy list    the original operator is no longer held busy by a car he is
--                not responsible for, which is the same correction 0050 made
--                for 'at_pickup'
--   dispatch     dispatch_reparking() writes the column, so the operator who
--                is actually sent sees it and is correctly busy
--
-- No frontend change is needed and claim_task() is untouched: the dispatched
-- operator matches assigned_operator_id the ordinary way.
--
-- ═══════════════════════════════════════════════════════════════════════
-- WHY THIS DOES NOT COST WHAT 0050 SAID IT WOULD
-- ═══════════════════════════════════════════════════════════════════════
-- 0050's header argues at length against clearing assigned_operator_id. That
-- argument was about clearing it at 'at_pickup', and there it is correct. Here
-- it does not apply, and the difference is worth writing down because the two
-- look identical.
--
--   analytics   "who fetched it" reads ONLY completed retrievals —
--               `and t.status = 'completed'`, report_api.sql:311. A task
--               sitting on 're_parking' has not completed, so nothing reads it
--               and there is no credit to lose. When the re-park DOES complete,
--               dispatch_reparking has already written an operator, and that
--               operator is the one who finished the job.
--
--               At 'at_pickup' the same clearing WOULD lose it: that task goes
--               on to complete as the successful fetch, and it would complete
--               with a null operator.
--
--   reviews     guest_record_review() stamps the rating with the column, but
--               ratings only ever go out with the hand-over message. A car
--               nobody collected never sent one. When the guest asks again a
--               NEW retrieval task is created and the rating attaches to that.
--
-- So: clearing at 'at_pickup' is wrong, clearing at 're_parking' is free.
-- ═══════════════════════════════════════════════════════════════════════

begin;

-- ── 1. THE ADMIN TAPS "GUEST NOT HERE" ────────────────────────────────
-- Otherwise identical to 0008. One line added to the update.
create or replace function public.task_guest_absent(p_task_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_task public.valet_tasks;
begin
  v_task := public.claim_task(p_task_id, 'retrieval', array['at_pickup']);

  update public.valet_tasks
     set status       = 're_parking',
         return_count = coalesce(return_count, 0) + 1,
         -- THE FIX. The car is nobody's now: not the operator who brought it
         -- (his job ended at the entrance) and not yet whoever will park it.
         -- dispatch_reparking() fills this in when the admin sends somebody.
         assigned_operator_id = null
   where id = v_task.id;

  update public.parked_vehicles
     set status = 're_parking'
   where id = v_task.vehicle_id;

  -- MSG 3: "you were not available, we have parked it again — tap when ready".
  insert into public.wa_outbox (property_id, vehicle_id, task_id, message_type)
  values (v_task.property_id, v_task.vehicle_id, v_task.id, 'not_available');

  return jsonb_build_object(
    'task_id',      v_task.id,
    'vehicle_id',   v_task.vehicle_id,
    'return_count', coalesce(v_task.return_count, 0) + 1
  );
end $fn$;

revoke execute on function public.task_guest_absent(uuid) from public, anon;
grant  execute on function public.task_guest_absent(uuid) to authenticated;


-- ── 2. THE TEN MINUTES RUN OUT ON THEIR OWN ───────────────────────────
-- The same change in the pg_cron path. This is the one that actually fires most
-- of the time, because a no-show is usually discovered by the clock rather than
-- by anybody tapping anything.
--
-- Otherwise identical to 0008.
create or replace function public.expire_stale_pickups(p_timeout_minutes int default 10)
returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  r       record;
  v_count int := 0;
begin
  for r in
    update public.valet_tasks t
       set status       = 're_parking',
           return_count = coalesce(t.return_count, 0) + 1,
           -- Same as above: the car is nobody's until the admin sends someone.
           assigned_operator_id = null
     where t.status            = 'at_pickup'
       and t.completed_at is null
       and t.pickup_started_at < now() - make_interval(mins => p_timeout_minutes)
    returning t.id, t.vehicle_id, t.property_id
  loop
    update public.parked_vehicles
       set status = 're_parking'
     where id = r.vehicle_id;

    insert into public.wa_outbox (property_id, vehicle_id, task_id, message_type)
    values (r.property_id, r.vehicle_id, r.id, 'not_available');

    v_count := v_count + 1;
  end loop;

  return v_count;
end $fn$;

revoke execute on function public.expire_stale_pickups(int) from public, anon, authenticated;


-- ── 3. TIDY UP WHAT IS ALREADY SITTING THERE ──────────────────────────
-- Without this, any car ALREADY on 're_parking' keeps showing on its old
-- operator's screen until somebody finishes it — including the one in the
-- report that prompted this migration.
--
-- Only untouched no-shows: a task the admin has already dispatched has a fresh
-- assigned_at, and clearing that would take the job off the screen of somebody
-- who is on their way to the car. `assigned_at < pickup_started_at` is what
-- separates them — a dispatch always refreshes assigned_at to now(), which is
-- necessarily after the car reached the door.
update public.valet_tasks
   set assigned_operator_id = null
 where status = 're_parking'
   and assigned_operator_id is not null
   and pickup_started_at is not null
   and (assigned_at is null or assigned_at < pickup_started_at);

commit;


-- ═══════════════════════════════════════════════════════════════════════
-- VERIFY — every row must read PASS
-- ═══════════════════════════════════════════════════════════════════════
select check_name, case when ok then 'PASS' else 'FAIL' end as result
from (
  -- THE CHANGE, in both paths. Comments stripped: both bodies explain the fix
  -- and name the column, so a plain `like` proves nothing.
  select 'the manual no-show clears the operator' as check_name,
         (select regexp_replace(prosrc, '--.*', '', 'gn') like '%assigned_operator_id = null%'
            from pg_proc
           where pronamespace = 'public'::regnamespace
             and proname = 'task_guest_absent') as ok

  union all select 'the 10-minute expiry clears the operator',
         (select regexp_replace(prosrc, '--.*', '', 'gn') like '%assigned_operator_id = null%'
            from pg_proc
           where pronamespace = 'public'::regnamespace and proname = 'expire_stale_pickups')

  -- Neither function may have lost anything else in the rewrite.
  union all select 'the manual no-show still messages the guest',
         (select prosrc like '%not_available%' from pg_proc
           where pronamespace = 'public'::regnamespace and proname = 'task_guest_absent')

  union all select 'the expiry still messages the guest',
         (select prosrc like '%not_available%' from pg_proc
           where pronamespace = 'public'::regnamespace and proname = 'expire_stale_pickups')

  union all select 'the manual no-show still counts the return',
         (select prosrc like '%return_count%' from pg_proc
           where pronamespace = 'public'::regnamespace and proname = 'task_guest_absent')

  union all select 'the expiry still counts the return',
         (select prosrc like '%return_count%' from pg_proc
           where pronamespace = 'public'::regnamespace and proname = 'expire_stale_pickups')

  union all select 'the expiry still measures from pickup_started_at',
         (select prosrc like '%pickup_started_at%' from pg_proc
           where pronamespace = 'public'::regnamespace and proname = 'expire_stale_pickups')

  union all select 'the expiry still moves the vehicle to re_parking',
         (select prosrc like '%''re_parking''%' from pg_proc
           where pronamespace = 'public'::regnamespace and proname = 'expire_stale_pickups')

  -- THE CLEANUP. No untouched no-show may still name an operator.
  union all select 'no waiting no-show is still on an operators screen',
         not exists (
           select 1 from public.valet_tasks
            where status = 're_parking'
              and assigned_operator_id is not null
              and pickup_started_at is not null
              and (assigned_at is null or assigned_at < pickup_started_at)
         )

  -- A car the admin HAS dispatched must keep its operator, or the cleanup took
  -- the job off the screen of somebody walking to the car.
  union all select 'a dispatched re-park still has its operator',
         not exists (
           select 1 from public.valet_tasks
            where status = 're_parking'
              and assigned_operator_id is null
              and assigned_at is not null
              and pickup_started_at is not null
              and assigned_at > pickup_started_at
         )

  -- 0050 must still be in place: it is what gives the admin the card and the
  -- means to send somebody. Without it this migration hides the car from the
  -- operator and offers nobody a way to deal with it.
  union all select '0050 is applied: dispatch_reparking exists',
         to_regprocedure('public.dispatch_reparking(uuid,uuid)') is not null

  union all select '0050 is applied: the admin is told at ten minutes',
         (select prosrc like '%send someone to park it again%' from pg_proc
           where pronamespace = 'public'::regnamespace and proname = 'enqueue_desk_push')

  -- Grants unchanged.
  union all select 'staff may still mark a guest absent',
         has_function_privilege('authenticated', 'public.task_guest_absent(uuid)', 'execute')

  union all select 'nobody may call the expiry directly',
         not has_function_privilege('authenticated', 'public.expire_stale_pickups(int)', 'execute')
) t
order by ok, check_name;
