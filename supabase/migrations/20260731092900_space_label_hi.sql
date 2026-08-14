-- ═══════════════════════════════════════════════════════════════════════
-- 0029 — A PARKING PLACE CAN HAVE A HINDI NAME
--
-- The operator's chips, the "Today's cars" list and the push notifications all
-- showed "back side" on a Hindi screen, because a place had exactly one name and
-- it was whatever the admin typed. Every other label in the app translates; the
-- one an operator reads two hundred times a shift did not.
--
-- ══ WHY A SECOND COLUMN AND NOT A TRANSLATION AT DISPLAY TIME ══
--
-- These are NAMES, not words. "back side", "L2 B4", "Behind the kitchen" — a
-- dictionary cannot help, and autoTranslate() deliberately refuses to touch
-- data. The admin has to be able to write the Hindi and, more importantly, to
-- CORRECT it: transliteration gets Indian place names wrong often enough that a
-- read-only guess would be worse than English.
--
-- Same shape as user_roles.name_hi in migration 0026, on purpose. One pattern
-- for "a name that has a Hindi spelling", not two.
--
-- ══ WHY parked_vehicles IS NOT TOUCHED ══
--
-- parking_location is free text copied at park time and deliberately not a
-- foreign key (migration 0016). It would have been easy to add a matching
-- parking_location_hi and fill it in the park RPCs — and it would have been
-- wrong: every row already parked would keep the old spelling for ever, and
-- fixing a typo in the admin table would not fix the history.
--
-- Instead the client maps the stored text back to a place by label, exactly as
-- parking_space_usage() already does. Correct the Hindi once and every screen,
-- past and present, shows the correction.
--
-- Safe to re-run.
-- ═══════════════════════════════════════════════════════════════════════

begin;

-- ═══════════════════════════════════════════════════════════════════════
-- 1. The column
--
-- NULLABLE, and that is the design: NULL means "no Hindi spelling yet", and
-- every reader falls back to `label`. Existing places keep working untouched,
-- and an admin who never opens this screen loses nothing.
-- ═══════════════════════════════════════════════════════════════════════

alter table public.parking_spaces
  add column if not exists label_hi text;

comment on column public.parking_spaces.label_hi is
  'The place name in Devanagari. NULL = show `label`. Written by the admin, usually from transliteration they can then correct.';


-- ═══════════════════════════════════════════════════════════════════════
-- 2. parking_space_usage() — now returns it
--
-- DROPPED first. A function with a RETURNS TABLE cannot gain a column via
-- CREATE OR REPLACE: Postgres refuses with 42P13 because the row type changes.
-- ═══════════════════════════════════════════════════════════════════════

drop function if exists public.parking_space_usage();

create function public.parking_space_usage()
returns table (
  id         uuid,
  label      text,
  label_hi   text,
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
    -- correct: this feeds one property's chips.
    return;
  end if;

  return query
  select
    s.id::uuid,
    s.label::text,
    s.label_hi::text,
    s.capacity::int,
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

revoke all    on function public.parking_space_usage() from public, anon;
grant execute on function public.parking_space_usage() to authenticated;


-- ═══════════════════════════════════════════════════════════════════════
-- 3. admin_set_space_label_hi — the only way to write it
--
-- A separate small RPC rather than an argument on add_parking_spaces, for the
-- same reason admin_set_staff_name_hi exists separately: add_parking_spaces is
-- a working function with role checks, de-duplication and sort ordering, and
-- restating it to thread one more argument through is where a step goes
-- missing. This does one thing.
--
-- Also: the Hindi is set AFTER the label exists, because it comes from
-- transliterating that label. Bulk paste adds twenty places at once; the client
-- then fills in twenty Hindi names.
-- ═══════════════════════════════════════════════════════════════════════

create or replace function public.admin_set_space_label_hi(
  p_space_id uuid,
  p_label_hi text
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_role text;
  v_prop uuid;
  v_hi   text := nullif(btrim(coalesce(p_label_hi, '')), '');
begin
  select ur.role, ur.property_id into v_role, v_prop
  from public.user_roles ur
  where ur.user_id = auth.uid() and ur.is_active = true;

  if v_role is null then
    raise exception 'FORBIDDEN: you are not signed in as an active user';
  end if;
  if v_role not in ('valet_admin', 'system_admin') then
    raise exception 'FORBIDDEN: only an admin can rename a place';
  end if;

  if length(v_hi) > 40 then
    raise exception 'BAD_NAME: keep the Hindi name short';
  end if;

  -- The property test is the access control. A valet_admin may only touch their
  -- own site's places; a system_admin has no property and may touch any.
  update public.parking_spaces s
     set label_hi = v_hi
   where s.id = p_space_id
     and (v_role = 'system_admin' or s.property_id = v_prop);

  if not found then
    raise exception 'NOT_FOUND: that place does not exist at your property';
  end if;
end $fn$;

revoke all    on function public.admin_set_space_label_hi(uuid, text) from public, anon;
grant execute on function public.admin_set_space_label_hi(uuid, text) to authenticated;

commit;


-- ═══════════════════════════════════════════════════════════════════════
-- VERIFY — every row must read PASS
-- ═══════════════════════════════════════════════════════════════════════
select check_name, case when ok then 'PASS' else 'FAIL' end as result
from (
  select 'parking_spaces.label_hi exists' as check_name,
         exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'parking_spaces'
                    and column_name = 'label_hi') as ok

  union all select 'it is nullable, so existing places keep working',
         (select is_nullable = 'YES' from information_schema.columns
           where table_schema = 'public' and table_name = 'parking_spaces'
             and column_name = 'label_hi')

  union all select 'parking_space_usage returns label_hi',
         exists (select 1 from information_schema.routines r
                  join information_schema.parameters p
                    on p.specific_name = r.specific_name
                 where r.routine_schema = 'public'
                   and r.routine_name = 'parking_space_usage'
                   and p.parameter_name = 'label_hi')

  union all select 'the occupancy count still matches on label, never label_hi',
         (select prosrc like '%btrim(s.label)%' and prosrc not like '%btrim(s.label_hi)%'
            from pg_proc where pronamespace = 'public'::regnamespace
             and proname = 'parking_space_usage')

  union all select 'admin_set_space_label_hi exists',
         to_regprocedure('public.admin_set_space_label_hi(uuid,text)') is not null

  union all select 'only an admin may call it',
         (select prosrc like '%only an admin can rename a place%'
            from pg_proc where pronamespace = 'public'::regnamespace
             and proname = 'admin_set_space_label_hi')

  union all select 'anon cannot call it',
         not has_function_privilege('anon', 'public.admin_set_space_label_hi(uuid,text)', 'execute')

  -- add_parking_spaces was deliberately NOT rewritten. If this fails, someone
  -- has restated it and its role checks and de-duplication need re-reading.
  union all select 'kept: add_parking_spaces is untouched and still one function',
         (select count(*) = 1 from pg_proc
           where pronamespace = 'public'::regnamespace and proname = 'add_parking_spaces')
) t
order by check_name;
