-- ═══════════════════════════════════════════════════════════════════════
-- MIGRATION 0071 — NIGHTLY PER-OPERATOR TOKEN RANGES, ROUND-ROBIN REUSE
--
--   >>> RUN THIS IN THE SUPABASE SQL EDITOR. <<<
--
-- Safe to run more than once. Creates one table; if the editor warns about
-- RLS, this migration enables it itself in section 1.
--
--
-- THE PIVOT
--
-- Today one property hands out one strictly-increasing number per service
-- day (token_ranges, allocate_token()). The valet floor wants the opposite:
-- each operator on duty tonight gets THEIR OWN small range — Ramesh 1-5,
-- Shailendra 6-10 — and reuses a number the moment the car it was written on
-- has been handed back to the guest. Ramesh's 6th car is token 1 again, not
-- token 6, because his 1st car was long since delivered.
--
-- "The moment delivered, not before" is a firm product decision: a car that
-- is merely 'requested' or 'fetching' still has that number written on a
-- paper stub in a guest's pocket, and issuing it again would put two guests
-- in front of the same stub.
--
--
-- WHY A NEW TABLE AND NOT A COLUMN ON token_ranges
--
-- token_ranges is unique(property_id, range_date) — one row per property per
-- night, by design, for a single shared counter. This feature needs MANY rows
-- per property per night, one per operator, so it is a new table rather than
-- a schema change to a table whose whole shape encodes "there is exactly one
-- of these." token_ranges is untouched and kept — see section 8 for why it
-- is retired rather than dropped.
--
--
-- WHY "LOWEST FREE SLOT", NOT A WRAPPING CURSOR
--
-- A cursor that increments and wraps at range_size breaks the instant a
-- delivery happens out of order: Ramesh parks 1, 2, 3; car 3's guest leaves
-- first. A cursor doesn't know slot 3 is free again until it has walked all
-- the way back around to it — and if 1 and 2 are still out, it reports
-- TOKEN_RANGE_EXHAUSTED with a free number sitting right there. "Lowest free
-- slot with no currently-active vehicle at that number" doesn't have this
-- failure mode, and under the in-order case it behaves identically to
-- round-robin — 1, 2, 3, 1, 2, 3, ... — because that is just what "lowest
-- free slot" produces when things are delivered in the order they were
-- parked.
--
--
-- WHY THE UNIQUE INDEX HAS TO CHANGE, NOT JUST GET A NEW SIBLING
--
-- parked_vehicles_token_per_day_key (property_id, service_date, token_number)
-- makes a token unique for an entire day. Under reuse two DELIVERED cars can
-- legitimately share a token the same day — so this index, left in place,
-- would reject the second occurrence of every reused number with a 23505 the
-- moment two operators between them handed back and re-issued the same slot.
-- It has to be replaced with a PARTIAL index that only looks at cars that are
-- still on the floor: unique(property_id, token_number) WHERE status <>
-- 'delivered'. That is also the real backstop against a concurrency race in
-- allocate_operator_token(), exactly as the old index backstopped
-- allocate_token().
-- ═══════════════════════════════════════════════════════════════════════

begin;


-- ═══════════════════════════════════════════════════════════════════════
-- 1. THE TABLE
--
-- One row per operator per property per service night. range_start is
-- immutable once set — a number already handed out cannot retroactively
-- belong to someone else. range_end can only grow — "extend" is an admin
-- action on this same row, not a new row, matching the exact "the range can
-- only ever grow" philosophy already on today's TokenMgmt.jsx.
--
-- is_active lets an admin take an operator off tonight's roster (sent home,
-- moved to another job) WITHOUT deleting the row — their tonight-so-far
-- stats stay intact for the roster view, and allocate_operator_token() just
-- stops handing out numbers from a deactivated range.
-- ═══════════════════════════════════════════════════════════════════════

create table if not exists public.operator_token_ranges (
  id           uuid primary key default gen_random_uuid(),
  property_id  uuid not null references public.properties(id),
  service_date date not null default public.ist_today(),
  operator_id  uuid not null references public.user_roles(id),
  range_start  int  not null,
  range_end    int  not null,
  is_active    boolean not null default true,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  constraint operator_token_ranges_bounds_chk
    check (range_start >= 1 and range_end >= range_start),
  constraint operator_token_ranges_one_per_night
    unique (property_id, service_date, operator_id)
);

comment on table public.operator_token_ranges is
  'Tonight''s roster: which numbers each operator hands out, per property per service_date. Resets every night — nothing auto-creates a row here, an admin assigns one per on-duty operator. See migration 0071.';

alter table public.operator_token_ranges enable row level security;

-- ── read: property-wide, like token_ranges_read ─────────────────────────
-- A range is a handful of plain integers, not sensitive data, and this
-- codebase's whole RLS strategy is coarse property scoping with ownership
-- enforced inside SECURITY DEFINER functions where it actually matters (see
-- tasks_property_rw). Letting every operator at a property see the whole
-- roster is also simply useful: it answers "why is my range only 1-5"
-- without a support call.
create policy operator_token_ranges_read on public.operator_token_ranges
  for select to authenticated
  using (public.is_system_admin() or property_id = public.my_property_id());

-- ── write: admin only, like token_ranges_admin_write ────────────────────
-- The REAL write path is admin_assign_token_range() below, which runs as
-- SECURITY DEFINER and so bypasses this policy entirely — exactly like
-- allocate_token() bypasses token_ranges_admin_write today. This policy is
-- defense in depth, not the enforcement mechanism.
create policy operator_token_ranges_admin_write on public.operator_token_ranges
  for all to authenticated
  using (
    public.is_system_admin()
    or (public.my_role() = 'valet_admin' and property_id = public.my_property_id())
  )
  with check (
    public.is_system_admin()
    or (public.my_role() = 'valet_admin' and property_id = public.my_property_id())
  );

grant select, insert, update on public.operator_token_ranges to authenticated;


-- ═══════════════════════════════════════════════════════════════════════
-- 2. THE UNIQUE INDEX SWAP
--
-- Old: unique per property per DAY. New: unique per property among cars
-- still ON THE FLOOR, regardless of day — a car checked in last night and
-- somehow still not delivered must keep blocking its number tonight too.
--
-- Dropping an index is never destructive to data, so the old one goes
-- unconditionally. The new one is guarded with the same "skip if the data
-- already violates it" safety check the original conditional uniqueness
-- check in 20260731090100_fixes_and_hardening.sql used.
-- ═══════════════════════════════════════════════════════════════════════

drop index if exists public.parked_vehicles_token_per_day_key;

do $$
begin
  if exists (
    select 1 from public.parked_vehicles
    where status <> 'delivered'
    group by property_id, token_number
    having count(*) > 1
  ) then
    raise notice 'SKIPPED active-token uniqueness: two non-delivered cars already share a token at the same property. Fix the data, then re-run this migration.';
  else
    create unique index if not exists parked_vehicles_active_token_key
      on public.parked_vehicles(property_id, token_number)
      where status <> 'delivered';
  end if;
end $$;


-- ═══════════════════════════════════════════════════════════════════════
-- 3. allocate_operator_token — the new claim, scoped to ONE operator
--
-- Internal helper, like claim_task: NOT granted to authenticated. It is
-- reached from inside operator_check_in, which runs as the function OWNER,
-- so it needs no grant of its own to be callable from there — a tightening
-- versus the old allocate_token(), which was (unnecessarily) granted
-- directly to authenticated.
--
-- Row lock on the OPERATOR'S OWN range for the rest of this transaction:
-- two simultaneous check-ins by the same operator (two devices, or a
-- double-tap) serialise here rather than both computing the same "lowest
-- free number" and racing for it. Two DIFFERENT operators never contend on
-- this lock, because admin_assign_token_range() below refuses to create
-- overlapping ranges — each operator's search only ever looks at numbers
-- nobody else could legally be handing out.
--
-- is_active = true excludes a range an admin has taken an operator off of
-- mid-shift, without touching their already-parked cars, which keep their
-- numbers until delivered normally.
-- ═══════════════════════════════════════════════════════════════════════

create or replace function public.allocate_operator_token(
  p_property_id uuid,
  p_operator_id uuid
)
returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_range public.operator_token_ranges;
  v_token int;
begin
  if p_property_id is null then
    raise exception 'PROPERTY_REQUIRED';
  end if;

  if not (public.is_system_admin() or p_property_id = public.my_property_id()) then
    raise exception 'FORBIDDEN_PROPERTY';
  end if;

  select * into v_range
  from public.operator_token_ranges otr
  where otr.property_id  = p_property_id
    and otr.operator_id  = p_operator_id
    and otr.service_date = public.ist_today()
    and otr.is_active    = true
  for update;

  if v_range.id is null then
    raise exception 'NO_TOKEN_RANGE: you have not been given a token range for tonight — ask your admin to assign you one';
  end if;

  -- Lowest number in [range_start, range_end] with no currently-active
  -- (non-delivered) car sitting on it, for THIS property. Not scoped to
  -- service_date on purpose: a car from before the 05:30 IST rollover that
  -- is somehow still not delivered must keep blocking its number tonight —
  -- the same reasoning as the partial unique index above.
  select s.n into v_token
  from generate_series(v_range.range_start, v_range.range_end) as s(n)
  where not exists (
    select 1 from public.parked_vehicles v
    where v.property_id  = p_property_id
      and v.token_number = s.n
      and v.status       <> 'delivered'
  )
  order by s.n
  limit 1;

  if v_token is null then
    raise exception 'TOKEN_RANGE_EXHAUSTED: your range (% to %) is fully in use — ask your admin to extend it before checking in another car',
      v_range.range_start, v_range.range_end;
  end if;

  return v_token;
end $fn$;

revoke execute on function public.allocate_operator_token(uuid, uuid)
  from public, anon, authenticated;


-- ═══════════════════════════════════════════════════════════════════════
-- 4. operator_check_in — REPLACED to allocate from the caller's OWN range
--
-- This is migration 0008's function, reprinted here per this repo's own
-- convention (CREATE OR REPLACE in a NEW file, never edit the old one — see
-- get_available_operators, vehicle_records and search_todays_cars, every one
-- of which has been re-declared this way multiple times). The signature and
-- return type are unchanged, so CREATE OR REPLACE is legal and every
-- existing grant on this function carries forward untouched.
--
-- The ONLY change from 0008's text is the one line that used to read
--   v_token := public.allocate_token(v_caller.property_id);
-- which becomes
--   v_token := public.allocate_operator_token(v_caller.property_id, v_caller.id);
-- Everything else is byte-for-byte identical to the live function body.
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
  -- ▼▼▼ the one changed line — was allocate_token(v_caller.property_id) ▼▼▼
  v_token := public.allocate_operator_token(v_caller.property_id, v_caller.id);

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
-- 5. admin_assign_token_range — create OR extend, one call
--
-- Upsert on (property_id, service_date, operator_id):
--   no row tonight yet  -> CREATE. p_range_start is required.
--   a row already exists -> EXTEND ONLY. p_range_start is ignored — the
--     start of a range that already has cars parked under it can never move.
--     p_range_end must be strictly greater than the current one.
--
-- Overlap is checked against every OTHER active operator's range for the
-- SAME property and service_date — not against every row ever, and not
-- against the operator's own current row (which is what is being widened).
--
-- p_service_date defaults to tonight but accepts tomorrow too, so an admin
-- can build tomorrow's roster in advance, the same way today's TokenMgmt.jsx
-- lets them pre-create tomorrow's range.
--
-- p_property_id follows the admin_attach_operator convention exactly:
-- required and honoured for a system_admin, accepted-and-discarded for a
-- valet_admin, who can only ever act on their own property.
-- ═══════════════════════════════════════════════════════════════════════

create or replace function public.admin_assign_token_range(
  p_operator_id  uuid,
  p_range_end    int,
  p_range_start  int  default null,
  p_service_date date default null,
  p_property_id  uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_my_role     text;
  v_my_property uuid;
  v_property    uuid;
  v_date        date;
  v_operator    record;
  v_existing    public.operator_token_ranges;
  v_collide     record;
begin
  select ur.role, ur.property_id into v_my_role, v_my_property
  from public.user_roles ur
  where ur.user_id = auth.uid() and ur.is_active = true;

  if v_my_role is null then
    raise exception 'FORBIDDEN: you are not signed in as an active user';
  end if;
  if v_my_role not in ('system_admin', 'valet_admin') then
    raise exception 'FORBIDDEN: only an admin can assign a token range';
  end if;

  if v_my_role = 'valet_admin' then
    v_property := v_my_property;
  else
    v_property := p_property_id;
    if v_property is null then
      raise exception 'PROPERTY_REQUIRED: choose a property';
    end if;
  end if;

  v_date := coalesce(p_service_date, public.ist_today());
  if v_date < public.ist_today() then
    raise exception 'BAD_DATE: cannot assign a range for a night that has already passed';
  end if;
  if v_date > public.ist_today() + 1 then
    raise exception 'BAD_DATE: you can only set up today or tomorrow''s roster';
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
  if v_operator.property_id is distinct from v_property then
    raise exception 'BAD_OPERATOR: that operator is not at this property';
  end if;

  select * into v_existing
  from public.operator_token_ranges otr
  where otr.property_id  = v_property
    and otr.service_date = v_date
    and otr.operator_id  = p_operator_id
  for update;

  if v_existing.id is null then
    -- ── CREATE ──────────────────────────────────────────────────────
    if p_range_start is null then
      raise exception 'RANGE_REQUIRED: enter the first token in %s range', v_operator.name;
    end if;
    if p_range_start < 1 then
      raise exception 'BAD_RANGE: the first token must be 1 or more';
    end if;
    if p_range_end <= p_range_start then
      raise exception 'BAD_RANGE: the last token must be greater than the first';
    end if;
    if p_range_end - p_range_start + 1 > 500 then
      raise exception 'BAD_RANGE: that range is unusually large — check the numbers';
    end if;

    select ur.name, otr.range_start, otr.range_end
      into v_collide
    from public.operator_token_ranges otr
    join public.user_roles ur on ur.id = otr.operator_id
    where otr.property_id  = v_property
      and otr.service_date = v_date
      and otr.is_active    = true
      and otr.range_start  <= p_range_end
      and otr.range_end    >= p_range_start
    limit 1;

    if v_collide.name is not null then
      raise exception 'RANGE_OVERLAP: % to % overlaps %''s range (% to %) tonight',
        p_range_start, p_range_end, v_collide.name, v_collide.range_start, v_collide.range_end;
    end if;

    insert into public.operator_token_ranges
      (property_id, service_date, operator_id, range_start, range_end)
    values
      (v_property, v_date, p_operator_id, p_range_start, p_range_end)
    returning * into v_existing;

    return jsonb_build_object(
      'created',       true,
      'operator_id',   p_operator_id,
      'operator_name', v_operator.name,
      'range_start',   v_existing.range_start,
      'range_end',     v_existing.range_end
    );
  end if;

  -- ── EXTEND ONLY ───────────────────────────────────────────────────
  if p_range_end <= v_existing.range_end then
    raise exception 'ONLY_BIGGER: %''s range already reaches % — enter a number above it',
      v_operator.name, v_existing.range_end;
  end if;
  if p_range_end - v_existing.range_start + 1 > 500 then
    raise exception 'BAD_RANGE: that range is unusually large — check the number';
  end if;

  select ur.name, otr.range_start, otr.range_end
    into v_collide
  from public.operator_token_ranges otr
  join public.user_roles ur on ur.id = otr.operator_id
  where otr.property_id  = v_property
    and otr.service_date = v_date
    and otr.operator_id  <> p_operator_id
    and otr.is_active    = true
    and otr.range_start  <= p_range_end
    and otr.range_end    >= v_existing.range_start
  limit 1;

  if v_collide.name is not null then
    raise exception 'RANGE_OVERLAP: extending to % overlaps %''s range (% to %) tonight',
      p_range_end, v_collide.name, v_collide.range_start, v_collide.range_end;
  end if;

  update public.operator_token_ranges
     set range_end  = p_range_end,
         is_active  = true,
         updated_at = now()
   where id = v_existing.id;

  return jsonb_build_object(
    'created',       false,
    'operator_id',   p_operator_id,
    'operator_name', v_operator.name,
    'range_start',   v_existing.range_start,
    'range_end',     p_range_end
  );
end $fn$;

revoke all    on function public.admin_assign_token_range(uuid, int, int, date, uuid) from public, anon;
grant execute on function public.admin_assign_token_range(uuid, int, int, date, uuid) to authenticated;


-- ═══════════════════════════════════════════════════════════════════════
-- 6. admin_remove_token_range — take an operator off tonight without
--    deleting their row or touching cars already under their range.
--
-- "Operator went home early" is a completely ordinary night; leaving no way
-- to stop issuing them further numbers, short of deleting the audit row,
-- would be a real gap.
-- ═══════════════════════════════════════════════════════════════════════

create or replace function public.admin_remove_token_range(
  p_operator_id  uuid,
  p_service_date date default null,
  p_property_id  uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_my_role     text;
  v_my_property uuid;
  v_property    uuid;
  v_date        date := coalesce(p_service_date, public.ist_today());
  v_row         public.operator_token_ranges;
begin
  select ur.role, ur.property_id into v_my_role, v_my_property
  from public.user_roles ur
  where ur.user_id = auth.uid() and ur.is_active = true;

  if v_my_role is null then
    raise exception 'FORBIDDEN: you are not signed in as an active user';
  end if;
  if v_my_role not in ('system_admin', 'valet_admin') then
    raise exception 'FORBIDDEN: only an admin can change tonight''s roster';
  end if;

  v_property := case when v_my_role = 'valet_admin' then v_my_property else p_property_id end;
  if v_property is null then
    raise exception 'PROPERTY_REQUIRED: choose a property';
  end if;

  update public.operator_token_ranges
     set is_active  = false,
         updated_at = now()
   where property_id  = v_property
     and service_date = v_date
     and operator_id  = p_operator_id
  returning * into v_row;

  if v_row.id is null then
    raise exception 'NOT_FOUND: that operator has no range tonight';
  end if;

  return jsonb_build_object('removed', true, 'operator_id', p_operator_id);
end $fn$;

revoke all    on function public.admin_remove_token_range(uuid, date, uuid) from public, anon;
grant execute on function public.admin_remove_token_range(uuid, date, uuid) to authenticated;


-- ═══════════════════════════════════════════════════════════════════════
-- 7. admin_token_roster — one read for the whole TokenMgmt screen
--
-- A plain PostgREST select-with-embed cannot compute "how many cars has this
-- operator run through their range tonight" — that needs parked_vehicles
-- aggregated PER RANGE, which is exactly the kind of thing this codebase
-- always puts in a stable RPC (see vehicle_records) rather than client JS.
--
-- open_count deliberately does NOT filter on service_date — a car still on
-- the floor from before the 05:30 rollover still counts as "currently out"
-- for that operator's range, matching allocate_operator_token()'s own
-- occupancy check exactly. issued_count and delivered_count ARE scoped to
-- the roster night, because "how many did they run through TONIGHT" is a
-- per-shift stat.
-- ═══════════════════════════════════════════════════════════════════════

create or replace function public.admin_token_roster(
  p_property_id  uuid default null,
  p_service_date date default null
)
returns table (
  operator_id      uuid,
  operator_name    text,
  operator_name_hi text,
  range_start      int,
  range_end        int,
  is_active        boolean,
  issued_count     bigint,
  open_count       bigint,
  delivered_count  bigint
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_role  text;
  v_mine  uuid;
  v_scope uuid;
  v_date  date := coalesce(p_service_date, public.ist_today());
begin
  select ur.role, ur.property_id into v_role, v_mine
  from public.user_roles ur
  where ur.user_id = auth.uid() and ur.is_active = true;

  if v_role is null then
    raise exception 'FORBIDDEN: you are not signed in as an active user';
  end if;

  if v_role = 'system_admin' then
    v_scope := p_property_id;
    if v_scope is null then
      raise exception 'PROPERTY_REQUIRED: choose a property';
    end if;
  elsif v_role = 'valet_admin' then
    v_scope := v_mine;
  else
    raise exception 'FORBIDDEN: only an admin can see the token roster';
  end if;

  return query
  select
    otr.operator_id,
    ur.name,
    ur.name_hi,
    otr.range_start,
    otr.range_end,
    otr.is_active,
    (select count(*) from public.parked_vehicles v
       where v.property_id  = v_scope
         and v.service_date = v_date
         and v.token_number between otr.range_start and otr.range_end)::bigint,
    (select count(*) from public.parked_vehicles v
       where v.property_id = v_scope
         and v.status      <> 'delivered'
         and v.token_number between otr.range_start and otr.range_end)::bigint,
    (select count(*) from public.parked_vehicles v
       where v.property_id  = v_scope
         and v.service_date = v_date
         and v.status       = 'delivered'
         and v.token_number between otr.range_start and otr.range_end)::bigint
  from public.operator_token_ranges otr
  join public.user_roles ur on ur.id = otr.operator_id
  where otr.property_id  = v_scope
    and otr.service_date = v_date
  order by otr.range_start;
end $fn$;

revoke all    on function public.admin_token_roster(uuid, date) from public, anon;
grant execute on function public.admin_token_roster(uuid, date) to authenticated;


-- ═══════════════════════════════════════════════════════════════════════
-- 8. RETIRE THE NIGHTLY RESET — nothing auto-creates a range any more
--
-- token_ranges, allocate_token(), reset_daily_tokens(), default_token_start()
-- and default_token_end() are left DEFINED but DORMANT — this repo has no
-- precedent for dropping a table or function that holds/produced historical
-- data. token_ranges keeps every past night's global-counter record exactly
-- as it was; nothing reads it going forward.
--
-- The CRON JOB is the one thing that must stop: left scheduled, it would
-- silently insert a pointless token_ranges row every night forever, which
-- directly contradicts "nothing is auto-created" (decision #3).
-- ═══════════════════════════════════════════════════════════════════════

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    if exists (select 1 from cron.job where jobname = 'daily-token-reset') then
      perform cron.unschedule('daily-token-reset');
      raise notice 'daily-token-reset unscheduled: token ranges are now assigned per operator, per night, by an admin.';
    end if;
  end if;
end $$;


-- ═══════════════════════════════════════════════════════════════════════
-- 9. search_todays_cars — ORDER BY FIX
--
-- Reprinted from its current live definition (20260731094400), same
-- signature and same 13 returned columns, so CREATE OR REPLACE is legal.
-- The ONLY change is the ORDER BY: token_number is no longer a stand-in for
-- "most recently checked in" once tokens repeat within a day. parked_at is
-- what this list actually means to show newest-first — CheckIn.jsx's own
-- "recent 5" query already orders by parked_at.
-- ═══════════════════════════════════════════════════════════════════════

create or replace function public.search_todays_cars(
  p_query text default null,
  p_limit int  default 200
)
returns table (
  id               uuid,
  token_number     int,
  car_number       text,
  car_tier         text,
  guest_name       text,
  guest_name_hi    text,
  guest_phone      text,
  parking_location text,
  notes            text,
  status           text,
  parked_at        timestamptz,
  rating           text,
  review_comment   text,
  total_today      bigint
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_prop   uuid := public.my_property_id();
  v_limit  int  := least(greatest(coalesce(p_limit, 200), 1), 500);
  v_q      text := nullif(btrim(coalesce(p_query, '')), '');
  v_digits text;
  v_car    text;
  v_token  int;
  v_total  bigint;
begin
  if v_prop is null then
    raise exception 'PROPERTY_REQUIRED: no property is linked to your account';
  end if;

  v_digits := regexp_replace(coalesce(v_q, ''), '\D', '', 'g');

  -- Car numbers are stored without separators, so the term is stripped the
  -- same way or "DL8C AF" would never match "DL8CAF1234".
  v_car := upper(regexp_replace(coalesce(v_q, ''), '[^A-Za-z0-9]', '', 'g'));

  -- Only treat it as a token if it could actually BE one. Without the length
  -- guard, pasting a 20-digit string would overflow the int cast and turn a
  -- harmless typo into an error.
  v_token := case
    when v_digits <> '' and length(v_digits) <= 6 then v_digits::int
    else null
  end;

  -- The count is the same for every row and is returned on each one so the
  -- page can say "showing 200 of 964" without a second round trip.
  select count(*) into v_total
  from public.parked_vehicles v
  where v.property_id = v_prop and v.service_date = public.ist_today();

  return query
  select v.id, v.token_number, v.car_number, v.car_tier, v.guest_name,
         v.guest_name_hi, v.guest_phone, v.parking_location, v.notes, v.status,
         v.parked_at,
         -- The guest's rating for this visit, if they gave one. Reached through
         -- the TASK because reviews.task_id is what the button tap records —
         -- a review carries no vehicle_id. A no-show leaves several retrieval
         -- tasks and at most one is rated, so this looks across all of them.
         (select r.rating from public.reviews r
            join public.valet_tasks rt on rt.id = r.task_id
           where rt.vehicle_id = v.id
           order by r.created_at desc
           limit 1)::text,
         -- What the guest typed after rating Poor. See vehicle_records for why
         -- it is review_comment and not comment.
         (select r.comment from public.reviews r
            join public.valet_tasks rt on rt.id = r.task_id
           where rt.vehicle_id = v.id
           order by r.created_at desc
           limit 1)::text,
         v_total
  from public.parked_vehicles v
  where v.property_id  = v_prop
    and v.service_date = public.ist_today()
    and (
      v_q is null
      or (v_token is not null and v.token_number = v_token)
      -- `like`, not `ilike`: car_number is stored already uppercased and
      -- v_car is uppercased above, so a case-insensitive scan would only cost
      -- more for a comparison that cannot differ.
      or (v_car <> '' and v.car_number like '%' || v_car || '%')
      or v.guest_name ilike '%' || v_q || '%'
      -- The HINDI name is searchable too. An operator reading a Hindi screen
      -- will type what they see; without this, searching the name they were just
      -- shown would find nothing.
      or (v.guest_name_hi is not null and v.guest_name_hi ilike '%' || v_q || '%')
      or (length(v_digits) >= 4 and v.guest_phone like '%' || v_digits || '%')
    )
  -- CHANGED: was `order by v.token_number desc`. Tokens now repeat within a
  -- day, so parked_at is the only thing that still means "most recent".
  order by v.parked_at desc
  limit v_limit;
end $fn$;

revoke all    on function public.search_todays_cars(text, int) from public, anon;
grant execute on function public.search_todays_cars(text, int) to authenticated;


-- ═══════════════════════════════════════════════════════════════════════
-- 10. vehicle_records — ORDER BY FIX (a real pagination-stability bug)
--
-- Reprinted from its current live definition (20260731096200), same
-- signature and same 24 returned columns. Its own comment states its whole
-- purpose is a STABLE sort key so LIMIT/OFFSET paging cannot shuffle a row
-- between pages. token_number was the tie-break because it used to be
-- unique per (property_id, service_date) — under reuse it is not, so paging
-- through a busy night's export could now silently duplicate or skip rows.
-- v.id is the one column guaranteed unique per row, so it replaces
-- token_number as the tie-break (parked_at stays ahead of it purely so the
-- default "newest first" ordering still reads naturally to a human).
-- ═══════════════════════════════════════════════════════════════════════

create or replace function public.vehicle_records(
  p_from        date default null,
  p_to          date default null,
  p_property_id uuid default null,
  p_query       text default null,
  p_limit       int  default 100,
  p_offset      int  default 0
)
returns table (
  id               uuid,
  service_date     date,
  property_id      uuid,
  property_name    text,
  token_number     int,
  guest_name       text,
  guest_phone      text,
  car_number       text,
  car_tier         text,
  parking_location text,
  notes            text,
  status           text,
  auto_delivered   boolean,
  parked_at        timestamptz,
  delivered_at     timestamptz,
  retrievals       bigint,
  no_shows         bigint,
  parked_by        text,
  parked_by_hi     text,
  fetched_by       text,
  fetched_by_hi    text,
  rating           text,
  review_comment   text,
  total_count      bigint
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_role   text;
  v_mine   uuid;
  v_scope  uuid;
  v_to     date := coalesce(p_to, public.ist_today());
  v_from   date;
  v_limit  int  := least(greatest(coalesce(p_limit, 100), 1), 1000);
  v_offset int  := greatest(coalesce(p_offset, 0), 0);
  v_q      text := nullif(btrim(coalesce(p_query, '')), '');
  v_digits text;
  v_car    text;
  v_token  int;
  v_total  bigint;
begin
  -- A trusted server states the property it wants and is taken at its word.
  -- Answered FIRST because a service call has no auth.uid(), so the user_roles
  -- lookup below would refuse it. null keeps its meaning: every property.
  if public.is_service_call() then
    v_scope := p_property_id;
  else
    select ur.role, ur.property_id into v_role, v_mine
    from public.user_roles ur
    where ur.user_id = auth.uid() and ur.is_active = true;

    if v_role is null then
      raise exception 'FORBIDDEN: you are not signed in as an active user';
    end if;

    if v_role = 'system_admin' then
      v_scope := p_property_id;
    elsif v_role = 'valet_admin' then
      v_scope := v_mine;
    else
      raise exception 'FORBIDDEN: only an admin can see the records';
    end if;
  end if;

  v_from := coalesce(p_from, v_to - 29);

  if v_from > v_to then
    raise exception 'BAD_RANGE: the start date is after the end date';
  end if;

  v_digits := regexp_replace(coalesce(v_q, ''), '\D', '', 'g');
  v_car    := upper(regexp_replace(coalesce(v_q, ''), '[^A-Za-z0-9]', '', 'g'));
  v_token  := case when v_digits <> '' and length(v_digits) <= 6 then v_digits::int end;

  select count(*) into v_total
  from public.parked_vehicles v
  where v.service_date between v_from and v_to
    and (v_scope is null or v.property_id = v_scope)
    and (
      v_q is null
      or (v_token is not null and v.token_number = v_token)
      or (v_car <> '' and v.car_number like '%' || v_car || '%')
      or v.guest_name ilike '%' || v_q || '%'
      or (length(v_digits) >= 4 and v.guest_phone like '%' || v_digits || '%')
    );

  return query
  select
    v.id,
    v.service_date,
    v.property_id,
    p.name::text,
    v.token_number,
    v.guest_name,
    v.guest_phone,
    v.car_number,
    v.car_tier,
    v.parking_location,
    v.notes,
    v.status,
    -- AUTO-DELIVERED, not handed over. close_open_cars() stamps
    -- auto_closed_at half an hour before the token reset on anything still
    -- open, so the night's cars reach the reports. A boolean rather than the
    -- timestamp: every reader wants "was this a real hand-over", and the exact
    -- second is on parked_vehicles for anybody who needs it.
    (v.auto_closed_at is not null)::boolean,
    v.parked_at,
    (select max(t.completed_at) from public.valet_tasks t
      where t.vehicle_id = v.id and t.task_type = 'retrieval'
        and t.status = 'completed')::timestamptz,
    (select count(*) from public.valet_tasks t
      where t.vehicle_id = v.id and t.task_type = 'retrieval')::bigint,
    (select coalesce(sum(t.return_count), 0) from public.valet_tasks t
      where t.vehicle_id = v.id)::bigint,
    -- WHO PARKED IT. Read from the parking task, not from a column on this row.
    -- CheckIn assigns that task to whoever took the keys and nothing ever
    -- reassigns it, so this is the record.
    (select ur.name from public.valet_tasks t
       join public.user_roles ur on ur.id = t.assigned_operator_id
      where t.vehicle_id = v.id and t.task_type = 'parking'
      order by t.created_at
      limit 1)::text,
    (select ur.name_hi from public.valet_tasks t
       join public.user_roles ur on ur.id = t.assigned_operator_id
      where t.vehicle_id = v.id and t.task_type = 'parking'
      order by t.created_at
      limit 1)::text,
    -- WHO FETCHED IT. The LAST completed retrieval, because a no-show means
    -- there were several and the one that finished is the one that counts. A
    -- stored column would hold whoever was assigned first.
    (select ur.name from public.valet_tasks t
       join public.user_roles ur on ur.id = t.assigned_operator_id
      where t.vehicle_id = v.id and t.task_type = 'retrieval'
        and t.status = 'completed'
      order by t.completed_at desc
      limit 1)::text,
    (select ur.name_hi from public.valet_tasks t
       join public.user_roles ur on ur.id = t.assigned_operator_id
      where t.vehicle_id = v.id and t.task_type = 'retrieval'
        and t.status = 'completed'
      order by t.completed_at desc
      limit 1)::text,
    -- THE GUEST'S RATING for this visit, if they gave one.
    --
    -- Reached through the TASK, because reviews.task_id is what the guest's
    -- button tap records — there is no vehicle_id on a review. A car with a
    -- no-show has several retrieval tasks and at most one of them is rated,
    -- so this finds the rating on any of them rather than assuming which.
    --
    -- Newest first and limit 1: the unique index on reviews.task_id already
    -- makes a second rating per task impossible, but the ordering makes the
    -- result deterministic if that ever changes.
    (select r.rating from public.reviews r
       join public.valet_tasks rt on rt.id = r.task_id
      where rt.vehicle_id = v.id
      order by r.created_at desc
      limit 1)::text,
    -- What the guest TYPED after rating Poor. Only ever set for 'poor', so on
    -- every other row this is null — the rating is the summary and this is the
    -- reason, and a reason with no complaint attached would be confusing.
    --
    -- Named review_comment, not comment: `comment` is a Postgres keyword (it is
    -- the COMMENT ON statement) and a column called that has to be quoted
    -- everywhere it appears, forever.
    (select r.comment from public.reviews r
       join public.valet_tasks rt on rt.id = r.task_id
      where rt.vehicle_id = v.id
      order by r.created_at desc
      limit 1)::text,
    v_total::bigint
  from public.parked_vehicles v
  join public.properties p on p.id = v.property_id
  where v.service_date between v_from and v_to
    and (v_scope is null or v.property_id = v_scope)
    and (
      v_q is null
      or (v_token is not null and v.token_number = v_token)
      or (v_car <> '' and v.car_number like '%' || v_car || '%')
      or v.guest_name ilike '%' || v_q || '%'
      or (length(v_digits) >= 4 and v.guest_phone like '%' || v_digits || '%')
    )
  -- CHANGED: token_number replaced by v.id as the stable tie-break. parked_at
  -- stays ahead of it so "newest first" still reads naturally; v.id alone
  -- guarantees no two rows ever tie.
  order by v.service_date desc, v.parked_at desc, v.id desc
  limit v_limit offset v_offset;
end $fn$;

revoke all    on function public.vehicle_records(date, date, uuid, text, int, int)
  from public, anon;
grant  execute on function public.vehicle_records(date, date, uuid, text, int, int)
  to authenticated, service_role;

commit;


-- ═══════════════════════════════════════════════════════════════════════
-- VERIFY — every row should say PASS.
-- ═══════════════════════════════════════════════════════════════════════

with checks as (
  select 'operator_token_ranges exists' as item,
         to_regclass('public.operator_token_ranges') is not null as ok
  union all select 'RLS enabled on operator_token_ranges',
         (select relrowsecurity from pg_class
           where oid = 'public.operator_token_ranges'::regclass)
  union all select 'read policy exists',
         exists (select 1 from pg_policies
                  where schemaname = 'public' and tablename = 'operator_token_ranges'
                    and policyname = 'operator_token_ranges_read')
  union all select 'admin write policy exists',
         exists (select 1 from pg_policies
                  where schemaname = 'public' and tablename = 'operator_token_ranges'
                    and policyname = 'operator_token_ranges_admin_write')
  union all select 'old per-day token index is gone',
         not exists (select 1 from pg_indexes
                      where schemaname = 'public'
                        and indexname = 'parked_vehicles_token_per_day_key')
  union all select 'new active-token index exists (or data was flagged dirty)',
         exists (select 1 from pg_indexes
                  where schemaname = 'public'
                    and indexname = 'parked_vehicles_active_token_key')
         or exists (
           select 1 from public.parked_vehicles
           where status <> 'delivered'
           group by property_id, token_number having count(*) > 1
         )
  union all select 'allocate_operator_token exists',
         to_regprocedure('public.allocate_operator_token(uuid,uuid)') is not null
  union all select 'allocate_operator_token NOT callable by authenticated',
         not has_function_privilege('authenticated',
           'public.allocate_operator_token(uuid,uuid)', 'execute')
  union all select 'operator_check_in now calls allocate_operator_token',
         (select prosrc like '%allocate_operator_token%'
            from pg_proc where oid = 'public.operator_check_in(text,text,text,text,text)'::regprocedure)
  union all select 'operator_check_in no longer calls allocate_token',
         (select prosrc not like '%allocate_token(v_caller%'
            from pg_proc where oid = 'public.operator_check_in(text,text,text,text,text)'::regprocedure)
  union all select 'admin_assign_token_range exists',
         to_regprocedure('public.admin_assign_token_range(uuid,int,int,date,uuid)') is not null
  union all select 'admin_assign_token_range callable by authenticated',
         has_function_privilege('authenticated',
           'public.admin_assign_token_range(uuid,int,int,date,uuid)', 'execute')
  union all select 'admin_assign_token_range blocks overlap',
         (select prosrc like '%RANGE_OVERLAP%'
            from pg_proc where oid = 'public.admin_assign_token_range(uuid,int,int,date,uuid)'::regprocedure)
  union all select 'admin_token_roster exists',
         to_regprocedure('public.admin_token_roster(uuid,date)') is not null
  union all select 'admin_token_roster callable by authenticated',
         has_function_privilege('authenticated',
           'public.admin_token_roster(uuid,date)', 'execute')
  union all select 'search_todays_cars now orders by parked_at',
         (select prosrc like '%order by v.parked_at desc%'
            from pg_proc where oid = 'public.search_todays_cars(text,int)'::regprocedure)
  union all select 'vehicle_records now orders by parked_at, id',
         (select prosrc like '%order by v.service_date desc, v.parked_at desc, v.id desc%'
            from pg_proc where oid = 'public.vehicle_records(date,date,uuid,text,int,int)'::regprocedure)
  union all select 'daily-token-reset is unscheduled',
         not exists (select 1 from pg_extension where extname = 'pg_cron')
      or not exists (select 1 from cron.job where jobname = 'daily-token-reset')
)
select item, case when ok then 'PASS' else 'FAIL' end as result
from checks
order by result desc, item;
