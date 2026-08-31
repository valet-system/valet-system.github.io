-- ═══════════════════════════════════════════════════════════════════════
-- MIGRATION 0059 — a re-park can be accepted, so its alarm can stop
--
-- On request: the continuous alarm should also sound when an operator is sent
-- to park a no-show again. It could not, and the reason was not the alarm.
--
-- ── WHY THE ALARM COULD NOT SIMPLY BE EXTENDED ────────────────────────
-- useUnacceptedAlarm sounds while the operator has a retrieval on 'assigned'.
-- It stops when they tap Accept, because task_accept moves the row to
-- 'in_progress' and the count falls to zero. The status IS the acknowledgement.
--
-- A re-park has no such step. dispatch_reparking sets assigned_operator_id and
-- leaves the status on 're_parking' — where it must stay, because MyTasks and
-- task_complete_reparking both key on it. The next thing the operator does is
-- enter where they parked it, which is minutes later, AFTER the driving.
--
-- So pointing the alarm at 're_parking' would have it sound for the whole
-- journey. That is not a louder alarm, it is an alarm nobody can silence, and
-- an operator who cannot silence one learns to ignore all of them.
--
-- ── WHAT THIS ADDS ────────────────────────────────────────────────────
-- accepted_at. A timestamp, not a status, precisely so the status can stay
-- 're_parking' and nothing downstream has to learn a new state.
--
--     dispatched, not yet seen   accepted_at is null   -> alarm sounds
--     operator taps Accept       accepted_at = now()   -> alarm stops
--     operator parks it          status = 'completed'  -> task done
--
-- ── WHY task_accept HANDLES BOTH ──────────────────────────────────────
-- One RPC and one button rather than a second pair. The operator is doing the
-- same thing in both cases — saying "I have seen this" — and a second function
-- would be the same guard, the same claim and the same lock, written twice and
-- free to drift.
--
-- ── A SIDE BENEFIT WORTH THE COLUMN ───────────────────────────────────
-- accepted_at also answers something nothing could before: how long an operator
-- took to acknowledge work. assigned_at was there; the other end never was.
-- ═══════════════════════════════════════════════════════════════════════

begin;

-- ── 1. THE COLUMN ─────────────────────────────────────────────────────
alter table public.valet_tasks
  add column if not exists accepted_at timestamptz;

comment on column public.valet_tasks.accepted_at is
  'When the operator acknowledged the work. For a retrieval the status already '
  'says so (assigned -> in_progress); this exists for a RE-PARK, whose status '
  'must stay re_parking. Null while dispatched-but-unseen, which is what the '
  'continuous alarm keys on.';

-- The alarm asks "anything of mine unaccepted?" on every realtime event, all
-- shift. Partial, so the index stays proportional to open work rather than to
-- every task ever completed.
create index if not exists valet_tasks_unaccepted_idx
  on public.valet_tasks(assigned_operator_id)
  where accepted_at is null and status in ('assigned', 're_parking', 'returned');


-- ── 2. ACCEPT, FOR BOTH KINDS OF WORK ─────────────────────────────────
create or replace function public.task_accept(p_task_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_task public.valet_tasks;
begin
  -- claim_task does the whole guard: signed in, task exists, right property,
  -- assigned to THIS operator, right type, and currently one of these. It also
  -- takes a row lock, so two taps from a double-press cannot both pass — the
  -- second finds a status this list no longer contains and raises WRONG_STATUS,
  -- which the app already renders as "pull down to refresh".
  --
  -- 'returned' is the older spelling of a no-show. Nothing creates it any more
  -- but rows already carrying it must still be acceptable.
  v_task := public.claim_task(
    p_task_id, 'retrieval', array['assigned', 're_parking', 'returned']
  );

  if v_task.status = 'assigned' then
    -- A FETCH. The status is the acknowledgement, as it always was — moving to
    -- 'in_progress' is what drops it out of the alarm's count. accepted_at is
    -- stamped too, so "how long to acknowledge" is answerable for both kinds.
    update public.valet_tasks
       set status      = 'in_progress',
           accepted_at = coalesce(accepted_at, now())
     where id = v_task.id;

    -- parked_vehicles is deliberately untouched. The car has not moved: it is
    -- still parked where it was until task_start_pickup says otherwise.

    return jsonb_build_object('task_id', v_task.id, 'status', 'in_progress');
  end if;

  -- A RE-PARK. The status MUST stay as it is: MyTasks decides what to show from
  -- it, and task_complete_reparking will only accept 're_parking'/'returned'.
  -- Only the timestamp changes, and only if it was not already set — a second
  -- tap must not move the clock and make the acknowledgement look slower.
  update public.valet_tasks
     set accepted_at = coalesce(accepted_at, now())
   where id = v_task.id;

  return jsonb_build_object('task_id', v_task.id, 'status', v_task.status);
end $fn$;

revoke execute on function public.task_accept(uuid) from public, anon;
grant  execute on function public.task_accept(uuid) to authenticated;


-- ── 3. A FRESH DISPATCH IS A FRESH ALARM ──────────────────────────────
-- dispatch_reparking must clear accepted_at. Without it, sending a car to a
-- SECOND operator after the first ignored it would arrive silently — the row
-- still carries the first operator's acknowledgement, so the alarm stays quiet
-- for somebody who has not seen it at all.
--
-- Otherwise identical to 0050.
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

  select count(*) into v_busy
  from public.valet_tasks t
  where t.assigned_operator_id = v_operator.id
    and t.property_id          = v_task.property_id
    and t.id                  <> v_task.id
    and t.status in ('assigned', 'in_progress', 're_parking', 'returned');

  if v_busy > 0 then
    raise exception 'OPERATOR_BUSY: % is already on another car', v_operator.name;
  end if;

  update public.valet_tasks
     set assigned_operator_id = v_operator.id,
         assigned_at          = now(),
         -- CLEARED. See the note above this function.
         accepted_at          = null
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
  select 'accepted_at exists' as check_name,
         exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'valet_tasks'
                    and column_name = 'accepted_at') as ok

  union all select 'it is nullable',
         (select is_nullable = 'YES' from information_schema.columns
           where table_schema = 'public' and table_name = 'valet_tasks'
             and column_name = 'accepted_at')

  union all select 'the alarm index exists',
         exists (select 1 from pg_indexes
                  where schemaname = 'public'
                    and indexname = 'valet_tasks_unaccepted_idx')

  -- ACCEPT NOW COVERS BOTH.
  union all select 'accept takes a re-park as well as a fetch',
         (select prosrc like '%''assigned'', ''re_parking'', ''returned''%' from pg_proc
           where pronamespace = 'public'::regnamespace and proname = 'task_accept')

  union all select 'a fetch still becomes in_progress',
         (select prosrc like '%''in_progress''%' from pg_proc
           where pronamespace = 'public'::regnamespace and proname = 'task_accept')

  -- The status must NOT be moved for a re-park, or MyTasks stops showing the
  -- location form and task_complete_reparking refuses the row.
  union all select 'a re-park only stamps the time',
         (select prosrc like '%set accepted_at = coalesce(accepted_at, now())%' from pg_proc
           where pronamespace = 'public'::regnamespace and proname = 'task_accept')

  -- A second tap must not move the clock and make the acknowledgement look
  -- slower than it was.
  union all select 'a second accept does not move the clock',
         (select prosrc like '%coalesce(accepted_at, now())%' from pg_proc
           where pronamespace = 'public'::regnamespace and proname = 'task_accept')

  -- A RE-DISPATCH MUST RE-ALARM.
  union all select 'dispatch clears the acknowledgement',
         (select prosrc like '%accepted_at          = null%' from pg_proc
           where pronamespace = 'public'::regnamespace and proname = 'dispatch_reparking')

  -- And must not have lost anything else from 0050.
  union all select 'dispatch is still admin only',
         (select prosrc like '%only an admin can send someone to park a car again%'
            from pg_proc
           where pronamespace = 'public'::regnamespace and proname = 'dispatch_reparking')

  union all select 'dispatch still refuses a car that is not waiting',
         (select prosrc like '%not waiting to be parked again%' from pg_proc
           where pronamespace = 'public'::regnamespace and proname = 'dispatch_reparking')

  union all select 'dispatch still excludes this task from its busy check',
         (select prosrc like '%<> v_task.id%' from pg_proc
           where pronamespace = 'public'::regnamespace and proname = 'dispatch_reparking')

  union all select 'staff may accept',
         has_function_privilege('authenticated', 'public.task_accept(uuid)', 'execute')

  union all select 'anon may NOT accept',
         not has_function_privilege('anon', 'public.task_accept(uuid)', 'execute')

  -- ── WHAT THIS REPLACED, AND WHY ─────────────────────────────────────
  -- There was a check here asserting that no COMPLETED task had a null
  -- accepted_at. It failed on the first run, correctly, and the check was the
  -- thing that was wrong: the column is added by THIS migration, so every task
  -- finished before today has a null in it. That is history, not a fault.
  --
  -- It was also pointless. A completed task is invisible to the alarm — the
  -- query only ever looks at 'assigned', 're_parking' and 'returned' — so a
  -- null there can never make anything ring.
  --
  -- What DOES matter is that a finished task cannot be accepted, and that is a
  -- property of the code rather than of the data. claim_task is given the list
  -- of acceptable statuses and 'completed' is not among them, so accepting one
  -- raises WRONG_STATUS instead of stamping a car nobody is working on.
  union all select 'a completed task cannot be accepted',
         (select prosrc not like '%''completed''%' from pg_proc
           where pronamespace = 'public'::regnamespace and proname = 'task_accept')

  -- And the alarm must never look at completed work, or every finished task
  -- from before this migration would ring for ever.
  union all select 'accept only takes the three open statuses',
         (select prosrc like '%array[''assigned'', ''re_parking'', ''returned'']%'
            from pg_proc
           where pronamespace = 'public'::regnamespace and proname = 'task_accept')
) t
order by ok, check_name;
