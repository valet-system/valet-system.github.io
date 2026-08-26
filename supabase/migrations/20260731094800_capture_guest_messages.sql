-- ═══════════════════════════════════════════════════════════════════════
-- MIGRATION 0048 — keep what guests write
--
-- Step 4 of the lead plan, built first and deliberately so. The plan's order
-- is not arbitrary: four of the five steps can be built in any order and
-- nothing is lost by waiting. This one cannot.
--
-- ── WHY THIS IS THE URGENT ONE ────────────────────────────────────────
-- WhatsApp Cloud API has no message history endpoint, no inbox, and no way to
-- ask Meta what somebody sent last week. The webhook delivers each message
-- exactly once. Store it or lose it — and "lose" is literal, not "hard to
-- find".
--
-- Today the webhook receives a message, asks one question of it ("is anyone
-- waiting for a Poor-rating comment?"), and if the answer is no, drops it:
--
--   guest types  ->  webhook  ->  no pending review  ->  gone
--                                 not in the database
--                                 not in the logs after they rotate
--                                 not on Meta, ever
--
-- Insights already showed 36 inbound messages. Every one that was not a button
-- tap is unrecoverable, including anyone who wrote "there is a scratch on my
-- car". This migration does not recover them. It stops the next one.
--
-- ── WHY TWO COLUMNS AND NOT A NEW TABLE ───────────────────────────────
-- wa_message_log already gets exactly one row per inbound message, inserted
-- before anything is decided about it — that insert is the dedupe lock, so it
-- is the one write guaranteed to happen for every message that arrives. The
-- capture point already exists; it was just throwing away the content.
--
-- A separate leads table would need its own insert, which means a second thing
-- that can fail, and a message captured in one table but not the other.
--
-- ── WHY NULLABLE, WITH NO BACKFILL ────────────────────────────────────
-- Every existing row is an outbound send or an inbound message whose text was
-- already discarded. There is nothing to backfill from. Rows before this
-- migration will read null for ever, and that is honest: null here means "not
-- captured", not "the guest sent nothing".
-- ═══════════════════════════════════════════════════════════════════════

begin;

-- ── 1. THE TWO COLUMNS ────────────────────────────────────────────────
alter table public.wa_message_log
  add column if not exists from_phone text,
  add column if not exists body       text;

comment on column public.wa_message_log.from_phone is
  'Guest phone as Meta sends it (digits, country code, no +). Null on outbound '
  'rows and on anything logged before migration 0048.';

comment on column public.wa_message_log.body is
  'What the guest actually sent: typed text, or the label of the button they '
  'tapped. The ONLY copy — Meta keeps no history and offers no inbox. Null '
  'means not captured, never "they sent nothing".';

-- ── 2. THE INDEX ──────────────────────────────────────────────────────
-- Every read of this data is "what did this person send" or "what came in
-- recently", so one index serves both. Partial: outbound rows have no
-- from_phone and would only make it bigger.
create index if not exists wa_message_log_from_phone_idx
  on public.wa_message_log (from_phone, created_at desc)
  where from_phone is not null;

-- ── 3. READING IT ─────────────────────────────────────────────────────
-- wa_message_log has NO RLS policy on purpose (see 0002), so service_role is
-- the only thing that can touch it directly. That is right for the webhook and
-- useless for a screen, hence a security definer function with its own check.
--
-- The guest name is JOINED, not stored. A phone number on its own is not a
-- lead — "97115 40211 wrote 'send me rates'" is worth far less than the same
-- line with the name of someone who has parked here four times. parked_vehicles
-- has held that name since day one; this is the first thing to look at it as a
-- list of people rather than a list of cars.
create or replace function public.guest_messages(
  p_since  timestamptz default now() - interval '30 days',
  p_search text        default null,
  p_limit  int         default 500
)
returns table (
  wa_message_id text,
  from_phone    text,
  guest_name    text,
  body          text,
  message_type  text,
  property_name text,
  visit_count   bigint,
  created_at    timestamptz
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_role text;
begin
  select ur.role into v_role
  from public.user_roles ur
  where ur.user_id = auth.uid() and ur.is_active = true;

  -- system_admin only, and not because the messages are secret — the point is
  -- that this is a cross-property list of guest phone numbers and free text.
  -- A valet_admin scoped to one site has no reason to read another site's, and
  -- an operator has no reason to read any of it.
  if v_role is distinct from 'system_admin' then
    raise exception 'FORBIDDEN: only a system admin can read guest messages';
  end if;

  return query
  with guest as (
    -- One row per phone: the name they last gave, where, and how many visits.
    --
    -- parked_at, NOT created_at. parked_vehicles has no created_at column at
    -- all — the timestamp is parked_at (see 0001) — so the obvious spelling
    -- fails outright rather than sorting oddly.
    --
    -- The window count is computed BEFORE distinct on, which is what makes
    -- this work: visits is the total for the phone, and distinct on then keeps
    -- the newest row. Its order by must lead with the distinct-on column.
    select distinct on (pv.guest_phone)
           pv.guest_phone,
           pv.guest_name,
           pv.property_id,
           count(*) over (partition by pv.guest_phone) as visits
    from public.parked_vehicles pv
    where pv.guest_phone is not null
    order by pv.guest_phone, pv.parked_at desc
  )
  select l.wa_message_id,
         l.from_phone,
         g.guest_name,
         l.body,
         l.message_type,
         p.name,
         g.visits,
         l.created_at
  from public.wa_message_log l
  -- Meta sends 919711540211; check-in stores 9711540211. Match on the last ten
  -- digits, which is the whole mobile number in India and the only part both
  -- sides reliably agree on.
  left join guest g on right(regexp_replace(g.guest_phone, '[^0-9]', '', 'g'), 10)
                     = right(regexp_replace(l.from_phone, '[^0-9]', '', 'g'), 10)
  left join public.properties p on p.id = g.property_id
  where l.direction = 'inbound'
    and l.from_phone is not null
    and l.created_at >= p_since
    and (
      p_search is null
      or l.body       ilike '%' || p_search || '%'
      or l.from_phone ilike '%' || p_search || '%'
      or g.guest_name ilike '%' || p_search || '%'
    )
  order by l.created_at desc
  limit least(greatest(coalesce(p_limit, 500), 1), 2000);
end $fn$;

revoke execute on function public.guest_messages(timestamptz, text, int) from public, anon;
grant  execute on function public.guest_messages(timestamptz, text, int) to authenticated;

commit;


-- ═══════════════════════════════════════════════════════════════════════
-- VERIFY — every row must read PASS
-- ═══════════════════════════════════════════════════════════════════════
select check_name, case when ok then 'PASS' else 'FAIL' end as result
from (
  select 'from_phone column exists' as check_name,
         exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'wa_message_log'
                    and column_name = 'from_phone') as ok

  union all select 'body column exists',
         exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'wa_message_log'
                    and column_name = 'body')

  -- Nullable on purpose: outbound rows have no sender, and there is nothing to
  -- backfill for anything logged before today.
  union all select 'both columns are nullable',
         (select count(*) = 2 from information_schema.columns
           where table_schema = 'public' and table_name = 'wa_message_log'
             and column_name in ('from_phone', 'body')
             and is_nullable = 'YES')

  union all select 'the lookup index exists',
         exists (select 1 from pg_indexes
                  where schemaname = 'public'
                    and indexname = 'wa_message_log_from_phone_idx')

  union all select 'guest_messages exists',
         to_regprocedure('public.guest_messages(timestamptz,text,int)') is not null

  -- The dedupe lock must still be a lock. If this index went, two copies of a
  -- Meta redelivery would both be acted on AND both stored.
  union all select 'wa_message_id is still unique',
         exists (select 1 from pg_constraint c
                  join pg_class t on t.oid = c.conrelid
                  where t.relname = 'wa_message_log' and c.contype = 'u')

  -- Reading is gated in the function, not by RLS, so the grants have to be
  -- exactly this: no anon, staff only, and the function decides from there.
  union all select 'staff may call guest_messages',
         has_function_privilege('authenticated',
           'public.guest_messages(timestamptz,text,int)', 'execute')

  union all select 'anon may NOT call guest_messages',
         not has_function_privilege('anon',
           'public.guest_messages(timestamptz,text,int)', 'execute')

  union all select 'it is system_admin only',
         (select prosrc like '%only a system admin can read guest messages%'
            from pg_proc
           where pronamespace = 'public'::regnamespace and proname = 'guest_messages')

  -- The join is the difference between a phone number and a lead.
  union all select 'it joins the guest name from their visits',
         (select prosrc like '%parked_vehicles%' from pg_proc
           where pronamespace = 'public'::regnamespace and proname = 'guest_messages')

  union all select 'it matches phones on the last ten digits',
         (select prosrc like '%right(regexp_replace%' from pg_proc
           where pronamespace = 'public'::regnamespace and proname = 'guest_messages')

  -- The table stays service_role only for direct access; the function is the
  -- only way in.
  union all select 'wa_message_log is still unreachable directly',
         not has_table_privilege('authenticated', 'public.wa_message_log', 'select')

  union all select 'wa_message_log still has RLS on',
         (select relrowsecurity from pg_class
           where oid = 'public.wa_message_log'::regclass)
) t
order by ok, check_name;
