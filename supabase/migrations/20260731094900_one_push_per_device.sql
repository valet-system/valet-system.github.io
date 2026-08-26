-- ═══════════════════════════════════════════════════════════════════════
-- MIGRATION 0049 — one notification per device, and a faster nag
--
-- Two reported problems, one file:
--
--   1. Every push arrives THREE times on the phone.
--   2. The dispatch nag should repeat every 5 seconds, not every 30.
--
-- ═══════════════════════════════════════════════════════════════════════
-- PART 1 — WHY THREE
-- ═══════════════════════════════════════════════════════════════════════
-- Not the nag, and it is worth showing why before changing anything:
--
--   * "Car re-parked" arrives three times too, and that push comes from a
--     single trigger INSERT with no nag anywhere near it.
--   * nag_unaccepted_retrievals() refuses to queue anything for a task that
--     already had a row in the last 25 seconds, so it physically cannot
--     produce three notifications in one burst.
--
-- So the duplication is not in what gets QUEUED. It is in how one queued row
-- is DELIVERED. push-send does this (functions/push-send/index.ts):
--
--     for (const sub of subs)  ->  one send per subscription row
--
-- which is correct — a person may hold a phone and a tablet. The bug is that
-- one PHONE can own three rows.
--
-- ── HOW ONE PHONE ACCUMULATES THREE ROWS ──────────────────────────────
-- save_push_subscription() upserts `on conflict (endpoint)`. Endpoint is the
-- only key, and nothing ever removes a person's OLDER endpoints. But a browser
-- issues a NEW endpoint when:
--
--   * the PWA is reinstalled
--   * site data is cleared
--   * the push service rotates it (Chrome does this on some updates)
--
-- Each of those leaves the previous row behind, still holding valid keys. The
-- push service keeps accepting the old endpoint for a while rather than
-- answering 410 — so push-send's "delete on 404/410" cleanup never fires, and
-- the phone shows one notification per stale row.
--
-- Three rows is what two of those events looks like.
--
-- ── THE FIX, AND WHY IT IS NOT "MATCH THE DEVICE" ─────────────────────
-- There is no device id in a web push subscription. Nothing in the endpoint
-- identifies the machine. So the two available signals are used instead:
--
--   user_agent    the same string means the same browser on the same phone.
--                 Imperfect: it changes when Chrome updates, which is exactly
--                 how the third row got there. It still catches the common
--                 case, and it never merges two DIFFERENT devices because
--                 their UA strings differ.
--
--   last_seen_at  refreshed every time the app opens (AppShell calls
--                 subscribeToPush on mount, and pushApi re-saves even when the
--                 endpoint is unchanged). Only the CURRENT endpoint gets
--                 refreshed, so a superseded one goes stale on its own.
--
-- Together they converge: the same-UA rule removes a reinstall immediately,
-- and the staleness rule removes a Chrome-update leftover.
--
-- ── WHY THE STALENESS WINDOW IS TWO DAYS AND NOT SEVEN ────────────────
-- Seven was the first number here and it was too slow to fix the reported bug.
-- Chrome rotates its endpoint on some updates, so the three rows on that phone
-- have three DIFFERENT user_agent strings and the same-UA rule cannot touch
-- them. Only staleness can — and at seven days, three endpoints created in the
-- same week all survive and the phone keeps buzzing three times until the week
-- is out.
--
-- Two days is what an operator's actual usage supports: they open the app every
-- shift, so a live device refreshes many times a day. Two days without a single
-- open is not a device in service.
--
-- The cost of being wrong is deliberately tiny. A device pruned by mistake
-- re-registers on its very next open — AppShell does it on mount, before any
-- screen renders — so the worst case is missing pushes on a phone nobody has
-- touched for two days, which is a phone nobody is watching anyway.
-- ═══════════════════════════════════════════════════════════════════════

begin;

-- ── 1a. ONE-TIME CLEANUP OF WHAT IS ALREADY THERE ─────────────────────
-- This is what actually stops the triple TODAY. Without it the new logic only
-- takes effect the next time each operator opens the app.
--
-- Keep the newest row per (person, user_agent); delete the rest.
--
-- coalesce(user_agent, id::text) is the careful part: a NULL user_agent must
-- partition ALONE, or every row that never recorded one would collapse into a
-- single group and all but one would be deleted. id is unique, so each NULL
-- keeps its own group and survives.
with ranked as (
  select id,
         row_number() over (
           partition by user_role_id, coalesce(user_agent, id::text)
           order by last_seen_at desc, created_at desc
         ) as rn
  from public.push_subscriptions
)
delete from public.push_subscriptions s
using ranked r
where s.id = r.id and r.rn > 1;

-- And anything nobody has opened the app on for two days. A live device
-- refreshes last_seen_at on every mount, so this only catches abandoned rows.
-- This is the clause that actually ends the triple today; see the header.
delete from public.push_subscriptions
where last_seen_at < now() - interval '2 days';


-- ── 1b. STOP IT HAPPENING AGAIN ───────────────────────────────────────
create or replace function public.save_push_subscription(
  p_endpoint   text,
  p_p256dh     text,
  p_auth       text,
  p_user_agent text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_me      uuid;
  v_removed int := 0;
begin
  select ur.id into v_me
  from public.user_roles ur
  where ur.user_id = auth.uid() and ur.is_active = true;

  if v_me is null then
    raise exception 'FORBIDDEN: you are not signed in as an active user';
  end if;

  if coalesce(btrim(p_endpoint), '') = ''
     or coalesce(btrim(p_p256dh), '') = ''
     or coalesce(btrim(p_auth), '') = ''
  then
    raise exception 'BAD_SUBSCRIPTION: the browser did not return a usable subscription';
  end if;

  insert into public.push_subscriptions
    (user_role_id, endpoint, p256dh, auth, user_agent, last_seen_at, failed_count)
  values (v_me, btrim(p_endpoint), btrim(p_p256dh), btrim(p_auth), p_user_agent, now(), 0)
  on conflict (endpoint) do update
    set user_role_id = excluded.user_role_id,
        p256dh       = excluded.p256dh,
        auth         = excluded.auth,
        user_agent   = excluded.user_agent,
        last_seen_at = now(),
        failed_count = 0;

  -- ── THE NEW PART ────────────────────────────────────────────────────
  -- This device just told us its current endpoint. Any OTHER row of ours that
  -- is the same browser, or that nobody has opened in two days, is a duplicate
  -- of this one — and that is what was tripling every notification.
  --
  -- Scoped to v_me, always. A subscription belonging to somebody else is never
  -- touched, whatever its user_agent says.
  --
  -- `p_user_agent is not null` matters: without it, two rows that both recorded
  -- NULL would look like the same device and one would be deleted for no
  -- reason. NULL is "we do not know", not "the same as the other unknown".
  delete from public.push_subscriptions
  where user_role_id = v_me
    and endpoint <> btrim(p_endpoint)
    and (
      (p_user_agent is not null and user_agent = p_user_agent)
      or last_seen_at < now() - interval '2 days'
    );

  get diagnostics v_removed = row_count;

  return jsonb_build_object('ok', true, 'superseded', v_removed);
end $fn$;

revoke all    on function public.save_push_subscription(text, text, text, text) from public, anon;
grant execute on function public.save_push_subscription(text, text, text, text) to authenticated;


-- ═══════════════════════════════════════════════════════════════════════
-- PART 2 — THE NAG, EVERY 5 SECONDS
--
-- On request. Only two numbers change, and the second one HAS to:
--
--   cron period   30 seconds  ->  5 seconds
--   c_min_gap     25 seconds  ->  4 seconds
--
-- The gap is not a detail. It exists to stop a double-run queueing twice, and
-- it is deliberately just under the cron period so a run firing a moment early
-- still counts as due. Left at 25 seconds against a 5-second schedule it would
-- reject five runs out of six and the nag would still effectively be every 30
-- seconds — the change would appear to do nothing at all.
--
-- ── WHAT THIS COSTS, ON THE RECORD ────────────────────────────────────
-- The nag window is unchanged at 10 minutes, so one unaccepted retrieval now
-- queues up to:
--
--     10 minutes / 5 seconds  =  120 notifications for ONE car
--
-- against 20 before. Each is a real push to every device that operator owns,
-- and each is a separate notification on the lock screen, because the nag uses
-- a unique tag on purpose so it re-alerts rather than replacing silently.
--
-- The risk is not the cost. It is the operator turning notifications off — and
-- after that the system cannot reach them at all, including for the pushes that
-- matter. If that starts happening the knob to turn is the WINDOW, not the
-- interval: c_nag_window at 2 minutes gives 24 alerts at the same 5-second
-- urgency.
-- ═══════════════════════════════════════════════════════════════════════

create or replace function public.nag_unaccepted_retrievals()
returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  -- How long a task keeps being nagged about. Unchanged.
  c_nag_window constant interval := interval '10 minutes';
  -- Just under the 5-second cron period, for the reason in the header above.
  c_min_gap    constant interval := interval '4 seconds';
  v_count int := 0;
begin
  insert into public.push_outbox (user_role_id, title, body, url, tag, critical, task_id)
  select t.assigned_operator_id,
         'Car still waiting',
         'Token ' || coalesce(v.token_number::text, '?') ||
           ' · ' || coalesce(v.car_number, 'car') ||
           case when v.parking_location is not null
                then ' · ' || v.parking_location else '' end,
         '/operator/tasks',
         -- Unique per nag, so each one alerts instead of silently replacing the
         -- last. The service worker closes the previous one by data.taskId.
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
      select 1
      from public.push_outbox p
      where p.task_id = t.id
        and p.created_at > now() - c_min_gap
    );

  get diagnostics v_count = row_count;
  return v_count;
end $fn$;

revoke execute on function public.nag_unaccepted_retrievals() from public, anon, authenticated;

commit;


-- ═══════════════════════════════════════════════════════════════════════
-- THE SCHEDULE — 5 seconds
--
-- Sub-minute cron needs pg_cron 1.5 or newer. On anything older the finest
-- available is once a minute, so the job still works — it just nags far less
-- often, and the notice says so rather than the migration failing.
-- ═══════════════════════════════════════════════════════════════════════

do $$
declare
  v_version text;
  v_parts   int[];
begin
  select extversion into v_version from pg_extension where extname = 'pg_cron';

  if v_version is null then
    raise notice 'pg_cron is not installed — nag_unaccepted_retrievals() exists but nothing calls it';
    return;
  end if;

  -- Re-running this migration must not stack duplicate jobs.
  perform cron.unschedule('nag-unaccepted-retrievals')
  where exists (select 1 from cron.job where jobname = 'nag-unaccepted-retrievals');

  v_parts := string_to_array(split_part(v_version, '-', 1), '.')::int[];

  if v_parts[1] > 1 or (v_parts[1] = 1 and v_parts[2] >= 5) then
    perform cron.schedule(
      'nag-unaccepted-retrievals',
      '5 seconds',
      $cron$ select public.nag_unaccepted_retrievals(); $cron$
    );
    raise notice 'cron job scheduled: nag-unaccepted-retrievals (every 5 SECONDS)';
  else
    perform cron.schedule(
      'nag-unaccepted-retrievals',
      '* * * * *',
      $cron$ select public.nag_unaccepted_retrievals(); $cron$
    );
    raise notice 'pg_cron % is older than 1.5 — scheduled once a MINUTE, not every 5s', v_version;
  end if;
end $$;


-- ═══════════════════════════════════════════════════════════════════════
-- VERIFY — every row must read PASS
-- ═══════════════════════════════════════════════════════════════════════
select check_name, case when ok then 'PASS' else 'FAIL' end as result
from (
  -- PART 1 — the duplicate that caused three notifications.
  select 'no person has two subscriptions for one browser' as check_name,
         not exists (
           select 1 from public.push_subscriptions
           where user_agent is not null
           group by user_role_id, user_agent
           having count(*) > 1
         ) as ok

  union all select 'no subscription has gone two days unseen',
         not exists (
           select 1 from public.push_subscriptions
           where last_seen_at < now() - interval '2 days'
         )

  union all select 'save_push_subscription now supersedes duplicates',
         (select prosrc like '%delete from public.push_subscriptions%' from pg_proc
           where pronamespace = 'public'::regnamespace and proname = 'save_push_subscription')

  -- The delete MUST be scoped to the caller, or one operator opening the app
  -- would clear another operator's device.
  union all select 'it only ever deletes the callers own rows',
         (select prosrc like '%where user_role_id = v_me%' from pg_proc
           where pronamespace = 'public'::regnamespace and proname = 'save_push_subscription')

  -- And must never treat two unknown user_agents as the same device.
  union all select 'a null user_agent is not matched against another null',
         (select prosrc like '%p_user_agent is not null%' from pg_proc
           where pronamespace = 'public'::regnamespace and proname = 'save_push_subscription')

  union all select 'it never deletes the row just saved',
         (select prosrc like '%endpoint <> btrim(p_endpoint)%' from pg_proc
           where pronamespace = 'public'::regnamespace and proname = 'save_push_subscription')

  -- PART 2 — the nag.
  union all select 'the nag gap is now 4 seconds',
         (select prosrc like '%interval ''4 seconds''%' from pg_proc
           where pronamespace = 'public'::regnamespace and proname = 'nag_unaccepted_retrievals')

  union all select 'the old 25-second gap is gone',
         (select prosrc not like '%25 seconds%' from pg_proc
           where pronamespace = 'public'::regnamespace and proname = 'nag_unaccepted_retrievals')

  union all select 'the 10-minute window is unchanged',
         (select prosrc like '%interval ''10 minutes''%' from pg_proc
           where pronamespace = 'public'::regnamespace and proname = 'nag_unaccepted_retrievals')

  -- One job, not two. An unschedule that missed would double the rate.
  union all select 'exactly one nag job is scheduled',
         (select count(*) = 1 from cron.job where jobname = 'nag-unaccepted-retrievals')

  -- The schedule itself. '5 seconds' on pg_cron 1.5+, else the minute
  -- fallback — both are a PASS, because the fallback is deliberate.
  union all select 'the nag job runs every 5 seconds (or the documented fallback)',
         (select schedule in ('5 seconds', '* * * * *')
            from cron.job where jobname = 'nag-unaccepted-retrievals')

  -- Grants unchanged: the app saves its own subscription, nothing else may.
  union all select 'staff may still save their own subscription',
         has_function_privilege('authenticated',
           'public.save_push_subscription(text,text,text,text)', 'execute')

  union all select 'anon may NOT save a subscription',
         not has_function_privilege('anon',
           'public.save_push_subscription(text,text,text,text)', 'execute')

  union all select 'nobody may call the nag directly',
         not has_function_privilege('authenticated',
           'public.nag_unaccepted_retrievals()', 'execute')
) t
order by ok, check_name;
