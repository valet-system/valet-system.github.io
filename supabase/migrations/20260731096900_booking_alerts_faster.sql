-- ═══════════════════════════════════════════════════════════════════════
-- MIGRATION 0069 — booking alerts in seconds, not minutes
--
-- On request: notifications were arriving up to two minutes after the booking
-- was made in Ambria. This takes the schedule to every ten seconds.
--
-- ── WHY THE SCHEDULE COULD NOT SIMPLY BE CHANGED ──────────────────────
-- Because at ten seconds, two runs can overlap, and the sync as 0067 wrote it
-- would then announce the same booking twice.
--
-- It read the whole of ambria_booking_seen, compared in JavaScript, and wrote
-- back what it found. Between that read and that write there is a gap. At two
-- minutes the gap was unreachable — a run takes about three seconds — so the
-- design was sound for the schedule it had. At ten seconds a slow reply from
-- Ambria is enough for the next tick to start before the last has recorded
-- anything, and both see the same booking as new.
--
-- pg_cron does not serialise runs of a job, and request_ambria_sync is
-- fire-and-forget over pg_net, so nothing upstream prevents it either.
--
-- ── THE FIX: LET THE DATABASE DECIDE WHAT IS NEW ──────────────────────
-- claim_ambria_bookings() takes every booking the feed returned and returns
-- only the ones that were genuinely new or genuinely reassigned. It is one
-- statement:
--
--     insert ... on conflict (booking_id) do update
--        set ...
--      where s.valet_phone is distinct from excluded.valet_phone
--     returning s.booking_id
--
-- RETURNING on an upsert yields the rows actually inserted or updated. A row
-- whose WHERE is false — already recorded, same vendor — is not returned at
-- all. So the claim IS the check, in one atomic step.
--
-- Two concurrent runs: the second blocks on the row lock, wakes to find the
-- value already stored, its WHERE is false, and it gets nothing back. The
-- announcement can only be made by whoever won the row.
--
-- This also removes a read. The sync no longer needs to pull the whole seen
-- table into memory to compare it — the comparison happens where the data is.
--
-- ── WHY TEN SECONDS AND NOT ONE ───────────────────────────────────────
-- Every tick reads a 400-day range out of ANOTHER project's database. Ten
-- seconds is six calls a minute; Ambria's own screens poll their database at
-- five seconds, so this sits inside the load they already accept from
-- themselves. One second would be six times that for a calendar that changes a
-- few times a day.
--
-- ── THE HONEST ANSWER IS STILL A WEBHOOK ──────────────────────────────
-- Polling can be made fast; it cannot be made instant, and every tick costs
-- somebody something. Ambria calling us when a booking is saved would be
-- immediate and free. That needs an endpoint here and a change to their
-- booking form — a conversation with the other project, not a migration.
-- ═══════════════════════════════════════════════════════════════════════

begin;

-- ── 1. THE ATOMIC CLAIM ───────────────────────────────────────────────
create or replace function public.claim_ambria_bookings(p_rows jsonb)
returns table (booking_id text, is_new boolean)
language sql
security definer
set search_path = public, pg_temp
as $fn$
  insert into public.ambria_booking_seen as s (booking_id, valet_phone, event_date)
  select r->>'booking_id',
         -- '' and null mean the same thing here: nobody is assigned. Stored as
         -- null so `is distinct from` compares them as one value rather than
         -- treating a change from '' to null as a reassignment.
         nullif(btrim(coalesce(r->>'valet_phone', '')), ''),
         nullif(r->>'event_date', '')::date
    from jsonb_array_elements(p_rows) r
   where coalesce(r->>'booking_id', '') <> ''
  on conflict (booking_id) do update
     set valet_phone = excluded.valet_phone,
         event_date  = excluded.event_date,
         notified_at = now()
   -- THE WHOLE MECHANISM. A row already recorded against the same vendor fails
   -- this and is not returned, so it is never announced twice. `is distinct
   -- from` rather than <>, because null <> null is null and an unassigned
   -- booking would then be re-announced on every single tick.
   where s.valet_phone is distinct from excluded.valet_phone
  -- xmax = 0 on a row returned from an upsert means it was INSERTED; a row
  -- reached through DO UPDATE carries the updating transaction's id. It is the
  -- only way to tell the two apart from RETURNING, and without it every
  -- announcement would be logged as a reassignment — including the ones that
  -- are plainly new bookings.
  returning s.booking_id, (s.xmax = 0) as is_new;
$fn$;

comment on function public.claim_ambria_bookings(jsonb) is
  'Records the bookings the feed returned and gives back only the ones that '
  'were new or moved to a different valet firm. The claim and the check are '
  'one statement, so two overlapping sync runs cannot both announce the same '
  'booking.';

-- Only the sync calls it, and the sync holds the service role. No browser has
-- any business writing this table.
revoke all    on function public.claim_ambria_bookings(jsonb) from public, anon, authenticated;
grant execute on function public.claim_ambria_bookings(jsonb) to service_role;

commit;


-- ═══════════════════════════════════════════════════════════════════════
-- THE SCHEDULE — every ten seconds
-- ═══════════════════════════════════════════════════════════════════════

do $$
begin
  if not exists (select 1 from pg_extension where extname = 'pg_cron') then
    raise notice 'pg_cron is not installed — nothing calls the sync';
    return;
  end if;

  perform cron.unschedule('ambria-bookings-sync')
  where exists (select 1 from cron.job where jobname = 'ambria-bookings-sync');

  -- The interval form, not a cron expression: pg_cron's five fields cannot
  -- express anything under a minute. This project already uses it for the
  -- five-second retrieval nag.
  perform cron.schedule(
    'ambria-bookings-sync',
    '10 seconds',
    $cron$ select public.request_ambria_sync(); $cron$
  );
  raise notice 'cron job rescheduled: ambria-bookings-sync (every 10 seconds)';
end $$;


-- ═══════════════════════════════════════════════════════════════════════
-- VERIFY — every row must read PASS
-- ═══════════════════════════════════════════════════════════════════════
select check_name, case when ok then 'PASS' else 'FAIL' end as result
from (
  select 'the claim function exists' as check_name,
         to_regprocedure('public.claim_ambria_bookings(jsonb)') is not null as ok

  -- THE THREE LINES THAT MAKE IT SAFE. Each is asserted separately because
  -- losing any one of them reintroduces a different bug, and all three look
  -- like detail in a diff.
  union all select 'the claim is an upsert, not a read then a write',
         (select prosrc like '%on conflict (booking_id) do update%' from pg_proc
           where pronamespace = 'public'::regnamespace and proname = 'claim_ambria_bookings')

  -- Without the WHERE, every booking is returned on every tick and announced
  -- every ten seconds, for ever.
  union all select 'it returns only what actually changed',
         (select prosrc like '%is distinct from excluded.valet_phone%' from pg_proc
           where pronamespace = 'public'::regnamespace and proname = 'claim_ambria_bookings')

  -- Without RETURNING there is nothing to announce at all.
  union all select 'it hands back the claimed ids',
         (select prosrc like '%returning s.booking_id%' from pg_proc
           where pronamespace = 'public'::regnamespace and proname = 'claim_ambria_bookings')

  -- Without it the log calls every announcement a reassignment.
  union all select 'and says which were brand new',
         (select prosrc like '%xmax = 0%' from pg_proc
           where pronamespace = 'public'::regnamespace and proname = 'claim_ambria_bookings')

  -- ── PERMISSIONS ─────────────────────────────────────────────────────
  union all select 'the sync may claim',
         has_function_privilege('service_role', 'public.claim_ambria_bookings(jsonb)', 'execute')

  union all select 'staff may NOT claim',
         not has_function_privilege('authenticated',
           'public.claim_ambria_bookings(jsonb)', 'execute')

  union all select 'anon may NOT claim',
         not has_function_privilege('anon', 'public.claim_ambria_bookings(jsonb)', 'execute')

  -- ── THE SCHEDULE ────────────────────────────────────────────────────
  union all select 'the job is still scheduled once',
         (select count(*) = 1 from cron.job where jobname = 'ambria-bookings-sync')

  union all select 'it now runs every ten seconds',
         (select schedule = '10 seconds' from cron.job where jobname = 'ambria-bookings-sync')

  union all select 'and it is active',
         (select active from cron.job where jobname = 'ambria-bookings-sync')

  -- ── WHAT IT ALL STILL DEPENDS ON ────────────────────────────────────
  union all select '0067 is applied: the seen table exists',
         to_regclass('public.ambria_booking_seen') is not null

  union all select 'the nudge still exists',
         to_regprocedure('public.request_ambria_sync()') is not null

  union all select 'push_outbox still nudges the sender on insert',
         exists (select 1 from pg_trigger
                  where tgrelid = 'public.push_outbox'::regclass
                    and tgname = 'push_outbox_send' and not tgisinternal)
) t
order by ok, check_name;
