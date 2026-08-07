-- ═══════════════════════════════════════════════════════════════════════
-- 0025 — "CAR RE-PARKED", AND EVERY NOTIFICATION LANDS SOMEWHERE USEFUL
--
-- Two things.
--
-- == 1. A BUG 0023 INTRODUCED ==
--
-- A retrieval finishes in two completely different ways and BOTH end up as
-- task_type = 'retrieval', status = 'completed':
--
--   at_pickup           -> completed   the guest took the car and drove off
--   re_parking/returned -> completed   the guest never came; it went back
--
-- 0023's "Car delivered" branch matched on type and status alone, so from the
-- moment it shipped an admin was told "car delivered" every time a guest
-- FAILED to turn up. The message was not merely unhelpful, it was false.
--
-- old.status tells them apart. Not the vehicle's status: task_complete_
-- reparking() updates valet_tasks first and parked_vehicles second, so when
-- this trigger runs the vehicle row still holds its previous value.
--
-- == 2. WHERE EACH NOTIFICATION LANDS WHEN TAPPED ==
--
--   Car requested        /admin/dashboard    the admin must ASSIGN someone,
--                                            and that control is on the queue
--   Car parked           /admin/car-status   CHANGED from /admin/dashboard —
--                                            a parked car is not in the queue
--   Car re-parked        /admin/car-status   new
--   Car delivered        /admin/car-status
--   Fetch a car          /operator/tasks
--   Guest did not arrive /operator/tasks
--
-- The rule: land on the screen that answers the question the notification
-- raises. The Dashboard is the retrieval QUEUE, so it is right for the one
-- message that needs an assignment and wrong for the three about cars that
-- have left it. Car Status carries the parked / in progress / re-parked /
-- delivered breakdown, which is exactly what those three prompt.
--
-- Restated in full, as with 0023 and 0024: CREATE OR REPLACE takes the whole
-- body. Copied from 0024, which is the live one.
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
  v_op       text;
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

  -- Who did the work. Its own segment on the two "quiet" messages below, so
  -- the admin's first question — which of my operators was this — is answered
  -- without opening anything.
  --
  -- The ENGLISH name, deliberately. This trigger has no idea which language
  -- the person reading the notification chose, and a name is passed through
  -- the translator untouched either way (see src/i18n/autoTranslate). An
  -- English name in a Hindi notification is readable; a Devanagari name in an
  -- English one is not.
  select ur.name into v_op
  from public.user_roles ur
  where ur.id = new.assigned_operator_id;

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
                  then ' · ' || v_vehicle.parking_location else '' end ||
             case when v_op is not null then ' · by ' || v_op else '' end,
           '/admin/car-status',
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
    -- A retrieval finishes in TWO completely different ways, and both land on
    -- task_type = 'retrieval', status = 'completed'. Telling them apart is not
    -- optional: without this the admin is told "car delivered" about a guest
    -- who never turned up.
    --
    --   at_pickup            -> completed   the guest took the car and left
    --   re_parking/returned  -> completed   nobody came; it went back
    --
    -- old.status is the discriminator rather than the vehicle's status,
    -- because task_complete_reparking() updates valet_tasks FIRST and
    -- parked_vehicles second — so at the moment this trigger runs, the vehicle
    -- row still says what it said before.
    if tg_op = 'UPDATE' and old.status in ('re_parking', 'returned') then
      -- ── the guest never came, so the car is back in the car park ──────
      --
      -- No location in the body, deliberately. The new spot is written to
      -- parked_vehicles by the statement AFTER the one that fired this
      -- trigger, so v_vehicle.parking_location is still the OLD spot. Printing
      -- it would name the wrong place with complete confidence, which is worse
      -- than naming none — the admin taps through to Car Status for the where.
      insert into public.push_outbox (user_role_id, title, body, url, tag, critical, task_id)
      select ur.id,
             'Car re-parked',
             v_label || case when v_op is not null then ' · by ' || v_op else '' end,
             '/admin/car-status',
             'valet-reparked',
             false,
             new.id
      from public.user_roles ur
      where ur.property_id = new.property_id
        and ur.role        = 'valet_admin'
        and ur.is_active   = true
        and ur.id is distinct from v_actor;
    else
      -- ── the guest has their car and gone ──────────────────────────────
      insert into public.push_outbox (user_role_id, title, body, url, tag, critical, task_id)
      select ur.id,
             'Car delivered',
             v_label || case when v_op is not null then ' · by ' || v_op else '' end,
             '/admin/car-status',
             'valet-delivered',
             false,
             new.id
      from public.user_roles ur
      where ur.property_id = new.property_id
        and ur.role        = 'valet_admin'
        and ur.is_active   = true
        and ur.id is distinct from v_actor;
    end if;

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
-- ═══════════════════════════════════════════════════════════════════════
select check_name, case when ok then 'PASS' else 'FAIL' end as result
from (
  with fn as (
    select prosrc as src from pg_proc
    where pronamespace = 'public'::regnamespace and proname = 'enqueue_task_push'
  )
  select 'the new "Car re-parked" message exists' as check_name,
         (select src like '%Car re-parked%' from fn) as ok

  union all select 'delivered and re-parked are told apart by old.status',
         (select src like '%old.status in (''re_parking'', ''returned'')%' from fn)

  union all select 're-parked prints NO location — the vehicle row is stale here',
         (select src not like '%Car re-parked%parking_location%' from fn)

  union all select 'Car parked now lands on Car Status',
         (select src not like '%valet-parked%' or
                 src like '%/admin/car-status'',%valet-parked%' from fn)

  union all select 'Car requested still lands on the queue, where Assign lives',
         (select src like '%/admin/dashboard'',%' from fn)

  union all select 'the two operator messages still land on My Tasks',
         (select (length(src) - length(replace(src, '/operator/tasks', ''))) / 15 = 2 from fn)

  -- All six messages, named. Restating a trigger body is where one goes
  -- missing by accident.
  union all select 'kept: Car requested',        (select src like '%Car requested%' from fn)
  union all select 'kept: Fetch a car',          (select src like '%Fetch a car%' from fn)
  union all select 'kept: Car parked',           (select src like '%Car parked%' from fn)
  union all select 'kept: Car delivered',        (select src like '%Car delivered%' from fn)
  union all select 'kept: Guest did not arrive', (select src like '%Guest did not arrive%' from fn)
  union all select 'kept: the operator is named',(select src like '%by '' || v_op%' from fn)

  union all select 'the trigger is still attached to valet_tasks',
         exists (select 1 from pg_trigger
                  where tgname = 'trg_task_push'
                    and tgrelid = 'public.valet_tasks'::regclass
                    and not tgisinternal)
) t
order by check_name;
