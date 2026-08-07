-- ═══════════════════════════════════════════════════════════════════════
-- 0023 — "CAR DELIVERED" PUSH TO THE ADMINS
--
-- Adds one branch to enqueue_task_push: a retrieval reaching 'completed' means
-- the guest has their car and driven off. The admins at that property get a
-- quiet notification.
--
-- ══ QUIET, AND SHARING A TAG. THE SAME RULE AS "CAR PARKED" ══
--
-- critical = false, tag = 'valet-delivered'. This fires once per car, so on a
-- Saturday it fires two hundred times. A buzzing, stacking notification per car
-- is precisely how an admin ends up silencing the app — and then misses
-- "Car requested", which is the one with a guest standing at a porch attached
-- to it. A shared tag means each delivery REPLACES the last in the tray, so the
-- admin sees the latest rather than a wall of history.
--
-- ══ WHY THE BODY DOES NOT NAME A PLACE ══
--
-- Every other message ends with the parking location. This one must not: the
-- car has left. Printing where it USED to be would read as where it is.
--
-- ══ WHY THE WHOLE FUNCTION IS RESTATED ══
--
-- A trigger function has no way to add a branch in place — CREATE OR REPLACE
-- takes the whole body. So this is migration 0019's function copied verbatim
-- with one block added, and the copy was taken from 0019 rather than from 0014,
-- because 0019 is the one that is actually live. Getting that backwards would
-- silently delete the "Car parked" branch.
--
-- Safe to re-run.
-- ═══════════════════════════════════════════════════════════════════════

begin;

create or replace function public.enqueue_task_push()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_vehicle  record;
  v_label    text;
  v_actor    uuid;
begin
  -- Who is doing this, so we never notify them about their own tap. NULL when
  -- the change came from pg_cron (expire_stale_pickups), which is exactly the
  -- case where a push matters most — nobody is looking at anything.
  select ur.id into v_actor
  from public.user_roles ur
  where ur.user_id = auth.uid() and ur.is_active = true;

  select v.token_number, v.car_number, v.car_tier, v.parking_location
    into v_vehicle
  from public.parked_vehicles v
  where v.id = new.vehicle_id;

  v_label := 'Token ' || coalesce(v_vehicle.token_number::text, '?') ||
             case when v_vehicle.car_number is not null
                  then ' · ' || v_vehicle.car_number else '' end;

  -- ── a guest asked for their car: tell the admins ────────────────────
  if new.task_type = 'retrieval'
     and new.status = 'pending'
     and (tg_op = 'INSERT' or old.status is distinct from 'pending')
  then
    insert into public.push_outbox (user_role_id, title, body, url, tag, critical, task_id)
    select ur.id,
           'Car requested',
           v_label ||
             case when v_vehicle.parking_location is not null
                  then ' · ' || v_vehicle.parking_location else '' end,
           '/admin/dashboard',
           'valet-task-' || new.id::text,
           true,
           new.id
    from public.user_roles ur
    where ur.property_id = new.property_id
      and ur.role        = 'valet_admin'
      and ur.is_active   = true
      and ur.id is distinct from v_actor;

    return new;
  end if;

  -- ── a retrieval was dispatched: tell that operator ──────────────────
  if new.task_type = 'retrieval'
     and new.status = 'assigned'
     and new.assigned_operator_id is not null
     and (tg_op = 'INSERT'
          or old.status is distinct from 'assigned'
          or old.assigned_operator_id is distinct from new.assigned_operator_id)
     and new.assigned_operator_id is distinct from v_actor
  then
    insert into public.push_outbox (user_role_id, title, body, url, tag, critical, task_id)
    values (
      new.assigned_operator_id,
      'Fetch a car',
      v_label ||
        case when v_vehicle.parking_location is not null
             then ' · ' || v_vehicle.parking_location else '' end,
      '/operator/tasks',
      'valet-task-' || new.id::text,
      true,
      new.id
    );

    return new;
  end if;

  -- ── a car has been parked: tell the admins, quietly ─────────────────
  -- Not critical, and a SHARED tag so each one replaces the last. This fires
  -- once per car, and a buzz per car is how an admin ends up muting the
  -- alerts that matter.
  if new.task_type = 'parking'
     and new.status = 'completed'
     and (tg_op = 'INSERT' or old.status is distinct from 'completed')
  then
    insert into public.push_outbox (user_role_id, title, body, url, tag, critical, task_id)
    select ur.id,
           'Car parked',
           v_label ||
             case when v_vehicle.parking_location is not null
                  then ' · ' || v_vehicle.parking_location else '' end,
           '/admin/dashboard',
           'valet-parked',
           false,
           new.id
    from public.user_roles ur
    where ur.property_id = new.property_id
      and ur.role        = 'valet_admin'
      and ur.is_active   = true
      and ur.id is distinct from v_actor;

    return new;
  end if;

  -- ── NEW: the guest has their car and gone: tell the admins, quietly ──
  --
  -- Lands on Car Status rather than the Dashboard: the Dashboard is the
  -- retrieval QUEUE, and by definition this car has left it. Car Status is the
  -- screen with the parked / in progress / re-parked / delivered breakdown,
  -- which is the question this notification raises.
  --
  -- No parking location in the body — the car is not there any more.
  if new.task_type = 'retrieval'
     and new.status = 'completed'
     and (tg_op = 'INSERT' or old.status is distinct from 'completed')
  then
    insert into public.push_outbox (user_role_id, title, body, url, tag, critical, task_id)
    select ur.id,
           'Car delivered',
           v_label,
           '/admin/car-status',
           'valet-delivered',
           false,
           new.id
    from public.user_roles ur
    where ur.property_id = new.property_id
      and ur.role        = 'valet_admin'
      and ur.is_active   = true
      and ur.id is distinct from v_actor;

    return new;
  end if;

  -- ── the hand-over window expired: tell the operator holding the car ──
  -- The single most important push in the system. expire_stale_pickups() runs
  -- on pg_cron and only ever fires when nobody tapped anything for ten minutes
  -- — overwhelmingly because the phone is locked in a pocket. The operator is
  -- standing next to a car whose guest never came.
  if new.status = 're_parking'
     and old.status is distinct from 're_parking'
     and new.assigned_operator_id is not null
     and new.assigned_operator_id is distinct from v_actor
  then
    insert into public.push_outbox (user_role_id, title, body, url, tag, critical, task_id)
    values (
      new.assigned_operator_id,
      'Guest did not arrive',
      v_label || ' · park it again and confirm the spot',
      '/operator/tasks',
      'valet-task-' || new.id::text,
      true,
      new.id
    );
  end if;

  return new;
end $fn$;

-- The trigger itself is unchanged; recreated so a fresh database gets it even
-- if an earlier migration is ever replayed out of order.
drop trigger if exists trg_task_push on public.valet_tasks;
create trigger trg_task_push
  after insert or update on public.valet_tasks
  for each row
  execute function public.enqueue_task_push();

commit;


-- ═══════════════════════════════════════════════════════════════════════
-- VERIFY — every row must read PASS
--
-- The function is not CALLED here. Checking the source text is the point: the
-- risk with restating a whole trigger body is that a branch goes MISSING, and
-- only the source can show that all five are still present.
-- ═══════════════════════════════════════════════════════════════════════
select check_name, case when ok then 'PASS' else 'FAIL' end as result
from (
  with fn as (
    select prosrc as src from pg_proc
    where pronamespace = 'public'::regnamespace and proname = 'enqueue_task_push'
  )
  select 'the new "Car delivered" branch is there' as check_name,
         (select src like '%Car delivered%' from fn) as ok

  union all select 'it is quiet and shares a tag (not critical)',
         (select src ~ '''valet-delivered'',\s*false' from fn)

  union all select 'it does NOT print a parking location — the car has left',
         (select src !~ '''Car delivered'',\s*\n?\s*v_label \|\|' from fn)

  union all select 'it lands on Car Status, not the retrieval queue',
         (select src like '%/admin/car-status%' from fn)

  -- The four that already existed. A restated trigger body is exactly where a
  -- branch gets dropped by accident, so each one is named.
  union all select 'kept: Car requested',      (select src like '%Car requested%' from fn)
  union all select 'kept: Fetch a car',        (select src like '%Fetch a car%' from fn)
  union all select 'kept: Car parked',         (select src like '%Car parked%' from fn)
  union all select 'kept: Guest did not arrive', (select src like '%Guest did not arrive%' from fn)

  union all select 'the trigger is still attached to valet_tasks',
         exists (select 1 from pg_trigger
                  where tgname = 'trg_task_push'
                    and tgrelid = 'public.valet_tasks'::regclass
                    and not tgisinternal)
) t
order by check_name;
