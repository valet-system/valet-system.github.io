-- ═══════════════════════════════════════════════════════════════════════
-- 0026 — THE BUSINESS DAY STARTS AT 05:30 IST, NOT MIDNIGHT
--
-- A party runs past midnight. Under the old definition a car handed over at
-- 01:00 belonged to "tomorrow": it took a token from tomorrow's range, it
-- vanished from Today's Cars while the guest was still inside, and the night's
-- takings were split across two rows in every report.
--
-- The day now runs 05:30 → 05:30. A car checked in at 01:00 on the 8th has
-- service_date = the 7th, which is the night it actually belongs to.
--
--   07 Aug 22:00 IST  ->  service_date 2026-08-07
--   08 Aug 01:00 IST  ->  service_date 2026-08-07   <- the change
--   08 Aug 05:29 IST  ->  service_date 2026-08-07
--   08 Aug 05:30 IST  ->  service_date 2026-08-08
--
-- ══ ONE FUNCTION, AND THAT IS THE WHOLE POINT ══
--
-- Every table default, every RPC and every report already goes through
-- ist_today(): parked_vehicles.service_date, token_ranges.range_date, the
-- analytics window, Today's Cars, the token allocator. Changing the one
-- function moves all of them together. Do NOT scatter the 5:30 offset around;
-- a second copy that disagrees would put a car in one day and its token range
-- in another, and check-in would fail with no useful error.
--
-- src/utils/format.js has the browser's half of exactly this rule and MUST
-- match. scripts/check-service-day.mjs proves they agree.
--
-- ══ HISTORY IS NOT REWRITTEN ══
--
-- Rows already written keep the service_date they were given. Only new rows
-- use the new boundary. Backfilling would mean deciding, for every car checked
-- in between midnight and 05:30 in the past, that it belonged to the previous
-- night — probably true, but it would silently change numbers an admin has
-- already read and acted on. Left alone deliberately.
--
-- Safe to re-run.
-- ═══════════════════════════════════════════════════════════════════════

begin;

-- ── the definition ────────────────────────────────────────────────────
--
-- Subtracting the offset from the IST wall clock and taking the date is the
-- whole trick: 05:29 minus 5h30m lands on 23:59 of the day before, 05:30 lands
-- on 00:00 of the same day.
create or replace function public.ist_today()
returns date
language sql
stable
as $$ select ((now() at time zone 'Asia/Kolkata') - interval '5 hours 30 minutes')::date $$;

comment on function public.ist_today() is
  'The SERVICE date in Asia/Kolkata. The day starts at 05:30 IST, not midnight, because parties run past midnight and the cars belong to the night that started them. Use instead of current_date — the DB runs in UTC. Mirrored by istToday() in src/utils/format.js.';

-- ── when a service day begins, as a timestamptz ───────────────────────
--
-- For anything filtering on created_at rather than service_date — the
-- notification feed, "completed today". Without it those windows would still
-- cut at midnight and disagree with everything else on screen.
create or replace function public.ist_day_start(p_day date default null)
returns timestamptz
language sql
stable
as $$
  select ((coalesce(p_day, public.ist_today()) + time '05:30') at time zone 'Asia/Kolkata')
$$;

comment on function public.ist_day_start(date) is
  'The instant a service day begins: 05:30 IST on that date. Pair with ist_day_start(day + 1) for the exclusive end.';


-- ── the nightly token reset moves with the boundary ───────────────────
--
-- reset_daily_tokens() inserts a range for ist_today() with ON CONFLICT DO
-- NOTHING, so it has to run once the day has actually turned.
--
-- Leaving it at 00:05 IST would have turned the job into a permanent no-op.
-- At 00:05 the new ist_today() still returns the PREVIOUS service date, whose
-- range already exists, so the insert hits the conflict and does nothing —
-- every night, for ever.
--
-- Nothing would break loudly. allocate_token() creates a range on demand at
-- the first check-in and is the documented second net. What would be lost is
-- quieter: a scheduled job that can no longer do anything, and a range that
-- appears at the first car of the day rather than before it — so an admin who
-- opens Token Management early sees "no range for today yet" and may make one
-- by hand with different bounds. A job that cannot fail because it never acts
-- is the sort of fault that gets lived with for months.
--
-- 05:30 IST is exactly 00:00 UTC, so 00:05 UTC is 05:35 IST.
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    if exists (select 1 from cron.job where jobname = 'daily-token-reset') then
      perform cron.unschedule('daily-token-reset');
    end if;

    perform cron.schedule(
      'daily-token-reset',
      '5 0 * * *',
      $cron$ select public.reset_daily_tokens(); $cron$
    );

    raise notice 'daily-token-reset now runs at 00:05 UTC = 05:35 IST';
  else
    raise notice 'pg_cron is not installed; schedule daily-token-reset yourself';
  end if;
end $$;

commit;


-- ═══════════════════════════════════════════════════════════════════════
-- VERIFY — every row must read PASS
--
-- The boundary is checked by evaluating the SAME expression the function uses
-- against fixed instants, rather than by calling ist_today() (which only ever
-- tells you about right now).
-- ═══════════════════════════════════════════════════════════════════════
with probe as (
  select label, at_ist,
         -- at_ist is already an IST wall-clock timestamp, which is exactly what
         -- (now() at time zone 'Asia/Kolkata') produces inside the function.
         -- So this line is the function's expression, verbatim.
         (at_ist - interval '5 hours 30 minutes')::date as service_date,
         expected
  from (values
    ('the evening of the 7th',        timestamp '2026-08-07 22:00', date '2026-08-07'),
    ('01:00, still the 7th''s party', timestamp '2026-08-08 01:00', date '2026-08-07'),
    ('05:29, one minute to go',       timestamp '2026-08-08 05:29', date '2026-08-07'),
    ('05:30, the new day',            timestamp '2026-08-08 05:30', date '2026-08-08'),
    ('midday on the 8th',             timestamp '2026-08-08 12:00', date '2026-08-08')
  ) as v(label, at_ist, expected)
)
select label as check_name,
       case when service_date = expected then 'PASS'
            else 'FAIL got ' || service_date || ' want ' || expected end as result
from probe

union all

select 'ist_day_start is 05:30 IST',
       case when public.ist_day_start(date '2026-08-08')
                 = timestamptz '2026-08-08 05:30+05:30'
            then 'PASS' else 'FAIL' end

union all

select 'daily-token-reset runs at 00:05 UTC (05:35 IST)',
       case when not exists (select 1 from pg_extension where extname = 'pg_cron')
                 then 'SKIPPED - no pg_cron'
            when exists (select 1 from cron.job
                          where jobname = 'daily-token-reset' and schedule = '5 0 * * *')
                 then 'PASS'
            else 'FAIL' end

union all

select 'ist_today() carries the new comment',
       case when obj_description('public.ist_today()'::regprocedure) like '%05:30%'
            then 'PASS' else 'FAIL' end;
