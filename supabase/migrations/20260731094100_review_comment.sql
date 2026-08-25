-- ═══════════════════════════════════════════════════════════════════════
-- MIGRATION 0041 — let a guest who rated Poor tell us WHY
--
-- The flow this completes, all inside WhatsApp:
--
--   guest taps Poor   ->  "Sorry for the inconvenience. Please suggest what we
--                          can do to make it better."
--   guest types text  ->  saved against that same review
--                     ->  "Thank you for your feedback."
--
-- ── WHERE THE "WAITING FOR THEIR ANSWER" STATE LIVES ──────────────────
-- Nowhere new. The review row IS the state:
--
--     rating = 'poor' AND comment IS NULL   ->  we asked, they have not answered
--     comment IS NOT NULL                   ->  answered, done
--
-- No session table, nothing to expire, nothing to clean up. A guest who never
-- replies simply leaves a poor rating with no comment, which is a true record of
-- what happened rather than a dangling row somewhere.
--
-- ── WHY A 24-HOUR WINDOW ON THE LOOKUP ────────────────────────────────
-- Two reasons, and the second is the one that matters. A message arriving days
-- later is about a visit nobody remembers. But more importantly, without a
-- bound, ANY free text that guest ever sends would be filed as the explanation
-- for a poor rating from last month — including "hi" six weeks later.
--
-- ── WHY THIS DOES NOT TOUCH rating ────────────────────────────────────
-- The comment is added to the row; the rating is never changed. So the reports
-- keep seeing exactly the three values they always saw, and a comment is extra
-- detail rather than a fourth kind of rating.
-- ═══════════════════════════════════════════════════════════════════════

begin;

-- ═══════════════════════════════════════════════════════════════════════
-- 1. Somewhere to put what they wrote
-- ═══════════════════════════════════════════════════════════════════════

alter table public.reviews
  add column if not exists comment text;

comment on column public.reviews.comment is
  'What the guest typed after rating Poor. NULL means they were asked and have '
  'not answered, or were never asked. Never set for excellent/good.';

-- Length is capped in the database as well as in the function, because the
-- function is not the only thing that could ever write here and a guest can
-- paste an entire email into WhatsApp.
alter table public.reviews
  drop constraint if exists reviews_comment_len_chk;
alter table public.reviews
  add constraint reviews_comment_len_chk
  check (comment is null or length(comment) <= 1000);


-- ═══════════════════════════════════════════════════════════════════════
-- 2. guest_add_comment — attach free text to the review we just asked about
--
-- Takes a PHONE, not a review id, because the webhook only ever knows the
-- number a message came from. Finding the row is this function's job.
--
-- Returns a code rather than raising, like the other two guest functions: the
-- webhook has to answer the guest either way, and an exception would leave them
-- on read.
-- ═══════════════════════════════════════════════════════════════════════

create or replace function public.guest_add_comment(p_phone text, p_comment text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_tail    text := public.phone_tail(p_phone);
  v_text    text := nullif(btrim(coalesce(p_comment, '')), '');
  v_review  record;
begin
  if length(v_tail) < 10 then
    return jsonb_build_object('ok', false, 'code', 'bad_phone');
  end if;

  if v_text is null then
    return jsonb_build_object('ok', false, 'code', 'empty_comment');
  end if;

  -- Truncated, not refused. Somebody who typed a long complaint has already
  -- taken the trouble; losing the first thousand characters of it to protect a
  -- constraint would be the wrong trade.
  if length(v_text) > 1000 then
    v_text := left(v_text, 1000);
  end if;

  -- The one review we are waiting on. 'poor' only: a guest who rated Excellent
  -- and then sends a message is not writing a complaint, and filing it as one
  -- would put words in their mouth.
  select r.id
    into v_review
  from public.reviews r
  where r.guest_phone = v_tail
    and r.rating      = 'poor'
    and r.comment     is null
    and r.created_at  > now() - interval '24 hours'
  order by r.created_at desc
  limit 1;

  if v_review.id is null then
    return jsonb_build_object('ok', false, 'code', 'no_pending_review');
  end if;

  update public.reviews
     set comment = v_text
   where id = v_review.id;

  return jsonb_build_object('ok', true, 'code', 'comment_saved',
                            'review_id', v_review.id);
end $fn$;

-- Same posture as the other two guest functions: revoked from every browser
-- role, granted only to the server that verified Meta's signature first.
-- Reachable by anon, this would let anyone overwrite any guest's complaint.
revoke execute on function public.guest_add_comment(text, text)
  from public, anon, authenticated;
grant  execute on function public.guest_add_comment(text, text) to service_role;

commit;


-- ═══════════════════════════════════════════════════════════════════════
-- VERIFY — every row must read PASS
-- ═══════════════════════════════════════════════════════════════════════
select check_name, case when ok then 'PASS' else 'FAIL' end as result
from (
  select 'reviews.comment exists' as check_name,
         exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'reviews'
                    and column_name = 'comment') as ok

  union all select 'the length cap is on the table',
         exists (select 1 from pg_constraint
                  where conname = 'reviews_comment_len_chk')

  union all select 'guest_add_comment exists',
         to_regprocedure('public.guest_add_comment(text,text)') is not null

  -- The webhook is service_role. Migration 0038 was needed because 0033
  -- revoked from PUBLIC and granted to nobody; this one grants explicitly so
  -- that cannot happen again.
  union all select 'the webhook may call it',
         has_function_privilege('service_role',
           'public.guest_add_comment(text,text)', 'execute')

  union all select 'anon may NOT call it',
         not has_function_privilege('anon',
           'public.guest_add_comment(text,text)', 'execute')

  union all select 'authenticated may NOT call it',
         not has_function_privilege('authenticated',
           'public.guest_add_comment(text,text)', 'execute')

  -- It must only ever fill a POOR review. Filing a message from someone who
  -- rated Excellent as a complaint would misrepresent them.
  union all select 'it only fills a poor review',
         (select prosrc like '%''poor''%' from pg_proc
           where pronamespace = 'public'::regnamespace
             and proname = 'guest_add_comment')

  union all select 'it never changes the rating',
         (select prosrc not like '%set rating%' from pg_proc
           where pronamespace = 'public'::regnamespace
             and proname = 'guest_add_comment')
) t
order by ok, check_name;
