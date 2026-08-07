-- ═══════════════════════════════════════════════════════════════════════
-- 0002 — FIXES & HARDENING
--
--   >>> RUN THIS IN THE SUPABASE SQL EDITOR. <<<
--
-- Safe to run on your existing database, and safe to run more than once
-- (every statement is idempotent). It repairs 10 defects in the original
-- schema. Each section states what was broken and how it failed.
--
-- Prerequisite: enable the pg_cron extension first
--   Dashboard -> Database -> Extensions -> search "pg_cron" -> Enable
-- If you skip that, section 9 is skipped automatically with a NOTICE and
-- everything else still applies.
-- ═══════════════════════════════════════════════════════════════════════

begin;

-- ═══════════════════════════════════════════════════════════════════════
-- 1. TIMEZONE  (severity: HIGH — silently corrupts every daily number)
--
-- BROKEN: `service_date date default current_date` and
--         `range_date date default current_date`.
--         Supabase Postgres runs in UTC. The UTC date rolls over at
--         00:00 UTC = 05:30 IST.
--
-- HOW IT FAILS: a restaurant valet parks a car at 01:00 IST Saturday.
--         In UTC that is 19:30 Friday, so the row gets service_date =
--         Friday. Consequences:
--           - "Today's cars" shows the wrong list for the whole late shift
--           - the token range is Friday's, so tokens keep counting up past
--             midnight instead of restarting
--           - every analytics figure is misattributed
--         For a business whose peak hours are 20:00-02:00 this is not an
--         edge case, it is most of the revenue.
--
-- FIX: an explicit Asia/Kolkata "business date" used everywhere.
-- ═══════════════════════════════════════════════════════════════════════

create or replace function public.ist_today()
returns date
language sql
stable
as $$ select (now() at time zone 'Asia/Kolkata')::date $$;

comment on function public.ist_today() is
  'Business date in Asia/Kolkata. Use instead of current_date — the DB runs in UTC.';

alter table public.parked_vehicles alter column service_date set default public.ist_today();
alter table public.token_ranges    alter column range_date   set default public.ist_today();


-- ═══════════════════════════════════════════════════════════════════════
-- 2. RLS INFINITE RECURSION  (severity: CRITICAL — nothing works at all)
--
-- BROKEN:
--   create policy "system admin sees all roles" on user_roles for all
--   using (exists (select 1 from user_roles ur where ur.user_id = auth.uid()
--                                                and ur.role = 'system_admin'));
--
-- HOW IT FAILS: to decide whether you may read user_roles, Postgres has to
--         evaluate this policy, which reads user_roles, which requires
--         evaluating the policy again. Postgres detects the cycle and
--         aborts with:
--           ERROR 42P17: infinite recursion detected in policy for
--                        relation "user_roles"
--         Because AuthContext's very first query is `select * from
--         user_roles`, every user — every role — fails at login. The app
--         never renders past the spinner.
--
-- FIX: read the caller's own role through SECURITY DEFINER functions.
--      A SECURITY DEFINER function runs as its owner and therefore does
--      not re-enter RLS, which breaks the cycle. This is also faster:
--      marked STABLE, Postgres evaluates it once per statement instead of
--      once per row.
-- ═══════════════════════════════════════════════════════════════════════

create or replace function public.my_role()
returns text
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select ur.role
  from public.user_roles ur
  where ur.user_id = auth.uid()
    and ur.is_active = true
  limit 1
$$;

create or replace function public.my_property_id()
returns uuid
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select ur.property_id
  from public.user_roles ur
  where ur.user_id = auth.uid()
    and ur.is_active = true
  limit 1
$$;

-- The caller's user_roles.id — this is what valet_tasks.assigned_operator_id
-- points at. NOT the same value as auth.uid().
create or replace function public.my_operator_id()
returns uuid
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select ur.id
  from public.user_roles ur
  where ur.user_id = auth.uid()
    and ur.is_active = true
  limit 1
$$;

create or replace function public.is_system_admin()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$ select coalesce(public.my_role() = 'system_admin', false) $$;

-- These read only the caller's own row, so exposing them to logged-in users
-- is safe. Anonymous visitors get nothing.
revoke execute on function public.my_role(), public.my_property_id(),
  public.my_operator_id(), public.is_system_admin() from public, anon;
grant execute on function public.my_role(), public.my_property_id(),
  public.my_operator_id(), public.is_system_admin() to authenticated;


-- ═══════════════════════════════════════════════════════════════════════
-- 3. POLICY REWRITE
--
-- Also fixed here:
--   a) `for all using (...)` with no `with check (...)`. Postgres falls back
--      to USING for the write check, so it happened to work — but it is
--      implicit and breaks the moment someone splits the policy. Now explicit.
--   b) `on properties for select using (true)` had no role restriction, so
--      the anon key could list all 4 properties before logging in. Now
--      restricted to `authenticated`.
--   c) `on wa_message_log for all using (true)` let ANY logged-in user read
--      and write the WhatsApp dedupe log — meaning any operator could
--      insert a fake wa_message_id and permanently block a guest's
--      "Get My Car" from ever registering. Now: no policy at all, which
--      means only service_role (Edge Functions) can touch it, since
--      service_role bypasses RLS by design.
-- ═══════════════════════════════════════════════════════════════════════

drop policy if exists "read properties"              on public.properties;
drop policy if exists "see own role"                 on public.user_roles;
drop policy if exists "system admin sees all roles"  on public.user_roles;
drop policy if exists "own property vehicles"        on public.parked_vehicles;
drop policy if exists "own property tasks"           on public.valet_tasks;
drop policy if exists "own property reviews"         on public.reviews;
drop policy if exists "own property tokens"          on public.token_ranges;
drop policy if exists "service role only"            on public.wa_message_log;

-- also drop this migration's own policies so re-running is clean
drop policy if exists properties_select        on public.properties;
drop policy if exists properties_admin_write   on public.properties;
drop policy if exists user_roles_select_self   on public.user_roles;
drop policy if exists user_roles_select_peers  on public.user_roles;
drop policy if exists user_roles_admin_all     on public.user_roles;
drop policy if exists vehicles_property_rw     on public.parked_vehicles;
drop policy if exists tasks_property_rw        on public.valet_tasks;
drop policy if exists reviews_property_read    on public.reviews;
drop policy if exists token_ranges_read        on public.token_ranges;
drop policy if exists token_ranges_admin_write on public.token_ranges;

-- ── properties ────────────────────────────────────────────────────────
-- Every logged-in user needs to read property names for UI labels.
create policy properties_select on public.properties
  for select to authenticated
  using (true);

-- Only the system admin creates/edits/disables properties.
create policy properties_admin_write on public.properties
  for all to authenticated
  using (public.is_system_admin())
  with check (public.is_system_admin());

-- ── user_roles ────────────────────────────────────────────────────────
create policy user_roles_select_self on public.user_roles
  for select to authenticated
  using (user_id = auth.uid());

-- A valet_admin must see the operator names at their own property, both to
-- populate the assign dropdown and to render "assigned to X" on task cards.
create policy user_roles_select_peers on public.user_roles
  for select to authenticated
  using (
    property_id is not null
    and property_id = public.my_property_id()
  );

create policy user_roles_admin_all on public.user_roles
  for all to authenticated
  using (public.is_system_admin())
  with check (public.is_system_admin());

-- ── parked_vehicles ───────────────────────────────────────────────────
create policy vehicles_property_rw on public.parked_vehicles
  for all to authenticated
  using      (public.is_system_admin() or property_id = public.my_property_id())
  with check (public.is_system_admin() or property_id = public.my_property_id());

-- ── valet_tasks ───────────────────────────────────────────────────────
create policy tasks_property_rw on public.valet_tasks
  for all to authenticated
  using      (public.is_system_admin() or property_id = public.my_property_id())
  with check (public.is_system_admin() or property_id = public.my_property_id());

-- ── reviews ───────────────────────────────────────────────────────────
-- Read-only for humans. Reviews are written by the wa-webhook Edge Function
-- using service_role, so no INSERT policy is needed or wanted: an operator
-- must not be able to fabricate a 5-star review for themselves.
create policy reviews_property_read on public.reviews
  for select to authenticated
  using (public.is_system_admin() or property_id = public.my_property_id());

-- ── token_ranges ──────────────────────────────────────────────────────
-- Operators read it (to show "Token 47 / 300"); only admins edit it.
create policy token_ranges_read on public.token_ranges
  for select to authenticated
  using (public.is_system_admin() or property_id = public.my_property_id());

create policy token_ranges_admin_write on public.token_ranges
  for all to authenticated
  using (
    public.is_system_admin()
    or (public.my_role() = 'valet_admin' and property_id = public.my_property_id())
  )
  with check (
    public.is_system_admin()
    or (public.my_role() = 'valet_admin' and property_id = public.my_property_id())
  );

-- wa_message_log: intentionally NO policy -> service_role only.


-- ═══════════════════════════════════════════════════════════════════════
-- 4. allocate_token  (severity: HIGH)
--
-- BROKEN 4a — misleading error: if today's token_ranges row does not exist
--         (nobody created it, or the IST/UTC date mismatch from section 1),
--         the UPDATE matches zero rows, v_token stays NULL, and the
--         function raises TOKEN_RANGE_EXHAUSTED. The operator sees
--         "token range finished" at 08:00 with zero cars parked, and the
--         admin has no idea what to do. Now the range is auto-created.
--
-- BROKEN 4b — privilege escalation: the function had no property check.
--         Any authenticated operator could call
--         rpc('allocate_token', { p_property_id: <other property> })
--         and burn through a competing property's token range. RLS does not
--         help here because the function bypasses it.
--
-- NOTE the concurrency design is CORRECT and is preserved: a single UPDATE
--      statement takes a row-level write lock, so 8 simultaneous operators
--      serialise on that one row and each gets a distinct token. This is why
--      it must never be read-then-write from React.
-- ═══════════════════════════════════════════════════════════════════════

create or replace function public.allocate_token(p_property_id uuid)
returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_token int;
  v_date  date := public.ist_today();
begin
  if p_property_id is null then
    raise exception 'PROPERTY_REQUIRED';
  end if;

  -- Only allocate for your own property (system_admin may do any).
  if not (public.is_system_admin() or p_property_id = public.my_property_id()) then
    raise exception 'FORBIDDEN_PROPERTY';
  end if;

  -- Safety net: make sure today's range exists before touching it.
  insert into public.token_ranges (property_id, range_date, range_start, range_end, next_token)
  values (p_property_id, v_date, 1, 300, 1)
  on conflict (property_id, range_date) do nothing;

  -- Atomic claim. RETURNING sees the NEW value, so "next_token - 1" is the
  -- token this caller just claimed.
  update public.token_ranges
     set next_token = next_token + 1
   where property_id = p_property_id
     and range_date  = v_date
     and next_token <= range_end
  returning next_token - 1 into v_token;

  if v_token is null then
    raise exception 'TOKEN_RANGE_EXHAUSTED';
  end if;

  return v_token;
end $$;

revoke execute on function public.allocate_token(uuid) from public, anon;
grant  execute on function public.allocate_token(uuid) to authenticated;


-- ═══════════════════════════════════════════════════════════════════════
-- 5. get_available_operators  (severity: HIGH — cross-property data leak)
--
-- BROKEN 5a: the "busy operators" subquery had no property_id filter:
--         ur.id not in (select assigned_operator_id from valet_tasks
--                       where status in (...))
--         It scanned valet_tasks across ALL FOUR properties. Harmless-looking,
--         but it means Property 1's free-operator list depends on Property 3's
--         workload — and since valet_tasks grows forever, this full scan gets
--         slower every single day.
--
-- BROKEN 5b: `not in (subquery)` is a NULL trap. The original guarded it with
--         `assigned_operator_id is not null`, so it worked — but if anyone
--         ever removes that line, NOT IN returns NULL for every row and the
--         function silently returns ZERO operators. Admin sees an empty
--         dropdown and cannot assign anyone. Rewritten as NOT EXISTS, which
--         is NULL-safe by construction and uses the index better.
--
-- BROKEN 5c: same missing property authorisation check as allocate_token —
--         an operator could enumerate another property's staff names.
--
-- Return type gains `phone` (admin needs to call the operator), so the
-- function must be dropped and recreated rather than replaced.
-- ═══════════════════════════════════════════════════════════════════════

drop function if exists public.get_available_operators(uuid);

create function public.get_available_operators(p_property_id uuid)
returns table (id uuid, name text, phone text)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if not (public.is_system_admin() or p_property_id = public.my_property_id()) then
    raise exception 'FORBIDDEN_PROPERTY';
  end if;

  return query
    select ur.id, ur.name, ur.phone
    from public.user_roles ur
    where ur.property_id = p_property_id
      and ur.role        = 'operator'
      and ur.is_active   = true
      and not exists (
        select 1
        from public.valet_tasks vt
        where vt.assigned_operator_id = ur.id
          and vt.property_id          = p_property_id
          and vt.status in ('assigned','in_progress','at_pickup','re_parking')
      )
    order by ur.name;
end $$;

revoke execute on function public.get_available_operators(uuid) from public, anon;
grant  execute on function public.get_available_operators(uuid) to authenticated;


-- ═══════════════════════════════════════════════════════════════════════
-- 6. DATA INTEGRITY CONSTRAINTS  (severity: MEDIUM-HIGH)
--
-- The original schema had no constraint stopping any of these:
--   - one auth user holding two role rows  -> `.single()` in AuthContext
--     throws, user cannot log in, and which property they belong to
--     becomes non-deterministic
--   - a valet_admin row with property_id = NULL -> my_property_id() returns
--     NULL, every RLS check evaluates to NULL (= deny), and that admin sees
--     a completely empty app with no error message
--   - two vehicles holding the same token on the same day -> two guests
--     both show token 47, wrong car gets handed over
--   - a guest double-tapping "Get My Car" creating two retrieval tasks ->
--     admin assigns two operators to fetch one car
--
-- Each is guarded: if existing rows already violate it, the constraint is
-- SKIPPED with a NOTICE instead of aborting the whole migration.
-- ═══════════════════════════════════════════════════════════════════════

-- 6a. Exactly one role row per auth user.
do $$
begin
  if exists (
    select 1 from public.user_roles
    where user_id is not null
    group by user_id having count(*) > 1
  ) then
    raise notice 'SKIPPED user_roles unique(user_id): duplicates exist. Fix them, then re-run.';
  else
    create unique index if not exists user_roles_user_id_key
      on public.user_roles(user_id);
  end if;
end $$;

-- 6b. Only system_admin may have a NULL property_id; everyone else must have one.
do $$
begin
  if exists (
    select 1 from public.user_roles
    where (role =  'system_admin' and property_id is not null)
       or (role <> 'system_admin' and property_id is null)
  ) then
    raise notice 'SKIPPED user_roles property-scope check: existing rows violate it.';
  else
    alter table public.user_roles drop constraint if exists user_roles_property_scope_chk;
    alter table public.user_roles add  constraint user_roles_property_scope_chk check (
      (role =  'system_admin' and property_id is null) or
      (role <> 'system_admin' and property_id is not null)
    );
  end if;
end $$;

-- 6c. A token is unique per property per business day.
do $$
begin
  if exists (
    select 1 from public.parked_vehicles
    group by property_id, service_date, token_number having count(*) > 1
  ) then
    raise notice 'SKIPPED parked_vehicles token uniqueness: duplicate tokens exist.';
  else
    create unique index if not exists parked_vehicles_token_per_day_key
      on public.parked_vehicles(property_id, service_date, token_number);
  end if;
end $$;

-- 6d. At most ONE open retrieval task per vehicle.
--     This is the real fix for "guest taps Get My Car twice". The webhook's
--     wa_message_id dedupe only catches Meta re-delivering the SAME message;
--     it does nothing for two genuinely different taps. A partial unique
--     index makes the second insert fail at the database level, which is the
--     only place a guarantee can actually live.
do $$
begin
  if exists (
    select 1 from public.valet_tasks
    where task_type = 'retrieval'
      and status in ('pending','assigned','in_progress','at_pickup','re_parking')
    group by vehicle_id having count(*) > 1
  ) then
    raise notice 'SKIPPED one-open-retrieval index: duplicate open retrievals exist.';
  else
    create unique index if not exists valet_tasks_one_open_retrieval_key
      on public.valet_tasks(vehicle_id)
      where task_type = 'retrieval'
        and status in ('pending','assigned','in_progress','at_pickup','re_parking');
  end if;
end $$;

-- 6e. NOT NULL on the columns every RLS policy depends on. A NULL
--     property_id makes `property_id = my_property_id()` evaluate to NULL,
--     which RLS treats as "deny" — the row becomes invisible to everyone,
--     including the person who created it. Silent data loss.
do $$
begin
  if exists (select 1 from public.parked_vehicles where property_id is null) then
    raise notice 'SKIPPED parked_vehicles.property_id NOT NULL: NULL rows exist.';
  else
    alter table public.parked_vehicles alter column property_id set not null;
  end if;

  if exists (select 1 from public.valet_tasks where property_id is null or vehicle_id is null) then
    raise notice 'SKIPPED valet_tasks NOT NULLs: NULL rows exist.';
  else
    alter table public.valet_tasks alter column property_id set not null;
    alter table public.valet_tasks alter column vehicle_id  set not null;
  end if;

  if exists (select 1 from public.user_roles where user_id is null) then
    raise notice 'SKIPPED user_roles.user_id NOT NULL: NULL rows exist.';
  else
    alter table public.user_roles alter column user_id set not null;
  end if;
end $$;

-- 6f. Property names must be unique — otherwise the system admin creates
--     "Ambria Restro" twice and no one can tell the dashboards apart.
do $$
begin
  if exists (select 1 from public.properties group by name having count(*) > 1) then
    raise notice 'SKIPPED properties unique(name): duplicate names exist.';
  else
    create unique index if not exists properties_name_key on public.properties(name);
  end if;
end $$;

-- 6g. Reviews need to know WHO delivered the car. Reviews.jsx is specified to
--     filter by operator, but the table had no operator column and
--     valet_tasks.assigned_operator_id can change on a re-park, so it cannot
--     be derived reliably after the fact. Captured at insert time instead.
alter table public.reviews
  add column if not exists operator_id uuid references public.user_roles(id);

-- 6h. Indexes for the queries the pages actually run.
create index if not exists reviews_property_created_idx
  on public.reviews(property_id, created_at desc);
create index if not exists parked_vehicles_phone_idx
  on public.parked_vehicles(guest_phone);
-- Partial index: the admin retrieval queue is the hottest query in the app
-- and only ever looks at pending retrievals.
create index if not exists valet_tasks_pending_retrieval_idx
  on public.valet_tasks(property_id, created_at)
  where task_type = 'retrieval' and status = 'pending';


-- ═══════════════════════════════════════════════════════════════════════
-- 7. WHATSAPP OUTBOX  (severity: HIGH — a whole feature was unreachable)
--
-- BROKEN: the spec says that when the 10-minute timer expires the guest
--         receives "Aap available nahi the...". The pg_cron job was plain
--         SQL — an UPDATE statement. SQL cannot make an HTTPS call to the
--         WhatsApp API. So if the operator's phone was locked or the app was
--         closed (exactly the scenario the cron job exists for), the guest
--         was NEVER told anything. Their car gets re-parked in silence.
--
-- FIX: a durable outbox table. Postgres queues a row; the wa-dispatch Edge
--      Function drains it. This is the standard transactional-outbox pattern
--      and it also gives us, for free:
--        - retries (attempts + last_error) instead of fire-and-forget loss
--        - an audit trail of every rupee spent on messaging
--        - guest messaging that survives the frontend being offline
-- ═══════════════════════════════════════════════════════════════════════

create table if not exists public.wa_outbox (
  id            uuid primary key default gen_random_uuid(),
  property_id   uuid not null references public.properties(id),
  vehicle_id    uuid references public.parked_vehicles(id) on delete cascade,
  task_id       uuid references public.valet_tasks(id) on delete cascade,
  message_type  text not null check (message_type in
                   ('car_parked','car_delivered','not_available','car_returned')),
  status        text not null default 'queued' check (status in ('queued','sent','failed')),
  attempts      int  not null default 0,
  last_error    text,
  wa_message_id text,
  created_at    timestamptz not null default now(),
  sent_at       timestamptz
);

-- Partial index: the dispatcher only ever asks for queued rows, and this
-- keeps that lookup O(queue length) instead of O(all messages ever sent).
create index if not exists wa_outbox_queued_idx
  on public.wa_outbox(created_at)
  where status = 'queued';

alter table public.wa_outbox enable row level security;
-- No policy: service_role (Edge Functions) only.


-- ═══════════════════════════════════════════════════════════════════════
-- 8. expire_stale_pickups  (severity: HIGH — left data half-updated)
--
-- BROKEN: the original cron job only updated valet_tasks:
--           update valet_tasks set status='returned', return_count=return_count+1
--           where status='at_pickup' and pickup_started_at < now() - '10 min'
--         It never touched parked_vehicles. Result after expiry:
--           valet_tasks.status   = 'returned'      (operator: re-park it)
--           parked_vehicles.status = 'at_pickup'   (guest list: still waiting)
--         Two tables disagreeing about the same car. TodaysCars shows the car
--         as awaiting pickup forever, and it can never be requested again
--         because the flow expects 'parked'.
--
-- FIX: one function that updates both tables and queues the guest message,
--      all inside a single transaction. Returns a count so you can verify it
--      by running `select public.expire_stale_pickups();` by hand.
-- ═══════════════════════════════════════════════════════════════════════

create or replace function public.expire_stale_pickups(p_timeout_minutes int default 10)
returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  r       record;
  v_count int := 0;
begin
  for r in
    update public.valet_tasks t
       set status       = 'returned',
           return_count = t.return_count + 1
     where t.status            = 'at_pickup'
       and t.completed_at is null
       and t.pickup_started_at < now() - make_interval(mins => p_timeout_minutes)
    returning t.id, t.vehicle_id, t.property_id
  loop
    -- keep the vehicle row in step with the task row
    update public.parked_vehicles
       set status = 're_parking'
     where id = r.vehicle_id;

    -- tell the guest, via the outbox so it survives Edge Function downtime
    insert into public.wa_outbox (property_id, vehicle_id, task_id, message_type)
    values (r.property_id, r.vehicle_id, r.id, 'not_available');

    v_count := v_count + 1;
  end loop;

  return v_count;
end $$;

-- Backend-only. An operator must not be able to expire other people's tasks.
revoke execute on function public.expire_stale_pickups(int) from public, anon, authenticated;


-- ═══════════════════════════════════════════════════════════════════════
-- 9. DAILY TOKEN RANGES + CRON
--
-- BROKEN: reset_daily_tokens() inserted a range for `current_date + 1` and
--         cron ran it at '59 23 * * *'. Both are UTC. 23:59 UTC is 05:29 IST,
--         so "tomorrow's" range was actually created halfway through the
--         morning of the day it was meant to cover — and dated using the UTC
--         day, which does not line up with the IST business day at all.
--
-- FIX: make it idempotent — "ensure the CURRENT IST business day has a range
--      for every active property" — and run it at 18:35 UTC = 00:05 IST,
--      just after the Indian day starts. Being idempotent means a missed run
--      is self-healing, and allocate_token() creates the range on demand as a
--      second safety net.
-- ═══════════════════════════════════════════════════════════════════════

create or replace function public.reset_daily_tokens()
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into public.token_ranges (property_id, range_date, range_start, range_end, next_token)
  select p.id, public.ist_today(), 1, 300, 1
  from public.properties p
  where p.is_active = true
  on conflict (property_id, range_date) do nothing;
end $$;

revoke execute on function public.reset_daily_tokens() from public, anon, authenticated;

-- Make sure today has ranges right now, so check-in works immediately.
select public.reset_daily_tokens();

-- ── cron jobs (skipped cleanly if pg_cron is not enabled yet) ──────────
do $$
declare j record;
begin
  if not exists (select 1 from pg_extension where extname = 'pg_cron') then
    raise notice '───────────────────────────────────────────────────────────';
    raise notice 'pg_cron is NOT enabled — the 10-minute timer safety net and';
    raise notice 'the daily token reset were NOT scheduled.';
    raise notice 'Enable it: Dashboard -> Database -> Extensions -> pg_cron,';
    raise notice 'then run this migration again.';
    raise notice '───────────────────────────────────────────────────────────';
    return;
  end if;

  -- remove the old (broken) jobs and any previous run of these
  for j in
    select jobname from cron.job
    where jobname in ('check-expired-pickups','daily-token-reset')
  loop
    perform cron.unschedule(j.jobname);
  end loop;

  -- every minute: the safety net for when the operator's app is closed
  perform cron.schedule(
    'check-expired-pickups',
    '* * * * *',
    $cron$ select public.expire_stale_pickups(10); $cron$
  );

  -- 18:35 UTC = 00:05 IST
  perform cron.schedule(
    'daily-token-reset',
    '35 18 * * *',
    $cron$ select public.reset_daily_tokens(); $cron$
  );

  raise notice 'cron jobs scheduled: check-expired-pickups, daily-token-reset';
end $$;


-- ═══════════════════════════════════════════════════════════════════════
-- 10. REALTIME  (severity: CRITICAL — realtime silently did nothing)
--
-- BROKEN: the schema never added any table to the `supabase_realtime`
--         publication. Supabase Realtime streams from Postgres logical
--         replication, and a table not in the publication produces no
--         events. So `.on('postgres_changes', ...)` subscribed happily,
--         reported SUBSCRIBED, and then fired zero callbacks forever.
--         Nothing errors — it just never updates. The admin would sit on the
--         retrieval queue and never see a request; the operator would never
--         see an assignment. This is the single hardest bug in the original
--         spec to diagnose, because every log looks healthy.
--
-- Also: REPLICA IDENTITY FULL. By default Postgres only puts the primary key
--       in the WAL for UPDATE/DELETE, so Realtime cannot evaluate an RLS
--       policy or a `filter:` against columns it never received. Without it,
--       property-scoped subscriptions drop events unpredictably.
--       Cost is a slightly larger WAL — irrelevant at 500 cars/day.
-- ═══════════════════════════════════════════════════════════════════════

alter table public.valet_tasks     replica identity full;
alter table public.parked_vehicles replica identity full;

do $$
declare t text;
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    raise notice 'publication supabase_realtime not found — skipping realtime setup';
    return;
  end if;

  foreach t in array array['valet_tasks','parked_vehicles','token_ranges'] loop
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime'
        and schemaname = 'public'
        and tablename = t
    ) then
      execute format('alter publication supabase_realtime add table public.%I', t);
      raise notice 'realtime enabled for public.%', t;
    end if;
  end loop;
end $$;

commit;

-- ═══════════════════════════════════════════════════════════════════════
-- VERIFY — run these after the migration and check the output
-- ═══════════════════════════════════════════════════════════════════════
--
-- -- 1. IST date is correct (should be today's Indian date):
-- select public.ist_today() as ist_date, current_date as utc_date;
--
-- -- 2. No recursion: this must return a row, not error 42P17
-- select * from public.user_roles limit 1;
--
-- -- 3. Realtime is actually on (expect 3 rows):
-- select tablename from pg_publication_tables
-- where pubname = 'supabase_realtime' and schemaname = 'public';
--
-- -- 4. Cron jobs registered (expect 2 rows):
-- select jobname, schedule from cron.job;
--
-- -- 5. Every active property has a range for today (expect 4 rows):
-- select p.name, t.range_start, t.range_end, t.next_token
-- from public.properties p
-- join public.token_ranges t
--   on t.property_id = p.id and t.range_date = public.ist_today()
-- order by p.name;
