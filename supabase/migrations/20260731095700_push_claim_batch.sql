-- ═══════════════════════════════════════════════════════════════════════
-- MIGRATION 0057 — one push per person, however many admins there are
--
-- Reported: the in-app bell shows one notification, but the phone buzzes twice.
--
-- ── WHY ONE ROW BECAME TWO PUSHES ─────────────────────────────────────
-- Both halves of this are correct on their own, which is why it survived.
--
-- enqueue_task_push() writes ONE ROW PER ADMIN, in a single statement:
--
--     insert into push_outbox (…) select ur.id, … from user_roles ur
--      where ur.role = 'valet_admin' …
--
-- Ambria Exotica has two valet admins, so that statement inserts two rows. The
-- trigger on push_outbox is FOR EACH ROW, so it fires twice, and each fire
-- calls request_push_send(). Two invocations of push-send, moments apart.
--
-- And push-send did not CLAIM anything. It read:
--
--     select … from push_outbox where status = 'queued' limit 50
--
-- …sent every row it found, and only then marked them 'sent'. Two invocations
-- overlapping in that gap both see BOTH rows and both send BOTH. Each admin
-- gets two notifications, and the outbox still shows exactly one row each —
-- which is why the bell was right and the phone was wrong.
--
-- It scales with admins. Three admins is three pushes each, four is four. The
-- earlier "three times" report was this, not the stale subscriptions that 0049
-- addresses — those are a real and separate problem.
--
-- ── THE FIX: CLAIM BEFORE SENDING ─────────────────────────────────────
-- A new status, 'sending', and a function that moves rows into it atomically.
-- `for update skip locked` is what makes it safe: two callers arriving together
-- take DIFFERENT rows rather than both taking all of them. It is the standard
-- way to hand a queue to competing workers, and the reason a second invocation
-- now finds nothing to do instead of doing the same work again.
--
-- ── ROWS THAT NEVER COME BACK ─────────────────────────────────────────
-- Claiming introduces a failure the plain select could not have: an invocation
-- that dies mid-batch — a timeout, a redeploy, an unhandled throw — leaves its
-- rows on 'sending' with nobody coming back for them. A queue that can strand
-- work silently is worse than one that occasionally repeats it.
--
-- So the same function un-claims anything that has sat in 'sending' for more
-- than two minutes before it claims anything new. No extra cron job, and no
-- state that only a human notices: the next sweep repairs it.
--
-- Two minutes is comfortably longer than a batch of fifty sends takes, and
-- short enough that a stranded alert about a waiting guest is not stranded
-- long.
-- ═══════════════════════════════════════════════════════════════════════

begin;

-- ── 1. THE NEW STATUS ─────────────────────────────────────────────────
alter table public.push_outbox
  drop constraint if exists push_outbox_status_check;

alter table public.push_outbox
  add constraint push_outbox_status_check
  check (status in ('queued', 'sending', 'sent', 'failed', 'no_device'));

-- The dispatcher's index only covered 'queued'. Claiming reads and writes
-- 'sending' on every sweep, and without this that is a full scan of every push
-- ever sent.
create index if not exists push_outbox_sending_idx
  on public.push_outbox(created_at)
  where status = 'sending';


-- ── 2. THE CLAIM ──────────────────────────────────────────────────────
create or replace function public.claim_push_batch(p_limit int default 50)
returns setof public.push_outbox
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
begin
  -- FIRST, rescue anything stranded. An invocation that died mid-batch left
  -- its rows on 'sending'; without this they are never sent and never
  -- reported. attempts is NOT incremented here — the row was never actually
  -- tried, and counting it would burn its retries on a crash it did not cause.
  update public.push_outbox
     set status = 'queued'
   where status = 'sending'
     and created_at < now() - interval '2 minutes';

  -- THEN claim. `skip locked` is the whole point: two callers arriving at the
  -- same moment take different rows instead of both taking all of them.
  return query
  update public.push_outbox o
     set status = 'sending'
   where o.id in (
     select id from public.push_outbox
      where status = 'queued'
      order by created_at
      limit greatest(coalesce(p_limit, 50), 1)
      for update skip locked
   )
  returning o.*;
end $fn$;

revoke all    on function public.claim_push_batch(int) from public, anon, authenticated;
grant execute on function public.claim_push_batch(int) to service_role;

commit;


-- ═══════════════════════════════════════════════════════════════════════
-- VERIFY — every row must read PASS
-- ═══════════════════════════════════════════════════════════════════════
select check_name, case when ok then 'PASS' else 'FAIL' end as result
from (
  select 'sending is an allowed status' as check_name,
         (select pg_get_constraintdef(oid) like '%sending%' from pg_constraint
           where conname = 'push_outbox_status_check') as ok

  -- The four that were already there must survive, or the dispatcher cannot
  -- write its own results back and every push fails on the update.
  union all select 'queued is still allowed',
         (select pg_get_constraintdef(oid) like '%queued%' from pg_constraint
           where conname = 'push_outbox_status_check')

  union all select 'sent is still allowed',
         (select pg_get_constraintdef(oid) like '%sent%' from pg_constraint
           where conname = 'push_outbox_status_check')

  union all select 'failed is still allowed',
         (select pg_get_constraintdef(oid) like '%failed%' from pg_constraint
           where conname = 'push_outbox_status_check')

  union all select 'no_device is still allowed',
         (select pg_get_constraintdef(oid) like '%no_device%' from pg_constraint
           where conname = 'push_outbox_status_check')

  union all select 'claim_push_batch exists',
         to_regprocedure('public.claim_push_batch(int)') is not null

  -- THE FIX. Without skip locked two callers block on each other and then both
  -- proceed — which is the bug with extra waiting.
  union all select 'it claims with skip locked',
         (select prosrc like '%for update skip locked%' from pg_proc
           where pronamespace = 'public'::regnamespace and proname = 'claim_push_batch')

  union all select 'it marks rows sending',
         (select prosrc like '%set status = ''sending''%' from pg_proc
           where pronamespace = 'public'::regnamespace and proname = 'claim_push_batch')

  -- And the recovery, or a crashed batch is lost silently.
  union all select 'it rescues rows stranded on sending',
         (select prosrc like '%interval ''2 minutes''%' from pg_proc
           where pronamespace = 'public'::regnamespace and proname = 'claim_push_batch')

  union all select 'the sending index exists',
         exists (select 1 from pg_indexes
                  where schemaname = 'public' and indexname = 'push_outbox_sending_idx')

  -- Only the dispatcher may call it. A staff session claiming the queue would
  -- take rows meant for somebody else's phone and never send them.
  union all select 'the dispatcher may claim',
         has_function_privilege('service_role', 'public.claim_push_batch(int)', 'execute')

  union all select 'staff may NOT claim',
         not has_function_privilege('authenticated', 'public.claim_push_batch(int)', 'execute')

  union all select 'anon may NOT claim',
         not has_function_privilege('anon', 'public.claim_push_batch(int)', 'execute')

  -- Nothing should be stuck right now.
  union all select 'no row is stranded on sending',
         not exists (select 1 from public.push_outbox
                      where status = 'sending'
                        and created_at < now() - interval '2 minutes')
) t
order by ok, check_name;
