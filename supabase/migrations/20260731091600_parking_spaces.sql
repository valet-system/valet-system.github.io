-- ═══════════════════════════════════════════════════════════════════════
-- 0016 — PARKING SPACES AS A MASTER LIST
--
--   >>> RUN THIS IN THE SUPABASE SQL EDITOR. <<<
--
-- Safe to run more than once. It creates one table, and RLS is enabled on it
-- below — the editor's warning is answered by the policies further down.
--
--
-- WHY
--
-- The operator typed the parking location by hand into a free-text field. On a
-- porch, on a phone, two hundred times a shift, that is the slowest step in the
-- whole flow and the one that produces "L2B4", "l2 b4", "L-2 B4" and "Level 2
-- Bay 4" for the same bay — so searching for a car by where it is parked never
-- worked, and neither did counting how full a level is.
--
-- The admin knows their car park. They define the spaces once; the operator taps
-- one. Nothing to type, nothing to spell differently.
--
--
-- WHY FREE TEXT IS STILL ALLOWED
--
-- parked_vehicles.parking_location stays a plain text column and is NOT a
-- foreign key to this table. Three reasons, and they all matter more than
-- referential tidiness:
--
--   1. A fresh property has no spaces defined yet. If the column pointed at this
--      table, the very first car of a new site could not be checked in until
--      an admin had finished data entry.
--   2. Cars get left in places that are not spaces — the ramp, the porch, behind
--      the kitchen — and refusing to record that would mean recording nothing.
--   3. Renaming a space must not rewrite history. A car parked in "L2 B4"
--      yesterday was parked there even if the space is called something else now.
--
-- So this table drives the CHIPS, not the constraint.
--
--
-- WHO OWNS THE LIST
--
-- The valet_admin of that property. They run the site and know which spaces
-- exist; a system_admin can reach every property's list too. An operator can
-- only READ it — being able to invent a space from the porch would put the
-- spelling problem straight back.
-- ═══════════════════════════════════════════════════════════════════════

begin;


-- ═══════════════════════════════════════════════════════════════════════
-- 1. THE TABLE
-- ═══════════════════════════════════════════════════════════════════════

create table if not exists public.parking_spaces (
  id          uuid primary key default gen_random_uuid(),
  property_id uuid not null references public.properties(id) on delete cascade,
  -- What the operator sees on the chip. Short on purpose: it has to be
  -- readable at a glance on a cheap phone in daylight.
  label       text not null,
  -- Manual ordering, because "10" sorts before "2" alphabetically and the
  -- operator reads these in the order the admin typed them, not ASCII order.
  sort_order  int not null default 0,
  is_active   boolean not null default true,
  created_at  timestamptz not null default now()
);

-- One space name per property. Two chips reading the same thing is the exact ambiguity
-- this table exists to remove.
create unique index if not exists parking_spaces_label_key
  on public.parking_spaces(property_id, lower(btrim(label)));

-- The operator's only query: my property's active spaces, in display order.
create index if not exists parking_spaces_property_idx
  on public.parking_spaces(property_id, is_active, sort_order);

alter table public.parking_spaces enable row level security;


-- ═══════════════════════════════════════════════════════════════════════
-- 2. POLICIES
-- ═══════════════════════════════════════════════════════════════════════

-- Everyone at the property may READ, including operators — they need the chips.
drop policy if exists parking_spaces_read on public.parking_spaces;
create policy parking_spaces_read on public.parking_spaces
  for select to authenticated
  using (public.is_system_admin() or property_id = public.my_property_id());

-- Only an admin may change the list. Split into three policies rather than
-- `for all`, so the reason each one exists stays visible.
drop policy if exists parking_spaces_insert on public.parking_spaces;
create policy parking_spaces_insert on public.parking_spaces
  for insert to authenticated
  with check (
    public.is_system_admin()
    or (public.my_role() = 'valet_admin' and property_id = public.my_property_id())
  );

drop policy if exists parking_spaces_update on public.parking_spaces;
create policy parking_spaces_update on public.parking_spaces
  for update to authenticated
  using (
    public.is_system_admin()
    or (public.my_role() = 'valet_admin' and property_id = public.my_property_id())
  )
  with check (
    public.is_system_admin()
    or (public.my_role() = 'valet_admin' and property_id = public.my_property_id())
  );

drop policy if exists parking_spaces_delete on public.parking_spaces;
create policy parking_spaces_delete on public.parking_spaces
  for delete to authenticated
  using (
    public.is_system_admin()
    or (public.my_role() = 'valet_admin' and property_id = public.my_property_id())
  );

revoke all on public.parking_spaces from anon;
grant select, insert, update, delete on public.parking_spaces to authenticated;


-- ═══════════════════════════════════════════════════════════════════════
-- 3. add_parking_spaces — bulk entry, because that is how a car park is typed
--
-- An admin setting up does not add one at a time; they have a level with
-- twenty spaces. This takes a list, cleans it, skips what already exists, and
-- keeps the order they typed.
--
-- `on conflict do nothing` and not an error: re-pasting a list that overlaps an
-- existing one is a normal thing to do and should top it up, not fail.
-- ═══════════════════════════════════════════════════════════════════════

create or replace function public.add_parking_spaces(
  p_labels      text[],
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

  -- Continue the existing numbering so a second paste lands after the first
  -- rather than interleaving with it.
  select coalesce(max(sort_order), 0) into v_next
  from public.parking_spaces where property_id = v_prop;

  foreach v_label in array coalesce(p_labels, array[]::text[])
  loop
    v_label := nullif(btrim(v_label), '');
    continue when v_label is null;

    if length(v_label) > 24 then
      raise exception 'BAD_LABEL: "%" is too long — keep a space name short enough to read on a chip', v_label;
    end if;

    v_next := v_next + 1;

    insert into public.parking_spaces (property_id, label, sort_order)
    values (v_prop, v_label, v_next)
    on conflict do nothing;

    if found then
      v_added := v_added + 1;
    end if;
  end loop;

  return v_added;
end $fn$;

revoke all    on function public.add_parking_spaces(text[], uuid) from public, anon;
grant execute on function public.add_parking_spaces(text[], uuid) to authenticated;

commit;


-- ═══════════════════════════════════════════════════════════════════════
-- VERIFY — every row should say PASS.
-- ═══════════════════════════════════════════════════════════════════════

with checks as (
  select 'parking_spaces table exists' as item,
         to_regclass('public.parking_spaces') is not null as ok
  union all select 'RLS is on',
         (select relrowsecurity from pg_class where oid = 'public.parking_spaces'::regclass)
  union all select 'operators can read it (they need the chips)',
         exists (select 1 from pg_policies where schemaname = 'public'
                 and tablename = 'parking_spaces' and cmd = 'SELECT')
  union all select 'writes are admin-only, and there are three of them',
         (select count(*) from pg_policies where schemaname = 'public'
          and tablename = 'parking_spaces' and cmd in ('INSERT','UPDATE','DELETE')) = 3
  union all select 'space names are unique per property',
         exists (select 1 from pg_indexes where schemaname = 'public'
                 and indexname = 'parking_spaces_label_key')
  union all select 'add_parking_spaces exists',
         to_regprocedure('public.add_parking_spaces(text[],uuid)') is not null
  union all select 'parking_location is still free text, NOT a foreign key',
         not exists (
           select 1 from information_schema.table_constraints tc
           join information_schema.key_column_usage k
             on k.constraint_name = tc.constraint_name
           where tc.table_schema = 'public'
             and tc.table_name = 'parked_vehicles'
             and tc.constraint_type = 'FOREIGN KEY'
             and k.column_name = 'parking_location'
         )
)
select item, case when ok then 'PASS' else 'FAIL' end as result
from checks
order by result desc, item;
