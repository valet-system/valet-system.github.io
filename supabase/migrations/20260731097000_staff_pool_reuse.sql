-- ═══════════════════════════════════════════════════════════════════════
-- MIGRATION 0070 — reuse an operator across venues instead of re-adding them
--
--   >>> RUN THIS IN THE SUPABASE SQL EDITOR. <<<
--
-- Safe to run more than once. Creates no tables; if the editor warns about
-- RLS, choose "Run without RLS".
--
--
-- THE PROBLEM
--
-- A staff row is one operator at one property (user_roles.property_id), and
-- the phone number that identifies them is UNIQUE GLOBALLY, not per property
-- (migration 0004's user_roles_phone_key). Deactivating someone — the normal
-- "they don't work here any more" action — does NOT free that phone number;
-- only the irreversible admin_delete_staff does (migration 0063).
--
-- So an operator who moves from one venue to another, or who splits time
-- between two, could not be re-added at the second venue at all: Add Staff
-- always INSERTs a brand new row, which collides on the phone number of the
-- row already sitting there, active or not. The only existing fix was
-- admin_set_staff_role (migration 0013) — but that is system_admin only, and
-- there was no UI path to find the existing row in the first place.
--
--
-- THE FIX — a pool to pick from, not a form to refill
--
--   admin_search_staff_pool(query)
--     Every operator that exists, anywhere, active or not — name, phone,
--     current property. SECURITY DEFINER because a valet_admin's own RLS
--     scope is one property; finding somebody to reuse means looking past it
--     on purpose, in a function that returns nothing but the few fields the
--     Add screen needs to show a pick-list, not the row itself.
--
--   admin_attach_operator(user_role_id, property_id)
--     Points that SAME row at a (possibly new) property and reactivates it.
--     No new row, no new phone number, no collision — and every task they
--     ever completed anywhere stays attributed to the one row that always
--     represented them.
--
--     A valet_admin may only ever land someone on their OWN property — the
--     argument is accepted and then discarded for them, the same pattern
--     admin_create_staff already uses for role and property, so there is no
--     client-supplied value that needs validating. A system_admin must name
--     one.
--
--     Refuses exactly like admin_set_staff_role: an operator holding a car
--     right now cannot be moved, because the car would be orphaned the same
--     way — stuck 'assigned' to somebody who can no longer reach it wherever
--     it is parked.
--
--     Restricted to role = 'operator' on both ends. Valet admins, system
--     admins and vendors are named individuals with a role that carries real
--     permissions (migration 0013's whole point) — not a shift-work pool to
--     be picked off a list.
-- ═══════════════════════════════════════════════════════════════════════

begin;

create or replace function public.admin_search_staff_pool(p_query text default '')
returns table (
  id            uuid,
  name          text,
  phone         text,
  is_active     boolean,
  property_id   uuid,
  property_name text
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_my_role uuid;
  v_role    text;
  v_needle  text := nullif(btrim(coalesce(p_query, '')), '');
  v_digits  text := regexp_replace(coalesce(p_query, ''), '\D', '', 'g');
begin
  select ur.role into v_role
  from public.user_roles ur
  where ur.user_id = auth.uid() and ur.is_active = true;

  if v_role is null then
    raise exception 'FORBIDDEN: you are not signed in as an active user';
  end if;
  if v_role not in ('system_admin', 'valet_admin') then
    raise exception 'FORBIDDEN: you do not have permission to manage staff';
  end if;

  return query
  select ur.id, ur.name, ur.phone, ur.is_active, ur.property_id, p.name
  from public.user_roles ur
  left join public.properties p on p.id = ur.property_id
  where ur.role = 'operator'
    and ur.deleted_at is null
    and (
      v_needle is null
      or ur.name ilike '%' || v_needle || '%'
      or (length(v_digits) >= 3 and ur.phone like '%' || v_digits || '%')
    )
  order by ur.is_active desc, ur.name
  limit 100;
end $fn$;

revoke all    on function public.admin_search_staff_pool(text) from public, anon;
grant execute on function public.admin_search_staff_pool(text) to authenticated;


create or replace function public.admin_attach_operator(
  p_user_role_id uuid,
  p_property_id  uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_my_role       text;
  v_my_property   uuid;
  v_property      uuid;
  v_property_name text;
  v_target        record;
  v_open          int;
  v_was_active    boolean;
  v_from_property uuid;
begin
  select ur.role, ur.property_id into v_my_role, v_my_property
  from public.user_roles ur
  where ur.user_id = auth.uid() and ur.is_active = true;

  if v_my_role is null then
    raise exception 'FORBIDDEN: you are not signed in as an active user';
  end if;
  if v_my_role not in ('system_admin', 'valet_admin') then
    raise exception 'FORBIDDEN: you do not have permission to manage staff';
  end if;

  -- Discarded and replaced for a valet_admin, not validated — same pattern
  -- as admin_create_staff, so there is nothing a client can send here that
  -- lands them anywhere but their own property.
  if v_my_role = 'valet_admin' then
    v_property := v_my_property;
  else
    v_property := p_property_id;
    if v_property is null then
      raise exception 'PROPERTY_REQUIRED: choose a property for this operator';
    end if;
  end if;

  select p.name into v_property_name
  from public.properties p
  where p.id = v_property and p.is_active = true;

  if v_property_name is null then
    raise exception 'NOT_FOUND: that property does not exist';
  end if;

  select ur.id, ur.name, ur.role, ur.property_id, ur.is_active
    into v_target
  from public.user_roles ur
  where ur.id = p_user_role_id and ur.deleted_at is null
  for update;

  if v_target.id is null then
    raise exception 'NOT_FOUND: that person no longer exists';
  end if;

  if v_target.role <> 'operator' then
    raise exception 'BAD_ROLE: only an operator can be added this way';
  end if;

  -- Nothing to do: already active right here.
  if v_target.is_active and v_target.property_id = v_property then
    return jsonb_build_object('changed', false, 'name', v_target.name);
  end if;

  -- Same guard as admin_set_staff_role: moving somebody holding a car right
  -- now would leave that car assigned to somebody who can no longer reach
  -- it, wherever it is parked.
  select count(*) into v_open
  from public.valet_tasks t
  where t.assigned_operator_id = v_target.id
    and t.status in ('assigned', 'in_progress', 'at_pickup', 're_parking', 'returned');

  if v_open > 0 then
    raise exception
      'HAS_OPEN_TASKS: % still has % car% in hand. Wait until it is finished — moving them now would leave that car assigned to somebody who can no longer complete it.',
      v_target.name, v_open, case when v_open = 1 then '' else 's' end;
  end if;

  v_was_active := v_target.is_active;
  v_from_property := v_target.property_id;

  update public.user_roles
     set property_id = v_property,
         is_active   = true
   where id = v_target.id;

  return jsonb_build_object(
    'changed',       true,
    'name',          v_target.name,
    'property_id',   v_property,
    'property_name', v_property_name,
    'reactivated',   not v_was_active,
    'moved',         v_from_property is distinct from v_property
  );
end $fn$;

revoke all    on function public.admin_attach_operator(uuid, uuid) from public, anon;
grant execute on function public.admin_attach_operator(uuid, uuid) to authenticated;

commit;


-- ═══════════════════════════════════════════════════════════════════════
-- VERIFY — every row should say PASS.
-- ═══════════════════════════════════════════════════════════════════════

with checks as (
  select 'admin_search_staff_pool exists' as item,
         to_regprocedure('public.admin_search_staff_pool(text)') is not null as ok
  union all select 'admin_attach_operator exists',
         to_regprocedure('public.admin_attach_operator(uuid,uuid)') is not null
  union all select 'search callable by authenticated',
         has_function_privilege('authenticated',
           'public.admin_search_staff_pool(text)', 'execute')
  union all select 'attach callable by authenticated',
         has_function_privilege('authenticated',
           'public.admin_attach_operator(uuid,uuid)', 'execute')
  union all select 'NOT callable by anon (search)',
         not has_function_privilege('anon',
           'public.admin_search_staff_pool(text)', 'execute')
  union all select 'NOT callable by anon (attach)',
         not has_function_privilege('anon',
           'public.admin_attach_operator(uuid,uuid)', 'execute')
  union all select 'attach guards open tasks',
         (select prosrc like '%HAS_OPEN_TASKS%'
          from pg_proc where oid = 'public.admin_attach_operator(uuid,uuid)'::regprocedure)
  union all select 'attach restricted to operators',
         (select prosrc like '%only an operator can be added this way%'
          from pg_proc where oid = 'public.admin_attach_operator(uuid,uuid)'::regprocedure)
)
select item, case when ok then 'PASS' else 'FAIL' end as result
from checks
order by item;
