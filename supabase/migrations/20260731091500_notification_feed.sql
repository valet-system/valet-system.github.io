-- ═══════════════════════════════════════════════════════════════════════
-- 0015 — THE NOTIFICATION BELL
--
--   >>> RUN THIS IN THE SUPABASE SQL EDITOR, AFTER 0014. <<<
--
-- Safe to run more than once. Creates no tables; if the editor warns about
-- RLS, choose "Run without RLS".
--
--
-- WHY push_outbox AND NOT A NEW notifications TABLE
--
-- A bell needs the same three things the push queue already holds — who it is
-- for, what it says, and where tapping it should go — plus a read flag. A
-- second table would mean the trigger in 0014 writing the same row twice, and
-- the day someone edits one INSERT and not the other, the bell and the phone
-- start disagreeing about what happened.
--
-- So this adds `read_at` and opens up SELECT. One write path, one truth.
--
-- The cost, stated plainly: prune_push_outbox keeps 14 days, so the bell's
-- history is 14 days. For task alerts that is correct — nobody needs to scroll
-- back to a car that was fetched in July — but it is a real limit, not an
-- oversight.
--
--
-- WHY SELECT IS A POLICY BUT MARKING READ IS AN RPC
--
-- Reading needs to be a table policy, not a function, because Supabase
-- Realtime delivers changes THROUGH RLS: with no SELECT policy the bell would
-- receive nothing and only update on a page reload. A policy makes it live.
--
-- Marking read cannot be a policy, because RLS grants or denies a whole row —
-- it cannot allow UPDATE of `read_at` while forbidding `title` and `body`. A
-- blanket UPDATE policy would let an operator rewrite their own notification
-- history. The RPC writes exactly one column.
--
-- Delivery fields (status, attempts, last_error) become readable to the
-- recipient. That is deliberate and harmless: it is the delivery state of
-- their own notification, and it is what makes "why did my phone not buzz"
-- answerable without a database session.
-- ═══════════════════════════════════════════════════════════════════════

begin;


-- ═══════════════════════════════════════════════════════════════════════
-- 1. read state
-- ═══════════════════════════════════════════════════════════════════════

alter table public.push_outbox
  add column if not exists read_at timestamptz;

-- The bell's only query: my rows, newest first. Covers the unread count too.
create index if not exists push_outbox_recipient_idx
  on public.push_outbox(user_role_id, created_at desc);


-- ═══════════════════════════════════════════════════════════════════════
-- 2. SELECT — own rows only
--
-- `user_role_id in (...)` rather than a join, so the policy stays a cheap
-- subquery on an indexed column.
-- ═══════════════════════════════════════════════════════════════════════

drop policy if exists push_outbox_select_own on public.push_outbox;
create policy push_outbox_select_own on public.push_outbox
  for select to authenticated
  using (
    user_role_id in (
      select ur.id from public.user_roles ur
      where ur.user_id = auth.uid() and ur.is_active = true
    )
  );

-- SELECT only. Insert stays closed so a browser can never forge a
-- notification to anybody, including itself.
grant select on public.push_outbox to authenticated;


-- ═══════════════════════════════════════════════════════════════════════
-- 3. mark_notifications_read
--
-- p_ids null = every unread row of mine. Returns how many changed, so the UI
-- can tell "nothing to do" from "it worked".
-- ═══════════════════════════════════════════════════════════════════════

create or replace function public.mark_notifications_read(p_ids bigint[] default null)
returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_me      uuid;
  v_updated int;
begin
  select ur.id into v_me
  from public.user_roles ur
  where ur.user_id = auth.uid() and ur.is_active = true;

  if v_me is null then
    raise exception 'FORBIDDEN: you are not signed in as an active user';
  end if;

  -- `user_role_id = v_me` is what makes the id list safe to accept from a
  -- browser: passing somebody else's ids matches no rows rather than marking
  -- their notifications read.
  update public.push_outbox
     set read_at = now()
   where user_role_id = v_me
     and read_at is null
     and (p_ids is null or id = any (p_ids));

  get diagnostics v_updated = row_count;
  return v_updated;
end $fn$;

revoke all    on function public.mark_notifications_read(bigint[]) from public, anon;
grant execute on function public.mark_notifications_read(bigint[]) to authenticated;

commit;


-- ═══════════════════════════════════════════════════════════════════════
-- 4. REALTIME — so the bell moves without a reload
--
-- Separate from the transaction above: altering a publication takes locks, and
-- a failure here must not roll back the policy and the function, which are
-- useful on their own.
-- ═══════════════════════════════════════════════════════════════════════

do $$
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    raise notice 'publication supabase_realtime not found — the bell will still';
    raise notice 'work, but only updates when the page refetches.';
    return;
  end if;

  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'push_outbox'
  ) then
    alter publication supabase_realtime add table public.push_outbox;
    raise notice 'push_outbox added to supabase_realtime';
  else
    raise notice 'push_outbox is already in supabase_realtime';
  end if;
end $$;


-- ═══════════════════════════════════════════════════════════════════════
-- VERIFY — every row should say PASS.
-- ═══════════════════════════════════════════════════════════════════════

with checks as (
  select 'read_at column exists' as item,
         exists (select 1 from information_schema.columns
                 where table_schema = 'public' and table_name = 'push_outbox'
                   and column_name = 'read_at') as ok
  union all select 'recipient index exists',
         exists (select 1 from pg_indexes where schemaname = 'public'
                 and indexname = 'push_outbox_recipient_idx')
  union all select 'a SELECT policy exists (realtime needs it)',
         exists (select 1 from pg_policies where schemaname = 'public'
                 and tablename = 'push_outbox' and cmd = 'SELECT')
  union all select 'there is still NO insert/update/delete policy',
         not exists (select 1 from pg_policies where schemaname = 'public'
                     and tablename = 'push_outbox' and cmd <> 'SELECT')
  union all select 'authenticated has SELECT but not INSERT',
         has_table_privilege('authenticated', 'public.push_outbox', 'select')
     and not has_table_privilege('authenticated', 'public.push_outbox', 'insert')
  union all select 'mark_notifications_read is callable',
         has_function_privilege('authenticated',
           'public.mark_notifications_read(bigint[])', 'execute')
  union all select 'push_outbox is published for realtime',
         not exists (select 1 from pg_publication where pubname = 'supabase_realtime')
      or exists (select 1 from pg_publication_tables
                 where pubname = 'supabase_realtime' and schemaname = 'public'
                   and tablename = 'push_outbox')
)
select item, case when ok then 'PASS' else 'FAIL' end as result
from checks
order by result desc, item;
