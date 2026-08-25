-- ═══════════════════════════════════════════════════════════════════════
-- MIGRATION 0043 — a review link PER PROPERTY, and the operator on the review
--
-- Two changes to one function, because both are things guest_record_review
-- already had in its hands and threw away.
--
-- ── 1. THE REVIEW LINK BELONGS TO THE PROPERTY, NOT THE APP ───────────
-- A guest who rates Excellent is asked to post it publicly. That link is
-- different for every property — Pushpanjali's Google listing is not Exotica's.
-- Sent from one WA_REVIEW_LINK secret, three quarters of guests would be
-- reviewing the wrong venue, and the venue with the good service would get
-- none of the credit.
--
-- So it lives on the property row, editable from the Properties screen. The
-- function already knows which property the visit belongs to; it just has to
-- carry the link back with the answer.
--
-- ── 2. operator_id — THE COLUMN THAT WAS NEVER FILLED ─────────────────
-- reviews.operator_id has existed since migration 0002, added for exactly one
-- purpose. Its comment there says:
--
--     "Reviews.jsx is specified to filter by operator, but the table had no
--      operator column and valet_tasks.assigned_operator_id can change on a
--      re-park, so it cannot be derived reliably after the fact. Captured at
--      insert time instead."
--
-- Then this function was written and never filled it in. So every rating so far
-- has operator_id NULL and any per-operator report reads empty.
--
-- 0002's warning is about reading it LATER. At this moment it is correct: the
-- task matched below is the specific completed retrieval being rated, and
-- whoever was assigned to it is who handed the car over.
--
-- ── WHAT THIS DOES NOT DO ─────────────────────────────────────────────
-- No backfill. Existing ratings keep operator_id NULL, because deriving them
-- now means reading assigned_operator_id long after the fact — the exact thing
-- 0002 warns gives the wrong person. A wrong name against an operator is worse
-- than no name.
-- ═══════════════════════════════════════════════════════════════════════

begin;

-- ═══════════════════════════════════════════════════════════════════════
-- 1. Somewhere to keep each property's public review link
-- ═══════════════════════════════════════════════════════════════════════

alter table public.properties
  add column if not exists review_link text;

comment on column public.properties.review_link is
  'Public review page for this property (Google, etc). Sent to a guest who '
  'rates Excellent. NULL means they are thanked without a link.';

-- Must start with http(s) or WhatsApp will not render it as a tappable link,
-- and the guest is sent a sentence ending in text they cannot use. Rejecting a
-- bad value at the table is better than discovering it in a guest's chat.
alter table public.properties
  drop constraint if exists properties_review_link_chk;
alter table public.properties
  add constraint properties_review_link_chk
  check (review_link is null or review_link ~* '^https?://.');


-- ═══════════════════════════════════════════════════════════════════════
-- 2. guest_record_review — record the operator, return the property's link
--
-- Everything else is migration 0033's text unchanged: the same rating guard,
-- the same phone check, the same 24-hour bound, the same one-per-visit
-- conflict clause.
-- ═══════════════════════════════════════════════════════════════════════

create or replace function public.guest_record_review(p_phone text, p_rating text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_tail text := public.phone_tail(p_phone);
  v_task record;
begin
  if p_rating not in ('excellent', 'good', 'poor') then
    return jsonb_build_object('ok', false, 'code', 'bad_rating');
  end if;

  if length(v_tail) < 10 then
    return jsonb_build_object('ok', false, 'code', 'bad_phone');
  end if;

  -- The car they just collected. Bounded to a day: a rating that arrives a
  -- week later is about a visit nobody remembers, and attaching it to their
  -- newest completed job would credit the wrong shift.
  --
  -- Two joins-worth of extra columns here, both read ONCE and both needed by
  -- the caller: who handed the car over, and where to send a happy guest.
  select t.id,
         t.property_id,
         t.assigned_operator_id,
         p.review_link
    into v_task
  from public.valet_tasks t
  join public.parked_vehicles v on v.id = t.vehicle_id
  join public.properties p      on p.id = t.property_id
  where t.task_type = 'retrieval'
    and t.status    = 'completed'
    and t.completed_at > now() - interval '24 hours'
    and public.phone_tail(v.guest_phone) = v_tail
  order by t.completed_at desc
  limit 1;

  if v_task.id is null then
    return jsonb_build_object('ok', false, 'code', 'no_recent_visit');
  end if;

  insert into public.reviews (task_id, property_id, guest_phone, rating, operator_id)
  values (v_task.id, v_task.property_id, v_tail, p_rating, v_task.assigned_operator_id)
  on conflict (task_id) where task_id is not null do nothing;

  -- The link is returned on BOTH paths. A guest who taps Excellent twice is
  -- still a guest who would post a review, and answering the second tap without
  -- the link would look like the offer was withdrawn.
  if not found then
    return jsonb_build_object('ok', true, 'code', 'already_rated',
                              'review_link', v_task.review_link);
  end if;

  return jsonb_build_object('ok', true, 'code', 'rated',
                            'task_id', v_task.id,
                            'review_link', v_task.review_link);
end $fn$;

-- Kept as migration 0038 left it: revoked from every browser role, granted to
-- the server that verified Meta's signature. CREATE OR REPLACE preserves
-- grants, but restated so a reader does not have to know that.
revoke execute on function public.guest_record_review(text, text)
  from public, anon, authenticated;
grant  execute on function public.guest_record_review(text, text) to service_role;

commit;


-- ═══════════════════════════════════════════════════════════════════════
-- VERIFY — every row must read PASS
-- ═══════════════════════════════════════════════════════════════════════
select check_name, case when ok then 'PASS' else 'FAIL' end as result
from (
  select 'properties.review_link exists' as check_name,
         exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'properties'
                    and column_name = 'review_link') as ok

  union all select 'a non-http link is rejected',
         exists (select 1 from pg_constraint
                  where conname = 'properties_review_link_chk')

  union all select 'guest_record_review exists',
         to_regprocedure('public.guest_record_review(text,text)') is not null

  union all select 'it returns the property review link',
         (select prosrc like '%review_link%' from pg_proc
           where pronamespace = 'public'::regnamespace
             and proname = 'guest_record_review')

  union all select 'it records the operator from the task',
         (select prosrc like '%assigned_operator_id%' from pg_proc
           where pronamespace = 'public'::regnamespace
             and proname = 'guest_record_review')

  -- Everything it did before must survive. The conflict clause in particular:
  -- without it a guest tapping twice is two opinions from one person.
  union all select 'one rating per visit still enforced',
         (select prosrc like '%on conflict%' from pg_proc
           where pronamespace = 'public'::regnamespace
             and proname = 'guest_record_review')

  union all select 'the 24-hour bound survived',
         (select prosrc like '%24 hours%' from pg_proc
           where pronamespace = 'public'::regnamespace
             and proname = 'guest_record_review')

  union all select 'only the three ratings are accepted',
         (select prosrc like '%bad_rating%' from pg_proc
           where pronamespace = 'public'::regnamespace
             and proname = 'guest_record_review')

  union all select 'the webhook may still call it',
         has_function_privilege('service_role',
           'public.guest_record_review(text,text)', 'execute')

  union all select 'anon still may NOT call it',
         not has_function_privilege('anon',
           'public.guest_record_review(text,text)', 'execute')
) t
order by ok, check_name;
