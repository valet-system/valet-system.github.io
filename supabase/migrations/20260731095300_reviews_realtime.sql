-- ═══════════════════════════════════════════════════════════════════════
-- MIGRATION 0053 — ratings arrive on the Reviews page on their own
--
-- The Refresh button was removed from every screen. On nine of them that cost
-- nothing: six carry realtime already, and the three report pages re-query
-- whenever their date range or page changes.
--
-- Reviews was the exception, and the only page where the button was doing real
-- work. Its load() rebuilds on [propertyId, range.from, range.to] — so nothing
-- re-queries unless somebody changes the date range, while guest ratings keep
-- arriving all day. An admin sitting on that page would simply never see a new
-- one.
--
-- ── WHY THIS IS A MIGRATION AND NOT JUST A HOOK ───────────────────────
-- Adding useRealtime() to the page is one call, and on its own it would have
-- been a SILENT no-op: `reviews` is not in the supabase_realtime publication.
-- Only four tables are — valet_tasks, parked_vehicles, token_ranges (0002) and
-- push_outbox (0015). The subscription would connect, report success, and never
-- deliver a row.
--
-- That is the worst kind of fix: it looks done. So the publication comes first.
--
-- ── WHAT DELIVERS AND WHAT DOES NOT ───────────────────────────────────
-- Two things write to this table and BOTH need to reach the page:
--
--   guest_record_review()  INSERT — the guest tapped Excellent / Good / Poor
--   guest_add_comment()    UPDATE — a Poor rating's written explanation, which
--                          arrives minutes later, in a separate message
--
-- The INSERT is straightforward. The UPDATE is the reason for the replica
-- identity below: with the default (primary key only) the pre-image of an
-- updated row carries nothing but the id, and a subscription filtered on
-- property_id has no property_id to match against — so the comment would
-- silently never arrive, which is exactly the half-working state this migration
-- exists to avoid.
--
-- `full` costs more WAL per update. On a table that takes one insert and at
-- most one update per car that is not worth optimising.
--
-- ── SECURITY: NOTHING IS WIDENED ──────────────────────────────────────
-- Realtime enforces RLS on every row before it is sent. reviews_property_read
-- (0002) already limits reads to the caller's own property, and this migration
-- does not touch it. A valet_admin receives ratings for their own site and
-- nothing else — the same rows the page could already fetch.
-- ═══════════════════════════════════════════════════════════════════════

begin;

do $$
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    raise notice 'publication supabase_realtime not found — skipping';
    return;
  end if;

  -- Guarded: adding a table twice is an error, and this migration must be
  -- re-runnable like every other one in this project.
  if not exists (
    select 1 from pg_publication_tables
     where pubname = 'supabase_realtime'
       and schemaname = 'public'
       and tablename = 'reviews'
  ) then
    alter publication supabase_realtime add table public.reviews;
    raise notice 'realtime enabled for public.reviews';
  else
    raise notice 'public.reviews was already published';
  end if;
end $$;

-- See the header: without this, the written comment on a Poor rating never
-- reaches a subscription filtered by property_id.
alter table public.reviews replica identity full;

commit;


-- ═══════════════════════════════════════════════════════════════════════
-- VERIFY — every row must read PASS
-- ═══════════════════════════════════════════════════════════════════════
select check_name, case when ok then 'PASS' else 'FAIL' end as result
from (
  select 'reviews is published for realtime' as check_name,
         exists (
           select 1 from pg_publication_tables
            where pubname = 'supabase_realtime'
              and schemaname = 'public'
              and tablename = 'reviews'
         ) as ok

  -- 'f' is full. Without it an UPDATE's pre-image has only the id, and a
  -- property-filtered subscription drops the comment.
  union all select 'reviews sends the whole row on update',
         (select relreplident = 'f' from pg_class
           where oid = 'public.reviews'::regclass)

  -- The tables that were already published must still be.
  union all select 'valet_tasks is still published',
         exists (select 1 from pg_publication_tables
                  where pubname = 'supabase_realtime'
                    and schemaname = 'public' and tablename = 'valet_tasks')

  union all select 'parked_vehicles is still published',
         exists (select 1 from pg_publication_tables
                  where pubname = 'supabase_realtime'
                    and schemaname = 'public' and tablename = 'parked_vehicles')

  -- NOTHING IS WIDENED. Realtime enforces RLS per row, so the read policy is
  -- what keeps one property's ratings away from another's.
  union all select 'RLS is still on for reviews',
         (select relrowsecurity from pg_class where oid = 'public.reviews'::regclass)

  union all select 'the property read policy is still there',
         exists (select 1 from pg_policies
                  where schemaname = 'public' and tablename = 'reviews'
                    and policyname = 'reviews_property_read')

  -- A table nobody should be subscribing to. If this ever turns true, someone
  -- has published guest PINs to every connected browser.
  union all select 'staff_pins is NOT published',
         not exists (select 1 from pg_publication_tables
                      where pubname = 'supabase_realtime'
                        and schemaname = 'public' and tablename = 'staff_pins')

  union all select 'wa_message_log is NOT published',
         not exists (select 1 from pg_publication_tables
                      where pubname = 'supabase_realtime'
                        and schemaname = 'public' and tablename = 'wa_message_log')
) t
order by ok, check_name;
