-- ═══════════════════════════════════════════════════════════════════════
-- MIGRATION 0039 — tell the guest their car has ARRIVED at the entrance
--
-- The gap this fills: between "your car will be at the gate within 15 minutes"
-- and "handed over", the guest hears nothing. The car can be standing at the
-- entrance for nine minutes with the guest still upstairs, and then it gets
-- re-parked and both sides have wasted a trip.
--
-- ── WHY task_start_pickup AND NOT task_guest_arrived ──────────────────
-- Because those are two different moments and only one of them is news:
--
--   task_accept          operator takes the job          nothing to tell
--   task_start_pickup    THE CAR IS AT THE ENTRANCE      <- this one
--   task_guest_arrived   the guest has taken it          already with them
--
-- task_start_pickup was the only step in the retrieval flow that changed the
-- vehicle's status and told nobody.
--
-- ── WHY "10 MINUTES" IS NOT A ROUND NUMBER SOMEBODY LIKED ─────────────
-- expire_stale_pickups() times a car out of 'at_pickup' after exactly 10
-- minutes and queues not_available. So the deadline in the message IS the
-- deadline the system enforces. If that timeout is ever changed, the template
-- wording has to change with it — and that means a fresh Meta review, so it is
-- worth not changing casually.
--
-- ── WHAT THIS COSTS ───────────────────────────────────────────────────
-- One more BILLED message per retrieval. A visit that ends normally now sends
-- car_park, this one, and car_delivered — three billed, plus the free
-- acknowledgement. Worth stating plainly: this is a real per-car cost, bought
-- to stop cars standing unclaimed at the entrance.
-- ═══════════════════════════════════════════════════════════════════════

begin;

-- ═══════════════════════════════════════════════════════════════════════
-- 1. The queue has to accept the new kind of message
--
-- message_type is a CHECK, not an enum, so this is a constraint swap. The old
-- values all stay — 'car_returned' included, even though nothing queues it any
-- more (migration 0036), because rows already written under it keep meaning
-- what they meant.
-- ═══════════════════════════════════════════════════════════════════════

alter table public.wa_outbox
  drop constraint if exists wa_outbox_message_type_check;

alter table public.wa_outbox
  add constraint wa_outbox_message_type_check
  check (message_type in (
    'car_parked',
    'car_at_pickup',   -- new: the car is standing at the entrance
    'car_delivered',
    'not_available',
    'car_returned'
  ));


-- ═══════════════════════════════════════════════════════════════════════
-- 2. task_start_pickup — same as migration 0007, plus the queue insert
--
-- Everything above the insert is that migration's text unchanged: the same
-- claim_task guard, the same two status updates, the same return shape.
-- ═══════════════════════════════════════════════════════════════════════

create or replace function public.task_start_pickup(p_task_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_task    public.valet_tasks;
  v_started timestamptz := now();
begin
  v_task := public.claim_task(p_task_id, 'retrieval', array['assigned', 'in_progress']);

  update public.valet_tasks
     set status            = 'at_pickup',
         pickup_started_at = v_started
   where id = v_task.id;

  update public.parked_vehicles
     set status = 'at_pickup'
   where id = v_task.vehicle_id;

  -- Queued INSIDE the same transaction as the status change, like every other
  -- guest message in this system. If the transaction rolls back the message
  -- goes with it, so the guest is never told about a state the database does
  -- not agree happened.
  insert into public.wa_outbox (property_id, vehicle_id, task_id, message_type)
  values (v_task.property_id, v_task.vehicle_id, v_task.id, 'car_at_pickup');

  return jsonb_build_object(
    'task_id',           v_task.id,
    'pickup_started_at', v_started
  );
end $fn$;

revoke execute on function public.task_start_pickup(uuid) from public, anon;
grant  execute on function public.task_start_pickup(uuid) to authenticated;

commit;


-- ═══════════════════════════════════════════════════════════════════════
-- VERIFY — every row must read PASS
-- ═══════════════════════════════════════════════════════════════════════
select check_name, case when ok then 'PASS' else 'FAIL' end as result
from (
  select 'the queue accepts car_at_pickup' as check_name,
         pg_get_constraintdef(oid) like '%car_at_pickup%' as ok
    from pg_constraint
   where conname = 'wa_outbox_message_type_check'

  -- The old values must survive the constraint swap. Losing one would make
  -- every future message of that kind fail an insert, inside the transaction
  -- that was completing an operator's task.
  union all select 'car_parked still allowed',
         (select pg_get_constraintdef(oid) like '%car_parked%' from pg_constraint
           where conname = 'wa_outbox_message_type_check')

  union all select 'car_delivered still allowed',
         (select pg_get_constraintdef(oid) like '%car_delivered%' from pg_constraint
           where conname = 'wa_outbox_message_type_check')

  union all select 'not_available still allowed',
         (select pg_get_constraintdef(oid) like '%not_available%' from pg_constraint
           where conname = 'wa_outbox_message_type_check')

  union all select 'car_returned still allowed (old rows keep meaning)',
         (select pg_get_constraintdef(oid) like '%car_returned%' from pg_constraint
           where conname = 'wa_outbox_message_type_check')

  union all select 'task_start_pickup now queues a message',
         (select prosrc like '%car_at_pickup%' from pg_proc
           where pronamespace = 'public'::regnamespace
             and proname = 'task_start_pickup')

  -- It must still do the work it did before. A version that only messages
  -- would leave the car in the wrong state with the guest already told.
  union all select 'task_start_pickup still sets at_pickup',
         (select prosrc like '%at_pickup%' and prosrc like '%pickup_started_at%'
            from pg_proc
           where pronamespace = 'public'::regnamespace
             and proname = 'task_start_pickup')

  union all select 'operators may still call it',
         has_function_privilege('authenticated',
           'public.task_start_pickup(uuid)', 'execute')

  union all select 'anon still may NOT call it',
         not has_function_privilege('anon', 'public.task_start_pickup(uuid)', 'execute')
) t
order by ok, check_name;
