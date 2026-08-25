-- Har row PASS hona chahiye. Read-only — kuch badalta nahi.
--
-- Yeh sirf "function ban gaya" nahi dekhta. Teen cheezein jo chup-chaap toot
-- sakti hain, unhe alag se check karta hai:
--   0034  trigger wa_outbox pe LAGA hai ya nahi (function ban jaana kaafi nahi)
--   0035  purana capacity wala form HATA hai ya nahi
--   0038  service_role guest RPCs ko CALL kar sakta hai ya nahi
--
-- Woh aakhri wala aaj pakda gaya: 0033 ne PUBLIC se execute cheen liya tha aur
-- service_role ko diya nahi, to webhook button tap pe kuch nahi kar pata tha
-- aur guest ko "Sorry, something went wrong" jaata tha.
select migration, case when ok then 'PASS' else 'FAIL' end as result
from (
  select '0031 task_accept' as migration,
         to_regprocedure('public.task_accept(uuid)') is not null as ok

  union all select '0032 nag_unaccepted',
         to_regprocedure('public.nag_unaccepted_retrievals()') is not null

  union all select '0033 guest_request_retrieval',
         to_regprocedure('public.guest_request_retrieval(text)') is not null

  union all select '0033 guest_record_review',
         to_regprocedure('public.guest_record_review(text,text)') is not null

  union all select '0034 request_wa_dispatch',
         to_regprocedure('public.request_wa_dispatch()') is not null

  -- Trigger, not just the function: 0034 is only doing its job if the trigger
  -- is actually attached to wa_outbox.
  union all select '0034 trigger on wa_outbox',
         exists (select 1 from pg_trigger t
                   join pg_class c on c.oid = t.tgrelid
                  where c.relname = 'wa_outbox'
                    and not t.tgisinternal
                    and t.tgname like '%wa_outbox%')

  union all select '0035 parking_space_usage',
         to_regprocedure('public.parking_space_usage(uuid)') is not null

  -- 0035 removed the capacity limit, so the old 3-arg form must be GONE.
  -- Still present means the migration did not fully apply.
  union all select '0035 old forced form removed',
         to_regprocedure('public.task_complete_parking(uuid,text,boolean)') is null

  union all select '0036 reparking no longer messages',
         (select prosrc not like '%wa_outbox%' from pg_proc
           where pronamespace = 'public'::regnamespace
             and proname = 'task_complete_reparking')

  -- The report API for Ambria Admin.
  union all select '0037 report_api',
         to_regprocedure('public.is_service_call()') is not null

  -- 0038 — the one that makes the guest's "Get My Car" button actually work.
  -- Without it the webhook is denied and the guest is told "Sorry, something
  -- went wrong", which looks like a WhatsApp fault and is not one.
  union all select '0038 webhook may call guest_request_retrieval',
         has_function_privilege('service_role',
           'public.guest_request_retrieval(text)', 'execute')

  union all select '0038 webhook may call guest_record_review',
         has_function_privilege('service_role',
           'public.guest_record_review(text,text)', 'execute')

  -- And the browser still may NOT. These take a phone number and act on
  -- whatever car it finds, with no session — reachable by anon, anyone could
  -- request any guest's car by guessing numbers.
  union all select '0038 anon still cannot call them',
         not has_function_privilege('anon',
           'public.guest_request_retrieval(text)', 'execute')
         and not has_function_privilege('anon',
           'public.guest_record_review(text,text)', 'execute')
) t
order by ok, migration;
