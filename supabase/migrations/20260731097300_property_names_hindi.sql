-- ═══════════════════════════════════════════════════════════════════════
-- 0073 — SITE NAMES AND ADDRESSES IN HINDI
--
-- Adds properties.name_hi and properties.address_hi.
--
-- ══ WHY THIS EXISTS ══
--
-- The app already switches staff names by language (user_roles.name_hi,
-- migration 0022) and parking place labels (parking_spaces.label_hi). Sites
-- were the one thing left in English: with the app in Hindi a page read
-- "साइटें ... Ambria Exotica ... 4 ऑपरेटर" — every label translated and the
-- one word identifying WHICH site untranslated.
--
-- ══ SAME SHAPE AS 0022, DELIBERATELY ══
--
-- A name is DATA, not something to translate at read time. Nothing turns
-- "Pushpanjali" into Devanagari reliably, and what is wanted is a
-- TRANSLITERATION rather than a translation — translating a venue name gives
-- nonsense. So the Hindi spelling is stored once and stays editable by the
-- admin who typed it; the browser offers a machine transliteration as a first
-- draft (src/lib/hindiText.js) and whatever is in the box at save time is what
-- gets stored.
--
-- ══ NULLABLE, AND THAT IS THE WHOLE DESIGN ══
--
-- NULL means "no Hindi spelling yet" and every reader falls back to the
-- English column. That is what makes this safe on a live table: nothing to
-- backfill, nothing breaks, and admins fill them in as they go. Do NOT add a
-- NOT NULL or a default.
--
-- ══ WHY THERE IS NO UNIQUE CONSTRAINT ON name_hi ══
--
-- `name` is unique (migration 0002) because it is the only thing telling two
-- dashboards apart. name_hi is a display label with a guaranteed fallback, and
-- a unique index on a mostly-NULL column would refuse the second site somebody
-- transliterates the same way — for no benefit, since nothing looks a site up
-- by its Hindi spelling.
--
-- ══ NO NEW FUNCTION NEEDED ══
--
-- Unlike staff, properties are written straight through the table by
-- system_admin under the RLS policy from 0002. These columns inherit it, so
-- there is nothing to grant and nothing to re-create.
--
-- Safe to re-run.
-- ═══════════════════════════════════════════════════════════════════════

begin;

alter table public.properties
  add column if not exists name_hi text;

alter table public.properties
  add column if not exists address_hi text;

comment on column public.properties.name_hi is
  'Optional Hindi spelling of name. NULL means none yet; every reader falls back to name. Written by an admin — machine transliteration is only the first draft.';

comment on column public.properties.address_hi is
  'Optional Hindi spelling of address. NULL means none yet; readers fall back to address.';

-- Length only. Deliberately NO check that the text contains Devanagari: an
-- admin may legitimately want a different Latin spelling for a name with no
-- natural Devanagari form, and a constraint refusing that would just make them
-- leave the field empty, which helps nobody.
--
-- The limits match the English columns they shadow.
alter table public.properties
  drop constraint if exists properties_name_hi_len_chk;
alter table public.properties
  add constraint properties_name_hi_len_chk
  check (name_hi is null or length(btrim(name_hi)) between 1 and 80);

alter table public.properties
  drop constraint if exists properties_address_hi_len_chk;
alter table public.properties
  add constraint properties_address_hi_len_chk
  check (address_hi is null or length(btrim(address_hi)) between 1 and 200);

commit;


-- ═══════════════════════════════════════════════════════════════════════
-- VERIFY — every row must read PASS
-- ═══════════════════════════════════════════════════════════════════════
select check_name, case when ok then 'PASS' else 'FAIL' end as result
from (
  select 'name_hi exists' as check_name,
         exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'properties'
                    and column_name = 'name_hi') as ok

  union all select 'address_hi exists',
         exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'properties'
                    and column_name = 'address_hi')

  -- NULLABLE is the design, not an oversight. A NOT NULL here would refuse
  -- every existing row and every site added before somebody types a Hindi
  -- spelling.
  union all select 'name_hi is nullable',
         (select is_nullable = 'YES' from information_schema.columns
           where table_schema = 'public' and table_name = 'properties'
             and column_name = 'name_hi')

  union all select 'address_hi is nullable',
         (select is_nullable = 'YES' from information_schema.columns
           where table_schema = 'public' and table_name = 'properties'
             and column_name = 'address_hi')

  -- ILIKE, not LIKE: pg_get_constraintdef deparses and UPPERCASES keywords,
  -- so a lowercase match silently never fires.
  union all select 'name_hi length is bounded',
         (select pg_get_constraintdef(oid) ilike '%length(btrim(name_hi))%'
            from pg_constraint
           where conrelid = 'public.properties'::regclass
             and conname = 'properties_name_hi_len_chk')

  union all select 'address_hi length is bounded',
         (select pg_get_constraintdef(oid) ilike '%length(btrim(address_hi))%'
            from pg_constraint
           where conrelid = 'public.properties'::regclass
             and conname = 'properties_address_hi_len_chk')

  -- The English name stays unique; the Hindi one deliberately is not.
  --
  -- pg_index, NOT pg_constraint. properties.name is unique because migration
  -- 0001 ran `create unique index properties_name_key`, and a bare CREATE
  -- UNIQUE INDEX never writes a pg_constraint row — so looking there reported
  -- FAIL on a database where the uniqueness was in fact present and working.
  -- pg_index is the catalog that covers BOTH spellings, since a unique
  -- constraint always has a backing index too.
  --
  -- '%(name)%' with the closing bracket, so it matches the index on (name)
  -- and not the one on (name_hi) that this migration is asserting is absent.
  union all select 'name is still unique',
         exists (select 1 from pg_index i
                  where i.indrelid = 'public.properties'::regclass
                    and i.indisunique
                    and pg_get_indexdef(i.indexrelid) ilike '%(name)%')

  union all select 'name_hi is NOT unique',
         not exists (select 1 from pg_index i
                      where i.indrelid = 'public.properties'::regclass
                        and i.indisunique
                        and pg_get_indexdef(i.indexrelid) ilike '%(name_hi)%')
) t
order by ok, check_name;
