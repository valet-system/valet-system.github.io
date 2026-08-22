-- ═══════════════════════════════════════════════════════════════════════
-- MIGRATION 0035 — two changes to parking places, both on request
--
--   1. THE PER-PLACE CAR LIMIT IS GONE.
--   2. A SYSTEM ADMIN CAN MANAGE ANY PROPERTY.
--
-- They land together because both touch the same three functions, and
-- shipping them apart would mean recreating each one twice.
--
-- ── 1. WHY REMOVING THE LIMIT IS A DATABASE CHANGE ────────────────────
-- The obvious move — take the capacity box out of the admin screen — is a
-- trap. `capacity` is `int not null default 1`, and task_complete_parking
-- refuses a car when space_is_full() says the place is full. Hide the box
-- and every new place is created with room for exactly ONE car, so the
-- second car of the night is refused and the operator has to reach for the
-- override every single time. The screen would look fixed and check-in
-- would be broken.
--
-- So the ENFORCEMENT goes, not the input. Both task functions stop asking
-- space_is_full() anything.
--
-- ── WHY p_force GOES WITH IT ──────────────────────────────────────────
-- p_force existed for exactly one purpose: to let an operator say "the car
-- really is in that full space" and proceed anyway. With nothing to refuse
-- them there is nothing to override, and an argument that no longer changes
-- any behaviour is worse than no argument — the next person reading the call
-- site has to work out that it does nothing. Both go back to two arguments.
--
-- space_is_full() itself is LEFT IN PLACE. It is correct, it takes a proper
-- row lock, and it is the hard part to write. Nothing calls it now; if a
-- limit is ever wanted again, restoring it is one `if` in each function
-- rather than re-deriving the locking.
--
-- ── 2. WHY parking_space_usage NEEDED RECREATING ──────────────────────
-- It read my_property_id() and returned NOTHING for a system_admin, which
-- was right when only a valet_admin had the screen. Now a system_admin picks
-- a property, so the property has to be an argument.
--
-- The argument is OPTIONAL and defaults to the caller's own property, so the
-- valet_admin call site does not change at all. A valet_admin asking about a
-- property that is not theirs is refused rather than quietly answered about
-- their own — a screen that silently shows the wrong site is worse than one
-- that errors.
--
-- The capacity column is dropped from the return: nothing displays it any
-- more, and leaving it would have the screen showing a limit that is no
-- longer enforced.
-- ═══════════════════════════════════════════════════════════════════════

begin;

-- ═══════════════════════════════════════════════════════════════════════
-- 1. task_complete_parking — no limit, no override
-- ═══════════════════════════════════════════════════════════════════════

drop function if exists public.task_complete_parking(uuid, text);
drop function if exists public.task_complete_parking(uuid, text, boolean);

create function public.task_complete_parking(
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

  -- No capacity check. See the header.

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
-- 2. task_complete_reparking — the same
--
-- The p_exclude argument space_is_full() took, so that a no-show car was not
-- compared against itself, goes with the check that needed it.
-- ═══════════════════════════════════════════════════════════════════════

drop function if exists public.task_complete_reparking(uuid, text);
drop function if exists public.task_complete_reparking(uuid, text, boolean);

create function public.task_complete_reparking(
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
-- 3. parking_space_usage(property) — one property, for whoever may see it
--
-- DROPPED first: a RETURNS TABLE cannot lose a column via CREATE OR REPLACE.
-- Postgres refuses with 42P13 because the row type changes.
-- ═══════════════════════════════════════════════════════════════════════

drop function if exists public.parking_space_usage();
drop function if exists public.parking_space_usage(uuid);

create function public.parking_space_usage(p_property_id uuid default null)
returns table (
  id         uuid,
  label      text,
  label_hi   text,
  in_use     bigint,
  is_active  boolean,
  sort_order int
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_role text := public.my_role();
  v_mine uuid := public.my_property_id();
  v_prop uuid := coalesce(p_property_id, v_mine);
begin
  if v_prop is null then
    -- A system_admin who has not picked a property yet. Nothing to show, and
    -- not an error — the screen renders its own "choose a site" state.
    return;
  end if;

  -- A valet_admin may only ever ask about their own property. Answering about
  -- their own instead would put one site of places on screen under another
  -- site heading, which is worse than refusing.
  if v_role is distinct from 'system_admin' and v_prop is distinct from v_mine then
    raise exception 'FORBIDDEN: that property is not yours';
  end if;

  return query
  select
    s.id::uuid,
    s.label::text,
    s.label_hi::text,
    (select count(*)
       from public.parked_vehicles v
      where v.property_id = v_prop
        -- Matched on the LABEL, case- and space-insensitively, because
        -- parking_location is free text and deliberately not a foreign key —
        -- see migration 0016 for why. NOT on label_hi: what was stored at park
        -- time is the English label, and a Hindi name must never change a count.
        and lower(btrim(v.parking_location)) = lower(btrim(s.label))
        and v.status in ('parked', 'returned', 're_parking'))::bigint,
    s.is_active::boolean,
    s.sort_order::int
  from public.parking_spaces s
  where s.property_id = v_prop
  order by s.sort_order, s.label;
end $fn$;

revoke all    on function public.parking_space_usage(uuid) from public, anon;
grant execute on function public.parking_space_usage(uuid) to authenticated;


-- ═══════════════════════════════════════════════════════════════════════
-- 4. add_parking_spaces — without the capacity argument
--
-- p_property_id was already here and already let a system_admin target a
-- site, so only the capacity argument goes. De-duplication, sort ordering and
-- the role check all stay exactly as they were.
-- ═══════════════════════════════════════════════════════════════════════

drop function if exists public.add_parking_spaces(text[], int, uuid);
drop function if exists public.add_parking_spaces(text[], uuid);

create function public.add_parking_spaces(
  p_labels      text[],
  p_property_id uuid default null
)
returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_role   text := public.my_role();
  v_mine   uuid := public.my_property_id();
  v_prop   uuid := coalesce(p_property_id, v_mine);
  v_next   int;
  v_added  int := 0;
  v_label  text;
begin
  if v_role not in ('valet_admin', 'system_admin') then
    raise exception 'FORBIDDEN: only an admin can add parking places';
  end if;

  if v_prop is null then
    raise exception 'PROPERTY_REQUIRED: pick a property first';
  end if;

  if v_role <> 'system_admin' and v_prop is distinct from v_mine then
    raise exception 'FORBIDDEN: that property is not yours';
  end if;

  select coalesce(max(sort_order), 0) + 1 into v_next
  from public.parking_spaces
  where property_id = v_prop;

  foreach v_label in array coalesce(p_labels, array[]::text[])
  loop
    v_label := nullif(btrim(v_label), '');
    continue when v_label is null;
    continue when length(v_label) > 60;

    -- Case-insensitive de-duplication: "Basement" and "basement" are one
    -- place, and two chips for it would split the count between them.
    if exists (
      select 1 from public.parking_spaces s
      where s.property_id = v_prop
        and lower(btrim(s.label)) = lower(v_label)
    ) then
      continue;
    end if;

    insert into public.parking_spaces (property_id, label, sort_order)
    values (v_prop, v_label, v_next);

    v_next  := v_next + 1;
    v_added := v_added + 1;
  end loop;

  return v_added;
end $fn$;

revoke all    on function public.add_parking_spaces(text[], uuid) from public, anon;
grant execute on function public.add_parking_spaces(text[], uuid) to authenticated;

commit;


-- ═══════════════════════════════════════════════════════════════════════
-- VERIFY — every row must read PASS
--
-- `check_name`, not `check`. That is not a style choice: CHECK is a reserved
-- word in Postgres, so `as check` parses and then `order by ... check` does
-- not — 42601, on the last line of the file, after everything above it has
-- already committed. Every other migration in this project uses check_name for
-- exactly this reason; this one broke the convention and hit the wall.
--
-- pronamespace is pinned to public on every row too. pg_proc holds every
-- function in the database, extensions included, so an unqualified proname
-- match can pick up somebody else and report a PASS that means nothing.
-- ═══════════════════════════════════════════════════════════════════════
select check_name, case when ok then 'PASS' else 'FAIL' end as result
from (
  select 'task_complete_parking takes 2 args, not 3' as check_name,
         (select count(*) = 1 from pg_proc
           where pronamespace = 'public'::regnamespace
             and proname = 'task_complete_parking' and pronargs = 2) as ok

  union all select 'task_complete_reparking takes 2 args, not 3',
         (select count(*) = 1 from pg_proc
           where pronamespace = 'public'::regnamespace
             and proname = 'task_complete_reparking' and pronargs = 2)

  union all select 'nothing calls space_is_full any more',
         (select count(*) = 0 from pg_proc
           where pronamespace = 'public'::regnamespace
             and prosrc like '%space_is_full%' and proname <> 'space_is_full')

  union all select 'space_is_full is still there, for later',
         to_regprocedure('public.space_is_full(uuid,text,uuid)') is not null

  union all select 'parking_space_usage takes a property',
         to_regprocedure('public.parking_space_usage(uuid)') is not null

  union all select 'parking_space_usage no longer returns capacity',
         (select 'capacity' <> all(coalesce(proargnames, array[]::text[]))
            from pg_proc
           where pronamespace = 'public'::regnamespace
             and proname = 'parking_space_usage')

  union all select 'add_parking_spaces takes 2 args, not 3',
         to_regprocedure('public.add_parking_spaces(text[],uuid)') is not null
) t
order by ok, check_name;
