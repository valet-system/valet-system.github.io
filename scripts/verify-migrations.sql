-- Kya saari 6 migrations lag gayi? Har row PASS hona chahiye.
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

  -- The report API from earlier today.
  union all select '0037 report_api',
         to_regprocedure('public.is_service_call()') is not null
) t
order by ok, migration;
