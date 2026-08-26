-- ═══════════════════════════════════════════════════════════════════════
-- MIGRATION 0051 — the operator is no longer told about a no-show
--
-- On request, and it follows from 0050 rather than reversing it.
--
-- ── WHAT IS REMOVED ───────────────────────────────────────────────────
-- One branch of enqueue_task_push(): the push that fired at 're_parking' and
-- went to the task's assigned operator, titled "Guest did not arrive".
--
-- Migration 0025 called it "the single most important push in the system", and
-- under the flow that existed then it was. The operator was standing next to a
-- car whose guest never came, the task was still his, the keys were in his
-- hand, and nothing else in the system would tell him.
--
-- ── WHY IT IS NOW THE WRONG PUSH ──────────────────────────────────────
-- Since 0050 none of that holds. He brought the car to the door, handed it to
-- the desk and walked away ten minutes ago. He is on another car. The keys are
-- with the admin. The task carries his name only as the record of who fetched
-- it — he cannot act on it and is not expected to.
--
-- So the push woke a phone to report work its owner could not do, about a car
-- he no longer had. Worse than useless: this is a critical push, so it buzzes
-- through, and a stream of alerts that turn out not to be your problem is how
-- an operator learns to ignore the ones that are.
--
-- ── WHO IS TOLD INSTEAD ───────────────────────────────────────────────
-- Nothing is lost. enqueue_desk_push() in 0050 already covers both people who
-- can actually do something:
--
--   the admins     at the moment the ten minutes expire — sending somebody is
--                  their decision to make
--   one operator   when the admin actually dispatches him, keyed on
--                  assigned_operator_id changing rather than on the status,
--                  because by then the status is already 're_parking'
--
-- ── WHY THE WHOLE FUNCTION IS REPRINTED ───────────────────────────────
-- Postgres has no way to remove one branch from a plpgsql body; the function
-- has to be replaced whole. The definition below was extracted from migration
-- 0025 programmatically and had exactly that one branch cut out — it was not
-- retyped. Reproducing ~200 lines and six branches by hand is how one of the
-- other five quietly loses a condition, and this file is the reason to say so:
-- if you are here to change something, do the same.
--
-- Branch count: 0025 had six push_outbox inserts. This has five.
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

  -- ── THE NO-SHOW PUSH TO THE OPERATOR IS GONE ────────────────────────
  -- Removed by migration 0051, on request. What used to be here:
  --
  --     'Guest did not arrive' -> new.assigned_operator_id
  --
  -- It was described in this file as "the single most important push in the
  -- system", and under the old flow it was: the operator was standing next to
  -- a car whose guest never came, the task was his, and nothing else would
  -- tell him.
  --
  -- None of that is true any more. Since migration 0050 he handed the car to
  -- the desk and walked away ten minutes ago — he is on another car, the keys
  -- are with the admin, and this task is no longer his to act on. The push
  -- told him about work he could not do, on a car he no longer had.
  --
  -- Who IS told now, both from enqueue_desk_push() in 0050:
  --
  --   the admins        the moment the ten minutes run out, because sending
  --                     somebody is their decision
  --   one operator      when the admin actually dispatches him — keyed on
  --                     assigned_operator_id changing, since the status is
  --                     already 're_parking' by then
  --
  -- So the information still reaches whoever can act on it. It just no longer
  -- reaches somebody who cannot.

  return new;
end $fn$;

-- The trigger is unchanged. Recreated so a fresh database gets it even if an
-- earlier migration is ever replayed out of order.
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
  -- THE REMOVAL. Comments are stripped first: the body now EXPLAINS the removal
  -- and names the title it removed, so a plain `not like` would match the
  -- explanation and report FAIL on correct code.
  select 'the operator is no longer told about a no-show' as check_name,
         (select regexp_replace(prosrc, '--.*', '', 'gn') not like '%Guest did not arrive%'
            from pg_proc
           where pronamespace = 'public'::regnamespace
             and proname = 'enqueue_task_push') as ok

  union all select 'the removed branch is documented, not just deleted',
         (select prosrc like '%Removed by migration 0051%' from pg_proc
           where pronamespace = 'public'::regnamespace and proname = 'enqueue_task_push')

  -- FIVE, NOT SIX. The whole risk of reprinting the function is losing another
  -- branch by accident, so the count is asserted.
  union all select 'exactly five pushes remain in the trigger',
         (select (length(prosrc) - length(replace(prosrc, 'insert into public.push_outbox', '')))
                 / length('insert into public.push_outbox') = 5
            from pg_proc
           where pronamespace = 'public'::regnamespace and proname = 'enqueue_task_push')

  -- And each survivor named individually, because a count alone would pass if
  -- one branch were duplicated and a different one dropped.
  union all select 'a guest asking for their car still pushes',
         (select prosrc like '%Car requested%' from pg_proc
           where pronamespace = 'public'::regnamespace and proname = 'enqueue_task_push')

  union all select 'a dispatched retrieval still pushes',
         (select prosrc like '%Fetch a car%' from pg_proc
           where pronamespace = 'public'::regnamespace and proname = 'enqueue_task_push')

  union all select 'the trigger still exists',
         exists (select 1 from pg_trigger
                  where tgrelid = 'public.valet_tasks'::regclass
                    and tgname = 'trg_task_push' and not tgisinternal)

  -- 0050's replacements MUST be in place, or this migration takes away the only
  -- notification anybody got for a no-show.
  union all select '0050 is applied: the desk trigger exists',
         exists (select 1 from pg_trigger
                  where tgrelid = 'public.valet_tasks'::regclass
                    and tgname = 'z_desk_push' and not tgisinternal)

  union all select 'the admins are still told at ten minutes',
         (select prosrc like '%send someone to park it again%' from pg_proc
           where pronamespace = 'public'::regnamespace and proname = 'enqueue_desk_push')

  union all select 'the dispatched operator is still told',
         (select prosrc like '%Park a car again%' from pg_proc
           where pronamespace = 'public'::regnamespace and proname = 'enqueue_desk_push')
) t
order by ok, check_name;
