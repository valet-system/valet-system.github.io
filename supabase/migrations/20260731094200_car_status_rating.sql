-- ═══════════════════════════════════════════════════════════════════════
-- MIGRATION 0042 — the guest's rating on the valet admin's Car Status
--
-- Migration 0040 put the rating on the system admin's Records screen. But the
-- person who can actually do something about a bad rating is the valet admin —
-- they are the one standing at that property, and Car Status is the screen they
-- keep open. A rating they never see is a rating nobody acts on.
--
-- ── WHY NOT JUST SHOW THEM Reviews.jsx ────────────────────────────────
-- That screen exists and is scoped to their property, so it would work. But it
-- is a second place to look, and the question "how did THIS car go" is asked
-- while looking at the car — not on a separate report. One column on a screen
-- already being read beats a page nobody opens.
--
-- ── WHY THE FUNCTION IS DROPPED AND NOT REPLACED ──────────────────────
-- A new returned column changes the RETURNS TABLE row type, which Postgres
-- refuses on CREATE OR REPLACE with 42P13. It has to go and come back.
--
-- Everything except the two rating lines is migration 0030's text unchanged:
-- the same property scoping, the same search parsing, the same ordering.
--
-- ── ONE THING THIS DOES NOT CHANGE ────────────────────────────────────
-- Car Status is a TODAY screen — search_todays_cars filters on ist_today(). So
-- a rating shows only while the car is still on today's list. Yesterday's
-- ratings live on Records and in Reviews, not here. That is deliberate: this
-- screen is for the shift in progress.
-- ═══════════════════════════════════════════════════════════════════════

begin;

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
  rating           text,
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
  select 'search_todays_cars exists' as check_name,
         to_regprocedure('public.search_todays_cars(text,int)') is not null as ok

  -- 13 now, not 12. A miscount means a column was lost in the rewrite, and
  -- losing one shifts every field after it on every card.
  union all select 'it returns 13 columns',
         (select count(*) = 13 from unnest(
            (select proallargtypes from pg_proc
              where pronamespace = 'public'::regnamespace
                and proname = 'search_todays_cars')) with ordinality o(t, n)
           where n > 2)

  union all select 'the rating comes from reviews',
         (select prosrc like '%public.reviews%' from pg_proc
           where pronamespace = 'public'::regnamespace
             and proname = 'search_todays_cars')

  -- The three things the rewrite must not have dropped. Losing the property
  -- scope would show one admin another property's cars.
  union all select 'it is still scoped to the caller property',
         (select prosrc like '%v.property_id%' from pg_proc
           where pronamespace = 'public'::regnamespace
             and proname = 'search_todays_cars')

  union all select 'it is still scoped to today',
         (select prosrc like '%ist_today()%' from pg_proc
           where pronamespace = 'public'::regnamespace
             and proname = 'search_todays_cars')

  union all select 'search still matches the Hindi name',
         (select prosrc like '%guest_name_hi%' from pg_proc
           where pronamespace = 'public'::regnamespace
             and proname = 'search_todays_cars')

  union all select 'newest token still first',
         (select prosrc like '%order by v.token_number desc%' from pg_proc
           where pronamespace = 'public'::regnamespace
             and proname = 'search_todays_cars')

  union all select 'signed-in staff may still run it',
         has_function_privilege('authenticated',
           'public.search_todays_cars(text,int)', 'execute')

  union all select 'anon still may NOT run it',
         not has_function_privilege('anon',
           'public.search_todays_cars(text,int)', 'execute')
) t
order by ok, check_name;
