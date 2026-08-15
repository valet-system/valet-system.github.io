-- ═══════════════════════════════════════════════════════════════════════
-- MIGRATION 0031 — task_accept: the operator acknowledges a dispatch
--
-- WHAT THIS ADDS
--   One RPC, task_accept(task_id), which moves a retrieval from 'assigned'
--   to 'in_progress'.
--
-- WHY IT EXISTS
--   Until now an admin dispatched a retrieval and had no way of knowing
--   whether the operator had even seen it. The task sat in 'assigned'
--   whether the phone was in a pocket, out of battery, or being read. The
--   only signal was the operator eventually tapping "Car at Delivery
--   Point", which happens minutes later, at the far end of the walk.
--
--   'assigned' now means dispatched-but-unacknowledged, and the operator's
--   screen keeps sounding the alarm for exactly as long as that is true.
--   Accepting is what stops it. So this transition is the thing the alarm
--   is waiting for, which is why it is a real server-side state change and
--   not a flag in the phone's local storage — an alarm that a reload can
--   silence is not an alarm.
--
-- WHY NO NEW COLUMN, AND NO NEW STATUS
--   'in_progress' already existed in the enum and in ACTIVE_TASK_STATUSES,
--   and was unused by the retrieval flow — assign wrote 'assigned' and
--   task_start_pickup jumped straight to 'at_pickup'. It already carries
--   exactly this meaning ("this operator has it in hand"), it is already
--   treated as busy by get_available_operators, and it already renders with
--   a label and a badge. Adding an accepted_at column and a fourth status
--   would have duplicated all of that.
--
--   The one thing it does not give us is WHEN the operator accepted. If a
--   response-time report is ever wanted, that is the moment to add the
--   column — not before, on the chance it might be.
--
-- WHY task_start_pickup NEEDS NO CHANGE
--   It already claims from array['assigned', 'in_progress'], so it works
--   from either side of this transition. That matters: an operator standing
--   at the delivery point can go straight there, and doing so stops the
--   alarm just as accepting does, because the status is no longer
--   'assigned'. Nobody is forced through a button that tells them what they
--   already know.
--
-- SAFE TO RE-RUN
--   create or replace, and the return type is new, so there is no 42P13
--   drop-first dance here.
-- ═══════════════════════════════════════════════════════════════════════

create or replace function public.task_accept(p_task_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_task public.valet_tasks;
begin
  -- claim_task does the whole guard: signed in, task exists, right property,
  -- assigned to THIS operator, right type, and currently 'assigned'. It also
  -- takes a row lock, so two taps from a double-press cannot both pass — the
  -- second one finds 'in_progress' and raises WRONG_STATUS, which the app
  -- already renders as "pull down to refresh".
  v_task := public.claim_task(p_task_id, 'retrieval', array['assigned']);

  update public.valet_tasks
     set status = 'in_progress'
   where id = v_task.id;

  -- parked_vehicles is deliberately untouched. The car has not moved: it is
  -- still parked where it was until task_start_pickup says otherwise.

  return jsonb_build_object(
    'task_id', v_task.id,
    'status',  'in_progress'
  );
end $fn$;

revoke execute on function public.task_accept(uuid) from public, anon;
grant  execute on function public.task_accept(uuid) to authenticated;
