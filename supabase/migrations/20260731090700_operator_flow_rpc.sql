-- ═══════════════════════════════════════════════════════════════════════
-- 0008 — OPERATOR FLOW RPC
--
--   >>> RUN THIS IN THE SUPABASE SQL EDITOR. <<<
--
-- Safe to run more than once. Adds the whole car lifecycle as atomic
-- Postgres functions: check-in, retrieval request, assignment, and every
-- task transition an operator taps.
--
-- If the editor warns "creates a table without enabling RLS", choose
-- "Run without RLS" — this migration creates no tables. That warning is a
-- naive pattern match, documented in the project memory.
--
--
-- WHY THESE ARE FUNCTIONS AND NOT SUPABASE CALLS FROM REACT
--
-- The spec has the browser do check-in as four sequential calls:
--   allocate_token -> insert parked_vehicles -> insert valet_tasks
--                  -> update parked_vehicles
-- and every task transition as two:
--   update valet_tasks -> update parked_vehicles
--
-- Each arrow is a separate HTTP request from a phone on hotel wifi. Any one
-- of them can be the last one that lands. What that leaves behind:
--
--   token allocated, vehicle insert fails  -> a token burned, guest has a
--                                             paper stub for a car the
--                                             system has never heard of
--   vehicle inserted, task insert fails    -> a car nobody is told to park
--   task updated, vehicle update fails     -> the exact two-tables-disagree
--                                             bug that migration 0002
--                                             section 8 was written to fix,
--                                             reintroduced from the client
--
-- One function call is one transaction. All of it, or none of it.
--
-- There is also a hard blocker: the guest's WhatsApp message is queued by
-- inserting into public.wa_outbox, and wa_outbox has NO RLS policy — by
-- design, so an operator cannot forge guest messaging. `authenticated`
-- therefore cannot insert into it at all. Queuing the message from React is
-- not "less tidy", it is impossible. It has to happen in here, inside the
-- same transaction as the status change, or a guest is silently never told
-- their car is ready.
--
--
-- DEFECT FIXED HERE — "guest absent" made the operator disappear
--
-- The spec says that when the guest does not show up, the task goes to
-- status 'returned' and the operator re-parks the car. Two things then break,
-- and they compound:
--
--   1. MyTasks lists tasks with status in
--      ('assigned','in_progress','at_pickup','re_parking').
--      'returned' is not in that list, so the card vanishes from the screen
--      of the one person standing next to the car, still holding the keys.
--
--   2. get_available_operators() treats those same four statuses as busy.
--      'returned' is not one of them, so that operator is immediately
--      offered for the next retrieval — while the car they are actually
--      holding is now invisible to everyone and its vehicle row sits in
--      're_parking' with nobody assigned to finish it.
--
-- expire_stale_pickups() has the same bug: it is the code path that runs when
-- the operator's phone is LOCKED, which is exactly when the operator most
-- needs the card to still be there when they look.
--
-- FIX: "guest absent" moves the task to 're_parking', not 'returned'.
-- 're_parking' is already in both lists above, so the card stays put and the
-- operator stays busy until they confirm the new parking spot. This migration
-- changes expire_stale_pickups() to match, and adds 'returned' to
-- get_available_operators()'s busy list so any task already stranded in that
-- state by the old code keeps its operator held until it is finished.
--
-- 'returned' stays a legal value — the CHECK constraint still allows it and
-- rows may already hold it — it is simply no longer a state this system
-- moves a task INTO.
-- ═══════════════════════════════════════════════════════════════════════

begin;


-- ═══════════════════════════════════════════════════════════════════════
-- 1. claim_task — the guard every transition shares
--
-- Loads a task, proves the caller is allowed to move it, proves it is in a
-- status the requested move is legal from, and holds a row lock until the
-- transaction ends.
--
-- WHY THE LOCK: an operator taps "Guest Arrived" and the screen does not
-- react fast enough on a cheap Android, so they tap again. Both requests
-- arrive. Without the lock both read status 'at_pickup', both pass the
-- check, and both complete the task — double-firing the guest's WhatsApp
-- message. With `for update`, the second waits for the first to commit, then
-- reads status 'completed' and fails the status check with a message that
-- says so. Double-taps stop being a class of bug.
--
-- WHY AN ADMIN MAY MOVE AN OPERATOR'S TASK: phones die mid-shift. Someone
-- has to be able to close out the task from the desk. An operator, though,
-- may only move their own — otherwise two operators race each other's cars.
--
-- NOT granted to authenticated. It is an internal helper; the functions
-- below reach it because they run as the owner, not as the caller.
-- ═══════════════════════════════════════════════════════════════════════

create or replace function public.claim_task(
  p_task_id uuid,
  p_type    text,
  p_from    text[]
)
returns public.valet_tasks
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_caller record;
  v_task   public.valet_tasks;
begin
  select ur.id, ur.role, ur.property_id
    into v_caller
  from public.user_roles ur
  where ur.user_id = auth.uid()
    and ur.is_active = true;

  if v_caller.id is null then
    raise exception 'FORBIDDEN: you are not signed in as an active user';
  end if;

  if p_task_id is null then
    raise exception 'NOT_FOUND: no task was given';
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

  if v_caller.role = 'operator'
     and v_task.assigned_operator_id is distinct from v_caller.id then
    raise exception 'FORBIDDEN: that task is assigned to someone else';
  end if;

  if v_task.task_type <> p_type then
    raise exception 'WRONG_TYPE: that is a % task, not a % task', v_task.task_type, p_type;
  end if;

  if not (v_task.status = any (p_from)) then
    raise exception 'WRONG_STATUS: this task is already marked "%" — pull down to refresh',
      v_task.status;
  end if;

  return v_task;
end $fn$;

revoke execute on function public.claim_task(uuid, text, text[]) from public, anon, authenticated;


-- ═══════════════════════════════════════════════════════════════════════
-- 2. operator_check_in — a car arrives at the porch
--
-- Token, vehicle row and parking task in one transaction, with the task
-- assigned to the person who typed the form. Nobody dispatches a parking
-- job: the operator taking the keys is the operator parking the car.
--
-- The vehicle is inserted straight as 'parking' rather than 'checked_in'
-- followed by an update. 'checked_in' means "logged, but no operator has it
-- yet" and that state does not exist here — it is over before the
-- transaction commits. Writing it would be a row version no reader can
-- observe and a second write to pay for.
--
-- Inputs are re-normalised server-side. The browser already does this, but
-- an RPC is a public endpoint: anything that reaches the table must be
-- cleaned by the thing that owns the table.
-- ═══════════════════════════════════════════════════════════════════════

create or replace function public.operator_check_in(
  p_guest_name  text,
  p_guest_phone text,
  p_car_number  text,
  p_car_tier    text default 'Standard',
  p_notes       text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_caller  record;
  v_name    text;
  v_phone   text;
  v_car     text;
  v_tier    text;
  v_notes   text;
  v_token   int;
  v_vehicle public.parked_vehicles;
  v_task_id uuid;
begin
  select ur.id, ur.role, ur.property_id
    into v_caller
  from public.user_roles ur
  where ur.user_id = auth.uid()
    and ur.is_active = true;

  if v_caller.id is null then
    raise exception 'FORBIDDEN: you are not signed in as an active user';
  end if;

  -- A valet_admin is allowed to check a car in. On a short-staffed evening
  -- the admin works the porch, and an admin who cannot take a car while an
  -- operator is away parking one is a support call, not a safeguard.
  if v_caller.role not in ('operator', 'valet_admin') then
    raise exception 'FORBIDDEN: only valet staff can check in a car';
  end if;

  if v_caller.property_id is null then
    raise exception 'PROPERTY_REQUIRED: no property is linked to your account';
  end if;

  -- ── clean the inputs ────────────────────────────────────────────────
  v_name  := nullif(btrim(coalesce(p_guest_name, '')), '');
  v_notes := nullif(btrim(coalesce(p_notes, '')), '');
  v_tier  := coalesce(nullif(btrim(coalesce(p_car_tier, '')), ''), 'Standard');

  -- Digits only, then shed the country code in the shapes people paste it.
  -- Mirrors normalisePhone() in src/utils/format.js. A '91' reaching this
  -- column would create a second row for a guest who already exists and a
  -- 12-digit value in a column every other row has 10 digits in.
  v_phone := regexp_replace(coalesce(p_guest_phone, ''), '\D', '', 'g');
  if length(v_phone) = 14 and left(v_phone, 4) = '0091' then
    v_phone := right(v_phone, 10);
  elsif length(v_phone) = 13 and left(v_phone, 3) = '910' then
    v_phone := right(v_phone, 10);
  elsif length(v_phone) = 12 and left(v_phone, 2) = '91' then
    v_phone := right(v_phone, 10);
  elsif length(v_phone) = 11 and left(v_phone, 1) = '0' then
    v_phone := right(v_phone, 10);
  end if;

  -- Uppercase, no separators: "dl 8c af 1234" -> "DL8CAF1234". Without this
  -- the same car checked in twice is two different strings and search misses.
  -- Deliberately NOT validated against the Indian plate format — a temporary
  -- registration, a diplomatic plate or a car from Nepal must still check in.
  -- Turning a guest away at the gate is worse than storing an unusual string.
  v_car := upper(regexp_replace(coalesce(p_car_number, ''), '[^A-Za-z0-9]', '', 'g'));

  -- ── validate ────────────────────────────────────────────────────────
  if v_name is null then
    raise exception 'BAD_NAME: enter the guest name';
  end if;

  if v_phone !~ '^[6-9][0-9]{9}$' then
    raise exception 'BAD_PHONE: enter a valid 10-digit mobile number starting 6-9';
  end if;

  if length(v_car) < 4 then
    raise exception 'BAD_CAR: enter the car number';
  end if;
  if length(v_car) > 15 then
    raise exception 'BAD_CAR: that car number is too long';
  end if;

  if v_tier not in ('VIP', 'Premium', 'Standard') then
    raise exception 'BAD_TIER: choose Standard, Premium or VIP';
  end if;

  -- ── write ───────────────────────────────────────────────────────────
  -- allocate_token takes a row lock on today's range, so simultaneous
  -- check-ins serialise here and each gets a distinct number.
  v_token := public.allocate_token(v_caller.property_id);

  insert into public.parked_vehicles
    (property_id, token_number, car_number, guest_phone, guest_name,
     car_tier, notes, status, parked_at, service_date)
  values
    (v_caller.property_id, v_token, v_car, v_phone, v_name,
     v_tier, v_notes, 'parking', now(), public.ist_today())
  returning * into v_vehicle;

  insert into public.valet_tasks
    (property_id, vehicle_id, task_type, status, assigned_operator_id, assigned_at)
  values
    (v_caller.property_id, v_vehicle.id, 'parking', 'assigned', v_caller.id, now())
  returning id into v_task_id;

  -- No WhatsApp here. The guest is standing in front of the operator; a
  -- message saying "your car is being parked" while they watch it happen is
  -- noise, and every send costs money. MSG 1 goes out when it is PARKED.
  return jsonb_build_object(
    'vehicle_id',   v_vehicle.id,
    'task_id',      v_task_id,
    'token_number', v_token,
    'car_number',   v_car,
    'car_tier',     v_tier,
    'guest_name',   v_name,
    'parked_at',    v_vehicle.parked_at
  );
end $fn$;

revoke execute on function public.operator_check_in(text, text, text, text, text)
  from public, anon;
grant  execute on function public.operator_check_in(text, text, text, text, text)
  to authenticated;


-- ═══════════════════════════════════════════════════════════════════════
-- 3. task_complete_parking — "Car Parked"
--
-- Closes the parking task, records where the car went, and queues MSG 1 to
-- the guest. The location is required and this is the only place it is
-- captured: without it the retrieval operator is sent to find one car in a
-- multi-level car park with nothing to go on.
-- ═══════════════════════════════════════════════════════════════════════

create or replace function public.task_complete_parking(
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
  v_task := public.claim_task(p_task_id, 'parking', array['assigned', 'in_progress']);

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
     set status           = 'parked',
         parking_location = v_location
   where id = v_task.vehicle_id;

  -- MSG 1: "your car is parked, token 47". Queued, not sent — the outbox
  -- survives the Edge Function being down, and a messaging failure must
  -- never roll back a car that is genuinely parked.
  insert into public.wa_outbox (property_id, vehicle_id, task_id, message_type)
  values (v_task.property_id, v_task.vehicle_id, v_task.id, 'car_parked');

  return jsonb_build_object('task_id', v_task.id, 'vehicle_id', v_task.vehicle_id);
end $fn$;

revoke execute on function public.task_complete_parking(uuid, text) from public, anon;
grant  execute on function public.task_complete_parking(uuid, text) to authenticated;


-- ═══════════════════════════════════════════════════════════════════════
-- 4. request_retrieval — the guest wants their car back
--
-- Normally the wa-webhook Edge Function will call this when the guest taps
-- "Get My Car". It is exposed to staff as well because guests walk up to the
-- porch and ask — and until WhatsApp is wired up, this is the ONLY way a
-- retrieval can be created at all, which is what makes the retrieval half of
-- the operator screen testable.
--
-- Creates the task as 'pending' and unassigned: who fetches it is the
-- admin's call on the retrieval queue, not the requester's.
--
-- The partial unique index valet_tasks_one_open_retrieval_key (migration
-- 0002) is what actually stops a double request. Two taps a second apart
-- both pass the status check — only the index can catch the second one, and
-- it is caught here rather than surfacing as a raw constraint name.
-- ═══════════════════════════════════════════════════════════════════════

create or replace function public.request_retrieval(p_vehicle_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_caller  record;
  v_vehicle public.parked_vehicles;
  v_task_id uuid;
begin
  select ur.id, ur.role, ur.property_id
    into v_caller
  from public.user_roles ur
  where ur.user_id = auth.uid()
    and ur.is_active = true;

  if v_caller.id is null then
    raise exception 'FORBIDDEN: you are not signed in as an active user';
  end if;

  select * into v_vehicle
  from public.parked_vehicles v
  where v.id = p_vehicle_id
  for update;

  if v_vehicle.id is null then
    raise exception 'NOT_FOUND: that car is not in the system';
  end if;

  if not (v_caller.role = 'system_admin' or v_vehicle.property_id = v_caller.property_id) then
    raise exception 'FORBIDDEN: that car belongs to another property';
  end if;

  -- 'returned' means re-parked after a no-show, so it is requestable again.
  if v_vehicle.status not in ('parked', 'returned') then
    raise exception 'NOT_PARKED: this car is already marked "%"', v_vehicle.status;
  end if;

  begin
    insert into public.valet_tasks
      (property_id, vehicle_id, task_type, status)
    values
      (v_vehicle.property_id, v_vehicle.id, 'retrieval', 'pending')
    returning id into v_task_id;
  exception when unique_violation then
    raise exception 'ALREADY_REQUESTED: this car has already been requested';
  end;

  update public.parked_vehicles
     set status = 'requested'
   where id = v_vehicle.id;

  return jsonb_build_object(
    'task_id',      v_task_id,
    'vehicle_id',   v_vehicle.id,
    'token_number', v_vehicle.token_number
  );
end $fn$;

revoke execute on function public.request_retrieval(uuid) from public, anon;
grant  execute on function public.request_retrieval(uuid) to authenticated;


-- ═══════════════════════════════════════════════════════════════════════
-- 5. assign_retrieval — the admin sends someone to fetch it
--
-- Used by the admin retrieval queue. Lives here because it is the same
-- lifecycle and the same two-tables-in-one-transaction problem.
--
-- The "is this operator free?" test is re-run here rather than trusted from
-- the dropdown. The dropdown was populated by get_available_operators() at
-- some point in the past; by the time the admin taps Assign, that operator
-- may have taken a check-in. Assigning a second car to someone already
-- holding one is how a guest waits twenty minutes.
--
-- No WhatsApp: the guest already knows their car is coming.
-- ═══════════════════════════════════════════════════════════════════════

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
    and t.status in ('assigned', 'in_progress', 'at_pickup', 're_parking', 'returned');

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
-- 6. task_start_pickup — "Car at Delivery Point"
--
-- Starts the hand-over window. pickup_started_at is the timestamp the whole
-- countdown hangs off, on the screen AND in expire_stale_pickups(), so it is
-- set by the server clock — never by the phone's, which is routinely wrong
-- by minutes and would let a device with a slow clock hold a car open past
-- the point the database has already given up on it.
--
-- No WhatsApp: MSG 2 is sent when the car is actually handed over.
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

  return jsonb_build_object(
    'task_id',           v_task.id,
    'pickup_started_at', v_started
  );
end $fn$;

revoke execute on function public.task_start_pickup(uuid) from public, anon;
grant  execute on function public.task_start_pickup(uuid) to authenticated;


-- ═══════════════════════════════════════════════════════════════════════
-- 7. task_guest_arrived — "Guest Arrived", car handed over
-- ═══════════════════════════════════════════════════════════════════════

create or replace function public.task_guest_arrived(p_task_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_task public.valet_tasks;
begin
  v_task := public.claim_task(p_task_id, 'retrieval', array['at_pickup']);

  update public.valet_tasks
     set status       = 'completed',
         completed_at = now()
   where id = v_task.id;

  update public.parked_vehicles
     set status = 'delivered'
   where id = v_task.vehicle_id;

  -- MSG 2: thank you + the rating buttons. This is the only message that
  -- can produce a review, so losing it loses the feedback loop entirely.
  insert into public.wa_outbox (property_id, vehicle_id, task_id, message_type)
  values (v_task.property_id, v_task.vehicle_id, v_task.id, 'car_delivered');

  return jsonb_build_object('task_id', v_task.id, 'vehicle_id', v_task.vehicle_id);
end $fn$;

revoke execute on function public.task_guest_arrived(uuid) from public, anon;
grant  execute on function public.task_guest_arrived(uuid) to authenticated;


-- ═══════════════════════════════════════════════════════════════════════
-- 8. task_guest_absent — "Guest Not Here"
--
-- Goes to 're_parking', NOT 'returned'. See the header of this migration for
-- why: 'returned' drops the card off the operator's screen and frees them
-- for another car while they are still holding this one.
--
-- return_count is incremented so the third no-show on the same car is
-- visible in analytics — that is a guest who needs a phone call, not another
-- lap of the car park.
-- ═══════════════════════════════════════════════════════════════════════

create or replace function public.task_guest_absent(p_task_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_task public.valet_tasks;
begin
  v_task := public.claim_task(p_task_id, 'retrieval', array['at_pickup']);

  update public.valet_tasks
     set status       = 're_parking',
         return_count = coalesce(return_count, 0) + 1
   where id = v_task.id;

  update public.parked_vehicles
     set status = 're_parking'
   where id = v_task.vehicle_id;

  -- MSG 3: "you were not available, we have parked it again — tap when ready".
  insert into public.wa_outbox (property_id, vehicle_id, task_id, message_type)
  values (v_task.property_id, v_task.vehicle_id, v_task.id, 'not_available');

  return jsonb_build_object(
    'task_id',      v_task.id,
    'vehicle_id',   v_task.vehicle_id,
    'return_count', coalesce(v_task.return_count, 0) + 1
  );
end $fn$;

revoke execute on function public.task_guest_absent(uuid) from public, anon;
grant  execute on function public.task_guest_absent(uuid) to authenticated;


-- ═══════════════════════════════════════════════════════════════════════
-- 9. task_complete_reparking — "Car Re-parked"
--
-- Closes out a no-show. The vehicle lands on 'returned', which
-- request_retrieval() accepts, so the guest can ask for it again.
--
-- 'returned' is accepted as a FROM status as well as 're_parking': tasks
-- stranded on 'returned' by expire_stale_pickups() before this migration
-- still need a way to be finished.
-- ═══════════════════════════════════════════════════════════════════════

create or replace function public.task_complete_reparking(
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

  -- MSG 4: "your car is parked again, tap Get My Car when you are ready".
  insert into public.wa_outbox (property_id, vehicle_id, task_id, message_type)
  values (v_task.property_id, v_task.vehicle_id, v_task.id, 'car_returned');

  return jsonb_build_object('task_id', v_task.id, 'vehicle_id', v_task.vehicle_id);
end $fn$;

revoke execute on function public.task_complete_reparking(uuid, text) from public, anon;
grant  execute on function public.task_complete_reparking(uuid, text) to authenticated;


-- ═══════════════════════════════════════════════════════════════════════
-- 10. expire_stale_pickups — the same defect, in the path that matters most
--
-- Replaces the version from migration 0002. One change: the task lands on
-- 're_parking' instead of 'returned'.
--
-- This is the cron job — the only thing that fires when the operator's phone
-- is locked, which is the single most likely reason a hand-over went quiet
-- in the first place. Under the old value, the operator unlocks their phone
-- to find the task gone from My Tasks, the car still in their hand, and
-- themselves already offered to the admin as free.
-- ═══════════════════════════════════════════════════════════════════════

create or replace function public.expire_stale_pickups(p_timeout_minutes int default 10)
returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  r       record;
  v_count int := 0;
begin
  for r in
    update public.valet_tasks t
       set status       = 're_parking',
           return_count = coalesce(t.return_count, 0) + 1
     where t.status            = 'at_pickup'
       and t.completed_at is null
       and t.pickup_started_at < now() - make_interval(mins => p_timeout_minutes)
    returning t.id, t.vehicle_id, t.property_id
  loop
    update public.parked_vehicles
       set status = 're_parking'
     where id = r.vehicle_id;

    insert into public.wa_outbox (property_id, vehicle_id, task_id, message_type)
    values (r.property_id, r.vehicle_id, r.id, 'not_available');

    v_count := v_count + 1;
  end loop;

  return v_count;
end $fn$;

revoke execute on function public.expire_stale_pickups(int) from public, anon, authenticated;


-- ═══════════════════════════════════════════════════════════════════════
-- 11. get_available_operators — hold operators stranded on 'returned'
--
-- Identical to migration 0002 except that 'returned' joins the busy list.
-- Nothing creates that status any more, but rows already carrying it are
-- exactly the case this protects: an operator holding a car nobody can see.
--
-- ACTIVE_TASK_STATUSES in src/types/index.js mirrors this list. The two are
-- duplicated on purpose — the database must not trust the client — but they
-- must be changed together.
-- ═══════════════════════════════════════════════════════════════════════

-- CREATE OR REPLACE cannot change a function's RETURN TYPE, and a
-- RETURNS TABLE list IS the return type — so adding or removing a column
-- later fails with 42P13 unless the old row type is gone first. Dropping
-- here keeps this migration re-runnable in any order.
drop function if exists public.get_available_operators(uuid);

create or replace function public.get_available_operators(p_property_id uuid)
returns table (id uuid, name text, phone text)
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
    select ur.id, ur.name, ur.phone
    from public.user_roles ur
    where ur.property_id = p_property_id
      and ur.role        = 'operator'
      and ur.is_active   = true
      and not exists (
        select 1
        from public.valet_tasks vt
        where vt.assigned_operator_id = ur.id
          and vt.property_id          = p_property_id
          and vt.status in ('assigned', 'in_progress', 'at_pickup', 're_parking', 'returned')
      )
    order by ur.name;
end $fn$;

revoke execute on function public.get_available_operators(uuid) from public, anon;
grant  execute on function public.get_available_operators(uuid) to authenticated;


-- ═══════════════════════════════════════════════════════════════════════
-- 12. INDEX — the operator's own task list
--
-- MyTasks runs "my open tasks" on every load and on every realtime event.
-- idx_tasks_operator covers (assigned_operator_id, status) but includes
-- every completed task the operator has ever finished, which grows without
-- limit. A partial index keeps the lookup proportional to open work.
-- ═══════════════════════════════════════════════════════════════════════

create index if not exists valet_tasks_operator_open_idx
  on public.valet_tasks(assigned_operator_id, created_at)
  where status in ('assigned', 'in_progress', 'at_pickup', 're_parking', 'returned');

commit;


-- ═══════════════════════════════════════════════════════════════════════
-- VERIFY — run this after the migration. Every row should say PASS.
-- ═══════════════════════════════════════════════════════════════════════

with checks as (
  select 'operator_check_in exists' as item,
         to_regprocedure('public.operator_check_in(text,text,text,text,text)') is not null as ok
  union all select 'task_complete_parking exists',
         to_regprocedure('public.task_complete_parking(uuid,text)') is not null
  union all select 'request_retrieval exists',
         to_regprocedure('public.request_retrieval(uuid)') is not null
  union all select 'assign_retrieval exists',
         to_regprocedure('public.assign_retrieval(uuid,uuid)') is not null
  union all select 'task_start_pickup exists',
         to_regprocedure('public.task_start_pickup(uuid)') is not null
  union all select 'task_guest_arrived exists',
         to_regprocedure('public.task_guest_arrived(uuid)') is not null
  union all select 'task_guest_absent exists',
         to_regprocedure('public.task_guest_absent(uuid)') is not null
  union all select 'task_complete_reparking exists',
         to_regprocedure('public.task_complete_reparking(uuid,text)') is not null
  union all select 'claim_task is NOT callable by authenticated',
         not has_function_privilege('authenticated',
           'public.claim_task(uuid,text,text[])', 'execute')
  union all select 'operator_check_in IS callable by authenticated',
         has_function_privilege('authenticated',
           'public.operator_check_in(text,text,text,text,text)', 'execute')
  union all select 'expire_stale_pickups now uses re_parking',
         (select prosrc like '%''re_parking''%'
          from pg_proc where oid = 'public.expire_stale_pickups(int)'::regprocedure)
  union all select 'get_available_operators holds returned',
         (select prosrc like '%''returned''%'
          from pg_proc where oid = 'public.get_available_operators(uuid)'::regprocedure)
  union all select 'open-task index exists',
         exists (select 1 from pg_indexes
                 where schemaname = 'public' and indexname = 'valet_tasks_operator_open_idx')
)
select item, case when ok then 'PASS' else 'FAIL' end as result
from checks
order by result desc, item;
