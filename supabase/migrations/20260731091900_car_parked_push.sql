-- ═══════════════════════════════════════════════════════════════════════
-- 0019 — TELL THE ADMIN WHEN A CAR IS PARKED
--
--   >>> RUN THIS IN THE SUPABASE SQL EDITOR, AFTER 0014. <<<
--
-- Safe to run more than once. Creates no tables; if the editor warns about
-- RLS, choose "Run without RLS".
--
--
-- WHAT CHANGES
--
-- One more branch in enqueue_task_push(): a completed PARKING task now notifies
-- the valet_admins at that property. Everything else about the trigger is
-- unchanged and is repeated below only because a plpgsql function has to be
-- replaced whole.
--
--
-- ── THIS ONE IS DELIBERATELY QUIET, AND THE REASON MATTERS ──────────────
--
-- Every other push in this system is `critical`: it buzzes, it stays on screen,
-- and somebody is waiting on the other end of it. This one is not, because it
-- fires ONCE PER CAR.
--
-- At forty cars a day that is fine. At a thousand — which one property can now
-- reach — a buzzing notification per car is forty an hour through a dinner
-- service, and the admin's only sane response is to turn notifications off for
-- this app entirely. That would also kill "Car requested" and "Guest did not
-- arrive", which are the two that actually need answering.
--
-- So it is silent, and it carries a SHARED tag: 'valet-parked' rather than
-- 'valet-task-<id>'. A shared tag makes each new one REPLACE the previous
-- notification instead of stacking, so the admin sees one line that keeps
-- updating with the latest car rather than a column of nine hundred.
--
-- The live count on the dashboard is the real answer to "how many are parked" —
-- this is a glance, not a queue.
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

  -- ── NEW: a car has been parked: tell the admins, quietly ────────────
  -- Not critical, and a SHARED tag so each one replaces the last. See the
  -- header — this fires once per car, and a buzz per car is how an admin ends
  -- up muting the alerts that matter.
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
-- if 0014 is ever replayed out of order.
drop trigger if exists trg_task_push on public.valet_tasks;
create trigger trg_task_push
  after insert or update on public.valet_tasks
  for each row
  execute function public.enqueue_task_push();

commit;


-- ═══════════════════════════════════════════════════════════════════════
-- VERIFY — every row should say PASS.
-- ═══════════════════════════════════════════════════════════════════════

with src as (
  select prosrc from pg_proc where oid = 'public.enqueue_task_push()'::regprocedure
),
checks as (
  select 'a parked car notifies the admins' as item,
         (select prosrc like '%''Car parked''%' from src) as ok
  -- `~` and not LIKE. `like '%''valet-parked'',%false%'` passes today only
  -- because no other `false` happens to appear later in the function — add one
  -- and this check starts passing whatever the parked push actually does. The
  -- regex requires `false` to be the very next token after the tag.
  union all select 'the parked push is NOT critical',
         (select prosrc ~ '''valet-parked'',\s*false' from src)
  union all select 'the parked push uses a SHARED tag (replaces, not stacks)',
         (select prosrc ~ '''valet-parked''\s*,' from src)
  union all select 'the three earlier pushes still exist',
         (select prosrc like '%''Car requested''%'
             and prosrc like '%''Fetch a car''%'
             and prosrc like '%''Guest did not arrive''%' from src)
  union all select 'nobody is notified about their own tap',
         (select prosrc like '%is distinct from v_actor%' from src)
  union all select 'the trigger is attached',
         exists (select 1 from pg_trigger where tgname = 'trg_task_push' and not tgisinternal)
)
select item, case when ok then 'PASS' else 'FAIL' end as result
from checks
order by result desc, item;
