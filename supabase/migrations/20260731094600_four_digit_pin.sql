-- ═══════════════════════════════════════════════════════════════════════
-- MIGRATION 0046 — four-digit PINs, and no PIN policy
--
-- On request. Two changes to one function:
--
--   six digits  ->  four
--   weak-PIN list, same-digit check, sequential check  ->  removed
--
-- So '1234', '1111' and '0000' are now accepted, and permanent.
--
-- ── WHAT THIS COSTS, ON THE RECORD ────────────────────────────────────
-- Not an argument against the change — it is asked for and it is done. But the
-- reasoning that put these checks here should not vanish with them, because
-- somebody will read this file later and wonder.
--
--   4 digits =    10,000 combinations
--   6 digits = 1,000,000 combinations
--
-- And this system has NO application-level lockout: a wrong PIN costs an
-- attacker nothing but a round trip. The checks existed because, without a
-- lockout, a guessable PIN is the whole attack — '1234' falls in the first few
-- attempts rather than the five-thousandth, which makes even the 10,000-space
-- irrelevant.
--
-- What is left holding the door is Supabase's per-IP auth rate limit
-- (Dashboard -> Authentication -> Rate Limits). It was already the second line
-- of defence; it is now the only one. It is worth opening that page and
-- confirming it is actually tightened, because everything else is gone.
--
-- ── WHY THE LENGTH CHECK STAYS ────────────────────────────────────────
-- Four digits is not policy, it is format. The PIN becomes the account's
-- password, so a three-digit or non-numeric value does not make the login
-- weaker — it makes it fail, at a counter, with a guest waiting.
--
-- ── WHY THIS IS ENFORCED HERE AND NOT ONLY IN THE APP ─────────────────
-- Unchanged from the original header: the frontend's checks are a courtesy. A
-- request crafted by hand never runs them. This function is what actually
-- decides, so it has to agree with the app rather than be more permissive.
-- ═══════════════════════════════════════════════════════════════════════

begin;

create or replace function public.is_pin_acceptable(p_pin text)
returns text
language plpgsql
immutable
as $$
begin
  -- The one rule left. Everything else was removed on request; see the header.
  if p_pin is null or p_pin !~ '^[0-9]{4}$' then
    return 'PIN must be exactly 4 digits.';
  end if;

  return null;  -- null means acceptable
end $$;

commit;


-- ═══════════════════════════════════════════════════════════════════════
-- VERIFY — every row must read PASS
-- ═══════════════════════════════════════════════════════════════════════
select check_name, case when ok then 'PASS' else 'FAIL' end as result
from (
  select 'four digits is accepted' as check_name,
         public.is_pin_acceptable('4827') is null as ok

  -- The whole point of the change: these used to be refused.
  union all select '1234 is now accepted',
         public.is_pin_acceptable('1234') is null

  union all select '1111 is now accepted',
         public.is_pin_acceptable('1111') is null

  union all select '0000 is now accepted',
         public.is_pin_acceptable('0000') is null

  -- Format still enforced, because a bad format breaks login rather than
  -- weakening it.
  union all select 'six digits is refused',
         public.is_pin_acceptable('482913') is not null

  union all select 'three digits is refused',
         public.is_pin_acceptable('482') is not null

  union all select 'letters are refused',
         public.is_pin_acceptable('12a4') is not null

  union all select 'null is refused',
         public.is_pin_acceptable(null) is not null

  union all select 'an empty string is refused',
         public.is_pin_acceptable('') is not null

  -- Whitespace is not a digit. ' 123' reaching the password column would be a
  -- PIN nobody can type twice the same way.
  union all select 'a padded PIN is refused',
         public.is_pin_acceptable(' 123') is not null
) t
order by ok, check_name;
