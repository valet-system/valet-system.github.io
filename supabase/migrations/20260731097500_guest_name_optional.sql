-- ═══════════════════════════════════════════════════════════════════════
-- MIGRATION 0075 — THE GUEST NAME IS OPTIONAL
--
--   >>> RUN THIS IN THE SUPABASE SQL EDITOR. <<<
--
-- Safe to run more than once.
--
--
-- WHAT CHANGES
--
-- operator_check_in() stops raising BAD_NAME when the guest name is blank.
-- That is the only change. Everything else in the function is byte-for-byte
-- what migration 0071 left there.
--
--
-- WHY
--
-- The phone and the plate are what the system actually runs on: the phone is
-- who gets the WhatsApp, the plate is what identifies the car to anyone
-- standing in the car park. The name is a courtesy on top of those, and at a
-- busy porch it is the field most likely to be a guess — an operator who did
-- not catch it types "sir", or a spelling nobody can use afterwards. A
-- required field that gets filled with noise is worse than an empty one,
-- because the noise cannot be told apart from a real answer.
--
--
-- NOTHING DOWNSTREAM BREAKS, AND THAT WAS ALREADY TRUE
--
-- parked_vehicles.guest_name has been nullable since the initial schema —
-- this raise was the only thing keeping it filled. Every reader was already
-- written for a missing name:
--
--   * wa-dispatch's guestLabel() already falls back to "Guest", so the
--     WhatsApp greeting reads "Hi Guest," rather than "Hi ,".
--   * Car status, the admin dashboard and Today's cars already render
--     t('common.guest') when the name is empty.
--   * My Tasks, the check-in panel and the dashboard's delivered strip
--     already hide the line entirely when there is no name.
--   * search_todays_cars matches guest_name with ILIKE, and a NULL simply
--     does not match — a car with no name is still found by its token, its
--     plate or its phone.
--
-- So there is no backfill and no default. A blank name stays NULL, which is
-- what every one of those readers is already looking for.
--
--
-- WHY THE WHOLE FUNCTION IS REPRINTED
--
-- This repo's convention: CREATE OR REPLACE in a NEW file, never edit an old
-- migration — the same way operator_check_in was already re-declared by 0071,
-- and get_available_operators and vehicle_records before it. The signature
-- and return type are unchanged, so CREATE OR REPLACE is legal and every
-- existing grant carries forward untouched.
-- ═══════════════════════════════════════════════════════════════════════

begin;

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
  -- v_name still normalises '' and '   ' to NULL. That matters more now, not
  -- less: NULL is the one value every reader downstream already treats as
  -- "no name", and an empty string would slip past all of them and render as
  -- a blank line where a name should be.
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
  -- ▼▼▼ the one change from 0071: there WAS a BAD_NAME raise here ▼▼▼
  --
  --   if v_name is null then
  --     raise exception 'BAD_NAME: enter the guest name';
  --   end if;
  --
  -- Gone. The phone and the plate below are still required, because those
  -- two are what a car is actually found and contacted by.

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

commit;


-- ═══════════════════════════════════════════════════════════════════════
-- VERIFY — every row must read PASS
-- ═══════════════════════════════════════════════════════════════════════
select check_name, case when ok then 'PASS' else 'FAIL' end as result
from (
  select 'operator_check_in still exists' as check_name,
         to_regprocedure('public.operator_check_in(text,text,text,text,text)') is not null as ok

  -- ── COMMENTS ARE STRIPPED BEFORE EVERY MATCH BELOW ──────────────────
  --
  -- pg_proc.prosrc is the function's source text, COMMENTS AND ALL. The
  -- first version of this block matched prosrc directly and reported FAIL,
  -- because the body above quotes the removed line in a comment so a reader
  -- can see what went — the check was finding the comment.
  --
  -- It cuts the other way too: 'BAD_PHONE is still enforced' would have read
  -- PASS off a mention in a comment long after the real check was deleted.
  -- So `--` to end of line comes out first, and every row below asserts
  -- against code that actually runs.

  -- The point of the whole migration: no BAD_NAME left in the body.
  union all select 'BAD_NAME is gone from the body',
         (select regexp_replace(prosrc, '--[^\n]*', '', 'g') not ilike '%raise exception ''BAD_NAME%'
            from pg_proc
           where oid = 'public.operator_check_in(text,text,text,text,text)'::regprocedure)

  -- ...while the two checks that DO matter are still in it. Without these
  -- rows, deleting the wrong three lines would still read PASS above.
  union all select 'BAD_PHONE is still enforced',
         (select regexp_replace(prosrc, '--[^\n]*', '', 'g') ilike '%BAD_PHONE%'
            from pg_proc
           where oid = 'public.operator_check_in(text,text,text,text,text)'::regprocedure)

  union all select 'BAD_CAR is still enforced',
         (select regexp_replace(prosrc, '--[^\n]*', '', 'g') ilike '%BAD_CAR%'
            from pg_proc
           where oid = 'public.operator_check_in(text,text,text,text,text)'::regprocedure)

  -- 0071's per-operator allocation must survive this reprint. Reprinting a
  -- function is exactly how an older version gets restored by accident.
  union all select 'still allocates from the operator range',
         (select regexp_replace(prosrc, '--[^\n]*', '', 'g') ilike '%allocate_operator_token%'
            from pg_proc
           where oid = 'public.operator_check_in(text,text,text,text,text)'::regprocedure)

  -- The column was always nullable; this confirms nothing ever added a
  -- NOT NULL behind the raise.
  union all select 'guest_name is nullable',
         (select is_nullable = 'YES' from information_schema.columns
           where table_schema = 'public'
             and table_name   = 'parked_vehicles'
             and column_name  = 'guest_name')

  -- Grants survive CREATE OR REPLACE, but this is the row that proves it
  -- rather than assuming it.
  union all select 'staff can still check a car in',
         has_function_privilege('authenticated',
           'public.operator_check_in(text,text,text,text,text)', 'execute')
) t
order by ok, check_name;
