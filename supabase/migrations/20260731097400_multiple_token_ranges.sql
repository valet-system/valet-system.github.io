-- ═══════════════════════════════════════════════════════════════════════
-- MIGRATION 0074 — AN OPERATOR CAN HOLD MORE THAN ONE RANGE TONIGHT
--
--   >>> RUN THIS IN THE SUPABASE SQL EDITOR. <<<
--
-- Safe to run more than once.
--
--
-- WHAT CHANGES, AND WHY
--
-- 0071 gave each operator exactly one range per night and 0072 gave that
-- range a forward-moving cursor. The only way to give an operator more
-- numbers was EXTEND — push range_end further out.
--
-- Extend can only ever grow a range at its top edge, so it works only when
-- the numbers immediately above are still free. On a busy night they are
-- not: Shailendra has 1-5, Ramesh has 6-20, and Shailendra runs out. There
-- is no number Shailendra can extend TO. The admin's real intent — "give
-- Shailendra another five numbers, 41 to 45" — could not be expressed at
-- all.
--
-- So a range stops being a property of the operator and becomes a row the
-- operator can have several of. The admin types a from and a to, and the
-- operator's numbers are the union of their ranges.
--
--
-- THE CURSOR ACROSS SEVERAL RANGES
--
-- 0072's rule was "walk forward from next_token, wrap at range_end". The
-- same rule now applies to the operator's ranges CONCATENATED, in
-- range_start order, as one circle:
--
--   ranges 1-5 and 41-45  ->  1 2 3 4 5 41 42 43 44 45 1 2 3 ...
--
-- After 5 the next number is 41, not 1. That is the behaviour 0072 was
-- fixing for a single range, applied to the whole set.
--
-- One cursor, not one per range: cursor_at marks WHICH range the cursor is
-- currently inside, and that range's next_token says where inside it. With
-- a single range cursor_at never matters and the behaviour is byte-for-byte
-- 0072's. That is deliberate — the common case must not change.
--
--
-- WHY NOT DROP next_token AND STORE ONE CURSOR ROW PER OPERATOR
--
-- It would be tidier and it would throw away the position of every range
-- mid-shift on a live night. Keeping the column means this migration can be
-- run at 9pm with cars on the floor and nobody's numbers move.
-- ═══════════════════════════════════════════════════════════════════════

begin;

-- ═══════════════════════════════════════════════════════════════════════
-- 1. THE CONSTRAINT THAT SAID "ONE"
--
-- Replaced rather than simply dropped. Two rows for the same operator
-- starting at the same number is always a double-submit, never an intent,
-- and without something in its place a flaky connection would leave
-- duplicates that quietly double every count on the roster screen.
-- ═══════════════════════════════════════════════════════════════════════

alter table public.operator_token_ranges
  drop constraint if exists operator_token_ranges_one_per_night;

create unique index if not exists operator_token_ranges_one_per_start
  on public.operator_token_ranges (property_id, service_date, operator_id, range_start);

comment on table public.operator_token_ranges is
  'Tonight''s roster: which numbers each operator hands out, per property per service_date. An operator may hold SEVERAL rows — their numbers are the union. Resets every night; nothing auto-creates a row, an admin assigns them. See migrations 0071 and 0074.';


-- ═══════════════════════════════════════════════════════════════════════
-- 2. WHICH RANGE THE CURSOR IS IN
--
-- NULL means "never issued from", which is also the right answer for every
-- row that exists today: an operator with one range has nothing to choose
-- between, and the tie-break below falls to the lowest range_start. So
-- there is deliberately no backfill — next_token already holds the position
-- and this column only decides WHICH range that position belongs to.
-- ═══════════════════════════════════════════════════════════════════════

alter table public.operator_token_ranges
  add column if not exists cursor_at timestamptz;

comment on column public.operator_token_ranges.cursor_at is
  'When this range last became the one the cursor sits in. The operator''s current range is their active range with the greatest cursor_at (NULLs last, then lowest range_start); that range''s next_token is the position inside it. See migration 0074.';


-- ═══════════════════════════════════════════════════════════════════════
-- 3. allocate_operator_token — one circular walk over ALL of the
--    operator's ranges
--
-- The whole set is laid out as numbered slots in (range_start, n) order,
-- rotated so the cursor's slot is first, and the first slot with no
-- currently-active car on it wins. A slot still on the floor is skipped;
-- the walk gives up only when every number the operator holds is in use.
--
-- Not scoped to service_date when checking whether a number is in use: a
-- car from before the 05:30 IST rollover that is somehow still not
-- delivered must keep blocking its number tonight. Same reasoning as 0071.
-- ═══════════════════════════════════════════════════════════════════════

create or replace function public.allocate_operator_token(
  p_property_id uuid,
  p_operator_id uuid
)
returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_date        date := public.ist_today();
  v_cur_range   uuid;
  v_cur_token   int;
  v_token       int;
  v_range_id    uuid;
  v_range_start int;
  v_range_end   int;
  v_next_id     uuid;
  v_next_start  int;
  v_bounds      text;
begin
  if p_property_id is null then
    raise exception 'PROPERTY_REQUIRED';
  end if;

  if not (public.is_system_admin() or p_property_id = public.my_property_id()) then
    raise exception 'FORBIDDEN_PROPERTY';
  end if;

  -- Lock the whole set, not one row. Two check-ins by the same operator at
  -- the same moment must not both read the same cursor and hand the same
  -- number to two guests.
  perform 1
  from public.operator_token_ranges otr
  where otr.property_id  = p_property_id
    and otr.operator_id  = p_operator_id
    and otr.service_date = v_date
    and otr.is_active    = true
  for update;

  -- The range the cursor is in. NULLs last, so a range that has never
  -- issued anything only becomes current once the walk actually reaches it.
  select otr.id, otr.next_token
    into v_cur_range, v_cur_token
  from public.operator_token_ranges otr
  where otr.property_id  = p_property_id
    and otr.operator_id  = p_operator_id
    and otr.service_date = v_date
    and otr.is_active    = true
  order by otr.cursor_at desc nulls last, otr.range_start
  limit 1;

  if v_cur_range is null then
    raise exception 'NO_TOKEN_RANGE: you have not been given a token range for tonight — ask your admin to assign you one';
  end if;

  with slots as (
    select
      otr.id          as range_id,
      otr.range_start,
      otr.range_end,
      s.n,
      row_number() over (order by otr.range_start, s.n) as ord
    from public.operator_token_ranges otr
    cross join lateral generate_series(otr.range_start, otr.range_end) as s(n)
    where otr.property_id  = p_property_id
      and otr.operator_id  = p_operator_id
      and otr.service_date = v_date
      and otr.is_active    = true
  ),
  anchor as (
    select sl.ord, (select count(*) from slots) as total
    from slots sl
    where sl.range_id = v_cur_range
      and sl.n        = v_cur_token
  )
  select sl.n, sl.range_id, sl.range_start, sl.range_end
    into v_token, v_range_id, v_range_start, v_range_end
  from slots sl
  cross join anchor a
  where not exists (
    select 1 from public.parked_vehicles v
    where v.property_id  = p_property_id
      and v.token_number = sl.n
      and v.status       <> 'delivered'
  )
  -- 0 for the cursor's own slot, so it is tried first and the walk runs
  -- forward from there, wrapping once through the whole set.
  order by (sl.ord - a.ord + a.total) % a.total
  limit 1;

  if v_token is null then
    select string_agg(format('%s-%s', otr.range_start, otr.range_end), ', ' order by otr.range_start)
      into v_bounds
    from public.operator_token_ranges otr
    where otr.property_id  = p_property_id
      and otr.operator_id  = p_operator_id
      and otr.service_date = v_date
      and otr.is_active    = true;

    raise exception 'TOKEN_RANGE_EXHAUSTED: every number you hold (%) is in use — ask your admin to give you another range', v_bounds;
  end if;

  if v_token < v_range_end then
    -- Still inside this range.
    update public.operator_token_ranges
       set next_token = v_token + 1,
           cursor_at  = now(),
           updated_at = now()
     where id = v_range_id;
  else
    -- That was the last number in this range, so the cursor moves into the
    -- next range by range_start, wrapping to the operator's first. With one
    -- range that IS this range, and this reduces to 0072's wrap exactly.
    select otr.id, otr.range_start
      into v_next_id, v_next_start
    from public.operator_token_ranges otr
    where otr.property_id  = p_property_id
      and otr.operator_id  = p_operator_id
      and otr.service_date = v_date
      and otr.is_active    = true
      and otr.range_start  > v_range_start
    order by otr.range_start
    limit 1;

    if v_next_id is null then
      select otr.id, otr.range_start
        into v_next_id, v_next_start
      from public.operator_token_ranges otr
      where otr.property_id  = p_property_id
        and otr.operator_id  = p_operator_id
        and otr.service_date = v_date
        and otr.is_active    = true
      order by otr.range_start
      limit 1;
    end if;

    update public.operator_token_ranges
       set next_token = v_next_start,
           cursor_at  = now(),
           updated_at = now()
     where id = v_next_id;
  end if;

  return v_token;
end $fn$;

revoke execute on function public.allocate_operator_token(uuid, uuid)
  from public, anon, authenticated;


-- ═══════════════════════════════════════════════════════════════════════
-- 4. admin_assign_token_range — ALWAYS creates a range, never extends
--
-- The signature is 0071's, unchanged, so nothing that already calls it
-- breaks — but p_range_start is now required in fact as well as in spirit,
-- because there is no longer a single existing row to extend.
--
-- "Add another range" and "assign the first range" are the same operation
-- now, which is why there is no second function: the first range is not a
-- special case of anything.
--
-- Overlap is checked against EVERY active range tonight including this
-- operator's own. Two of their own ranges overlapping would put the same
-- number in the circle twice and hand it out twice in one lap.
-- ═══════════════════════════════════════════════════════════════════════

create or replace function public.admin_assign_token_range(
  p_operator_id  uuid,
  p_range_end    int,
  p_range_start  int  default null,
  p_service_date date default null,
  p_property_id  uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_my_role     text;
  v_my_property uuid;
  v_property    uuid;
  v_date        date;
  v_operator    record;
  v_collide     record;
  v_row         public.operator_token_ranges;
  v_count       int;
begin
  select ur.role, ur.property_id into v_my_role, v_my_property
  from public.user_roles ur
  where ur.user_id = auth.uid() and ur.is_active = true;

  if v_my_role is null then
    raise exception 'FORBIDDEN: you are not signed in as an active user';
  end if;
  if v_my_role not in ('system_admin', 'valet_admin') then
    raise exception 'FORBIDDEN: only an admin can assign a token range';
  end if;

  if v_my_role = 'valet_admin' then
    v_property := v_my_property;
  else
    v_property := p_property_id;
    if v_property is null then
      raise exception 'PROPERTY_REQUIRED: choose a property';
    end if;
  end if;

  v_date := coalesce(p_service_date, public.ist_today());
  if v_date < public.ist_today() then
    raise exception 'BAD_DATE: cannot assign a range for a night that has already passed';
  end if;
  if v_date > public.ist_today() + 1 then
    raise exception 'BAD_DATE: you can only set up today or tomorrow''s roster';
  end if;

  select ur.id, ur.name, ur.role, ur.property_id, ur.is_active
    into v_operator
  from public.user_roles ur
  where ur.id = p_operator_id;

  if v_operator.id is null then
    raise exception 'NOT_FOUND: that operator no longer exists';
  end if;
  if v_operator.role <> 'operator' or v_operator.is_active is not true then
    raise exception 'BAD_OPERATOR: that person is not an active operator';
  end if;
  if v_operator.property_id is distinct from v_property then
    raise exception 'BAD_OPERATOR: that operator is not at this property';
  end if;

  if p_range_start is null then
    raise exception 'RANGE_REQUIRED: enter the first token in the range';
  end if;
  if p_range_start < 1 then
    raise exception 'BAD_RANGE: the first token must be 1 or more';
  end if;
  if p_range_end <= p_range_start then
    raise exception 'BAD_RANGE: the last token must be greater than the first';
  end if;
  if p_range_end - p_range_start + 1 > 500 then
    raise exception 'BAD_RANGE: that range is unusually large — check the numbers';
  end if;

  -- A cap on the number of ranges, not just their size. Ten blocks is far
  -- more than any real night needs, and it is what stops a stuck "Add"
  -- button from filling the roster screen with hundreds of rows.
  select count(*) into v_count
  from public.operator_token_ranges otr
  where otr.property_id  = v_property
    and otr.service_date = v_date
    and otr.operator_id  = p_operator_id
    and otr.is_active    = true;

  if v_count >= 10 then
    raise exception 'TOO_MANY_RANGES: % already has % ranges tonight — remove one before adding another',
      v_operator.name, v_count;
  end if;

  select ur.name, ur.id as who, otr.range_start, otr.range_end
    into v_collide
  from public.operator_token_ranges otr
  join public.user_roles ur on ur.id = otr.operator_id
  where otr.property_id  = v_property
    and otr.service_date = v_date
    and otr.is_active    = true
    and otr.range_start  <= p_range_end
    and otr.range_end    >= p_range_start
  limit 1;

  if v_collide.name is not null then
    if v_collide.who = p_operator_id then
      raise exception 'RANGE_OVERLAP: % to % overlaps a range % already has tonight (% to %)',
        p_range_start, p_range_end, v_operator.name, v_collide.range_start, v_collide.range_end;
    end if;
    raise exception 'RANGE_OVERLAP: % to % overlaps %''s range (% to %) tonight',
      p_range_start, p_range_end, v_collide.name, v_collide.range_start, v_collide.range_end;
  end if;

  -- An earlier range of this operator's that was removed and is being given
  -- back gets revived rather than duplicated — the unique index above is on
  -- (property, date, operator, range_start) and covers inactive rows too.
  insert into public.operator_token_ranges
    (property_id, service_date, operator_id, range_start, range_end, next_token)
  values
    (v_property, v_date, p_operator_id, p_range_start, p_range_end, p_range_start)
  on conflict (property_id, service_date, operator_id, range_start)
  do update set range_end  = excluded.range_end,
                is_active  = true,
                updated_at = now()
  returning * into v_row;

  return jsonb_build_object(
    'created',       true,
    'range_id',      v_row.id,
    'operator_id',   p_operator_id,
    'operator_name', v_operator.name,
    'range_start',   v_row.range_start,
    'range_end',     v_row.range_end
  );
end $fn$;

revoke all    on function public.admin_assign_token_range(uuid, int, int, date, uuid) from public, anon;
grant execute on function public.admin_assign_token_range(uuid, int, int, date, uuid) to authenticated;


-- ═══════════════════════════════════════════════════════════════════════
-- 5. admin_drop_token_range — remove ONE range, by id
--
-- A distinct name rather than an overload of admin_remove_token_range:
-- PostgREST resolves an RPC by the argument NAMES it is given, and two
-- functions each reachable with a single uuid would be ambiguous.
--
-- DELETED when nothing was ever issued from it, DEACTIVATED when something
-- was. A range typed in by mistake is a mistake and should leave no trace;
-- a range with cars on it is the record of who handed out those numbers,
-- and deleting it would orphan them.
-- ═══════════════════════════════════════════════════════════════════════

create or replace function public.admin_drop_token_range(
  p_range_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_my_role     text;
  v_my_property uuid;
  v_row         public.operator_token_ranges;
  v_used        bigint;
begin
  select ur.role, ur.property_id into v_my_role, v_my_property
  from public.user_roles ur
  where ur.user_id = auth.uid() and ur.is_active = true;

  if v_my_role is null then
    raise exception 'FORBIDDEN: you are not signed in as an active user';
  end if;
  if v_my_role not in ('system_admin', 'valet_admin') then
    raise exception 'FORBIDDEN: only an admin can change tonight''s roster';
  end if;

  select * into v_row
  from public.operator_token_ranges otr
  where otr.id = p_range_id
  for update;

  if v_row.id is null then
    raise exception 'NOT_FOUND: that range no longer exists';
  end if;
  if v_my_role = 'valet_admin' and v_row.property_id is distinct from v_my_property then
    raise exception 'FORBIDDEN: that range belongs to another property';
  end if;

  select count(*) into v_used
  from public.parked_vehicles v
  where v.property_id  = v_row.property_id
    and v.service_date = v_row.service_date
    and v.token_number between v_row.range_start and v_row.range_end;

  if v_used = 0 then
    delete from public.operator_token_ranges where id = v_row.id;
    return jsonb_build_object('removed', true, 'deleted', true, 'range_id', p_range_id);
  end if;

  update public.operator_token_ranges
     set is_active  = false,
         updated_at = now()
   where id = v_row.id;

  return jsonb_build_object('removed', true, 'deleted', false, 'range_id', p_range_id);
end $fn$;

revoke all    on function public.admin_drop_token_range(uuid) from public, anon;
grant execute on function public.admin_drop_token_range(uuid) to authenticated;


-- ═══════════════════════════════════════════════════════════════════════
-- 6. admin_remove_token_range — now takes the operator OFF DUTY entirely,
--    which means every range they hold tonight
--
-- 0071's version updated "the" row. With several, updating one at random
-- would leave the operator still issuing numbers from the others — the one
-- thing this function exists to stop.
-- ═══════════════════════════════════════════════════════════════════════

create or replace function public.admin_remove_token_range(
  p_operator_id  uuid,
  p_service_date date default null,
  p_property_id  uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_my_role     text;
  v_my_property uuid;
  v_property    uuid;
  v_date        date := coalesce(p_service_date, public.ist_today());
  v_count       int;
begin
  select ur.role, ur.property_id into v_my_role, v_my_property
  from public.user_roles ur
  where ur.user_id = auth.uid() and ur.is_active = true;

  if v_my_role is null then
    raise exception 'FORBIDDEN: you are not signed in as an active user';
  end if;
  if v_my_role not in ('system_admin', 'valet_admin') then
    raise exception 'FORBIDDEN: only an admin can change tonight''s roster';
  end if;

  v_property := case when v_my_role = 'valet_admin' then v_my_property else p_property_id end;
  if v_property is null then
    raise exception 'PROPERTY_REQUIRED: choose a property';
  end if;

  update public.operator_token_ranges
     set is_active  = false,
         updated_at = now()
   where property_id  = v_property
     and service_date = v_date
     and operator_id  = p_operator_id
     and is_active    = true;

  get diagnostics v_count = row_count;

  if v_count = 0 then
    raise exception 'NOT_FOUND: that operator has no range tonight';
  end if;

  return jsonb_build_object('removed', true, 'ranges', v_count, 'operator_id', p_operator_id);
end $fn$;

revoke all    on function public.admin_remove_token_range(uuid, date, uuid) from public, anon;
grant execute on function public.admin_remove_token_range(uuid, date, uuid) to authenticated;


-- ═══════════════════════════════════════════════════════════════════════
-- 7. admin_token_roster — ONE ROW PER RANGE, not per operator
--
-- DROP then CREATE, not CREATE OR REPLACE: the returned column list gains
-- range_id, and Postgres refuses to replace a function whose OUT columns
-- change. The grants below are the same ones 0071 set, re-applied because
-- dropping the function dropped them with it.
--
-- The screen groups by operator_id. Doing that in the browser rather than
-- in SQL keeps this function a plain list — an operator's three counts are
-- per RANGE here, and the screen adds them up, which is also what lets it
-- show "5 issued from 1-5, 0 from 41-45" if that is ever wanted.
-- ═══════════════════════════════════════════════════════════════════════

drop function if exists public.admin_token_roster(uuid, date);

create function public.admin_token_roster(
  p_property_id  uuid default null,
  p_service_date date default null
)
returns table (
  range_id         uuid,
  operator_id      uuid,
  operator_name    text,
  operator_name_hi text,
  range_start      int,
  range_end        int,
  is_active        boolean,
  issued_count     bigint,
  open_count       bigint,
  delivered_count  bigint
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_role  text;
  v_mine  uuid;
  v_scope uuid;
  v_date  date := coalesce(p_service_date, public.ist_today());
begin
  select ur.role, ur.property_id into v_role, v_mine
  from public.user_roles ur
  where ur.user_id = auth.uid() and ur.is_active = true;

  if v_role is null then
    raise exception 'FORBIDDEN: you are not signed in as an active user';
  end if;

  if v_role = 'system_admin' then
    v_scope := p_property_id;
    if v_scope is null then
      raise exception 'PROPERTY_REQUIRED: choose a property';
    end if;
  elsif v_role = 'valet_admin' then
    v_scope := v_mine;
  else
    raise exception 'FORBIDDEN: only an admin can see the token roster';
  end if;

  return query
  select
    otr.id,
    otr.operator_id,
    ur.name,
    ur.name_hi,
    otr.range_start,
    otr.range_end,
    otr.is_active,
    (select count(*) from public.parked_vehicles v
       where v.property_id  = v_scope
         and v.service_date = v_date
         and v.token_number between otr.range_start and otr.range_end)::bigint,
    (select count(*) from public.parked_vehicles v
       where v.property_id = v_scope
         and v.status      <> 'delivered'
         and v.token_number between otr.range_start and otr.range_end)::bigint,
    (select count(*) from public.parked_vehicles v
       where v.property_id  = v_scope
         and v.service_date = v_date
         and v.status       = 'delivered'
         and v.token_number between otr.range_start and otr.range_end)::bigint
  from public.operator_token_ranges otr
  join public.user_roles ur on ur.id = otr.operator_id
  where otr.property_id  = v_scope
    and otr.service_date = v_date
  order by ur.name, otr.range_start;
end $fn$;

revoke all    on function public.admin_token_roster(uuid, date) from public, anon;
grant execute on function public.admin_token_roster(uuid, date) to authenticated;

commit;


-- ═══════════════════════════════════════════════════════════════════════
-- VERIFY — every row must read PASS
-- ═══════════════════════════════════════════════════════════════════════
select check_name, case when ok then 'PASS' else 'FAIL' end as result
from (
  -- The constraint that allowed exactly one range per operator is gone.
  select 'one-per-night constraint removed' as check_name,
         not exists (select 1 from pg_constraint
                      where conrelid = 'public.operator_token_ranges'::regclass
                        and conname  = 'operator_token_ranges_one_per_night') as ok

  -- ...and something still refuses an exact duplicate.
  union all select 'duplicate start still refused',
         exists (select 1 from pg_indexes
                  where schemaname = 'public'
                    and tablename  = 'operator_token_ranges'
                    and indexname  = 'operator_token_ranges_one_per_start')

  union all select 'cursor_at exists',
         exists (select 1 from information_schema.columns
                  where table_schema = 'public'
                    and table_name   = 'operator_token_ranges'
                    and column_name  = 'cursor_at')

  -- NULLABLE by design: it means "never issued from", which is every row
  -- that already exists tonight.
  union all select 'cursor_at is nullable',
         (select is_nullable = 'YES' from information_schema.columns
           where table_schema = 'public'
             and table_name   = 'operator_token_ranges'
             and column_name  = 'cursor_at')

  -- 0072's per-range cursor must survive — this migration builds on it.
  union all select 'next_token still there',
         exists (select 1 from information_schema.columns
                  where table_schema = 'public'
                    and table_name   = 'operator_token_ranges'
                    and column_name  = 'next_token')

  union all select 'admin_drop_token_range exists',
         to_regprocedure('public.admin_drop_token_range(uuid)') is not null

  union all select 'admin_token_roster returns range_id',
         (select count(*) = 1 from information_schema.parameters
           where specific_schema = 'public'
             and parameter_mode  = 'OUT'
             and parameter_name  = 'range_id'
             and specific_name in (
               select specific_name from information_schema.routines
                where specific_schema = 'public' and routine_name = 'admin_token_roster'
             ))

  union all select 'roster is executable by a signed-in user',
         has_function_privilege('authenticated', 'public.admin_token_roster(uuid,date)', 'execute')

  union all select 'drop range is executable by a signed-in user',
         has_function_privilege('authenticated', 'public.admin_drop_token_range(uuid)', 'execute')

  -- The operator-facing allocator must stay OFF limits: it is called from
  -- inside operator_check_in, never directly.
  union all select 'allocate stays internal',
         not has_function_privilege('authenticated', 'public.allocate_operator_token(uuid,uuid)', 'execute')

  -- No operator should end up holding two overlapping ranges. Nothing can
  -- create one through the RPC; this catches data written another way.
  union all select 'no operator holds overlapping ranges',
         not exists (
           select 1
           from public.operator_token_ranges a
           join public.operator_token_ranges b
             on b.property_id  = a.property_id
            and b.service_date = a.service_date
            and b.operator_id  = a.operator_id
            and b.id          <> a.id
            and b.range_start <= a.range_end
            and b.range_end   >= a.range_start
           where a.is_active and b.is_active
         )

  -- next_token has to stay inside its own range or the walk starts outside
  -- the set it is walking.
  union all select 'every cursor is inside its range',
         not exists (select 1 from public.operator_token_ranges
                      where next_token not between range_start and range_end)
) t
order by ok, check_name;
