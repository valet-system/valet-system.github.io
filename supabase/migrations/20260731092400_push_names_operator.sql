-- ═══════════════════════════════════════════════════════════════════════
-- 0024 — NAME THE OPERATOR ON THE TWO QUIET NOTIFICATIONS
--
-- "Car parked" and "Car delivered" now end with who did it:
--
--   Car parked      Token 47 · 4821 · Basement 2 · by Rajesh
--   Car delivered   Token 47 · 4821 · by Rajesh
--
-- == WHY IT IS A SEGMENT AND NOT PART OF THE TITLE ==
--
-- The title is looked up as a WHOLE string to be translated — see
-- SERVER_PHRASES in src/i18n/autoTranslate.js. "Car parked by Rajesh" would
-- never match anything, so the whole notification would fall back to English.
-- The body is split on the middot and each piece is handled on its own, which
-- is how "by Rajesh" becomes "राजेश ने" while the car number and the place
-- name beside it stay exactly as they were written.
--
-- == WHY THE ENGLISH NAME ==
--
-- A trigger has no idea which language the person reading the notification
-- chose. A name passes through the translator untouched either way, and an
-- English name inside a Hindi notification is readable, whereas a Devanagari
-- name inside an English one is not.
--
-- == ONLY THESE TWO ==
--
-- "Car requested" goes out before anyone is assigned, so there is no operator
-- to name. "Fetch a car" and "Guest did not arrive" go TO the operator, who
-- does not need telling who they are.
--
-- Restated in full for the same reason as 0023: CREATE OR REPLACE takes the
-- whole body. This is 0023's function with two lines added, and the copy was
-- taken from 0023 because that is the one that is live.
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
  select 'the operator is looked up' as check_name,
         (select src like '%select ur.name into v_op%' from fn) as ok

  union all select 'Car parked names the operator',
         (select src like '%Car parked%by '' || v_op%' from fn)

  union all select 'Car delivered names the operator',
         (select src like '%Car delivered%by '' || v_op%' from fn)

  union all select 'a missing operator does not break the body',
         (select src like '%case when v_op is not null%' from fn)

  -- All five branches, named, because restating a trigger body is exactly
  -- where one goes missing by accident.
  union all select 'kept: Car requested',        (select src like '%Car requested%' from fn)
  union all select 'kept: Fetch a car',          (select src like '%Fetch a car%' from fn)
  union all select 'kept: Car parked',           (select src like '%Car parked%' from fn)
  union all select 'kept: Car delivered',        (select src like '%Car delivered%' from fn)
  union all select 'kept: Guest did not arrive', (select src like '%Guest did not arrive%' from fn)

  union all select 'the trigger is still attached to valet_tasks',
         exists (select 1 from pg_trigger
                  where tgname = 'trg_task_push'
                    and tgrelid = 'public.valet_tasks'::regclass
                    and not tgisinternal)
) t
order by check_name;
