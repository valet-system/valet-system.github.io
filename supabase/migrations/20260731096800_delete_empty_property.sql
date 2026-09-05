-- ═══════════════════════════════════════════════════════════════════════
-- MIGRATION 0068 — a system admin can delete a property that was never used
--
-- On request. The case this exists for is a site added by mistake: a typo, a
-- duplicate, a "test". Those sit in the tab strip for ever because the only
-- action available is Close, and a closed site still takes a tab and still
-- appears in every property picker.
--
-- ── WHAT THIS DELIBERATELY DOES NOT DO ────────────────────────────────
-- It does not delete a property that has been USED. Properties.jsx has said
-- "A PROPERTY IS NEVER DELETED" since it was written, and for a site with
-- history that remains exactly right: seven tables point at a property, and
-- between them they are the record of cars real people handed over.
--
--     parked_vehicles   every car ever parked there
--     valet_tasks       every job done there
--     reviews           every rating a guest left
--     token_ranges      the numbering for every service day
--     parking_spaces    the bays
--     user_roles        the staff, including deleted ones
--     wa_outbox         the messages sent to guests
--
-- A delete that cascaded through those would erase months of history to tidy a
-- tab strip. A delete that nulled the references would leave that history
-- pointing nowhere, which is worse: the rows survive and quietly stop meaning
-- anything.
--
-- So this refuses, and says what is in the way. The refusal is the feature —
-- it is what makes the button safe to offer at all.
--
-- ── WHY user_roles COUNTS DELETED STAFF ───────────────────────────────
-- A staff row deleted by admin_delete_staff (0063) keeps its property_id: the
-- row survives so that parked_by and fetched_by still resolve for every car
-- that person handled. Removing the property under it would break exactly the
-- history 0063 went to lengths to preserve, so a deleted operator still blocks
-- the delete — and is still counted, because "1 staff member" beside a list
-- showing none is the kind of message that gets called a bug.
--
-- ── THE COUNTS ARE RETURNED, NOT JUST THE REFUSAL ─────────────────────
-- "Cannot delete" tells an admin nothing they can act on. The exception names
-- the first thing standing in the way and how many, so the answer to "why not"
-- arrives with the refusal instead of requiring a second conversation.
-- ═══════════════════════════════════════════════════════════════════════

begin;

create or replace function public.admin_delete_property(p_property_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_caller_role text;
  v_target      record;
  v_vehicles    bigint;
  v_tasks       bigint;
  v_reviews     bigint;
  v_tokens      bigint;
  v_spaces      bigint;
  v_staff       bigint;
  v_messages    bigint;
  v_blocker     text;
  v_count       bigint;
begin
  -- ── WHO IS ASKING ───────────────────────────────────────────────────
  select ur.role into v_caller_role
  from public.user_roles ur
  where ur.user_id = auth.uid()
    and ur.is_active = true
    and ur.deleted_at is null;

  if v_caller_role is null then
    raise exception 'FORBIDDEN: you are not signed in as an active user';
  end if;

  -- System admin only. A valet admin manages one site and has no business
  -- removing it; the RLS policy on properties already refuses them every other
  -- write, and this keeps the two consistent.
  if v_caller_role <> 'system_admin' then
    raise exception 'FORBIDDEN: only a system admin can delete a property';
  end if;

  select p.id, p.name, p.is_active into v_target
  from public.properties p
  where p.id = p_property_id
  for update;

  if v_target.id is null then
    raise exception 'NOT_FOUND: that property no longer exists';
  end if;

  -- ── WHAT POINTS AT IT ───────────────────────────────────────────────
  select count(*) into v_vehicles from public.parked_vehicles where property_id = p_property_id;
  select count(*) into v_tasks    from public.valet_tasks     where property_id = p_property_id;
  select count(*) into v_reviews  from public.reviews         where property_id = p_property_id;
  select count(*) into v_tokens   from public.token_ranges    where property_id = p_property_id;
  select count(*) into v_spaces   from public.parking_spaces  where property_id = p_property_id;
  select count(*) into v_messages from public.wa_outbox       where property_id = p_property_id;
  -- Deleted staff included, deliberately. See the header.
  select count(*) into v_staff    from public.user_roles      where property_id = p_property_id;

  -- ── THE REFUSAL, NAMING THE FIRST THING IN THE WAY ──────────────────
  -- Ordered by what an admin can most readily act on: bays and staff can be
  -- moved or removed, a night's cars cannot.
  v_blocker := null;
  if    v_vehicles > 0 then v_blocker := 'cars parked there';        v_count := v_vehicles;
  elsif v_tasks    > 0 then v_blocker := 'valet jobs';               v_count := v_tasks;
  elsif v_reviews  > 0 then v_blocker := 'guest reviews';            v_count := v_reviews;
  elsif v_messages > 0 then v_blocker := 'WhatsApp messages';        v_count := v_messages;
  elsif v_tokens   > 0 then v_blocker := 'daily token ranges';       v_count := v_tokens;
  elsif v_staff    > 0 then v_blocker := 'staff accounts';           v_count := v_staff;
  elsif v_spaces   > 0 then v_blocker := 'parking spaces';           v_count := v_spaces;
  end if;

  if v_blocker is not null then
    raise exception
      'IN_USE: % has % % on record. Close it instead — deleting it would take that history with it.',
      v_target.name, v_count, v_blocker;
  end if;

  -- ── NOTHING POINTS AT IT ────────────────────────────────────────────
  delete from public.properties where id = p_property_id;

  return jsonb_build_object('code', 'deleted', 'name', v_target.name);
end $fn$;

revoke all    on function public.admin_delete_property(uuid) from public, anon;
grant execute on function public.admin_delete_property(uuid) to authenticated;

commit;


-- ═══════════════════════════════════════════════════════════════════════
-- VERIFY — every row must read PASS
-- ═══════════════════════════════════════════════════════════════════════
select check_name, case when ok then 'PASS' else 'FAIL' end as result
from (
  select 'admin_delete_property exists' as check_name,
         to_regprocedure('public.admin_delete_property(uuid)') is not null as ok

  union all select 'only a system admin may call it',
         (select prosrc like '%v_caller_role <> ''system_admin''%' from pg_proc
           where pronamespace = 'public'::regnamespace and proname = 'admin_delete_property')

  -- ── EVERY REFERENCING TABLE IS CHECKED ──────────────────────────────
  -- Seven tables carry a property_id. Missing one would let a delete through
  -- that the foreign key then refuses with 23503 — or worse, succeeds and
  -- orphans the rows. Each is asserted by name.
  union all select 'it counts parked cars',
         (select prosrc like '%from public.parked_vehicles where property_id%' from pg_proc
           where pronamespace = 'public'::regnamespace and proname = 'admin_delete_property')
  union all select 'it counts valet jobs',
         (select prosrc like '%from public.valet_tasks%' from pg_proc
           where pronamespace = 'public'::regnamespace and proname = 'admin_delete_property')
  union all select 'it counts reviews',
         (select prosrc like '%from public.reviews%' from pg_proc
           where pronamespace = 'public'::regnamespace and proname = 'admin_delete_property')
  union all select 'it counts token ranges',
         (select prosrc like '%from public.token_ranges%' from pg_proc
           where pronamespace = 'public'::regnamespace and proname = 'admin_delete_property')
  union all select 'it counts parking spaces',
         (select prosrc like '%from public.parking_spaces%' from pg_proc
           where pronamespace = 'public'::regnamespace and proname = 'admin_delete_property')
  union all select 'it counts staff',
         (select prosrc like '%from public.user_roles%' from pg_proc
           where pronamespace = 'public'::regnamespace and proname = 'admin_delete_property')
  union all select 'it counts WhatsApp messages',
         (select prosrc like '%from public.wa_outbox%' from pg_proc
           where pronamespace = 'public'::regnamespace and proname = 'admin_delete_property')

  -- THE REFUSAL ITSELF. Without it this is a delete that destroys history.
  union all select 'it refuses a property in use',
         (select prosrc like '%IN_USE:%' from pg_proc
           where pronamespace = 'public'::regnamespace and proname = 'admin_delete_property')

  union all select 'and names how much is in the way',
         (select prosrc like '%on record. Close it instead%' from pg_proc
           where pronamespace = 'public'::regnamespace and proname = 'admin_delete_property')

  -- ── NO TABLE-LEVEL DELETE WAS GRANTED ───────────────────────────────
  -- The project grants DELETE on nothing by design; this function is security
  -- definer precisely so that stays true. If a grant appeared, a browser could
  -- delete a property directly and skip every check above.
  union all select 'staff still cannot delete a property directly',
         not has_table_privilege('authenticated', 'public.properties', 'delete')

  union all select 'anon cannot call the function',
         not has_function_privilege('anon', 'public.admin_delete_property(uuid)', 'execute')

  union all select 'signed-in staff may call it (the role check decides)',
         has_function_privilege('authenticated', 'public.admin_delete_property(uuid)', 'execute')

  -- Nothing should have been removed by running this migration.
  union all select 'no property was deleted by this migration',
         (select count(*) > 0 from public.properties)
) t
order by ok, check_name;
