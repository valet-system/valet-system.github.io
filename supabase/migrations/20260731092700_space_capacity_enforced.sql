-- ═══════════════════════════════════════════════════════════════════════
-- 0027 — A FULL PLACE IS REFUSED IN THE DATABASE, NOT ONLY IN THE UI
--
-- The picker already greys out a full chip. That closes the ordinary case and
-- nothing else: two operators can still both be looking at "1 free", both tap
-- it, and both save. The screen was honest when each of them read it.
--
-- ══ WHY A LOCK AND NOT JUST A COUNT ══
--
-- Counting and then inserting is not atomic. Both transactions would count
-- N-1, both would pass, and the space would end up with N+1 cars in it. So the
-- parking_spaces ROW is taken FOR UPDATE first. It is not read for its data —
-- it is the mutex. The second transaction waits, then counts, and sees the
-- first one's car.
--
-- ══ WHY IT CAN BE OVERRIDDEN, AND WHY THAT IS NOT A LOOPHOLE ══
--
-- By the time an operator taps a place, the car is ALREADY PARKED. They drove
-- it, walked back, and are now recording what they did. A refusal that cannot
-- be overridden does not un-park the car; it leaves a car sitting in a real bay
-- that the system believes is still at the porch — task open, guest never told,
-- location unrecorded. That is a worse failure than a count of 21 in a 20-car
-- space, because a wrong count is visible on the admin screen and a missing car
-- is not.
--
-- So p_force exists. The client only sets it after asking the operator, in so
-- many words, whether the car really is there. The result is that an over-fill
-- can still happen — but only as something a human asserted, never as an
-- accident. `parking_space_usage()` already reports over-capacity and the admin
-- screen already shows it in red.
--
-- ══ WHAT IS DELIBERATELY NOT ENFORCED ══
--
-- Free text. "Behind the kitchen" typed by hand is not a row in
-- parking_spaces, has no capacity, and is not checked. That is the escape
-- hatch working as designed: the system's job is to know where the car is.
--
-- Safe to re-run.
-- ═══════════════════════════════════════════════════════════════════════

begin;

-- ═══════════════════════════════════════════════════════════════════════
-- space_is_full — one definition, used by both callers below
--
-- Takes the lock. Every caller must therefore be inside a transaction that is
-- about to write, which both of them are.
-- ═══════════════════════════════════════════════════════════════════════

create or replace function public.space_is_full(
  p_property_id uuid,
  p_location    text,
  p_exclude     uuid default null
)
returns boolean
language plpgsql
set search_path = public, pg_temp
as $fn$
declare
  v_space    public.parking_spaces;
  v_in_use   bigint;
begin
  -- FOR UPDATE is the whole point: it serialises two operators racing for the
  -- last slot. Without it both count the same N-1 and both win.
  --
  -- Matched case- and space-insensitively, the same way parking_space_usage()
  -- does, because parking_location is free text and deliberately not a foreign
  -- key — see migration 0016.
  select * into v_space
  from public.parking_spaces s
  where s.property_id = p_property_id
    and lower(btrim(s.label)) = lower(btrim(coalesce(p_location, '')))
    and s.is_active = true
  for update;

  -- Not a known place: free text, or a place that is out of service. Neither
  -- has a capacity to exceed.
  if v_space.id is null then
    return false;
  end if;

  select count(*) into v_in_use
  from public.parked_vehicles v
  where v.property_id = p_property_id
    and lower(btrim(v.parking_location)) = lower(btrim(v_space.label))
    and v.status in ('parked', 'returned', 're_parking')
    -- The car being re-parked is already counted at its OLD location, which may
    -- be this same place. Counting it against itself would make a re-park into
    -- the same spot impossible.
    and (p_exclude is null or v.id <> p_exclude);

  return v_in_use >= v_space.capacity;
end $fn$;

comment on function public.space_is_full(uuid, text, uuid) is
  'True when p_location names an active parking_space that has no room left. Takes FOR UPDATE on the space row, so callers must be in a write transaction. Free text and out-of-service places always return false.';

revoke all    on function public.space_is_full(uuid, text, uuid) from public, anon;
grant execute on function public.space_is_full(uuid, text, uuid) to authenticated;


-- ═══════════════════════════════════════════════════════════════════════
-- task_complete_parking — migration 0008's function, plus the check
--
-- Dropped rather than replaced: adding p_force makes a new signature, and two
-- overloads would leave PostgREST unable to tell which one the client meant.
-- ═══════════════════════════════════════════════════════════════════════

drop function if exists public.task_complete_parking(uuid, text);
drop function if exists public.task_complete_parking(uuid, text, boolean);

create function public.task_complete_parking(
  p_task_id  uuid,
  p_location text,
  p_force    boolean default false
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

  -- The code is what the client keys on to offer "the car really is there".
  -- The detail after it is what the operator reads.
  if not p_force and public.space_is_full(v_task.property_id, v_location) then
    raise exception 'SPACE_FULL: % is full. Pick another place, or confirm the car is really there.', v_location;
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

revoke execute on function public.task_complete_parking(uuid, text, boolean) from public, anon;
grant  execute on function public.task_complete_parking(uuid, text, boolean) to authenticated;


-- ═══════════════════════════════════════════════════════════════════════
-- task_complete_reparking — the same, and it needs the exclusion
--
-- A no-show car is already counted at wherever it was before. Without
-- p_exclude, re-parking it into the same place would compare it against itself
-- and always look full.
-- ═══════════════════════════════════════════════════════════════════════

drop function if exists public.task_complete_reparking(uuid, text);
drop function if exists public.task_complete_reparking(uuid, text, boolean);

create function public.task_complete_reparking(
  p_task_id  uuid,
  p_location text,
  p_force    boolean default false
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

  if not p_force
     and public.space_is_full(v_task.property_id, v_location, v_task.vehicle_id)
  then
    raise exception 'SPACE_FULL: % is full. Pick another place, or confirm the car is really there.', v_location;
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

revoke execute on function public.task_complete_reparking(uuid, text, boolean) from public, anon;
grant  execute on function public.task_complete_reparking(uuid, text, boolean) to authenticated;

commit;


-- ═══════════════════════════════════════════════════════════════════════
-- VERIFY — every row must read PASS
--
-- The functions are not CALLED: auth.uid() is NULL in the SQL Editor, so
-- claim_task would raise and abort the block instead of printing a FAIL.
-- ═══════════════════════════════════════════════════════════════════════
select check_name, case when ok then 'PASS' else 'FAIL' end as result
from (
  select 'space_is_full exists' as check_name,
         to_regprocedure('public.space_is_full(uuid,text,uuid)') is not null as ok

  union all select 'it takes the row lock (FOR UPDATE), which is what stops the race',
         (select prosrc ~* 'for update' from pg_proc
           where pronamespace = 'public'::regnamespace and proname = 'space_is_full')

  union all select 'it counts the same statuses as parking_space_usage',
         (select prosrc like '%''parked'', ''returned'', ''re_parking''%' from pg_proc
           where pronamespace = 'public'::regnamespace and proname = 'space_is_full')

  union all select 'exactly one task_complete_parking, and it takes p_force',
         (select count(*) = 1 and bool_or('p_force' = any(proargnames)) from pg_proc
           where pronamespace = 'public'::regnamespace and proname = 'task_complete_parking')

  union all select 'exactly one task_complete_reparking, and it takes p_force',
         (select count(*) = 1 and bool_or('p_force' = any(proargnames)) from pg_proc
           where pronamespace = 'public'::regnamespace and proname = 'task_complete_reparking')

  union all select 'parking raises SPACE_FULL',
         (select prosrc like '%SPACE_FULL%' from pg_proc
           where pronamespace = 'public'::regnamespace and proname = 'task_complete_parking')

  union all select 'reparking raises SPACE_FULL',
         (select prosrc like '%SPACE_FULL%' from pg_proc
           where pronamespace = 'public'::regnamespace and proname = 'task_complete_reparking')

  union all select 'reparking excludes the car being moved, so the same spot is allowed',
         (select prosrc like '%v_task.vehicle_id)%' from pg_proc
           where pronamespace = 'public'::regnamespace and proname = 'task_complete_reparking')

  -- The things these functions did before, still done. Restating a body is
  -- where a step goes missing.
  union all select 'kept: parking still queues the car_parked message',
         (select prosrc like '%car_parked%' from pg_proc
           where pronamespace = 'public'::regnamespace and proname = 'task_complete_parking')
  union all select 'kept: reparking still queues the car_returned message',
         (select prosrc like '%car_returned%' from pg_proc
           where pronamespace = 'public'::regnamespace and proname = 'task_complete_reparking')
  union all select 'kept: reparking still sets the vehicle to returned',
         (select prosrc like '%status           = ''returned''%' from pg_proc
           where pronamespace = 'public'::regnamespace and proname = 'task_complete_reparking')
  union all select 'kept: both still claim the task first',
         (select bool_and(prosrc like '%claim_task%') from pg_proc
           where pronamespace = 'public'::regnamespace
             and proname in ('task_complete_parking', 'task_complete_reparking'))
) t
order by check_name;
