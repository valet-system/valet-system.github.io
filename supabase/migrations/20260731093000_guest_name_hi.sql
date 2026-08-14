-- ═══════════════════════════════════════════════════════════════════════
-- 0030 — A GUEST'S NAME HAS A HINDI SPELLING, WRITTEN WITHOUT ASKING
--
-- On a Hindi screen every label was Hindi and the guest's name was not. Same
-- gap that migration 0026 closed for staff and 0029 closed for parking places;
-- this is the last one.
--
-- ══ WHY IT IS SILENT, AND WHY THAT IS THE RIGHT TRADE ══
--
-- A staff name is typed once by an admin who can sit and check it. A parking
-- place is typed once by an admin. A GUEST name is typed by an operator at the
-- porch, with the guest standing there and a queue behind them — check-in is the
-- hottest path in the app and the one place a second of delay is felt.
--
-- So nothing is added to that screen. The operator types the name in English as
-- they always did, check-in completes exactly as fast as before, and the Hindi
-- spelling is filled in AFTERWARDS by a second call that nobody waits for.
--
-- The cost is honest: the operator never sees what was generated, so a wrong
-- transliteration is not caught. That is acceptable here and would not be for
-- staff — a guest name is read once, to match a person to a car, and the English
-- is right there beside it on every screen that matters.
--
-- ══ WHY operator_check_in IS NOT TOUCHED ══
--
-- It allocates a token, creates the vehicle and opens the parking task in one
-- transaction — the piece that guarantees a burnt token cannot exist without a
-- car behind it. Threading one more argument through it to save a round trip is
-- not worth restating that function, and transliteration is a network call: doing
-- it BEFORE check-in would slow down the exact thing this design protects.
--
-- ══ NO BACKFILL, DELIBERATELY ══
--
-- 0029 backfills parking places because there are a handful of them and they
-- live for ever. Guest names arrive by the hundred every day and the list
-- empties at 05:30 IST. A sweep would mean hundreds of transliteration requests
-- to fix rows that are about to age out on their own. New check-ins get a Hindi
-- name; today's existing rows keep showing English until the service day turns.
--
-- Safe to re-run.
-- ═══════════════════════════════════════════════════════════════════════

begin;

-- ═══════════════════════════════════════════════════════════════════════
-- 1. The column
--
-- NULLABLE. NULL means "no Hindi spelling", and every reader falls back to
-- guest_name — so a check-in made while offline, or one whose transliteration
-- failed, is completely normal and shows English.
-- ═══════════════════════════════════════════════════════════════════════

alter table public.parked_vehicles
  add column if not exists guest_name_hi text;

comment on column public.parked_vehicles.guest_name_hi is
  'The guest name in Devanagari, transliterated in the background after check-in. NULL = show guest_name.';


-- ═══════════════════════════════════════════════════════════════════════
-- 2. set_guest_name_hi — the only way to write it
--
-- An OPERATOR may call this, not just an admin, because the operator is the one
-- who just checked the car in. Scoped to their own property, so it cannot be
-- used to rewrite names at another site.
-- ═══════════════════════════════════════════════════════════════════════

create or replace function public.set_guest_name_hi(
  p_vehicle_id uuid,
  p_name_hi    text
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_role text;
  v_prop uuid;
  v_hi   text := nullif(btrim(coalesce(p_name_hi, '')), '');
begin
  select ur.role, ur.property_id into v_role, v_prop
  from public.user_roles ur
  where ur.user_id = auth.uid() and ur.is_active = true;

  if v_role is null then
    raise exception 'FORBIDDEN: you are not signed in as an active user';
  end if;

  if length(v_hi) > 60 then
    raise exception 'BAD_NAME: keep the Hindi name short';
  end if;

  -- The property test is the access control. A system_admin has no property of
  -- their own and may touch any row; everyone else is confined to their site.
  update public.parked_vehicles v
     set guest_name_hi = v_hi
   where v.id = p_vehicle_id
     and (v_role = 'system_admin' or v.property_id = v_prop);

  -- No exception when nothing matched. This runs in the background after a
  -- check-in and nobody is watching its result — a car that has since been
  -- handed over and pruned is not an error worth raising.
end $fn$;

revoke all    on function public.set_guest_name_hi(uuid, text) from public, anon;
grant execute on function public.set_guest_name_hi(uuid, text) to authenticated;


-- ═══════════════════════════════════════════════════════════════════════
-- 3. search_todays_cars — now returns it
--
-- DROPPED first: a RETURNS TABLE function cannot gain a column through CREATE
-- OR REPLACE, Postgres refuses with 42P13 because the row type changes.
--
-- Restated from migration 0012, which is its latest definition. Everything it
-- did, it still does — the search behaviour is asserted in the VERIFY block
-- below, because restating a body is exactly where a step goes missing.
-- ═══════════════════════════════════════════════════════════════════════

drop function if exists public.search_todays_cars(text, int);

create function public.search_todays_cars(
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
         v.parked_at, v_total
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
  order by v.token_number desc
  limit v_limit;
end $fn$;

revoke all    on function public.search_todays_cars(text, int) from public, anon;
grant execute on function public.search_todays_cars(text, int) to authenticated;

commit;


-- ═══════════════════════════════════════════════════════════════════════
-- VERIFY — every row must read PASS
-- ═══════════════════════════════════════════════════════════════════════
select check_name, case when ok then 'PASS' else 'FAIL' end as result
from (
  select 'parked_vehicles.guest_name_hi exists' as check_name,
         exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'parked_vehicles'
                    and column_name = 'guest_name_hi') as ok

  union all select 'it is nullable, so a failed transliteration is survivable',
         (select is_nullable = 'YES' from information_schema.columns
           where table_schema = 'public' and table_name = 'parked_vehicles'
             and column_name = 'guest_name_hi')

  union all select 'set_guest_name_hi exists',
         to_regprocedure('public.set_guest_name_hi(uuid,text)') is not null

  union all select 'an operator can call it, not only an admin',
         (select prosrc not like '%only an admin%' from pg_proc
           where pronamespace = 'public'::regnamespace and proname = 'set_guest_name_hi')

  union all select 'it is confined to the caller''s own property',
         (select prosrc like '%v.property_id = v_prop%' from pg_proc
           where pronamespace = 'public'::regnamespace and proname = 'set_guest_name_hi')

  union all select 'anon cannot call it',
         not has_function_privilege('anon', 'public.set_guest_name_hi(uuid,text)', 'execute')

  union all select 'exactly one search_todays_cars, and it returns guest_name_hi',
         (select count(*) = 1 from pg_proc
           where pronamespace = 'public'::regnamespace and proname = 'search_todays_cars')
         and exists (select 1 from information_schema.routines r
                      join information_schema.parameters p
                        on p.specific_name = r.specific_name
                     where r.routine_schema = 'public'
                       and r.routine_name = 'search_todays_cars'
                       and p.parameter_name = 'guest_name_hi')

  -- Everything 0012's version did. Restating a body is where a step goes missing.
  union all select 'kept: search still matches a token number',
         (select prosrc like '%v.token_number = v_token%' from pg_proc
           where pronamespace = 'public'::regnamespace and proname = 'search_todays_cars')
  union all select 'kept: search still matches a car number, stripped and uppercased',
         (select prosrc like '%v.car_number like%' from pg_proc
           where pronamespace = 'public'::regnamespace and proname = 'search_todays_cars')
  union all select 'kept: search still matches a phone, only from 4 digits up',
         (select prosrc like '%length(v_digits) >= 4%' from pg_proc
           where pronamespace = 'public'::regnamespace and proname = 'search_todays_cars')
  union all select 'kept: the 6-digit guard against an int overflow',
         (select prosrc like '%length(v_digits) <= 6%' from pg_proc
           where pronamespace = 'public'::regnamespace and proname = 'search_todays_cars')
  union all select 'kept: still scoped to this property and this service day',
         (select prosrc like '%v.service_date = public.ist_today()%' from pg_proc
           where pronamespace = 'public'::regnamespace and proname = 'search_todays_cars')
  union all select 'kept: total_today is still returned on every row',
         (select prosrc like '%v_total%' from pg_proc
           where pronamespace = 'public'::regnamespace and proname = 'search_todays_cars')

  union all select 'new: the Hindi name is searchable too',
         (select prosrc like '%v.guest_name_hi ilike%' from pg_proc
           where pronamespace = 'public'::regnamespace and proname = 'search_todays_cars')
) t
order by check_name;
