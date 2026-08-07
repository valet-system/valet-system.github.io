-- ═══════════════════════════════════════════════════════════════════════
-- 0003 — EXPLICIT TABLE GRANTS
--
--   >>> RUN THIS IN THE SUPABASE SQL EDITOR, AFTER 0002. <<<
--
-- Safe to run more than once.
--
-- ── WHY THIS MIGRATION EXISTS ──────────────────────────────────────────
--
-- Postgres checks permission in TWO INDEPENDENT LAYERS, and both must pass:
--
--   LAYER 1 — GRANT (table level)  "may this role touch this table at all?"
--   LAYER 2 — RLS   (row level)    "which rows of it may they see?"
--
-- Almost every Supabase tutorial only ever discusses layer 2, so layer 1 is
-- assumed to be handled by Supabase's default privileges — and usually it is.
-- Not here. Querying public.properties with the anon key on this project
-- returns:
--
--   {"code":"42501","message":"permission denied for table properties"}
--
-- 42501 is a GRANT failure, not an RLS failure. An RLS refusal is silent: you
-- get an empty array, because RLS FILTERS rows rather than rejecting the
-- statement. So the tables created in 0001 did not receive Supabase's default
-- grants.
--
-- ── WHAT WOULD HAVE HAPPENED WITHOUT THIS ──────────────────────────────
--
-- Nothing at all, until the first user logged in. Then EVERY query would fail
-- with 42501, the app would show "You do not have permission to do that." on
-- every screen, and the obvious conclusion would be that the RLS policies in
-- 0002 are wrong. Hours would go into rewriting perfectly correct policies,
-- because the error points at the wrong layer.
--
-- ── WHY WE WRITE GRANTS EXPLICITLY FROM NOW ON ─────────────────────────
--
-- Relying on ALTER DEFAULT PRIVILEGES is invisible and environment-dependent:
-- it silently does the right thing on one project and nothing on another,
-- depending on which role created the table. A migration that states its own
-- grants behaves identically everywhere, including on a fresh `supabase db
-- reset`.
--
-- ── THE PRIVILEGE MODEL, STATED ONCE ───────────────────────────────────
--
--   anon           NOTHING. Not one table. A visitor who has not logged in
--                  has no business reading any of this, and the login flow
--                  itself only needs the /auth endpoints, not table access.
--
--   authenticated  Only the verbs each screen actually performs. Note there
--                  is no DELETE anywhere: this is an audit trail of cars and
--                  money. Records are closed by status, never removed. If
--                  DELETE is not granted, no bug and no compromised operator
--                  account can erase history.
--
--   service_role   Everything, and it bypasses RLS entirely. This is why that
--                  key must never leave Edge Function secrets.
-- ═══════════════════════════════════════════════════════════════════════

begin;

-- ═══════════════════════════════════════════════════════════════════════
-- 1. START FROM ZERO
--
-- Revoke first so this migration fully defines the end state rather than
-- adding to whatever happened to be there already. Without this, a stray
-- GRANT ALL from someone debugging in the SQL editor would survive forever.
-- ═══════════════════════════════════════════════════════════════════════

revoke all on all tables    in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;

-- USAGE on the schema is the prerequisite for touching anything inside it.
-- Without it every table grant below is ignored.
grant usage on schema public to anon, authenticated;


-- ═══════════════════════════════════════════════════════════════════════
-- 2. authenticated — least privilege, table by table
--
-- RLS (from migration 0002) then narrows each of these to the caller's own
-- property. GRANT decides the VERB, RLS decides the ROWS.
-- ═══════════════════════════════════════════════════════════════════════

-- properties
--   read: every screen shows the property name
--   write: system_admin only — enforced by policy properties_admin_write
grant select, insert, update on public.properties to authenticated;

-- user_roles
--   read: own row (login), plus peers at the same property (assign dropdown)
--   write: system_admin only — enforced by policy user_roles_admin_all
grant select, insert, update on public.user_roles to authenticated;

-- token_ranges
--   read: operators, to show "Token 47 / 300"
--   write: valet_admin creating or extending a range
--   (allocate_token() is SECURITY DEFINER and does not depend on this)
grant select, insert, update on public.token_ranges to authenticated;

-- parked_vehicles
--   insert: an operator checking a car in
--   update: status and parking_location as the car moves
grant select, insert, update on public.parked_vehicles to authenticated;

-- valet_tasks
--   insert: the parking task an operator assigns to themselves
--   update: status transitions, and the admin assigning an operator
--   (retrieval tasks are inserted by the webhook using service_role)
grant select, insert, update on public.valet_tasks to authenticated;

-- reviews
--   SELECT ONLY, deliberately. Reviews are written exclusively by the
--   wa-webhook Edge Function with service_role. Without INSERT here, an
--   operator cannot fabricate a glowing review for themselves even if they
--   craft the request by hand — and no amount of frontend code can change
--   that, which is the point.
grant select on public.reviews to authenticated;

-- wa_message_log and wa_outbox: NO GRANT AT ALL.
--   These are backend plumbing. wa_message_log is the WhatsApp dedupe ledger;
--   write access to it would let someone insert a wa_message_id in advance and
--   permanently block a guest's "Get My Car" from ever registering. wa_outbox
--   holds queued guest messages. Only service_role touches either.


-- ═══════════════════════════════════════════════════════════════════════
-- 3. anon — nothing, stated explicitly
--
-- Already revoked in section 1. This block only documents the intent so the
-- absence reads as a decision rather than an oversight.
-- ═══════════════════════════════════════════════════════════════════════

-- (intentionally empty)


-- ═══════════════════════════════════════════════════════════════════════
-- 4. FUTURE TABLES
--
-- ALTER DEFAULT PRIVILEGES applies to tables created FROM NOW ON by the
-- current role. This is a safety net so a table added later is not
-- accidentally unreachable — but it is not a substitute for granting
-- explicitly in the migration that creates it.
--
-- Note it grants no DELETE, keeping the append-only audit rule intact.
-- ═══════════════════════════════════════════════════════════════════════

alter default privileges in schema public
  grant select, insert, update on tables to authenticated;

-- service_role keeps full access to everything, now and in future.
grant all on all tables    in schema public to service_role;
grant all on all sequences in schema public to service_role;
alter default privileges in schema public grant all on tables    to service_role;
alter default privileges in schema public grant all on sequences to service_role;


-- ═══════════════════════════════════════════════════════════════════════
-- 5. RPC FUNCTIONS
--
-- Re-stated here because section 1's blanket REVOKE does not touch functions,
-- but it costs nothing to be certain — these two are what the app calls, and
-- a missing EXECUTE grant on allocate_token means check-in fails outright.
-- ═══════════════════════════════════════════════════════════════════════

grant execute on function public.allocate_token(uuid)            to authenticated;
grant execute on function public.get_available_operators(uuid)   to authenticated;
grant execute on function public.ist_today()                     to authenticated;
grant execute on function public.my_role()                       to authenticated;
grant execute on function public.my_property_id()                to authenticated;
grant execute on function public.my_operator_id()                to authenticated;
grant execute on function public.is_system_admin()               to authenticated;

-- Backend only. An operator must not be able to expire other people's tasks
-- or rewrite the day's token ranges.
revoke execute on function public.expire_stale_pickups(int) from anon, authenticated;
revoke execute on function public.reset_daily_tokens()      from anon, authenticated;

commit;

-- ═══════════════════════════════════════════════════════════════════════
-- VERIFY
-- ═══════════════════════════════════════════════════════════════════════
--
-- Expect: 'authenticated' rows for the 5 writable tables, SELECT only on
-- reviews, and NOT A SINGLE 'anon' row anywhere.
--
-- select grantee, table_name, string_agg(privilege_type, ', ' order by privilege_type) as privileges
-- from information_schema.role_table_grants
-- where table_schema = 'public'
--   and grantee in ('anon', 'authenticated')
-- group by grantee, table_name
-- order by grantee, table_name;
--
-- Expect zero rows (nobody should be able to DELETE anything):
--
-- select grantee, table_name from information_schema.role_table_grants
-- where table_schema = 'public'
--   and privilege_type = 'DELETE'
--   and grantee in ('anon', 'authenticated');
