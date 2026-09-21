-- ═══════════════════════════════════════════════════════════════════════
-- MIGRATION 0072 — FIX: round robin was jumping BACKWARD to whichever
-- number freed up first, instead of moving FORWARD through the range.
--
--   >>> RUN THIS IN THE SUPABASE SQL EDITOR. <<<
--
-- Safe to run more than once.
--
--
-- THE BUG, AS REPORTED
--
-- Ramesh's range is 25-35. He parks cars 25, 26, 27, 28, 29, 30, 31 in
-- order (7 cars). Token 29's car is delivered, freeing it. His 8th car
-- should get 32 — the range keeps moving forward, 32, 33, 34, 35, and only
-- THEN wraps back to the numbers that freed up earlier, in the order they
-- come around: 25, 26, 27, 28, 29 (now free), ... His 8th car got 29
-- instead, because migration 0071's allocate_operator_token() always
-- picked the LOWEST free number in the whole range — 25 is lower than 32,
-- so the moment 29 freed up (still not the lowest — 25-28 were still out —
-- but lower than 32), it jumped there, well ahead of the numbers actually
-- next in sequence.
--
-- 0071's own header reasoned this was MORE correct than a wrapping cursor,
-- using an out-of-order-delivery example to argue a cursor would falsely
-- report TOKEN_RANGE_EXHAUSTED. That reasoning was wrong about which
-- behavior the product actually wants: the whole point of "round robin" —
-- 1, 2, 3, 4, 5, 1, 2, ... — is that it moves forward through the range and
-- only revisits a number once everything after it has also been tried.
-- Jumping straight to the first thing that frees up, regardless of where
-- the range currently is, is a different (and, per this report, wrong)
-- policy — it is a stack of reused numbers, not a round-robin queue of them.
--
--
-- THE FIX
--
-- operator_token_ranges gains next_token — the same idea as the OLD
-- token_ranges.next_token, but bounded to the operator's own range and
-- WRAPPING at range_end back to range_start, instead of stopping there.
--
-- allocate_operator_token() now walks forward from next_token, one slot at
-- a time, wrapping around, for at most one full lap of the range. It takes
-- the first slot with no currently-active (non-delivered) car and leaves
-- next_token pointing just past it — so the search space still exists (a
-- car delivered out of order is still found once the lap reaches it,
-- exactly as 0071 wanted), but the search always starts from where
-- issuance actually left off, not from the bottom of the range.
--
--
-- BACKFILL
--
-- Existing operator_token_ranges rows (created under 0071, already handing
-- out numbers tonight) get next_token set to one past the HIGHEST token
-- number ever issued in that range today, wrapping to range_start if that
-- highest number was range_end itself. That is the same position the
-- cursor would already be sitting at if it had existed from the first
-- check-in of the night — so a range mid-shift resumes exactly where it
-- left off rather than restarting from range_start and re-offering numbers
-- already on stubs in guests' pockets.
-- ═══════════════════════════════════════════════════════════════════════

begin;

-- ═══════════════════════════════════════════════════════════════════════
-- 1. THE COLUMN
-- ═══════════════════════════════════════════════════════════════════════

alter table public.operator_token_ranges
  add column if not exists next_token int;

update public.operator_token_ranges otr
   set next_token = coalesce(
     (
       select case when max(v.token_number) = otr.range_end
                   then otr.range_start
                   else max(v.token_number) + 1
              end
       from public.parked_vehicles v
       where v.property_id  = otr.property_id
         and v.service_date = otr.service_date
         and v.token_number between otr.range_start and otr.range_end
     ),
     otr.range_start
   )
 where next_token is null;

alter table public.operator_token_ranges
  alter column next_token set not null;

alter table public.operator_token_ranges
  drop constraint if exists operator_token_ranges_next_token_chk;
alter table public.operator_token_ranges
  add constraint operator_token_ranges_next_token_chk
  check (next_token between range_start and range_end);

comment on column public.operator_token_ranges.next_token is
  'Where allocate_operator_token() resumes its forward search next. Wraps at range_end back to range_start — see migration 0072.';


-- ═══════════════════════════════════════════════════════════════════════
-- 2. allocate_operator_token — walk forward from next_token, wrap once
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
  v_range  public.operator_token_ranges;
  v_size   int;
  v_token  int;
  i        int;
begin
  if p_property_id is null then
    raise exception 'PROPERTY_REQUIRED';
  end if;

  if not (public.is_system_admin() or p_property_id = public.my_property_id()) then
    raise exception 'FORBIDDEN_PROPERTY';
  end if;

  select * into v_range
  from public.operator_token_ranges otr
  where otr.property_id  = p_property_id
    and otr.operator_id  = p_operator_id
    and otr.service_date = public.ist_today()
    and otr.is_active    = true
  for update;

  if v_range.id is null then
    raise exception 'NO_TOKEN_RANGE: you have not been given a token range for tonight — ask your admin to assign you one';
  end if;

  v_size := v_range.range_end - v_range.range_start + 1;

  -- One lap, starting at next_token: 32, 33, 34, 35, 25, 26, ... A slot
  -- still on the floor (a non-delivered car sitting on that number) is
  -- skipped; the lap gives up only once every slot in the range has been
  -- tried and none is free.
  for i in 0 .. v_size - 1 loop
    v_token := v_range.range_start + ((v_range.next_token - v_range.range_start + i) % v_size);

    if not exists (
      select 1 from public.parked_vehicles v
      where v.property_id  = p_property_id
        and v.token_number = v_token
        and v.status       <> 'delivered'
    ) then
      update public.operator_token_ranges
         set next_token = case when v_token = v_range.range_end then v_range.range_start else v_token + 1 end,
             updated_at = now()
       where id = v_range.id;

      return v_token;
    end if;
  end loop;

  raise exception 'TOKEN_RANGE_EXHAUSTED: your range (% to %) is fully in use — ask your admin to extend it before checking in another car',
    v_range.range_start, v_range.range_end;
end $fn$;

revoke execute on function public.allocate_operator_token(uuid, uuid)
  from public, anon, authenticated;


-- ═══════════════════════════════════════════════════════════════════════
-- 3. admin_assign_token_range — seed next_token when a range is CREATED
--
-- Reprinted from 0071 with one change: the INSERT on the create path now
-- sets next_token = range_start, the same starting point range_end and
-- range_start themselves get. Nothing else changes — extending an existing
-- row never touches next_token, since issuance should carry on from
-- wherever it already was, not jump back to the start.
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
  v_existing    public.operator_token_ranges;
  v_collide     record;
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

  select * into v_existing
  from public.operator_token_ranges otr
  where otr.property_id  = v_property
    and otr.service_date = v_date
    and otr.operator_id  = p_operator_id
  for update;

  if v_existing.id is null then
    -- ── CREATE ──────────────────────────────────────────────────────
    if p_range_start is null then
      raise exception 'RANGE_REQUIRED: enter the first token in %s range', v_operator.name;
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

    select ur.name, otr.range_start, otr.range_end
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
      raise exception 'RANGE_OVERLAP: % to % overlaps %''s range (% to %) tonight',
        p_range_start, p_range_end, v_collide.name, v_collide.range_start, v_collide.range_end;
    end if;

    insert into public.operator_token_ranges
      (property_id, service_date, operator_id, range_start, range_end, next_token)
    values
      (v_property, v_date, p_operator_id, p_range_start, p_range_end, p_range_start)
    returning * into v_existing;

    return jsonb_build_object(
      'created',       true,
      'operator_id',   p_operator_id,
      'operator_name', v_operator.name,
      'range_start',   v_existing.range_start,
      'range_end',     v_existing.range_end
    );
  end if;

  -- ── EXTEND ONLY ───────────────────────────────────────────────────
  if p_range_end <= v_existing.range_end then
    raise exception 'ONLY_BIGGER: %''s range already reaches % — enter a number above it',
      v_operator.name, v_existing.range_end;
  end if;
  if p_range_end - v_existing.range_start + 1 > 500 then
    raise exception 'BAD_RANGE: that range is unusually large — check the number';
  end if;

  select ur.name, otr.range_start, otr.range_end
    into v_collide
  from public.operator_token_ranges otr
  join public.user_roles ur on ur.id = otr.operator_id
  where otr.property_id  = v_property
    and otr.service_date = v_date
    and otr.operator_id  <> p_operator_id
    and otr.is_active    = true
    and otr.range_start  <= p_range_end
    and otr.range_end    >= v_existing.range_start
  limit 1;

  if v_collide.name is not null then
    raise exception 'RANGE_OVERLAP: extending to % overlaps %''s range (% to %) tonight',
      p_range_end, v_collide.name, v_collide.range_start, v_collide.range_end;
  end if;

  update public.operator_token_ranges
     set range_end  = p_range_end,
         is_active  = true,
         updated_at = now()
   where id = v_existing.id;

  return jsonb_build_object(
    'created',       false,
    'operator_id',   p_operator_id,
    'operator_name', v_operator.name,
    'range_start',   v_existing.range_start,
    'range_end',     p_range_end
  );
end $fn$;

revoke all    on function public.admin_assign_token_range(uuid, int, int, date, uuid) from public, anon;
grant execute on function public.admin_assign_token_range(uuid, int, int, date, uuid) to authenticated;

commit;


-- ═══════════════════════════════════════════════════════════════════════
-- VERIFY — every row should say PASS.
-- ═══════════════════════════════════════════════════════════════════════

with checks as (
  select 'operator_token_ranges.next_token exists' as item,
         exists (
           select 1 from information_schema.columns
           where table_schema = 'public' and table_name = 'operator_token_ranges'
             and column_name = 'next_token'
         ) as ok
  union all select 'next_token is not null on every row',
         not exists (select 1 from public.operator_token_ranges where next_token is null)
  union all select 'next_token bounds constraint exists',
         exists (
           select 1 from pg_constraint
           where conname = 'operator_token_ranges_next_token_chk'
         )
  union all select 'allocate_operator_token walks forward from next_token',
         (select prosrc like '%v_range.next_token - v_range.range_start%'
            from pg_proc where oid = 'public.allocate_operator_token(uuid,uuid)'::regprocedure)
  union all select 'allocate_operator_token NOT callable by authenticated',
         not has_function_privilege('authenticated',
           'public.allocate_operator_token(uuid,uuid)', 'execute')
  union all select 'admin_assign_token_range seeds next_token on create',
         (select prosrc like '%range_start, range_end, next_token%'
            from pg_proc where oid = 'public.admin_assign_token_range(uuid,int,int,date,uuid)'::regprocedure)
  union all select 'admin_assign_token_range callable by authenticated',
         has_function_privilege('authenticated',
           'public.admin_assign_token_range(uuid,int,int,date,uuid)', 'execute')
)
select item, case when ok then 'PASS' else 'FAIL' end as result
from checks
order by result desc, item;
