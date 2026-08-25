-- ═══════════════════════════════════════════════════════════════════════
-- MIGRATION 0038 — let the webhook actually CALL the guest RPCs
--
-- Symptom: a guest taps "Get My Car", the webhook recognises the button, and
-- the guest is answered "Sorry, something went wrong. Please speak to the valet
-- desk." Nothing is queued and no task is created.
--
-- Cause, and it is a hole two migrations wide:
--
--   0033 ends with
--       revoke execute on function public.guest_request_retrieval(text)
--         from public, anon, authenticated;
--
--   That is right in intent — a guest RPC must not be reachable by a browser.
--   But Postgres grants EXECUTE to PUBLIC on every new function, and revoking
--   PUBLIC removes it for EVERY role that had no explicit grant of its own.
--   service_role is one of those roles.
--
--   0002 looks like it covers this and does not:
--       alter default privileges in schema public grant all on tables    to service_role;
--       alter default privileges in schema public grant all on sequences to service_role;
--
--   Tables and sequences. Not functions. So nothing ever granted service_role
--   execute on these two, and the webhook — which is service_role — was denied.
--
-- ── WHY THIS FAILED SO QUIETLY ────────────────────────────────────────
-- The webhook catches the error, logs it, and still answers the guest, because
-- leaving somebody on read after they tapped a button is worse than a vague
-- apology. That is the right behaviour and it is also why this looked like a
-- WhatsApp problem for a while: the guest gets a reply, Meta reports success,
-- and the only trace is one line in the function log.
--
-- ── WHY NOT JUST DROP THE REVOKE ──────────────────────────────────────
-- Because the revoke is doing real work. These functions take a phone number
-- and act on whatever car it finds — no auth.uid(), no session. Reachable by
-- anon it would let anyone with the project URL request any guest's car by
-- guessing numbers. It must stay revoked from browsers and granted only to the
-- server that verified Meta's signature first.
-- ═══════════════════════════════════════════════════════════════════════

begin;

grant execute on function public.guest_request_retrieval(text)        to service_role;
grant execute on function public.guest_record_review(text, text)      to service_role;

-- phone_tail is called from inside those two, which are security definer and so
-- run as the owner — it does not need a grant of its own. Granted anyway, for
-- the case where someone later calls it directly from a function that is not.
grant execute on function public.phone_tail(text)                     to service_role;

commit;


-- ═══════════════════════════════════════════════════════════════════════
-- VERIFY — every row must read PASS
-- ═══════════════════════════════════════════════════════════════════════
select check_name, case when ok then 'PASS' else 'FAIL' end as result
from (
  select 'service_role may run guest_request_retrieval' as check_name,
         has_function_privilege('service_role',
           'public.guest_request_retrieval(text)', 'execute') as ok

  union all select 'service_role may run guest_record_review',
         has_function_privilege('service_role',
           'public.guest_record_review(text,text)', 'execute')

  union all select 'service_role may run phone_tail',
         has_function_privilege('service_role', 'public.phone_tail(text)', 'execute')

  -- The revoke must SURVIVE. If a browser can reach these, anyone with the
  -- project URL can request any guest's car by guessing phone numbers.
  union all select 'anon still may NOT run guest_request_retrieval',
         not has_function_privilege('anon',
           'public.guest_request_retrieval(text)', 'execute')

  union all select 'authenticated still may NOT run guest_request_retrieval',
         not has_function_privilege('authenticated',
           'public.guest_request_retrieval(text)', 'execute')

  union all select 'anon still may NOT run guest_record_review',
         not has_function_privilege('anon',
           'public.guest_record_review(text,text)', 'execute')
) t
order by ok, check_name;
