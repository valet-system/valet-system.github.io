-- ═══════════════════════════════════════════════════════════════════════
-- 0013 — CHANGE A PERSON'S ROLE AND PROPERTY
--
--   >>> RUN THIS IN THE SUPABASE SQL EDITOR. <<<
--
-- Safe to run more than once. Creates no tables; if the editor warns about
-- RLS, choose "Run without RLS".
--
--
-- WHY THIS IS NOT PART OF admin_update_staff
--
-- Name and number are field edits. Role and property are PERMISSIONS, and
-- every RLS policy in this project is written in terms of them. Putting them
-- behind the same function as "fix a typo in a name" means one authorisation
-- mistake affects both.
--
-- Only a system_admin may call this. A valet_admin can already manage the
-- operators at their property; if they could also set a role, they could
-- promote themselves — or anyone — to valet_admin or system_admin, and the
-- four-property isolation this whole system rests on would be theirs to
-- switch off.
--
--
-- THE THING THAT ACTUALLY BREAKS, AND IS EASY TO MISS
--
-- Changing role or property while somebody is holding a car ORPHANS that car,
-- silently, with no error anywhere:
--
--   operator -> valet_admin, mid-task
--     get_available_operators() only returns operators, so they vanish from
--     the assignment list. My Tasks is not in an admin's navigation, so the
--     card disappears from the screen of the one person who has the keys. The
--     task stays 'assigned' to them forever and no other operator can be sent.
--
--   moved to another property, mid-task
--     claim_task() requires v_task.property_id = the caller's property. Their
--     own task now belongs to a property they are no longer at, so every
--     button on it fails FORBIDDEN. The car is stuck with nobody able to
--     finish it.
--
-- Both leave a real car in a real car park that the system has lost track of,
-- so this function REFUSES while any open task exists and says how many. The
-- fix is thirty seconds of waiting, which is much cheaper than the alternative
-- of un-sticking a task by hand in SQL.
--
-- Name and number are deliberately NOT restricted this way — renaming someone
-- mid-task breaks nothing.
--
--
-- AND THE ONE THAT LOCKS EVERYONE OUT
--
-- A system_admin demoting themselves when they are the only one leaves nobody
-- who can set roles, create properties, or promote a replacement. There is no
-- screen that can recover from that — only hand-written SQL. So it is refused.
-- ═══════════════════════════════════════════════════════════════════════

begin;


create or replace function public.admin_set_staff_role(
  p_user_role_id uuid,
  p_role         text,
  p_property_id  uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_me            uuid;
  v_my_role       text;
  v_target        record;
  v_role          text := nullif(btrim(coalesce(p_role, '')), '');
  v_property      uuid := p_property_id;
  v_open          int;
  v_other_admins  int;
  v_property_name text;
begin
  -- ── who is asking ───────────────────────────────────────────────────
  select ur.id, ur.role into v_me, v_my_role
  from public.user_roles ur
  where ur.user_id = auth.uid() and ur.is_active = true;

  if v_my_role is null then
    raise exception 'FORBIDDEN: you are not signed in as an active user';
  end if;

  -- Not can_manage_staff(): that grants a valet_admin their own operators,
  -- which is right for names and PINs and wrong for permissions.
  if v_my_role <> 'system_admin' then
    raise exception 'FORBIDDEN: only a system admin can change a role or property';
  end if;

  -- ── the target ──────────────────────────────────────────────────────
  select ur.id, ur.name, ur.role, ur.property_id into v_target
  from public.user_roles ur
  where ur.id = p_user_role_id
  for update;

  if v_target.id is null then
    raise exception 'NOT_FOUND: that user no longer exists';
  end if;

  -- ── validate the requested role ──────────────────────────────────────
  if v_role is null or v_role not in ('system_admin', 'valet_admin', 'operator') then
    raise exception 'BAD_ROLE: choose Operator, Valet Admin or System Admin';
  end if;

  -- A system_admin belongs to no single property; everyone else must have one.
  -- There is no CHECK constraint enforcing this on user_roles, so it is
  -- enforced here and in admin_create_staff — the only two paths that write it.
  if v_role = 'system_admin' then
    v_property := null;
  else
    if v_property is null then
      raise exception 'PROPERTY_REQUIRED: choose a property for this role';
    end if;

    select p.name into v_property_name
    from public.properties p where p.id = v_property;

    if v_property_name is null then
      raise exception 'NOT_FOUND: that property does not exist';
    end if;
  end if;

  -- ── nothing to do ───────────────────────────────────────────────────
  -- Checked BEFORE the guards below, so re-saving an unchanged form never
  -- fails just because the person happens to be parking a car right now.
  if v_target.role = v_role and v_target.property_id is not distinct from v_property then
    return jsonb_build_object('changed', false, 'name', v_target.name);
  end if;

  -- ── guard: an open task would be orphaned ───────────────────────────
  select count(*) into v_open
  from public.valet_tasks t
  where t.assigned_operator_id = v_target.id
    and t.status in ('assigned', 'in_progress', 'at_pickup', 're_parking', 'returned');

  if v_open > 0 then
    raise exception
      'HAS_OPEN_TASKS: % still has % car% in hand. Wait until it is finished — moving them now would leave that car assigned to somebody who can no longer complete it.',
      v_target.name, v_open, case when v_open = 1 then '' else 's' end;
  end if;

  -- ── guard: do not remove the last system admin ──────────────────────
  if v_target.role = 'system_admin' and v_role <> 'system_admin' then
    select count(*) into v_other_admins
    from public.user_roles ur
    where ur.role = 'system_admin'
      and ur.is_active = true
      and ur.id <> v_target.id;

    if v_other_admins = 0 then
      raise exception
        'LAST_SYSTEM_ADMIN: % is the only system admin. Promote somebody else first, or nobody will be able to manage roles or properties at all.',
        v_target.name;
    end if;
  end if;

  -- ── write ───────────────────────────────────────────────────────────
  update public.user_roles
     set role        = v_role,
         property_id = v_property
   where id = v_target.id;

  return jsonb_build_object(
    'changed',       true,
    'name',          v_target.name,
    'role',          v_role,
    'property_id',   v_property,
    'property_name', v_property_name,
    'was_self',      v_target.id = v_me
  );
end $fn$;

revoke all    on function public.admin_set_staff_role(uuid, text, uuid) from public, anon;
grant execute on function public.admin_set_staff_role(uuid, text, uuid) to authenticated;

commit;


-- ═══════════════════════════════════════════════════════════════════════
-- VERIFY — every row should say PASS.
-- ═══════════════════════════════════════════════════════════════════════

with checks as (
  select 'admin_set_staff_role exists' as item,
         to_regprocedure('public.admin_set_staff_role(uuid,text,uuid)') is not null as ok
  union all select 'callable by authenticated',
         has_function_privilege('authenticated',
           'public.admin_set_staff_role(uuid,text,uuid)', 'execute')
  union all select 'NOT callable by anon',
         not has_function_privilege('anon',
           'public.admin_set_staff_role(uuid,text,uuid)', 'execute')
  union all select 'refuses non system_admin callers',
         (select prosrc like '%only a system admin can change a role%'
          from pg_proc where oid = 'public.admin_set_staff_role(uuid,text,uuid)'::regprocedure)
  union all select 'guards open tasks',
         (select prosrc like '%HAS_OPEN_TASKS%'
          from pg_proc where oid = 'public.admin_set_staff_role(uuid,text,uuid)'::regprocedure)
  union all select 'guards the last system admin',
         (select prosrc like '%LAST_SYSTEM_ADMIN%'
          from pg_proc where oid = 'public.admin_set_staff_role(uuid,text,uuid)'::regprocedure)
  -- Not a check of this migration, but the invariant it maintains. A FAIL here
  -- means data already violated it before today.
  union all select 'no system_admin currently has a property',
         not exists (select 1 from public.user_roles
                     where role = 'system_admin' and property_id is not null)
  union all select 'no operator or valet_admin is missing a property',
         not exists (select 1 from public.user_roles
                     where role in ('operator', 'valet_admin') and property_id is null)
)
select item, case when ok then 'PASS' else 'FAIL' end as result
from checks
order by result desc, item;
