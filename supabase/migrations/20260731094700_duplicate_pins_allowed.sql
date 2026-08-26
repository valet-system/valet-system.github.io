-- ═══════════════════════════════════════════════════════════════════════
-- MIGRATION 0047 — two people may hold the same PIN
--
-- On request: "anyone can use any pin whether that pin is getting used or not".
--
-- ── WHY THIS TOUCHES ONE FUNCTION AND NOT FOUR ────────────────────────
-- Every PIN_TAKEN error in the schema comes from the same source. Three
-- functions raise it, and each decides by calling pin_in_use():
--
--   admin_set_staff_pin    (0008, line 285)
--   change_my_pin          (0007, line 488)
--   admin_create_staff     (0007, line 603)
--
-- A fourth, admin_reset_staff_pin (0007), is a one-line alias kept for
-- deploy compatibility -- `select public.admin_set_staff_pin(...)` -- so it
-- inherits the change rather than needing one.
--
-- None of them queries staff_pins itself. So pin_in_use() returning "free" for
-- everything disables the rule everywhere at once, and no function body has to
-- be rewritten -- which matters, because those bodies also carry the
-- authorisation checks, the auth.users password update and the audit insert.
-- Rewriting them to delete three lines is how one of those quietly gets
-- dropped.
--
-- The signature is kept for the same reason: every caller still compiles.
--
-- ── WHY DUPLICATE PINS DO NOT BREAK LOGIN ─────────────────────────────
-- Worth stating, because it looks like it should. Sign-in is phone + PIN, and
-- the phone is what identifies the account — user_roles_phone_key makes it
-- unique, and the PIN is only the password for that one account. Two staff on
-- 1234 are two different accounts with the same password, not an ambiguity.
-- Nobody can sign in as the wrong person.
--
-- ── WHAT IT DOES COST, ON THE RECORD ──────────────────────────────────
-- Not an argument against it — it is asked for and it is done. But this is now
-- the third guard removed from PINs in a row, and the third is what makes the
-- first two matter:
--
--   0046  six digits -> four            10,000 combinations, not 1,000,000
--   0046  weak-PIN list removed         1234 and 0000 are permitted
--   0047  uniqueness removed            EVERY account may sit on 1234
--
-- Together: the default for a new account is 1234, nothing forces a change
-- (see DEFAULT_PIN in src/types/index.js), and now nothing stops every account
-- keeping it. An attacker who knows one staff phone number does not need
-- 10,000 attempts — the first guess is 1234, and it will often be right.
--
-- There is still no application-level lockout. What is left holding the door is
-- Supabase's per-IP auth rate limit (Dashboard -> Authentication -> Rate
-- Limits). It is now the ONLY remaining control on PIN guessing. It is worth
-- opening that page and confirming it is actually tightened.
--
-- ── WHAT IS DELIBERATELY NOT DONE ─────────────────────────────────────
-- pin_in_use() is emptied, not dropped. Dropping it would fail: three functions
-- reference it, and plpgsql resolves that at call time, so they would compile
-- fine and then throw "function does not exist" the first time an admin set a
-- PIN — at a counter, with a new hire waiting.
--
-- The frontend's PIN_TAKEN message (src/lib/adminApi.js) is also left in place.
-- It becomes unreachable, and that is the point: if this migration has not been
-- run yet on some environment, the old error still has a sentence to show.
-- ═══════════════════════════════════════════════════════════════════════

begin;

create or replace function public.pin_in_use(p_pin text, p_exclude_user_role_id uuid default null)
returns text
language sql
immutable
as $$
  -- Always free. null is this function's "nobody has it" answer, which is the
  -- one thing every caller tests for.
  --
  -- No decryption, no scan of staff_pins. The previous version decrypted every
  -- stored PIN on every call to find a match; there is nothing to match now, so
  -- doing that work would only be a way to leak timing.
  select null::text;
$$;

-- Same grants as before. Nothing calls this from a session; only the three
-- security definer functions that raise PIN_TAKEN, and they run as owner.
revoke all on function public.pin_in_use(text, uuid) from public, anon, authenticated;

commit;


-- ═══════════════════════════════════════════════════════════════════════
-- VERIFY — every row must read PASS
-- ═══════════════════════════════════════════════════════════════════════
select check_name, case when ok then 'PASS' else 'FAIL' end as result
from (
  -- The signature has to survive, or its callers break at run time.
  select 'pin_in_use still exists with both arguments' as check_name,
         to_regprocedure('public.pin_in_use(text,uuid)') is not null as ok

  -- The actual change: nothing is ever reported as taken.
  union all select 'a PIN is free even with no exclusion',
         public.pin_in_use('1234') is null

  union all select 'a PIN is free when excluding somebody',
         public.pin_in_use('1234', gen_random_uuid()) is null

  union all select 'the default PIN is free',
         public.pin_in_use('1234') is null

  -- The real test of "anyone can use any pin": a PIN that IS stored right now
  -- must still come back free. Skipped honestly rather than faked when there
  -- are no stored PINs to read.
  union all select 'a PIN somebody already holds is still free',
         coalesce(
           (select public.pin_in_use(public.decrypt_pin(pin_encrypted)) is null
              from public.staff_pins limit 1),
           true)

  -- It must not be reading the table any more.
  --
  -- COMMENTS ARE STRIPPED FIRST, and that is not tidiness -- it is a check that
  -- already failed once. prosrc is the whole body INCLUDING its comments, and
  -- the body above explains itself by naming the things it no longer touches.
  -- So a plain `not like` on the raw prosrc reported FAIL while the code was
  -- perfectly correct: it was matching the prose, not the query.
  --
  -- The 'n' flag is what makes this work without an escape: it stops . at a
  -- line end, so '--.*' is exactly one line comment.
  union all select 'it no longer scans the pin table',
         (select regexp_replace(prosrc, '--.*', '', 'gn') not like '%staff_pins%'
            from pg_proc
           where pronamespace = 'public'::regnamespace and proname = 'pin_in_use')

  union all select 'it no longer decrypts anything',
         (select regexp_replace(prosrc, '--.*', '', 'gn') not like '%decrypt_pin%'
            from pg_proc
           where pronamespace = 'public'::regnamespace and proname = 'pin_in_use')

  -- The positive form of the same thing, and the one no comment can fake:
  -- strip the comments, strip the whitespace, and what is left must be the
  -- single constant select and nothing else.
  union all select 'its body is one constant select and nothing else',
         (select btrim(regexp_replace(prosrc, '--.*', '', 'gn'), chr(9) || chr(10) || chr(13) || ' ') = 'select null::text;'
            from pg_proc
           where pronamespace = 'public'::regnamespace and proname = 'pin_in_use')

  -- THE CALLERS. These are what make a single-function edit sufficient: if any
  -- of them stopped routing through pin_in_use, it would be enforcing its own
  -- uniqueness rule again and this migration would be silently half-applied.
  union all select 'admin_set_staff_pin still routes through it',
         (select prosrc like '%pin_in_use%' from pg_proc
           where pronamespace = 'public'::regnamespace and proname = 'admin_set_staff_pin')

  union all select 'admin_create_staff still routes through it',
         (select prosrc like '%pin_in_use%' from pg_proc
           where pronamespace = 'public'::regnamespace and proname = 'admin_create_staff')

  union all select 'change_my_pin still routes through it',
         (select prosrc like '%pin_in_use%' from pg_proc
           where pronamespace = 'public'::regnamespace and proname = 'change_my_pin')

  -- Not a direct caller: an alias that delegates, so it inherits the change.
  -- Asserting pin_in_use appeared in ITS body would fail.
  union all select 'admin_reset_staff_pin still delegates to admin_set_staff_pin',
         (select prosrc like '%admin_set_staff_pin%' from pg_proc
           where pronamespace = 'public'::regnamespace and proname = 'admin_reset_staff_pin')

  -- Format is NOT policy and stays enforced: a bad format breaks login rather
  -- than weakening it. 0046 is the file that decides this.
  union all select 'the four-digit format is still required',
         public.is_pin_acceptable('12') is not null

  union all select 'a valid four-digit PIN is still accepted',
         public.is_pin_acceptable('1234') is null

  -- Nothing here should have touched who may read whose PIN.
  union all select 'anon still may not call pin_in_use',
         not has_function_privilege('anon', 'public.pin_in_use(text,uuid)', 'execute')

  union all select 'authenticated still may not call pin_in_use',
         not has_function_privilege('authenticated', 'public.pin_in_use(text,uuid)', 'execute')
) t
order by ok, check_name;
