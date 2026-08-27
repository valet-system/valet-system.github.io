-- ═══════════════════════════════════════════════════════════════════════
-- MIGRATION 0054 — "cars parked" means TODAY, like everything else
--
-- Reported: Parking spaces showed 14 cars parked while the Dashboard showed 4
-- cars still on site. Both numbers were correct; they were answering different
-- questions, and only one of them was the question being asked.
--
-- ── WHAT THE THREE SCREENS WERE DOING ─────────────────────────────────
--   Dashboard        .eq('service_date', today)      -> today
--   Car Status       .eq('service_date', istToday()) -> today
--   Parking spaces   no date filter at all           -> since the beginning
--
-- The whole app is built on a service day: it rolls at 05:30 IST, tokens reset
-- nightly, and both other screens are scoped to it. This one function was the
-- exception.
--
-- ── WHY IT WAS BUILT THAT WAY, AND WHY THAT REASONING FAILS ───────────
-- The intent was live OCCUPANCY, and for occupancy all-time looks right: a car
-- left overnight is still physically in the bay, so it should still be counted
-- the next morning.
--
-- The flaw is that nothing ever closes a car out. reset_daily_tokens() — the
-- only nightly job — creates a token range and touches no vehicle. So a record
-- that never reaches 'delivered' stays 'parked' for ever:
--
--   * the operator forgot to mark the hand-over
--   * the app was closed mid-flow
--   * the guest took the keys off the desk themselves
--
-- Every one of those adds 1 to this count PERMANENTLY. It is a counter that
-- only rises. At even a 1% miss rate the number drifts past anything useful
-- within months, and there is no mechanism that could ever bring it back down.
--
-- An occupancy count with no close-out is not an occupancy count.
--
-- ── WHAT THIS COSTS ───────────────────────────────────────────────────
-- A car genuinely left overnight reads as 0 the next morning. Worth stating,
-- but Car Status already behaves that way, so the app has assumed a daily cycle
-- from the start — this makes one straggler agree with it rather than changing
-- what the system believes.
--
-- ── WHAT THIS ALSO FIXES, WITHOUT A CLEANUP ───────────────────────────
-- No UPDATE is needed anywhere. Stale rows from previous days simply stop being
-- counted the moment the filter exists. Nothing is deleted and no history is
-- rewritten — those cars are still on Records with their real status, and a
-- report about last Tuesday still finds them.
--
-- ── BOTH CALLERS MOVE TOGETHER ────────────────────────────────────────
-- This function feeds two screens:
--
--   Spaces.jsx        the admin's "Cars parked" tile and per-place counts
--   SpacePicker.jsx   the chips an operator taps when choosing where to park
--
-- Both wanted today. An operator picking a bay needs to know what is there on
-- this shift, not a running total carrying ghosts from last month.
--
-- The body below was extracted from 0035 programmatically with ONE line added,
-- not retyped.
-- ═══════════════════════════════════════════════════════════════════════

begin;

create or replace function public.parking_space_usage(p_property_id uuid default null)
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
        and v.status in ('parked', 'returned', 're_parking')
        -- ADDED BY 0054. Without it this counted every car the system had ever
        -- believed was in a bay, for all time. See that migration's header.
        and v.service_date = public.ist_today())::bigint,
    s.is_active::boolean,
    s.sort_order::int
  from public.parking_spaces s
  where s.property_id = v_prop
  order by s.sort_order, s.label;
end $fn$;

revoke all    on function public.parking_space_usage(uuid) from public, anon;
grant execute on function public.parking_space_usage(uuid) to authenticated;

commit;


-- ═══════════════════════════════════════════════════════════════════════
-- VERIFY — every row must read PASS
-- ═══════════════════════════════════════════════════════════════════════
select check_name, case when ok then 'PASS' else 'FAIL' end as result
from (
  -- THE CHANGE. Comments stripped: the body now explains itself and names the
  -- function it calls, so a plain `like` would pass on the prose alone.
  select 'the count is scoped to the service day' as check_name,
         (select regexp_replace(prosrc, '--.*', '', 'gn') like '%ist_today()%'
            from pg_proc
           where pronamespace = 'public'::regnamespace
             and proname = 'parking_space_usage') as ok

  union all select 'it uses ist_today, not current_date',
         (select regexp_replace(prosrc, '--.*', '', 'gn') not like '%current_date%'
            from pg_proc
           where pronamespace = 'public'::regnamespace and proname = 'parking_space_usage')

  -- Nothing else may have been lost in the reprint.
  union all select 'it still matches on the label, not label_hi',
         (select prosrc like '%lower(btrim(s.label))%' from pg_proc
           where pronamespace = 'public'::regnamespace and proname = 'parking_space_usage')

  union all select 'it still counts all three on-site statuses',
         (select prosrc like '%''parked'', ''returned'', ''re_parking''%' from pg_proc
           where pronamespace = 'public'::regnamespace and proname = 'parking_space_usage')

  union all select 'a valet_admin still cannot ask about another property',
         (select prosrc like '%that property is not yours%' from pg_proc
           where pronamespace = 'public'::regnamespace and proname = 'parking_space_usage')

  union all select 'it still returns all six columns',
         (select pg_get_function_result(oid)
                 = 'TABLE(id uuid, label text, label_hi text, in_use bigint, is_active boolean, sort_order integer)'
            from pg_proc
           where pronamespace = 'public'::regnamespace and proname = 'parking_space_usage')

  -- ist_today must exist, or the filter is a hard error at call time.
  union all select 'ist_today exists',
         to_regprocedure('public.ist_today()') is not null

  -- The service day is 05:30 IST, not midnight. If this ever fails, the whole
  -- app's idea of "today" has moved and this count moves with it.
  union all select 'the service day still starts at 05:30 IST',
         (select prosrc like '%5 hours 30 minutes%' from pg_proc
           where pronamespace = 'public'::regnamespace and proname = 'ist_today')

  union all select 'staff may call it',
         has_function_privilege('authenticated', 'public.parking_space_usage(uuid)', 'execute')

  union all select 'anon may NOT call it',
         not has_function_privilege('anon', 'public.parking_space_usage(uuid)', 'execute')
) t
order by ok, check_name;
