-- ═══════════════════════════════════════════════════════════════════════
-- MIGRATION 0036 — one message per no-show, not two
--
-- A guest who does not come to collect used to get TWO messages, seconds
-- apart, about one event:
--
--   operator taps Guest Absent    -> 'not_available'
--     "we brought it out, could not find you, it has been parked again"
--   operator taps Car Re-parked   -> 'car_returned'
--     "your car is parked again"
--
-- Same news, twice, and the second one is billed. So task_complete_reparking
-- stops queueing anything.
--
-- ── WHY THE QUEUEING GOES AND NOT JUST THE TEMPLATE ───────────────────
-- The obvious move is to simply not create the car_returned template. That
-- leaves the row being queued with nothing to send it: wa-dispatch finds no
-- template name configured, marks it failed, and the outbox fills with a
-- permanent failure on every re-park. Nothing breaks, but the logs grow a
-- fault that is not one, and the next person to read them chases it.
--
-- ── WHAT THE GUEST NOW READS, AND WHEN ────────────────────────────────
-- One message, at Guest Absent — BEFORE the car is actually back in a space.
-- The wording has to match that, so it says the car is being parked again
-- rather than that it has been. The old text claimed a past tense that was
-- still a minute away.
--
-- The guest can still ask for it again: the Get my car button on that message
-- works, and 'returned' is a requestable status.
--
-- ── WHAT IS NOT REMOVED ───────────────────────────────────────────────
-- 'car_returned' stays in the wa_outbox message_type CHECK constraint. Rows
-- already queued under it keep their meaning, and dropping a value from a
-- CHECK is a rewrite of the table for no gain. wa-dispatch keeps handling it
-- too, so a re-queue by hand still works if this is ever reversed.
-- ═══════════════════════════════════════════════════════════════════════

begin;

drop function if exists public.task_complete_reparking(uuid, text);
drop function if exists public.task_complete_reparking(uuid, text, boolean);

create function public.task_complete_reparking(
  p_task_id  uuid,
  p_location text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_task     public.valet_tasks;
  v_location text := nullif(btrim(coalesce(p_location, '')), '');
begin
  v_task := public.claim_task(p_task_id, 'retrieval', array['re_parking', 'returned']);

  if v_location is null then
    raise exception 'BAD_LOCATION: enter where you parked the car';
  end if;
  if length(v_location) > 60 then
    raise exception 'BAD_LOCATION: keep the location short, like "L2 Bay B4"';
  end if;

  update public.valet_tasks
     set status       = 'completed',
         completed_at = now()
   where id = v_task.id;

  update public.parked_vehicles
     set status           = 'returned',
         parking_location = v_location
   where id = v_task.vehicle_id;

  -- NO MESSAGE. The guest was already told at Guest Absent, one step earlier.
  -- See the header: two messages for one event, and the second one billed.

  return jsonb_build_object('task_id', v_task.id, 'vehicle_id', v_task.vehicle_id);
end $fn$;

revoke execute on function public.task_complete_reparking(uuid, text) from public, anon;
grant  execute on function public.task_complete_reparking(uuid, text) to authenticated;

commit;


-- ═══════════════════════════════════════════════════════════════════════
-- VERIFY — every row must read PASS
-- ═══════════════════════════════════════════════════════════════════════
select check_name, case when ok then 'PASS' else 'FAIL' end as result
from (
  select 'task_complete_reparking exists and takes 2 args' as check_name,
         to_regprocedure('public.task_complete_reparking(uuid,text)') is not null as ok

  union all select 'it no longer queues a guest message',
         (select prosrc not like '%wa_outbox%' from pg_proc
           where pronamespace = 'public'::regnamespace
             and proname = 'task_complete_reparking')

  union all select 'it still writes both tables',
         (select prosrc like '%valet_tasks%' and prosrc like '%parked_vehicles%'
            from pg_proc
           where pronamespace = 'public'::regnamespace
             and proname = 'task_complete_reparking')

  union all select 'Guest Absent still DOES message the guest',
         (select prosrc like '%not_available%' from pg_proc
           where pronamespace = 'public'::regnamespace
             and proname = 'task_guest_absent')
) t
order by ok, check_name;
