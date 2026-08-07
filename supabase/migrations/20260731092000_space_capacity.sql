-- ═══════════════════════════════════════════════════════════════════════
-- 0020 — HOW MANY CARS FIT IN EACH PLACE
--
--   >>> RUN THIS IN THE SUPABASE SQL EDITOR, AFTER 0016. <<<
--
-- Safe to run more than once. Adds one column; if the editor warns about RLS,
-- choose "Run without RLS" — parking_spaces already has its policies from 0016.
--
--
-- WHAT THIS ADDS
--
-- parking_spaces.capacity, and one function that reports how full each place is
-- right now. The admin says "the basement holds 20"; the operator sees
-- "Basement 17/20" on the chip and "FULL" when it is.
--
--
-- ══ OCCUPANCY IS DERIVED, NEVER STORED ══
--
-- There is no `cars_parked` counter on parking_spaces, and there must not be.
-- A counter has to be incremented when a car is parked and decremented when it
-- is handed back — and the day one of those paths is missed, or a transaction
-- rolls back after the increment, the number is wrong forever with nothing to
-- reconcile it against. In a car park that means an operator being told a row
-- is full when it is empty, and no way to find out why.
--
-- Instead it is COUNTED, live, from the cars themselves: how many
-- parked_vehicles rows currently sit at that label with a status that means the
-- car is physically there. Delivering a car changes its status, so the place
-- frees itself. There is no bookkeeping to get wrong.
--
-- The cost is a count per place on each read. That is what
-- parking_spaces_location_idx below is for, and at four properties it is
-- nothing.
--
--
-- ══ A FULL PLACE IS STILL TAPPABLE, AND THAT IS DELIBERATE ══
--
-- Capacity is advisory. Valets double-park, stack, and put one more car across
-- the end of a row when the porch is blocked — and when they do, the system
-- must record where that car ACTUALLY is. A picker that refuses the only
-- honest answer gets the nearest wrong place tapped instead, which reads as
-- precise and is not.
--
-- So "full" is loud on the chip, going over shows as 5/4 in red to the admin —
-- which is real, actionable information about an overstuffed row — and nothing
-- is blocked.
-- ═══════════════════════════════════════════════════════════════════════

begin;


-- ═══════════════════════════════════════════════════════════════════════
-- 1. THE COLUMN
--
-- Default 1, not 0: a place that holds nothing is not a place, and defaulting
-- to 0 would make every existing row read as permanently full the moment this
-- migration ran.
-- ═══════════════════════════════════════════════════════════════════════

alter table public.parking_spaces
  add column if not exists capacity int not null default 1;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'parking_spaces_capacity_positive'
  ) then
    alter table public.parking_spaces
      add constraint parking_spaces_capacity_positive
      check (capacity > 0 and capacity <= 999);
  end if;
end $$;

-- The index the occupancy count runs on. Without it, counting cars per place is
-- a scan of today's vehicles per place — fine at four places, quadratic at forty.
create index if not exists parked_vehicles_location_idx
  on public.parked_vehicles(property_id, parking_location)
  where parking_location is not null;


-- ═══════════════════════════════════════════════════════════════════════
-- 2. parking_space_usage — every place, and how full it is right now
--
-- Readable by OPERATORS as well as admins: they need it to draw the chips. It
-- exposes nothing a chip does not already show.
--
-- `in_use` counts cars whose status means the car is physically in that place.
-- Not 'delivered' (gone), not 'fetching' or 'at_pickup' — a car being driven to
-- the porch has left its space, and holding the space until hand-over is
-- complete would under-report free room during exactly the busiest minutes.
-- ═══════════════════════════════════════════════════════════════════════

-- CREATE OR REPLACE cannot change a function's RETURN TYPE, and a
-- RETURNS TABLE list IS the return type — so adding or removing a column
-- later fails with 42P13 unless the old row type is gone first. Dropping
-- here keeps this migration re-runnable in any order.
drop function if exists public.parking_space_usage();

create or replace function public.parking_space_usage()
returns table (
  id         uuid,
  label      text,
  capacity   int,
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
  v_prop uuid := public.my_property_id();
begin
  if v_prop is null then
    -- A system_admin has no property of their own. Returning nothing is
    -- correct: this feeds one property's chips, and "every place at every
    -- site" is not a list anyone asked for.
    return;
  end if;

  return query
  select
    s.id::uuid,
    s.label::text,
    s.capacity::int,
    (select count(*)
       from public.parked_vehicles v
      where v.property_id = v_prop
        -- Matched on the LABEL, case- and space-insensitively, because
        -- parking_location is free text and deliberately not a foreign key —
        -- see migration 0016 for why.
        and lower(btrim(v.parking_location)) = lower(btrim(s.label))
        and v.status in ('parked', 'returned', 're_parking'))::bigint,
    s.is_active::boolean,
    s.sort_order::int
  from public.parking_spaces s
  where s.property_id = v_prop
  order by s.sort_order, s.label;
end $fn$;

revoke all    on function public.parking_space_usage() from public, anon;
grant execute on function public.parking_space_usage() to authenticated;


-- ═══════════════════════════════════════════════════════════════════════
-- 3. add_parking_spaces — now takes a capacity for the whole batch
--
-- One capacity per paste, because that is how they come: "the basement has 20
-- bays", "the front row holds 6". Individual places are adjusted afterwards.
-- ═══════════════════════════════════════════════════════════════════════

create or replace function public.add_parking_spaces(
  p_labels      text[],
  p_capacity    int  default 1,
  p_property_id uuid default null
)
returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_role     text;
  v_prop     uuid;
  v_cap      int := least(greatest(coalesce(p_capacity, 1), 1), 999);
  v_label    text;
  v_next     int;
  v_added    int := 0;
begin
  select ur.role, ur.property_id into v_role, v_prop
  from public.user_roles ur
  where ur.user_id = auth.uid() and ur.is_active = true;

  if v_role is null then
    raise exception 'FORBIDDEN: you are not signed in as an active user';
  end if;

  if v_role = 'system_admin' then
    v_prop := coalesce(p_property_id, v_prop);
    if v_prop is null then
      raise exception 'PROPERTY_REQUIRED: choose a property';
    end if;
  elsif v_role = 'valet_admin' then
    -- A valet_admin's own property, always. Ignoring p_property_id rather than
    -- validating it means there is no way to aim this at another site at all.
    if p_property_id is not null and p_property_id <> v_prop then
      raise exception 'FORBIDDEN_PROPERTY';
    end if;
  else
    raise exception 'FORBIDDEN: only an admin can define parking spaces';
  end if;

  select coalesce(max(sort_order), 0) into v_next
  from public.parking_spaces where property_id = v_prop;

  foreach v_label in array coalesce(p_labels, array[]::text[])
  loop
    v_label := nullif(btrim(v_label), '');
    continue when v_label is null;

    if length(v_label) > 24 then
      raise exception 'BAD_LABEL: "%" is too long — keep a name short enough to read on a chip', v_label;
    end if;

    v_next := v_next + 1;

    insert into public.parking_spaces (property_id, label, capacity, sort_order)
    values (v_prop, v_label, v_cap, v_next)
    on conflict do nothing;

    if found then
      v_added := v_added + 1;
    end if;
  end loop;

  return v_added;
end $fn$;

-- The two-argument form from 0016 is dropped so it cannot be resolved by
-- accident. An overload left behind would silently create places with the
-- default capacity while the caller believed it had set one.
drop function if exists public.add_parking_spaces(text[], uuid);

revoke all    on function public.add_parking_spaces(text[], int, uuid) from public, anon;
grant execute on function public.add_parking_spaces(text[], int, uuid) to authenticated;

commit;


-- ═══════════════════════════════════════════════════════════════════════
-- VERIFY — every row should say PASS.
-- ═══════════════════════════════════════════════════════════════════════

with checks as (
  select 'capacity column exists' as item,
         exists (select 1 from information_schema.columns
                 where table_schema = 'public' and table_name = 'parking_spaces'
                   and column_name = 'capacity') as ok
  union all select 'capacity must be positive',
         exists (select 1 from pg_constraint
                 where conname = 'parking_spaces_capacity_positive')
  union all select 'capacity defaults to 1, not 0',
         (select column_default like '1%' from information_schema.columns
          where table_schema = 'public' and table_name = 'parking_spaces'
            and column_name = 'capacity')
  union all select 'the location index exists (the count runs on it)',
         exists (select 1 from pg_indexes where schemaname = 'public'
                 and indexname = 'parked_vehicles_location_idx')
  union all select 'parking_space_usage exists',
         to_regprocedure('public.parking_space_usage()') is not null
  union all select 'operators can call it (they draw the chips)',
         has_function_privilege('authenticated', 'public.parking_space_usage()', 'execute')
  union all select 'add_parking_spaces now takes a capacity',
         to_regprocedure('public.add_parking_spaces(text[],int,uuid)') is not null
  union all select 'the old 2-arg add is GONE (no silent overload)',
         to_regprocedure('public.add_parking_spaces(text[],uuid)') is null
  union all select 'there is still NO stored occupancy counter',
         not exists (select 1 from information_schema.columns
                     where table_schema = 'public' and table_name = 'parking_spaces'
                       and column_name in ('cars_parked', 'occupied', 'in_use'))
)
select item, case when ok then 'PASS' else 'FAIL' end as result
from checks
order by result desc, item;


-- How full each place is right now. Run it signed in as a valet_admin:
--
-- select label, in_use, capacity, capacity - in_use as free
-- from public.parking_space_usage()
-- order by sort_order;
