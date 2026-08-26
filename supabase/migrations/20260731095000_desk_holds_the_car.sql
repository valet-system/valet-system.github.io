-- ═══════════════════════════════════════════════════════════════════════
-- MIGRATION 0050 — the car at the door belongs to the desk
--
-- The requested flow, in order:
--
--   1. operator brings the car, taps "Car at Delivery Point" -> HIS JOB ENDS
--   2. the valet admin is notified: a car is waiting at the door
--   3. the 10-minute countdown keeps running
--   4. guest arrives inside 10 min  -> the admin marks it handed over, and the
--                                      existing WhatsApp thank-you + rating
--                                      goes out exactly as it does today
--   5. 10 min pass with no guest    -> operator AND admin are both notified,
--                                      and the admin dispatches a FREE operator
--                                      to park it again
--
-- ── WHAT WAS TRUE BEFORE ──────────────────────────────────────────────
-- Tapping "Car at Delivery Point" left the operator holding the task for the
-- whole ten minutes. He stood next to a car waiting for somebody who might
-- never come, while cars queued up behind him — and the admin could not give
-- him anything else, because 'at_pickup' counted as busy in two places.
--
-- ═══════════════════════════════════════════════════════════════════════
-- WHY assigned_operator_id IS NOT CLEARED
-- ═══════════════════════════════════════════════════════════════════════
-- The obvious implementation of "his job ends" is to set assigned_operator_id
-- to null: the car is nobody's now, it is the desk's. It would also mean no
-- busy-list changes at all, because nothing would point at him.
--
-- It would break two things that have nothing to do with who is busy:
--
--   analytics   operator performance is counted by joining user_roles on
--               valet_tasks.assigned_operator_id (report_api.sql:300 and
--               three more). Null it and the operator who actually fetched
--               the car is credited with nothing.
--
--   reviews     guest_record_review() stamps the rating with that same column
--               (review_operator.sql:116). Null it and "which operator earned
--               this rating" is gone permanently — and that is the whole point
--               of the ratings feature.
--
-- So the name STAYS on the task as the record of who fetched it. What changes
-- is only whether that record makes him unavailable. Those were the same thing
-- by accident, not by design.
-- ═══════════════════════════════════════════════════════════════════════

begin;

-- ═══════════════════════════════════════════════════════════════════════
-- 1. THE OPERATOR IS FREE THE MOMENT THE CAR REACHES THE DOOR
--
-- 'at_pickup' comes out of the busy list. Both copies of it, and that is the
-- point of doing them in one migration: get_available_operators() fills the
-- admin's dropdown, and assign_retrieval() enforces the same rule again on
-- submit. Change one and the dropdown offers an operator that the assign then
-- refuses with OPERATOR_BUSY — a bug that only shows up at the porch, with a
-- guest watching.
--
-- 're_parking' and 'returned' STAY busy. A car being parked again is real work
-- in someone's hands; only the wait at the door is not.
-- ═══════════════════════════════════════════════════════════════════════

-- ── DROP FIRST, AND WHY ───────────────────────────────────────────────
-- `create or replace` CANNOT change a function's return type — Postgres
-- answers 42P13, "cannot change return type of existing function". So the
-- signature below must match the live one exactly, or the function has to be
-- dropped first.
--
-- It is dropped, because the first version of this migration got the signature
-- WRONG and that is worth recording. It was copied from 0008, which returns
--
--     (id, name, phone)
--
-- but 0022 (staff_name_hi) had already replaced the function with
--
--     (id, name, name_hi, phone)
--
-- 0022 does it with `drop function` + `create function`, NOT
-- `create or replace` — so a grep for "create or replace function
-- public.get_available_operators" finds only 0008 and looks conclusive. It is
-- not. When you need a function's CURRENT shape, grep the bare name.
--
-- 42P13 was the lucky outcome: it refused loudly and rolled the whole
-- transaction back. Had the columns merely been reordered rather than dropped,
-- it would have applied, and name_hi would have vanished from the admin's
-- operator dropdown — where Dashboard reads personName(op.name, op.name_hi) —
-- as silently missing Hindi names, not as an error.
drop function if exists public.get_available_operators(uuid);

create function public.get_available_operators(p_property_id uuid)
returns table (id uuid, name text, name_hi text, phone text)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $fn$
begin
  if not (public.is_system_admin() or p_property_id = public.my_property_id()) then
    raise exception 'FORBIDDEN_PROPERTY';
  end if;

  return query
    select ur.id, ur.name, ur.name_hi, ur.phone
    from public.user_roles ur
    where ur.property_id = p_property_id
      and ur.role        = 'operator'
      and ur.is_active   = true
      and not exists (
        select 1
        from public.valet_tasks vt
        where vt.assigned_operator_id = ur.id
          and vt.property_id          = p_property_id
          -- 'at_pickup' is DELIBERATELY ABSENT. See the header.
          -- Otherwise identical to 0022.
          and vt.status in ('assigned', 'in_progress', 're_parking', 'returned')
      )
    order by ur.name;
end $fn$;

revoke execute on function public.get_available_operators(uuid) from public, anon;
grant  execute on function public.get_available_operators(uuid) to authenticated;


create or replace function public.assign_retrieval(
  p_task_id     uuid,
  p_operator_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_caller   record;
  v_task     public.valet_tasks;
  v_operator record;
  v_busy     int;
begin
  select ur.id, ur.role, ur.property_id
    into v_caller
  from public.user_roles ur
  where ur.user_id = auth.uid()
    and ur.is_active = true;

  if v_caller.id is null then
    raise exception 'FORBIDDEN: you are not signed in as an active user';
  end if;
  if v_caller.role not in ('valet_admin', 'system_admin') then
    raise exception 'FORBIDDEN: only an admin can assign a retrieval';
  end if;

  select * into v_task
  from public.valet_tasks t
  where t.id = p_task_id
  for update;

  if v_task.id is null then
    raise exception 'NOT_FOUND: that request no longer exists';
  end if;
  if not (v_caller.role = 'system_admin' or v_task.property_id = v_caller.property_id) then
    raise exception 'FORBIDDEN: that request belongs to another property';
  end if;
  if v_task.task_type <> 'retrieval' then
    raise exception 'WRONG_TYPE: only a retrieval can be assigned';
  end if;
  if v_task.status <> 'pending' then
    raise exception 'WRONG_STATUS: this request is already marked "%" — pull down to refresh',
      v_task.status;
  end if;

  select ur.id, ur.name, ur.role, ur.property_id, ur.is_active
    into v_operator
  from public.user_roles ur
  where ur.id = p_operator_id;

  if v_operator.id is null then
    raise exception 'NOT_FOUND: that operator no longer exists';
  end if;
  if v_operator.role <> 'operator' or v_operator.is_active is not true then
    raise exception 'BAD_OPERATOR: that person is not an active operator';
  end if;
  if v_operator.property_id is distinct from v_task.property_id then
    raise exception 'BAD_OPERATOR: that operator is not at this property';
  end if;

  select count(*) into v_busy
  from public.valet_tasks t
  where t.assigned_operator_id = v_operator.id
    and t.property_id          = v_task.property_id
    -- MUST MATCH get_available_operators() above, exactly. 'at_pickup' absent.
    and t.status in ('assigned', 'in_progress', 're_parking', 'returned');

  if v_busy > 0 then
    raise exception 'OPERATOR_BUSY: % is already on another car', v_operator.name;
  end if;

  update public.valet_tasks
     set status               = 'assigned',
         assigned_operator_id = v_operator.id,
         assigned_at          = now()
   where id = v_task.id;

  update public.parked_vehicles
     set status = 'fetching'
   where id = v_task.vehicle_id;

  return jsonb_build_object(
    'task_id',       v_task.id,
    'operator_id',   v_operator.id,
    'operator_name', v_operator.name
  );
end $fn$;

revoke execute on function public.assign_retrieval(uuid, uuid) from public, anon;
grant  execute on function public.assign_retrieval(uuid, uuid) to authenticated;


-- ═══════════════════════════════════════════════════════════════════════
-- 2. THE ADMIN IS TOLD — A SECOND TRIGGER, NOT AN EDIT TO THE FIRST
--
-- enqueue_task_push() (last redefined in 0025) is ~200 lines carrying six
-- branches, each with its own actor check and early return. Two things are
-- needed from it here:
--
--   * a NEW push when a task reaches 'at_pickup'      -> to the admins
--   * the EXISTING 're_parking' push, which goes only to the operator,
--     also going to the admins
--
-- Reproducing that whole function to add them is how one of the other five
-- branches quietly loses a condition. So this is a SEPARATE trigger and the
-- original is not touched at all. Two after-triggers both inserting into
-- push_outbox is fine — they read different transitions and neither returns
-- anything the other depends on.
--
-- Naming: 'z_' prefix so it fires after trg_task_push. Postgres runs triggers
-- on the same event in name order, and while nothing here depends on the
-- order, the operator's own notification arriving before the admin's is the
-- friendlier accident to have.
-- ═══════════════════════════════════════════════════════════════════════

create or replace function public.enqueue_desk_push()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_vehicle record;
  v_label   text;
  v_actor   uuid;
begin
  -- Who did this, so nobody is notified about their own tap. NULL when the row
  -- was changed by pg_cron — which is precisely the expire_stale_pickups case,
  -- where a push matters most because nobody is looking at anything.
  select ur.id into v_actor
  from public.user_roles ur
  where ur.user_id = auth.uid() and ur.is_active = true;

  select v.token_number, v.car_number
    into v_vehicle
  from public.parked_vehicles v
  where v.id = new.vehicle_id;

  v_label := 'Token ' || coalesce(v_vehicle.token_number::text, '?') ||
             ' · ' || coalesce(v_vehicle.car_number, 'car');

  -- ── the car has reached the door: tell the admins ───────────────────
  -- This is the notification that did not exist before. From here the car is
  -- the desk's: the countdown is running and somebody at the desk has to hand
  -- it over or send it back.
  --
  -- critical = false. It is a ten-minute window opening, not a guest already
  -- waiting — and a hard buzz for every single car is how an admin ends up
  -- muting the alerts that do matter.
  if new.task_type = 'retrieval'
     and new.status = 'at_pickup'
     and (tg_op = 'INSERT' or old.status is distinct from 'at_pickup')
  then
    insert into public.push_outbox (user_role_id, title, body, url, tag, critical, task_id)
    select ur.id,
           'Car at the door',
           v_label || ' · waiting for the guest',
           '/admin/dashboard',
           'valet-task-' || new.id::text,
           false,
           new.id
    from public.user_roles ur
    where ur.property_id = new.property_id
      and ur.role        = 'valet_admin'
      and ur.is_active   = true
      and ur.id is distinct from v_actor;

    return new;
  end if;

  -- ── sent to park a no-show again: tell that operator ────────────────
  -- WITHOUT THIS THE DISPATCH IS SILENT, and that is not a nicety — it is the
  -- difference between the flow working and not.
  --
  -- dispatch_reparking() changes only assigned_operator_id and assigned_at. The
  -- status is ALREADY 're_parking', so every other branch in this file and in
  -- trg_task_push is guarded by `old.status is distinct from 're_parking'` and
  -- none of them fires. The operator would learn about the job only by having
  -- the app open at that moment — which, on a phone in a pocket in a car park,
  -- he does not.
  --
  -- Keyed on the OPERATOR CHANGING rather than on the status, because here the
  -- status is what stayed the same.
  if tg_op = 'UPDATE'
     and new.status in ('re_parking', 'returned')
     and new.assigned_operator_id is not null
     and old.assigned_operator_id is distinct from new.assigned_operator_id
     and new.assigned_operator_id is distinct from v_actor
  then
    insert into public.push_outbox (user_role_id, title, body, url, tag, critical, task_id)
    values (
      new.assigned_operator_id,
      'Park a car again',
      v_label || ' · the guest never came',
      '/operator/tasks',
      -- Its own tag. The admin's 'valet-desk-' push for this task may still be
      -- on screen, and a shared tag would replace it on a device signed in as
      -- both — silently, because renotify is not set. See sw.js.
      'valet-repark-' || new.id::text,
      true,
      new.id
    );

    return new;
  end if;

  -- ── ten minutes gone: tell the admins as well ───────────────────────
  -- trg_task_push already tells the OPERATOR on this same transition. This adds
  -- the admins, because under the new flow the operator is very likely to be
  -- halfway across the car park on another car, and the admin is the one who
  -- has to dispatch somebody to park this one again.
  --
  -- critical = true here, unlike the branch above: a guest did not turn up and
  -- a car is now standing at the door blocking the porch.
  if new.status = 're_parking'
     and old.status is distinct from 're_parking'
  then
    insert into public.push_outbox (user_role_id, title, body, url, tag, critical, task_id)
    select ur.id,
           'Guest did not arrive',
           v_label || ' · send someone to park it again',
           '/admin/dashboard',
           -- A DIFFERENT tag from the operator's push for the same event.
           -- Sharing one would let whichever landed second replace the first
           -- on a device signed in as both.
           'valet-desk-' || new.id::text,
           true,
           new.id
    from public.user_roles ur
    where ur.property_id = new.property_id
      and ur.role        = 'valet_admin'
      and ur.is_active   = true
      and ur.id is distinct from v_actor;

    return new;
  end if;

  return new;
end $fn$;

drop trigger if exists z_desk_push on public.valet_tasks;
create trigger z_desk_push
  after insert or update on public.valet_tasks
  for each row execute function public.enqueue_desk_push();


-- ═══════════════════════════════════════════════════════════════════════
-- 3. THE ADMIN SENDS SOMEBODY TO PARK IT AGAIN
--
-- Step 5 of the flow. The task is sitting on 're_parking' still carrying the
-- name of the operator who fetched it — who by now is usually busy elsewhere,
-- which is the entire reason this function exists.
--
-- ── WHY IT REASSIGNS, AND WHAT THAT COSTS ─────────────────────────────
-- assigned_operator_id is overwritten with whoever is being sent. Stated
-- plainly because it is a real trade:
--
--   * The re-park IS that operator's work, and it has to land in HIS task list
--     or he has no way to enter where he parked it. The task list is keyed on
--     assigned_operator_id, so there is no other place to put him.
--   * The cost is that analytics now credits the fetch to the second operator
--     rather than the first. return_count on the row records that the car came
--     back, so the event is not invisible — but the fetch attribution moves.
--   * Review attribution is NOT affected. Ratings only ever go out with the
--     hand-over message (MSG 2), and a car that got here never had one. When
--     the guest asks for it again a NEW retrieval task is created, and that is
--     the task the rating attaches to.
--
-- ── WHY NOT A SECOND TASK ─────────────────────────────────────────────
-- Cleaner on paper: leave the retrieval with the first operator and create a
-- fresh parking task for the re-park. But then one car has two open tasks, and
-- every "is this operator busy", every count of cars in progress, and the
-- guest's own WhatsApp thread would have to learn which of the two is real.
-- Not worth it to preserve one number in a report.
-- ═══════════════════════════════════════════════════════════════════════

create or replace function public.dispatch_reparking(
  p_task_id     uuid,
  p_operator_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_caller   record;
  v_task     public.valet_tasks;
  v_operator record;
  v_busy     int;
begin
  select ur.id, ur.role, ur.property_id
    into v_caller
  from public.user_roles ur
  where ur.user_id = auth.uid() and ur.is_active = true;

  if v_caller.id is null then
    raise exception 'FORBIDDEN: you are not signed in as an active user';
  end if;
  if v_caller.role not in ('valet_admin', 'system_admin') then
    raise exception 'FORBIDDEN: only an admin can send someone to park a car again';
  end if;

  select * into v_task
  from public.valet_tasks t
  where t.id = p_task_id
  for update;

  if v_task.id is null then
    raise exception 'NOT_FOUND: that task no longer exists';
  end if;
  if not (v_caller.role = 'system_admin' or v_task.property_id = v_caller.property_id) then
    raise exception 'FORBIDDEN: that task belongs to another property';
  end if;
  if v_task.task_type <> 'retrieval' then
    raise exception 'WRONG_TYPE: only a retrieval can be sent back to be parked';
  end if;

  -- 're_parking' is the no-show. 'returned' is the older spelling of the same
  -- state; nothing creates it any more but rows already carrying it must still
  -- be finishable. Anything else — still at the door, already handed over — is
  -- refused, because sending somebody would produce a second person and one car.
  if v_task.status not in ('re_parking', 'returned') then
    raise exception 'WRONG_STATUS: that car is not waiting to be parked again (it is "%")',
      v_task.status;
  end if;

  select ur.id, ur.name, ur.role, ur.property_id, ur.is_active
    into v_operator
  from public.user_roles ur
  where ur.id = p_operator_id;

  if v_operator.id is null then
    raise exception 'NOT_FOUND: that operator no longer exists';
  end if;
  if v_operator.role <> 'operator' or v_operator.is_active is not true then
    raise exception 'BAD_OPERATOR: that person is not an active operator';
  end if;
  if v_operator.property_id is distinct from v_task.property_id then
    raise exception 'BAD_OPERATOR: that operator is not at this property';
  end if;

  -- Same busy rule as assign_retrieval, with THIS task excluded — it is the one
  -- being handed over, and it is already 're_parking', so without the exclusion
  -- the function would report the operator busy on the very task it is giving
  -- them the moment an admin re-sent it to the same person.
  select count(*) into v_busy
  from public.valet_tasks t
  where t.assigned_operator_id = v_operator.id
    and t.property_id          = v_task.property_id
    and t.id                  <> v_task.id
    and t.status in ('assigned', 'in_progress', 're_parking', 'returned');

  if v_busy > 0 then
    raise exception 'OPERATOR_BUSY: % is already on another car', v_operator.name;
  end if;

  -- assigned_at is refreshed on purpose: it is what the operator's countdown
  -- and the nag both measure from, and a stale one would make the new job look
  -- ten minutes late the instant it arrives.
  update public.valet_tasks
     set assigned_operator_id = v_operator.id,
         assigned_at          = now()
   where id = v_task.id;

  return jsonb_build_object(
    'task_id',       v_task.id,
    'operator_id',   v_operator.id,
    'operator_name', v_operator.name
  );
end $fn$;

revoke execute on function public.dispatch_reparking(uuid, uuid) from public, anon;
grant  execute on function public.dispatch_reparking(uuid, uuid) to authenticated;

commit;


-- ═══════════════════════════════════════════════════════════════════════
-- VERIFY — every row must read PASS
-- ═══════════════════════════════════════════════════════════════════════
select check_name, case when ok then 'PASS' else 'FAIL' end as result
from (
  -- 1. THE OPERATOR IS FREE AT THE DOOR
  -- COMMENTS STRIPPED FIRST. prosrc is the whole body including comments, and
  -- both bodies below explain the absence by NAMING 'at_pickup' — so a plain
  -- `not like` matches the explanation and reports FAIL on correct code. The 'n'
  -- flag stops . at a line end, so '--.*' is exactly one line comment.
  select 'the dropdown no longer counts at_pickup as busy' as check_name,
         (select regexp_replace(prosrc, '--.*', '', 'gn') not like '%''at_pickup''%' from pg_proc
           where pronamespace = 'public'::regnamespace
             and proname = 'get_available_operators') as ok

  union all select 'assign_retrieval no longer counts at_pickup as busy',
         (select regexp_replace(prosrc, '--.*', '', 'gn') not like '%''at_pickup''%' from pg_proc
           where pronamespace = 'public'::regnamespace and proname = 'assign_retrieval')

  -- The two lists MUST agree or the dropdown offers someone the assign refuses.
  -- THE SIGNATURE. This is what 42P13 caught the first time round, and the
  -- failure mode without it is silent: Hindi names quietly missing from the
  -- admin's operator dropdown.
  union all select 'the dropdown still returns name_hi',
         (select pg_get_function_result(oid) like '%name_hi%' from pg_proc
           where pronamespace = 'public'::regnamespace
             and proname = 'get_available_operators')

  union all select 'the dropdown still returns all four columns',
         (select pg_get_function_result(oid)
                 = 'TABLE(id uuid, name text, name_hi text, phone text)'
            from pg_proc
           where pronamespace = 'public'::regnamespace
             and proname = 'get_available_operators')

  union all select 'both still hold re_parking busy',
         (select bool_and(prosrc like '%''re_parking''%') from pg_proc
           where pronamespace = 'public'::regnamespace
             and proname in ('get_available_operators', 'assign_retrieval'))

  union all select 'both still hold returned busy',
         (select bool_and(prosrc like '%''returned''%') from pg_proc
           where pronamespace = 'public'::regnamespace
             and proname in ('get_available_operators', 'assign_retrieval'))

  -- assign_retrieval must not have lost anything else in the rewrite.
  union all select 'assign_retrieval still refuses a non-pending request',
         (select prosrc like '%WRONG_STATUS%' from pg_proc
           where pronamespace = 'public'::regnamespace and proname = 'assign_retrieval')

  union all select 'assign_retrieval is still admin only',
         (select prosrc like '%only an admin can assign a retrieval%' from pg_proc
           where pronamespace = 'public'::regnamespace and proname = 'assign_retrieval')

  union all select 'assign_retrieval still sets the vehicle to fetching',
         (select prosrc like '%''fetching''%' from pg_proc
           where pronamespace = 'public'::regnamespace and proname = 'assign_retrieval')

  -- 2. THE NOTIFICATIONS
  union all select 'the desk trigger exists',
         exists (select 1 from pg_trigger
                  where tgrelid = 'public.valet_tasks'::regclass
                    and tgname = 'z_desk_push' and not tgisinternal)

  union all select 'the original push trigger is untouched',
         exists (select 1 from pg_trigger
                  where tgrelid = 'public.valet_tasks'::regclass
                    and tgname = 'trg_task_push' and not tgisinternal)

  union all select 'the admin is told when a car reaches the door',
         (select prosrc like '%Car at the door%' from pg_proc
           where pronamespace = 'public'::regnamespace and proname = 'enqueue_desk_push')

  union all select 'the admin is told when the guest never came',
         (select prosrc like '%send someone to park it again%' from pg_proc
           where pronamespace = 'public'::regnamespace and proname = 'enqueue_desk_push')

  union all select 'the operator sent to re-park is told',
         (select prosrc like '%Park a car again%' from pg_proc
           where pronamespace = 'public'::regnamespace and proname = 'enqueue_desk_push')

  -- Keyed on the operator changing, NOT the status: dispatch_reparking leaves
  -- the status alone, which is why every other branch misses it.
  union all select 'the re-park push keys on the operator changing',
         (select prosrc like '%old.assigned_operator_id is distinct from new.assigned_operator_id%'
            from pg_proc
           where pronamespace = 'public'::regnamespace and proname = 'enqueue_desk_push')

  union all select 'it never notifies whoever tapped the button',
         (select prosrc like '%is distinct from v_actor%' from pg_proc
           where pronamespace = 'public'::regnamespace and proname = 'enqueue_desk_push')

  union all select 'the door push is not marked critical',
         (select prosrc like '%waiting for the guest%' from pg_proc
           where pronamespace = 'public'::regnamespace and proname = 'enqueue_desk_push')

  -- 3. SENDING SOMEBODY TO PARK IT AGAIN
  union all select 'dispatch_reparking exists',
         to_regprocedure('public.dispatch_reparking(uuid,uuid)') is not null

  union all select 'it is admin only',
         (select prosrc like '%only an admin can send someone to park a car again%'
            from pg_proc
           where pronamespace = 'public'::regnamespace and proname = 'dispatch_reparking')

  union all select 'it only accepts a car waiting to be parked again',
         (select prosrc like '%not waiting to be parked again%' from pg_proc
           where pronamespace = 'public'::regnamespace and proname = 'dispatch_reparking')

  union all select 'it excludes this task from its own busy check',
         (select prosrc like '%<> v_task.id%' from pg_proc
           where pronamespace = 'public'::regnamespace and proname = 'dispatch_reparking')

  union all select 'it refreshes assigned_at',
         (select prosrc like '%assigned_at%=%now()%' from pg_proc
           where pronamespace = 'public'::regnamespace and proname = 'dispatch_reparking')

  union all select 'staff may call it',
         has_function_privilege('authenticated',
           'public.dispatch_reparking(uuid,uuid)', 'execute')

  union all select 'anon may NOT call it',
         not has_function_privilege('anon',
           'public.dispatch_reparking(uuid,uuid)', 'execute')

  -- The timer itself is untouched: it hangs off pickup_started_at, which has
  -- nothing to do with who is busy. Named here so nobody "fixes" it later.
  union all select 'the 10-minute timer still runs off pickup_started_at',
         (select prosrc like '%pickup_started_at%' from pg_proc
           where pronamespace = 'public'::regnamespace and proname = 'expire_stale_pickups')
) t
order by ok, check_name;
