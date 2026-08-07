-- ═══════════════════════════════════════════════════════════════════════
-- 0004 — PHONE + 6-DIGIT PIN LOGIN
--
--   >>> RUN THIS IN THE SUPABASE SQL EDITOR, AFTER 0003. <<<
--
-- Safe to run more than once.
--
-- ── WHAT CHANGES ───────────────────────────────────────────────────────
--
-- Everyone signs in with a 10-digit mobile number and a 6-digit PIN instead of
-- an email and a password. Reason: an operator logs in at the start of every
-- shift, standing outside, often with cold or wet hands, on a phone. Typing
-- "rajesh.kumar@ambria.in" plus a password on a touch keyboard is slow and
-- error-prone; two numeric fields on a numeric keypad is neither.
--
-- Schema-wise this migration does exactly one thing: it promotes
-- user_roles.phone from an optional note into the login identifier, with the
-- constraints that role demands.
--
-- ── HOW IT WORKS — AND WHY WE DO NOT STORE THE PIN ─────────────────────
--
-- We do NOT invent our own authentication. The PIN is handed to Supabase Auth
-- as a password, against a derived, deliberately-unroutable email address:
--
--     phone 9876543210  ->  9876543210@phone.invalid
--     PIN   482913      ->  that account's password
--
-- Supabase then stores it bcrypt-hashed in auth.users, issues a normal JWT,
-- and handles refresh tokens and its own rate limiting. Nothing in this
-- project ever sees, stores, or hashes a PIN — there is no `pin` column
-- anywhere, and there must never be one.
--
-- That is the entire reason for this design. Rolling our own — a `pin_hash`
-- column plus a verification function — would mean owning password storage,
-- session minting, and timing-safe comparison. Each of those is a well-known
-- way to get breached, and none of them is our job.
--
-- WHY THE `.invalid` TLD: RFC 2606 reserves it, so it can never resolve. No
-- mail can ever be delivered there, so nobody can trigger a password-reset
-- email to an address that looks like a real operator's. The domain is
-- configurable via VITE_PHONE_EMAIL_DOMAIN in case Supabase's email validation
-- ever rejects it.
--
-- WHY DERIVED RATHER THAN LOOKED UP: a lookup would mean letting anonymous
-- visitors read user_roles to turn a phone into an email — a staff directory
-- handed to anyone who opens the login page. Deriving needs no read access at
-- all, so anon keeps zero database privileges (see migration 0003).
--
-- ══ SECURITY: WHAT PROTECTS THIS, AND WHAT YOU MUST DO ══════════════════
--
-- A 6-digit PIN is 1,000,000 combinations. There is deliberately NO
-- application-level lockout in this system — that was decided against, so the
-- protection rests on exactly two things:
--
--   1. THE PIN LENGTH. 6 digits, enforced in the UI. This is why 4 was not
--      used: 10,000 combinations is brute-forceable in under an hour.
--
--   2. SUPABASE'S OWN RATE LIMITS. Per-IP, enforced inside GoTrue itself, and
--      NOT bypassable by calling the API directly.
--
--      >>> THIS IS NOW A REQUIRED SETUP STEP, NOT AN OPTIONAL ONE. <<<
--
--      Dashboard -> Authentication -> Rate Limits
--        "Sign in / Sign up"  ->  lower to 10 per 5 minutes per IP
--
--      With that set, an attacker gets ~2,880 guesses per day per IP against
--      1,000,000 combinations. Left at the default, the same attacker gets
--      several times that. This one dashboard field is doing the work an
--      application lockout would otherwise do.
--
-- Also worth knowing: PINs are per-account, so a leaked operator PIN exposes
-- one property's car list (RLS enforces that). A leaked system_admin PIN
-- exposes all four properties and user management — so give the system_admin
-- account a PIN that is not a birthday, and treat it like a root password.
-- ═══════════════════════════════════════════════════════════════════════

begin;

-- ═══════════════════════════════════════════════════════════════════════
-- PHONE BECOMES THE LOGIN IDENTIFIER
--
-- It was a nullable, unvalidated text column — fine for "a number you might
-- call this person on". It is now how a human proves who they are, so it
-- needs all three of: a checked format, uniqueness, and NOT NULL.
--
-- Each change is guarded: if existing rows violate it, the constraint is
-- SKIPPED with a NOTICE telling you how to find the offending rows, rather
-- than aborting the whole migration.
-- ═══════════════════════════════════════════════════════════════════════

-- ── 1. FORMAT ─────────────────────────────────────────────────────────
-- Exactly 10 digits, first digit 6-9 (Indian mobile), stored WITHOUT the '91'
-- country code. This matches normalisePhone() in src/utils/format.js and spec
-- rule 11 — '91' is added only when calling WhatsApp, never in the database.
--
-- Why enforce it here as well as in the UI: the phone is now half of a login
-- credential. A row with '98765 43210' (a space) or '919876543210' (a country
-- code) derives a DIFFERENT email than the login screen will, so that person
-- can never sign in — and the failure gives no hint why.
do $$
begin
  if exists (
    select 1 from public.user_roles
    where phone is not null and phone !~ '^[6-9][0-9]{9}$'
  ) then
    raise notice 'SKIPPED phone format check: badly formatted phones exist.';
    raise notice '  Find them: select id, name, phone from user_roles where phone !~ ''^[6-9][0-9]{9}$'';';
  else
    alter table public.user_roles drop constraint if exists user_roles_phone_format_chk;
    alter table public.user_roles add  constraint user_roles_phone_format_chk
      check (phone ~ '^[6-9][0-9]{9}$');
  end if;
end $$;

-- ── 2. UNIQUE ─────────────────────────────────────────────────────────
-- Globally unique, not per-property. The number alone resolves to one auth
-- account, so two operators at different sites cannot share one — the second
-- would silently be logging into the first one's account.
do $$
begin
  if exists (
    select 1 from public.user_roles
    where phone is not null
    group by phone having count(*) > 1
  ) then
    raise notice 'SKIPPED unique(phone): duplicate phone numbers exist. Fix them, then re-run.';
    raise notice '  Find them: select phone, count(*) from user_roles group by phone having count(*) > 1;';
  else
    create unique index if not exists user_roles_phone_key on public.user_roles(phone);
  end if;
end $$;

-- ── 3. NOT NULL ───────────────────────────────────────────────────────
-- A user_roles row without a phone is an account that can never log in. It
-- looks perfectly healthy in the table editor, which is exactly why it should
-- be impossible to create.
do $$
begin
  if exists (select 1 from public.user_roles where phone is null) then
    raise notice 'SKIPPED phone NOT NULL: rows with a NULL phone exist.';
  else
    alter table public.user_roles alter column phone set not null;
  end if;
end $$;

comment on column public.user_roles.phone is
  'LOGIN IDENTIFIER. 10 digits, no country code. Derives the auth email {phone}@phone.invalid. Changing this changes how the person logs in.';


-- ═══════════════════════════════════════════════════════════════════════
-- A VALET ADMIN MAY MANAGE THEIR OWN OPERATORS
--
-- Migration 0002 gave write access on user_roles to system_admin only. But a
-- valet_admin is the person actually on site when an operator joins mid-shift,
-- and routing every hire through one system_admin does not survive contact
-- with a Saturday night.
--
-- The policy is deliberately narrow. A valet_admin may only touch rows where
-- ALL THREE hold:
--     role        = 'operator'                 <- cannot create another admin
--     property_id = their own property         <- cannot touch other sites
--     they are    a valet_admin                <- not an operator
--
-- The `role = 'operator'` clause is the important one. Without it a valet_admin
-- could set their own row to 'system_admin', or create a second system_admin,
-- and quietly own all four properties. Note it is repeated in WITH CHECK: USING
-- is evaluated against the row as it EXISTS, WITH CHECK against the row as it
-- WOULD BE. Only having USING would let them UPDATE an operator row into a
-- system_admin row — the old row passes the check, and there is nothing to stop
-- the new one.
-- ═══════════════════════════════════════════════════════════════════════

drop policy if exists user_roles_valet_admin_operators on public.user_roles;

create policy user_roles_valet_admin_operators on public.user_roles
  for all to authenticated
  using (
    public.my_role()  = 'valet_admin'
    and role          = 'operator'
    and property_id   = public.my_property_id()
  )
  with check (
    public.my_role()  = 'valet_admin'
    and role          = 'operator'
    and property_id   = public.my_property_id()
  );

commit;

-- ═══════════════════════════════════════════════════════════════════════
-- ── HOW PINs ARE SET AND CHANGED ───────────────────────────────────────
--
-- WHO SETS THE FIRST PIN
--   A valet_admin (own property, operators only) or a system_admin (anyone).
--   The row above is only half of it: creating the row is one thing, creating
--   the AUTH ACCOUNT that holds the PIN needs the service_role key, which
--   never leaves the server. So the admin UI calls an Edge Function that:
--       1. checks the caller is valet_admin or system_admin
--       2. if valet_admin, FORCES role='operator' and their own property_id
--          (never trusting those two values from the browser)
--       3. creates the auth user with email_confirm: true
--       4. inserts the user_roles row
--   That function ships with the system/Users screen. Until then, users are
--   created by hand — see the steps below.
--
-- WHO CHANGES IT AFTERWARDS
--   The operator, themselves, from Change PIN in the app. That is
--   supabase.auth.updateUser({ password: newPin }) on their own session, so no
--   elevated key is involved and an admin never needs to know the new PIN.
--   The app re-verifies the current PIN first — see changePin() in
--   src/context/AuthContext.jsx for why.
--
--   An admin can also RESET a forgotten PIN (a PIN cannot be recovered, only
--   replaced), again through the Edge Function.
--
-- ── ONE SUPABASE SETTING THAT MATTERS ──────────────────────────────────
--   Dashboard -> Authentication -> Policies -> Password requirements
--   Minimum length must stay at 6 (the default) and required characters must
--   stay at "no required characters". A 6-digit PIN is exactly 6 characters, so
--   raising the minimum to 8, or requiring a letter or symbol, breaks every
--   login and every PIN change at once.
--
-- ── CREATING USERS BY HAND (until the Edge Function exists) ─────────────
--
-- The email is DERIVED by the app, so it must be created exactly as the app
-- will derive it: {phone}@phone.invalid, lowercase, no country code. One typo
-- and that person can never log in.
--
-- STEP 1 — Dashboard -> Authentication -> Users -> Add user
--     Email          9876543210@phone.invalid
--     Password       482913        <- this IS the 6-digit PIN
--     Auto Confirm   ON            <- REQUIRED. `.invalid` can never receive a
--                                     confirmation email, so without this the
--                                     account stays unconfirmed and login
--                                     fails with "Email not confirmed".
--
-- STEP 2 — SQL Editor. The digits in `phone` MUST match those in the email:
--
--   insert into user_roles (user_id, property_id, role, name, phone)
--   select u.id, p.id, 'operator', 'Rajesh Kumar', '9876543210'
--   from auth.users u, properties p
--   where u.email = '9876543210@phone.invalid'
--     and p.name  = 'Ambria Exotica';
--
-- system_admin gets NO property (constraint user_roles_property_scope_chk):
--
--   insert into user_roles (user_id, property_id, role, name, phone)
--   select u.id, null, 'system_admin', 'System Admin', '9000000001'
--   from auth.users u
--   where u.email = '9000000001@phone.invalid';
--
-- ── VERIFY ─────────────────────────────────────────────────────────────
--
-- -- phone is the login key (expect 'NO', then one index row):
-- select is_nullable from information_schema.columns
-- where table_name = 'user_roles' and column_name = 'phone';
--
-- select indexname from pg_indexes
-- where tablename = 'user_roles' and indexname = 'user_roles_phone_key';
--
-- -- anon can still reach NOTHING (expect zero rows):
-- select p.proname from pg_proc p
-- join pg_namespace n on n.oid = p.pronamespace
-- where n.nspname = 'public' and has_function_privilege('anon', p.oid, 'execute');
--
-- -- every user's phone matches their auth email (expect zero rows = all good):
-- select ur.name, ur.phone, u.email
-- from user_roles ur join auth.users u on u.id = ur.user_id
-- where u.email <> ur.phone || '@phone.invalid';
--
-- -- who can write user_roles (expect the sysadmin policy + the valet_admin one):
-- select policyname, cmd from pg_policies
-- where tablename = 'user_roles' order by policyname;

