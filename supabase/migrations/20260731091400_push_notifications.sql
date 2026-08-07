-- ═══════════════════════════════════════════════════════════════════════
-- 0014 — WEB PUSH NOTIFICATIONS
--
--   >>> RUN THIS IN THE SUPABASE SQL EDITOR. <<<
--
-- Safe to run more than once. It DOES create tables, so the editor's RLS
-- warning is real this time — but both tables have RLS enabled below, so
-- choose "Run without RLS" for the auth-schema check and read on.
--
--
-- WHY THIS EXISTS — the gap nothing else covers
--
-- The app already alerts loudly. Every one of those channels needs the PAGE
-- TO BE RUNNING: realtime is a websocket the page owns, the sounds come from
-- an AudioContext the page created, and a notification raised from page
-- JavaScript dies with the tab.
--
-- An operator's phone spends the shift in a pocket with the screen off. There
-- is no page, so there is no socket, so there is no event and no sound. The
-- admin assigns them a car and they find out whenever they next look — which
-- on a busy porch can be ten minutes with a guest waiting.
--
-- A push message is delivered by the operating system to the service worker,
-- which runs whether or not the app is open. It is the only channel that
-- crosses that gap.
--
--
-- HOW THE PIECES FIT
--
--   push_subscriptions   one row per browser install, written by the client
--                        after the operator grants permission
--   push_outbox          queued messages. A TRIGGER on valet_tasks fills it
--   push-send            Edge Function: reads the outbox, signs a VAPID JWT,
--                        POSTs to each browser's push service
--
-- An OUTBOX rather than the trigger calling out to the network directly, for
-- the same reason wa_outbox exists: a trigger that makes an HTTP request holds
-- the transaction open on the network. A push service having a bad minute
-- would then slow down — or roll back — an operator's tap on "Car Parked".
-- The queue decouples them, survives the sender being down, and makes a
-- failed send visible instead of lost.
--
--
-- WHAT THE TRIGGER DELIBERATELY DOES NOT DO
--
-- No push for a PARKING task. CheckIn assigns that to the operator who is
-- already standing at the porch holding the keys — notifying them about the
-- car in their own hand is noise, and noise is what makes people turn
-- notifications off.
--
-- No push to whoever caused the change. The admin who just tapped Assign is
-- looking at the screen.
-- ═══════════════════════════════════════════════════════════════════════

begin;


-- ═══════════════════════════════════════════════════════════════════════
-- 1. push_subscriptions
--
-- endpoint is UNIQUE and is the natural key. The browser mints one URL per
-- install, and re-subscribing on the same device returns the SAME endpoint —
-- so an upsert on it keeps one row per device instead of accumulating a new
-- row every time the app is opened.
-- ═══════════════════════════════════════════════════════════════════════

create table if not exists public.push_subscriptions (
  id           uuid primary key default gen_random_uuid(),
  user_role_id uuid not null references public.user_roles(id) on delete cascade,
  endpoint     text not null unique,
  -- The browser's public key and auth secret, from PushSubscription.getKey().
  -- Both are needed to encrypt a payload for this device (RFC 8291).
  p256dh       text not null,
  auth         text not null,
  user_agent   text,
  created_at   timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  -- Counts consecutive send failures. The sender deletes a subscription after
  -- a 404/410 immediately; this is for softer errors.
  failed_count int not null default 0
);

create index if not exists push_subscriptions_user_idx
  on public.push_subscriptions(user_role_id);

alter table public.push_subscriptions enable row level security;

-- A person manages only their own devices. Nobody can read anybody's
-- subscription — not even their own, because no screen needs to: the client
-- writes it and forgets it. Only service_role reads, in the Edge Function.
drop policy if exists push_subs_insert_own on public.push_subscriptions;
create policy push_subs_insert_own on public.push_subscriptions
  for insert to authenticated
  with check (
    user_role_id in (
      select ur.id from public.user_roles ur
      where ur.user_id = auth.uid() and ur.is_active = true
    )
  );

drop policy if exists push_subs_update_own on public.push_subscriptions;
create policy push_subs_update_own on public.push_subscriptions
  for update to authenticated
  using (
    user_role_id in (
      select ur.id from public.user_roles ur
      where ur.user_id = auth.uid() and ur.is_active = true
    )
  )
  with check (
    user_role_id in (
      select ur.id from public.user_roles ur
      where ur.user_id = auth.uid() and ur.is_active = true
    )
  );

drop policy if exists push_subs_delete_own on public.push_subscriptions;
create policy push_subs_delete_own on public.push_subscriptions
  for delete to authenticated
  using (
    user_role_id in (
      select ur.id from public.user_roles ur
      where ur.user_id = auth.uid() and ur.is_active = true
    )
  );

revoke all on public.push_subscriptions from anon;
grant insert, update, delete on public.push_subscriptions to authenticated;


-- ═══════════════════════════════════════════════════════════════════════
-- 2. push_outbox
--
-- RLS on and NO policies at all, exactly like wa_outbox. `authenticated`
-- therefore cannot touch it. That is the point: if a browser could insert
-- here, an operator could send any notification to anyone.
-- ═══════════════════════════════════════════════════════════════════════

create table if not exists public.push_outbox (
  id           bigserial primary key,
  user_role_id uuid not null references public.user_roles(id) on delete cascade,
  title        text not null,
  body         text not null,
  url          text,
  tag          text,
  critical     boolean not null default false,
  task_id      uuid references public.valet_tasks(id) on delete set null,
  status       text not null default 'queued'
                 check (status in ('queued', 'sent', 'failed', 'no_device')),
  attempts     int not null default 0,
  last_error   text,
  created_at   timestamptz not null default now(),
  sent_at      timestamptz
);

alter table public.push_outbox enable row level security;
revoke all on public.push_outbox from anon, authenticated;

-- The dispatcher only ever asks for queued rows. Partial, so the lookup stays
-- proportional to the queue rather than to every push ever sent.
create index if not exists push_outbox_queued_idx
  on public.push_outbox(created_at)
  where status = 'queued';


-- ═══════════════════════════════════════════════════════════════════════
-- 3. THE TRIGGER — what earns a push
-- ═══════════════════════════════════════════════════════════════════════

create or replace function public.enqueue_task_push()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_vehicle  record;
  v_label    text;
  v_actor    uuid;
begin
  -- Who is doing this, so we never notify them about their own tap. NULL when
  -- the change came from pg_cron (expire_stale_pickups), which is exactly the
  -- case where a push matters most — nobody is looking at anything.
  select ur.id into v_actor
  from public.user_roles ur
  where ur.user_id = auth.uid() and ur.is_active = true;

  select v.token_number, v.car_number, v.car_tier, v.parking_location
    into v_vehicle
  from public.parked_vehicles v
  where v.id = new.vehicle_id;

  v_label := 'Token ' || coalesce(v_vehicle.token_number::text, '?') ||
             ' · ' || coalesce(v_vehicle.car_number, 'car');

  -- ── a guest asked for their car: tell the admins ────────────────────
  if new.task_type = 'retrieval'
     and new.status = 'pending'
     and (tg_op = 'INSERT' or old.status is distinct from 'pending')
  then
    insert into public.push_outbox (user_role_id, title, body, url, tag, critical, task_id)
    select ur.id,
           'Car requested',
           v_label ||
             case when v_vehicle.parking_location is not null
                  then ' · ' || v_vehicle.parking_location else '' end,
           '/admin/dashboard',
           'valet-task-' || new.id::text,
           true,
           new.id
    from public.user_roles ur
    where ur.property_id = new.property_id
      and ur.role        = 'valet_admin'
      and ur.is_active   = true
      and ur.id is distinct from v_actor;

    return new;
  end if;

  -- ── a retrieval was dispatched: tell that operator ──────────────────
  -- Parking tasks are excluded on purpose; see the file header.
  if new.task_type = 'retrieval'
     and new.status = 'assigned'
     and new.assigned_operator_id is not null
     and (tg_op = 'INSERT'
          or old.status is distinct from 'assigned'
          or old.assigned_operator_id is distinct from new.assigned_operator_id)
     and new.assigned_operator_id is distinct from v_actor
  then
    insert into public.push_outbox (user_role_id, title, body, url, tag, critical, task_id)
    values (
      new.assigned_operator_id,
      'Fetch a car',
      v_label ||
        case when v_vehicle.parking_location is not null
             then ' · ' || v_vehicle.parking_location else '' end,
      '/operator/tasks',
      'valet-task-' || new.id::text,
      true,
      new.id
    );

    return new;
  end if;

  -- ── the hand-over window expired: tell the operator holding the car ──
  -- This is the single most important push in the system. expire_stale_pickups
  -- runs on pg_cron, and it only ever fires when nobody tapped anything for
  -- ten minutes — overwhelmingly because the phone is locked in a pocket. The
  -- operator is standing next to a car whose guest never came, and without
  -- this nothing tells them the task changed under them.
  if new.status = 're_parking'
     and old.status is distinct from 're_parking'
     and new.assigned_operator_id is not null
     and new.assigned_operator_id is distinct from v_actor
  then
    insert into public.push_outbox (user_role_id, title, body, url, tag, critical, task_id)
    values (
      new.assigned_operator_id,
      'Guest did not arrive',
      v_label || ' · park it again and confirm the spot',
      '/operator/tasks',
      'valet-task-' || new.id::text,
      true,
      new.id
    );
  end if;

  return new;
end $fn$;

drop trigger if exists trg_task_push on public.valet_tasks;
create trigger trg_task_push
  after insert or update on public.valet_tasks
  for each row
  execute function public.enqueue_task_push();


-- ═══════════════════════════════════════════════════════════════════════
-- 4. save_push_subscription — the client's one write
--
-- An RPC rather than a plain upsert from the browser, because the caller must
-- not choose which user_role_id the device belongs to. It is read from their
-- own JWT here, so a subscription can only ever be attached to the person who
-- created it.
-- ═══════════════════════════════════════════════════════════════════════

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
  v_me uuid;
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

  -- Conflict on endpoint, and REASSIGN user_role_id. A shared porch tablet is
  -- one browser install used by whoever is on shift, so the same endpoint must
  -- follow the person currently signed in — otherwise the previous operator
  -- keeps getting the notifications after they go home.
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

  return jsonb_build_object('ok', true);
end $fn$;

revoke all    on function public.save_push_subscription(text, text, text, text) from public, anon;
grant execute on function public.save_push_subscription(text, text, text, text) to authenticated;


-- ═══════════════════════════════════════════════════════════════════════
-- 5. delete_push_subscription — used on sign-out
--
-- Without this, a shared handset keeps pushing the previous operator's tasks
-- to whoever picks it up next.
-- ═══════════════════════════════════════════════════════════════════════

create or replace function public.delete_push_subscription(p_endpoint text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
begin
  delete from public.push_subscriptions
   where endpoint = btrim(coalesce(p_endpoint, ''))
     and btrim(coalesce(p_endpoint, '')) <> '';

  return jsonb_build_object('ok', true);
end $fn$;

revoke all    on function public.delete_push_subscription(text) from public, anon;
grant execute on function public.delete_push_subscription(text) to authenticated;


-- ═══════════════════════════════════════════════════════════════════════
-- 6. prune_push_outbox — retention, same reasoning as wa_outbox
-- ═══════════════════════════════════════════════════════════════════════

create or replace function public.prune_push_outbox(p_keep_days int default 14)
returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_days    int := greatest(coalesce(p_keep_days, 14), 3);
  v_deleted int;
begin
  delete from public.push_outbox
   where status in ('sent', 'failed', 'no_device')
     and created_at < now() - make_interval(days => v_days);

  get diagnostics v_deleted = row_count;
  return v_deleted;
end $fn$;

revoke execute on function public.prune_push_outbox(int) from public, anon, authenticated;

commit;


-- ═══════════════════════════════════════════════════════════════════════
-- 7. SCHEDULE THE PRUNE alongside the wa_outbox one
-- ═══════════════════════════════════════════════════════════════════════

do $$
begin
  if not exists (select 1 from pg_extension where extname = 'pg_cron') then
    raise notice 'pg_cron is NOT enabled — push_outbox will grow without limit.';
    return;
  end if;

  perform cron.unschedule(j.jobname)
  from cron.job j where j.jobname = 'prune-push-outbox';

  perform cron.schedule(
    'prune-push-outbox',
    '20 20 * * 0',
    $cron$ select public.prune_push_outbox(14); $cron$
  );

  raise notice 'cron job scheduled: prune-push-outbox (weekly)';
end $$;


-- ═══════════════════════════════════════════════════════════════════════
-- VERIFY — every row should say PASS.
-- ═══════════════════════════════════════════════════════════════════════

with checks as (
  select 'push_subscriptions table exists' as item,
         to_regclass('public.push_subscriptions') is not null as ok
  union all select 'push_outbox table exists',
         to_regclass('public.push_outbox') is not null
  union all select 'RLS is on for push_subscriptions',
         (select relrowsecurity from pg_class where oid = 'public.push_subscriptions'::regclass)
  union all select 'RLS is on for push_outbox',
         (select relrowsecurity from pg_class where oid = 'public.push_outbox'::regclass)
  union all select 'push_outbox has NO policies (service_role only)',
         not exists (select 1 from pg_policies
                     where schemaname = 'public' and tablename = 'push_outbox')
  union all select 'nobody can SELECT a push subscription',
         not exists (select 1 from pg_policies
                     where schemaname = 'public' and tablename = 'push_subscriptions'
                       and cmd = 'SELECT')
  union all select 'task trigger is attached',
         exists (select 1 from pg_trigger
                 where tgname = 'trg_task_push' and not tgisinternal)
  union all select 'save_push_subscription is callable by authenticated',
         has_function_privilege('authenticated',
           'public.save_push_subscription(text,text,text,text)', 'execute')
  union all select 'delete_push_subscription is callable by authenticated',
         has_function_privilege('authenticated',
           'public.delete_push_subscription(text)', 'execute')
  union all select 'endpoint is unique (one row per device)',
         exists (select 1 from pg_indexes where schemaname = 'public'
                 and tablename = 'push_subscriptions' and indexdef like '%UNIQUE%endpoint%')
)
select item, case when ok then 'PASS' else 'FAIL' end as result
from checks
order by result desc, item;
