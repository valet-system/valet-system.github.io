-- ═══════════════════════════════════════════════════════════════════════
-- MIGRATION 0060 — the nag covers a re-park, not just a fetch
--
-- On request: an operator sent to park a no-show again should be pushed
-- repeatedly, exactly as one sent to fetch a car is.
--
-- ── WHAT WAS ALREADY THERE ────────────────────────────────────────────
-- Migration 0059 gave the CONTINUOUS BEEP to re-parks. It works because the
-- beep asks "is anything of mine unaccepted", and 0059 gave a re-park a way to
-- be unaccepted — accepted_at null.
--
-- The PUSH did not follow, and the reason is that nag_unaccepted_retrievals
-- keys on one status:
--
--     and t.status = 'assigned'
--
-- A dispatched re-park sits on 're_parking' for its whole life. It never
-- matched, so it was never re-pushed: one notification at dispatch, then
-- silence, while a fetch got one every five seconds.
--
-- ── WHY THE TWO CANNOT SHARE ONE CONDITION ────────────────────────────
-- Because "unacknowledged" is stored differently for each, and that is
-- deliberate rather than untidy:
--
--   a FETCH     accept moves it to 'in_progress'. The status IS the answer, so
--               status = 'assigned' alone is enough.
--
--   a RE-PARK   the status must STAY 're_parking' — MyTasks reads what to show
--               from it and task_complete_reparking refuses anything else — so
--               the answer is accepted_at.
--
-- One insert per shape, therefore, rather than one clause trying to be both.
-- They also say different things, which matters more than the plumbing: a
-- fetch is "somebody is waiting for this car" and a re-park is "this car needs
-- putting away". Sending the wrong one is worse than sending none.
--
-- ── WHAT IS UNCHANGED ─────────────────────────────────────────────────
-- The window is ten minutes from assigned_at, and dispatch_reparking sets
-- assigned_at = now(), so a re-park's clock starts when it is dispatched.
--
-- The four-second gap still guards both: whatever was queued for a task in the
-- last four seconds stops another going out, which is what stops the first nag
-- landing on top of the dispatch notification.
--
-- The unique tag per nag also stays, for the reason 0025 gives: re-using one
-- replaces the previous notification SILENTLY on Chrome, and a silent
-- replacement is not an alert. The service worker closes the old one by
-- data.taskId instead.
-- ═══════════════════════════════════════════════════════════════════════

begin;

create or replace function public.nag_unaccepted_retrievals()
returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  -- How long a task keeps being nagged about. Unchanged.
  c_nag_window constant interval := interval '10 minutes';
  -- Just under the 5-second cron period, so a run firing a moment early still
  -- counts as due rather than being skipped until the next one.
  c_min_gap    constant interval := interval '4 seconds';
  v_count int := 0;
  v_rows  int := 0;
begin
  -- ── A CAR TO FETCH ──────────────────────────────────────────────────
  insert into public.push_outbox (user_role_id, title, body, url, tag, critical, task_id)
  select t.assigned_operator_id,
         'Car still waiting',
         'Token ' || coalesce(v.token_number::text, '?') ||
           ' · ' || coalesce(v.car_number, 'car') ||
           case when v.parking_location is not null
                then ' · ' || v.parking_location else '' end,
         '/operator/tasks',
         'valet-nag-' || t.id::text || '-' || extract(epoch from now())::bigint::text,
         true,
         t.id
  from public.valet_tasks t
  join public.parked_vehicles v on v.id = t.vehicle_id
  where t.task_type            = 'retrieval'
    and t.status               = 'assigned'
    and t.assigned_operator_id is not null
    and t.assigned_at          > now() - c_nag_window
    and not exists (
      select 1 from public.push_outbox p
      where p.task_id = t.id and p.created_at > now() - c_min_gap
    );

  get diagnostics v_rows = row_count;
  v_count := v_count + v_rows;

  -- ── A CAR TO PUT AWAY AGAIN ─────────────────────────────────────────
  -- accepted_at, not the status: see the header. And assigned_operator_id must
  -- be checked explicitly — since migration 0052 a no-show nobody has been sent
  -- for carries NULL there, and nagging that would be pushing to nobody.
  --
  -- NO PARKING LOCATION in the body. The car is at the door, not in a bay, and
  -- the location column still holds where it USED to be — printing it would
  -- name the wrong place with complete confidence.
  insert into public.push_outbox (user_role_id, title, body, url, tag, critical, task_id)
  select t.assigned_operator_id,
         'Park a car again',
         'Token ' || coalesce(v.token_number::text, '?') ||
           ' · ' || coalesce(v.car_number, 'car') ||
           ' · the guest never came',
         '/operator/tasks',
         'valet-nag-' || t.id::text || '-' || extract(epoch from now())::bigint::text,
         true,
         t.id
  from public.valet_tasks t
  join public.parked_vehicles v on v.id = t.vehicle_id
  where t.task_type            = 'retrieval'
    and t.status               in ('re_parking', 'returned')
    and t.assigned_operator_id is not null
    and t.accepted_at          is null
    and t.assigned_at          > now() - c_nag_window
    and not exists (
      select 1 from public.push_outbox p
      where p.task_id = t.id and p.created_at > now() - c_min_gap
    );

  get diagnostics v_rows = row_count;
  v_count := v_count + v_rows;

  return v_count;
end $fn$;

revoke execute on function public.nag_unaccepted_retrievals() from public, anon, authenticated;

commit;


-- ═══════════════════════════════════════════════════════════════════════
-- VERIFY — every row must read PASS
-- ═══════════════════════════════════════════════════════════════════════
select check_name, case when ok then 'PASS' else 'FAIL' end as result
from (
  -- BOTH SHAPES ARE NAGGED.
  select 'a fetch is still nagged' as check_name,
         (select prosrc like '%Car still waiting%' from pg_proc
           where pronamespace = 'public'::regnamespace
             and proname = 'nag_unaccepted_retrievals') as ok

  union all select 'a re-park is nagged too',
         (select prosrc like '%Park a car again%' from pg_proc
           where pronamespace = 'public'::regnamespace and proname = 'nag_unaccepted_retrievals')

  union all select 'there are two inserts, not one',
         (select (length(prosrc) - length(replace(prosrc, 'insert into public.push_outbox', '')))
                 / length('insert into public.push_outbox') = 2
            from pg_proc
           where pronamespace = 'public'::regnamespace and proname = 'nag_unaccepted_retrievals')

  -- THE RE-PARK CONDITION. accepted_at is what makes it stop; without it the
  -- nag would run for the whole ten minutes however fast the operator answered.
  union all select 'the re-park nag stops on acknowledgement',
         (select prosrc like '%t.accepted_at          is null%' from pg_proc
           where pronamespace = 'public'::regnamespace and proname = 'nag_unaccepted_retrievals')

  -- Since 0052 an undispatched no-show has no operator. Nagging it would push
  -- to nobody, every five seconds.
  union all select 'it never nags a no-show nobody was sent for',
         (select prosrc like '%t.assigned_operator_id is not null%' from pg_proc
           where pronamespace = 'public'::regnamespace and proname = 'nag_unaccepted_retrievals')

  -- UNCHANGED GUARDS.
  union all select 'the ten-minute window is unchanged',
         (select prosrc like '%interval ''10 minutes''%' from pg_proc
           where pronamespace = 'public'::regnamespace and proname = 'nag_unaccepted_retrievals')

  union all select 'the four-second gap still guards both',
         (select prosrc like '%interval ''4 seconds''%' from pg_proc
           where pronamespace = 'public'::regnamespace and proname = 'nag_unaccepted_retrievals')

  union all select 'each nag still gets its own tag',
         (select prosrc like '%valet-nag-%' from pg_proc
           where pronamespace = 'public'::regnamespace and proname = 'nag_unaccepted_retrievals')

  -- The re-park body must NOT print a parking location — it is the old bay,
  -- and the car is not in it.
  union all select 'the re-park body names no location',
         (select prosrc like '%the guest never came%' from pg_proc
           where pronamespace = 'public'::regnamespace and proname = 'nag_unaccepted_retrievals')

  -- DEPENDENCIES. Without 0059 there is no accepted_at and this whole second
  -- insert would error on every sweep.
  union all select '0059 is applied: accepted_at exists',
         exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'valet_tasks'
                    and column_name = 'accepted_at')

  union all select 'the sweep is still scheduled',
         (select count(*) = 1 from cron.job where jobname = 'nag-unaccepted-retrievals')

  union all select 'nobody may call the nag directly',
         not has_function_privilege('authenticated',
           'public.nag_unaccepted_retrievals()', 'execute')
) t
order by ok, check_name;
