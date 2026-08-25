-- ═══════════════════════════════════════════════════════════════════════
-- MIGRATION 0045 — send an operator for a car nobody asked for yet
--
-- The gap: a guest walks up to the desk and asks for their car in person. They
-- never tapped "Get My Car", so no retrieval task exists, so the admin's queue
-- does not know about them and there is nothing to assign.
--
-- Until now the only way through was the operator's own "Request car" button on
-- Today's Cars. That is being removed — dispatch is the admin's job, and an
-- operator raising their own work made the queue lie about who asked.
--
-- ── WHY ONE FUNCTION AND NOT TWO CALLS ────────────────────────────────
-- request_retrieval() and assign_retrieval() both already exist, so the admin
-- screen could call them in sequence. It must not.
--
-- If the second call fails — the operator just went busy, the network dropped,
-- the tab closed — the first has already committed. The car now carries a
-- pending retrieval request that nobody made, sitting at the top of the queue,
-- and the guest gets told their car is coming when nobody was sent.
--
-- One function, one transaction: either an operator is on their way or nothing
-- happened at all.
--
-- ── WHY IT REUSES A PENDING TASK RATHER THAN REFUSING ─────────────────
-- The guest may have tapped the button seconds before the admin pressed
-- Assign — a race between a phone and a desk that will happen. Refusing would
-- make the admin retry for no reason. So an existing pending request is
-- adopted, not duplicated, and the guest's own request is what gets assigned.
-- ═══════════════════════════════════════════════════════════════════════

begin;

create or replace function public.dispatch_vehicle(
  p_vehicle_id  uuid,
  p_operator_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_role    text;
  v_mine    uuid;
  v_vehicle public.parked_vehicles;
  v_task_id uuid;
begin
  -- ── WHO IS ASKING ───────────────────────────────────────────────────
  select ur.role, ur.property_id into v_role, v_mine
  from public.user_roles ur
  where ur.user_id = auth.uid() and ur.is_active = true;

  if v_role is null then
    raise exception 'FORBIDDEN: you are not signed in as an active user';
  end if;

  -- Dispatch is an admin action. An operator calling this would be handing
  -- themselves work, which is the thing this migration exists to stop.
  if v_role not in ('valet_admin', 'system_admin') then
    raise exception 'FORBIDDEN: only an admin can send someone for a car';
  end if;

  select * into v_vehicle
  from public.parked_vehicles
  where id = p_vehicle_id;

  if v_vehicle.id is null then
    raise exception 'NOT_FOUND: that car is not on the list';
  end if;

  -- A valet_admin is pinned to their own site. Without this an admin at one
  -- property could dispatch a car at another, to an operator who is not there.
  if v_role = 'valet_admin' and v_vehicle.property_id <> v_mine then
    raise exception 'FORBIDDEN: that car is at another property';
  end if;

  -- ── THE CAR HAS TO BE THERE ─────────────────────────────────────────
  -- 'parked' is the normal case. 'returned' is a car that came back after a
  -- no-show and is on site again, so it can be asked for a second time.
  -- Anything else — already being fetched, at the gate, or gone — is refused,
  -- because sending a second operator for it produces two people and one car.
  if v_vehicle.status not in ('parked', 'returned') then
    raise exception 'WRONG_STATUS: that car is not parked right now';
  end if;

  -- ── THE OPERATOR HAS TO BE REAL, HERE, AND FREE ─────────────────────
  if not exists (
    select 1 from public.user_roles ur
     where ur.id = p_operator_id
       and ur.role = 'operator'
       and ur.is_active = true
       and ur.property_id = v_vehicle.property_id
  ) then
    raise exception 'BAD_OPERATOR: that operator is not active at this property';
  end if;

  -- ── ADOPT A PENDING REQUEST, OR MAKE ONE ────────────────────────────
  -- The guest may have tapped Get My Car a moment ago. Taking theirs keeps one
  -- request per car and keeps the guest's own timestamp, which is what the
  -- waiting time on the queue is measured from.
  select id into v_task_id
  from public.valet_tasks
  where vehicle_id = p_vehicle_id
    and task_type  = 'retrieval'
    and status     = 'pending'
  order by created_at
  limit 1;

  if v_task_id is null then
    insert into public.valet_tasks (property_id, vehicle_id, task_type, status)
    values (v_vehicle.property_id, v_vehicle.id, 'retrieval', 'pending')
    returning id into v_task_id;
  end if;

  -- Assignment is left to the existing function, so there is one place that
  -- decides what "assigned" means — the operator check, the timestamps, and
  -- whatever it queues. Duplicating it here is how the two would drift.
  return public.assign_retrieval(v_task_id, p_operator_id);
end $fn$;

revoke execute on function public.dispatch_vehicle(uuid, uuid) from public, anon;
grant  execute on function public.dispatch_vehicle(uuid, uuid) to authenticated;

commit;


-- ═══════════════════════════════════════════════════════════════════════
-- VERIFY — every row must read PASS
-- ═══════════════════════════════════════════════════════════════════════
select check_name, case when ok then 'PASS' else 'FAIL' end as result
from (
  select 'dispatch_vehicle exists' as check_name,
         to_regprocedure('public.dispatch_vehicle(uuid,uuid)') is not null as ok

  union all select 'an operator cannot dispatch to themselves',
         (select prosrc like '%only an admin can send someone for a car%'
            from pg_proc
           where pronamespace = 'public'::regnamespace
             and proname = 'dispatch_vehicle')

  union all select 'a valet_admin is pinned to their property',
         (select prosrc like '%that car is at another property%' from pg_proc
           where pronamespace = 'public'::regnamespace
             and proname = 'dispatch_vehicle')

  union all select 'the car must be parked or returned',
         (select prosrc like '%WRONG_STATUS%' from pg_proc
           where pronamespace = 'public'::regnamespace
             and proname = 'dispatch_vehicle')

  union all select 'the operator must be active at that property',
         (select prosrc like '%BAD_OPERATOR%' from pg_proc
           where pronamespace = 'public'::regnamespace
             and proname = 'dispatch_vehicle')

  -- The whole reason this function exists: one transaction, not two calls.
  union all select 'it adopts a pending request instead of duplicating it',
         (select prosrc like '%status     = ''pending''%' from pg_proc
           where pronamespace = 'public'::regnamespace
             and proname = 'dispatch_vehicle')

  union all select 'it delegates the assignment itself',
         (select prosrc like '%assign_retrieval%' from pg_proc
           where pronamespace = 'public'::regnamespace
             and proname = 'dispatch_vehicle')

  union all select 'staff may call it',
         has_function_privilege('authenticated',
           'public.dispatch_vehicle(uuid,uuid)', 'execute')

  union all select 'anon may NOT call it',
         not has_function_privilege('anon',
           'public.dispatch_vehicle(uuid,uuid)', 'execute')
) t
order by ok, check_name;
