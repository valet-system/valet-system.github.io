-- ═══════════════════════════════════════════════════════════════════════
-- 0010 — DAILY TOKEN RANGE: 1000 PER PROPERTY
--
--   >>> RUN THIS IN THE SUPABASE SQL EDITOR. <<<
--
-- Safe to run more than once. Creates no tables; if the editor warns about
-- RLS, choose "Run without RLS".
--
--
-- WHAT CHANGES
--
-- The daily range each property gets goes from 1–300 to 1–1000.
--
-- Ranges were ALREADY separate per property and that is not what changes
-- here. token_ranges is unique(property_id, range_date) and parked_vehicles
-- is unique(property_id, service_date, token_number), so Exotica's token 47
-- and Restro's token 47 have always been different cars, counted by different
-- rows. Each site hands out its own 1..N. Only N moves.
--
--
-- WHY THIS NEEDS A MIGRATION AT ALL, AND WHY IT ONLY NEEDS ONE MORE
--
-- 300 was written in three places that had to agree: the column default on
-- token_ranges, the on-demand safety net inside allocate_token(), and the
-- nightly reset_daily_tokens(). Three copies of one number is why changing it
-- is a schema change rather than a setting.
--
-- So the number moves into default_token_start() / default_token_end() and
-- all three read from there. Changing it again is one CREATE OR REPLACE, and
-- there is no longer a copy that can be missed and left disagreeing — which
-- would show up as a range that silently caps at the old value on whichever
-- path created it that day.
--
--
-- EXISTING ROWS
--
-- Today's and any future range are raised to 1000, but ONLY where they still
-- look untouched (1–300, the old default). A range an admin deliberately set
-- to something else is left exactly as it is: they had a reason, and this
-- migration does not know it. Past dates are never touched — they are a
-- record of what actually happened.
-- ═══════════════════════════════════════════════════════════════════════

begin;


-- ═══════════════════════════════════════════════════════════════════════
-- 1. THE NUMBER, IN ONE PLACE
--
-- Not a settings table: this is read on the insert path of every check-in,
-- and a function the planner can inline is cheaper than a lookup. A settings
-- row would also need RLS, grants and an admin screen to be useful, and
-- nobody has asked to change this from the UI.
-- ═══════════════════════════════════════════════════════════════════════

create or replace function public.default_token_start()
returns int
language sql
immutable
as $fn$ select 1 $fn$;

create or replace function public.default_token_end()
returns int
language sql
immutable
as $fn$ select 1000 $fn$;

comment on function public.default_token_end() is
  'Last token of a property''s daily range. Change HERE only — allocate_token(), reset_daily_tokens() and the token_ranges column default all read it.';

-- Exposed so the UI can show the same number it will actually get, rather
-- than a second copy in JavaScript that drifts from this one.
revoke all    on function public.default_token_start() from public, anon;
revoke all    on function public.default_token_end()   from public, anon;
grant execute on function public.default_token_start() to authenticated;
grant execute on function public.default_token_end()   to authenticated;


-- ═══════════════════════════════════════════════════════════════════════
-- 2. COLUMN DEFAULTS
-- ═══════════════════════════════════════════════════════════════════════

alter table public.token_ranges
  alter column range_start set default public.default_token_start();
alter table public.token_ranges
  alter column range_end   set default public.default_token_end();
alter table public.token_ranges
  alter column next_token  set default public.default_token_start();


-- ═══════════════════════════════════════════════════════════════════════
-- 3. allocate_token — same concurrency design, no hardcoded 300
--
-- UNCHANGED and deliberately so: one UPDATE statement takes a row-level write
-- lock, so simultaneous check-ins serialise on that single row and each gets
-- a distinct token. This is why a token is never computed in React.
-- ═══════════════════════════════════════════════════════════════════════

create or replace function public.allocate_token(p_property_id uuid)
returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_token int;
  v_date  date := public.ist_today();
begin
  if p_property_id is null then
    raise exception 'PROPERTY_REQUIRED';
  end if;

  if not (public.is_system_admin() or p_property_id = public.my_property_id()) then
    raise exception 'FORBIDDEN_PROPERTY';
  end if;

  -- Safety net: make sure today's range exists before touching it. Without
  -- this, a missed cron run means the first operator of the day is told the
  -- token range is finished, with zero cars parked.
  insert into public.token_ranges (property_id, range_date, range_start, range_end, next_token)
  values (p_property_id, v_date,
          public.default_token_start(), public.default_token_end(),
          public.default_token_start())
  on conflict (property_id, range_date) do nothing;

  -- Atomic claim. RETURNING sees the NEW value, so "next_token - 1" is the
  -- token this caller just took.
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
end $fn$;

revoke execute on function public.allocate_token(uuid) from public, anon;
grant  execute on function public.allocate_token(uuid) to authenticated;


-- ═══════════════════════════════════════════════════════════════════════
-- 4. reset_daily_tokens — the 00:05 IST job
--
-- Still idempotent, so a missed run is self-healing and allocate_token()
-- above is the second net.
-- ═══════════════════════════════════════════════════════════════════════

create or replace function public.reset_daily_tokens()
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
begin
  insert into public.token_ranges (property_id, range_date, range_start, range_end, next_token)
  select p.id, public.ist_today(),
         public.default_token_start(), public.default_token_end(),
         public.default_token_start()
  from public.properties p
  where p.is_active = true
  on conflict (property_id, range_date) do nothing;
end $fn$;

revoke execute on function public.reset_daily_tokens() from public, anon, authenticated;


-- ═══════════════════════════════════════════════════════════════════════
-- 5. RAISE TODAY'S AND FUTURE RANGES — only the untouched ones
--
-- `range_start = 1 and range_end = 300` is the fingerprint of a range nobody
-- edited. Anything else was chosen by an admin and is left alone.
--
-- next_token is NOT touched. It belongs to allocate_token(); moving it by
-- hand is how two guests end up holding the same number.
-- ═══════════════════════════════════════════════════════════════════════

update public.token_ranges
   set range_end = public.default_token_end()
 where range_date >= public.ist_today()
   and range_start = 1
   and range_end   = 300;

-- And make sure today exists at all, at the new size.
select public.reset_daily_tokens();

commit;


-- ═══════════════════════════════════════════════════════════════════════
-- VERIFY — every row should say PASS.
-- ═══════════════════════════════════════════════════════════════════════

with checks as (
  select 'default_token_end() is 1000' as item,
         public.default_token_end() = 1000 as ok
  union all select 'column default reads the function',
         (select column_default like '%default_token_end%'
          from information_schema.columns
          where table_schema = 'public' and table_name = 'token_ranges'
            and column_name = 'range_end')
  union all select 'allocate_token has no hardcoded 300',
         (select prosrc not like '%300%'
          from pg_proc where oid = 'public.allocate_token(uuid)'::regprocedure)
  union all select 'reset_daily_tokens has no hardcoded 300',
         (select prosrc not like '%300%'
          from pg_proc where oid = 'public.reset_daily_tokens()'::regprocedure)
  union all select 'no untouched 1-300 range left for today or later',
         not exists (select 1 from public.token_ranges
                     where range_date >= public.ist_today()
                       and range_start = 1 and range_end = 300)
  union all select 'every active property has a range for today',
         not exists (
           select 1 from public.properties p
           where p.is_active = true
             and not exists (select 1 from public.token_ranges tr
                             where tr.property_id = p.id
                               and tr.range_date = public.ist_today())
         )
)
select item, case when ok then 'PASS' else 'FAIL' end as result
from checks
order by result desc, item;


-- Today's ranges, per property, after the change:
--
-- select p.name, tr.range_start, tr.range_end, tr.next_token,
--        tr.range_end - tr.next_token + 1 as remaining
-- from public.token_ranges tr
-- join public.properties p on p.id = tr.property_id
-- where tr.range_date = public.ist_today()
-- order by p.name;
