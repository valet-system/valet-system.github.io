# Project memory

Working context for this repo — the decisions, the traps, and the state of
things. Written so that anyone picking this up cold (a new person, or an AI
assistant whose conversation history is gone) can be useful in ten minutes
instead of rediscovering the same lessons.

**Keep appending.** New entries go at the bottom of [The log](#the-log). Don't
rewrite history — if something turned out wrong, add a line saying so and why.

> This repo is **public**. Never put a key, a secret, a guest's name or a phone
> number in this file or any other. Secrets live in Supabase → Edge Functions →
> Secrets, and nowhere else.

---

## 1. What this is

A valet parking system for **Ambria**, a hospitality group with five venues.
Vite + React 19 + Tailwind + Supabase, shipped as an installable PWA and
deployed to GitHub Pages from `main`.

**Pushing to `main` deploys to production.** There is no staging.

Users are staff, not the public. They sign in with a phone number and a PIN.

### The four roles

| Role | Lands on | Sees |
|---|---|---|
| `operator` | `/operator/checkin` | check-in, their tasks, their cars |
| `valet_admin` | `/admin/dashboard` | one property: queue, staff, tokens, spaces |
| `system_admin` | `/system/properties` | everything, all properties |
| `valet_vendor` | `/vendor/bookings` | the Valet Bookings calendar and nothing else |

`system_admin` and `valet_vendor` carry **no** `property_id`; the other two must
have one. That is enforced by `user_roles_property_scope_chk` and by both write
paths (`admin_create_staff`, `admin_set_staff_role`).

---

## 2. The other system, and the boundary

**Ambria Admin** (a.k.a. `ambria-workforce`) is a separate app on a separate
Supabase project. It owns staffing, attendance, vendors, and the **valet
bookings** shown in this app.

The standing instruction is: **do not work in that repo.** Read it if needed,
and hand over a `.md` brief for its own developer to act on. Two such briefs
live here:

- `AMBRIA_ADMIN_RECORDS_TAB.md` — a Records tab for them, built on our report API
- `AMBRIA_VALET_BOOKINGS_FEED.md` — their bookings feed, which we consume

### Traffic between the two, in both directions

```
Ambria Admin  ──(valet-analytics proxy, holds OUR report key)──▶  valet-report
   this app   ──(ambria-bookings proxy, holds THEIR feed key)──▶  valet-bookings-feed
```

Each side keeps the other's key in an **edge function secret**. Neither key ever
reaches a browser.

**Never accept Ambria's anon key.** Every table on that project carries a
permissive `"Allow all"` RLS policy, so their anon key is full read *and write*
on staff, attendance, tasks and repair requests. A shared secret that unlocks
exactly one read is the correct blast radius.

`valet-report` deliberately sends **no CORS headers** — that is the guard that
stops anyone calling it from a page. It is not a bug to work around.

---

## 3. Working agreements

These came from the user and hold until they say otherwise.

- **Never `git push` without explicit approval.** Asking "shall I push?" is not
  approval; a "yes" to a different question is not approval either.
- **Never paste live credentials into chat.** The transcript is written to disk.
  Secrets go straight into the Supabase dashboard.
- **Never put `service_role` in a `VITE_` variable or in a migration.** Public repo.
- **Do not work in the Ambria Admin repo.** Read-only, plus `.md` briefs.
- Replies in **English**.

---

## 4. Things that are not obvious from the code

### The service day starts at 05:30 IST, not midnight

A car checked in at 01:00 belongs to the previous night. Use
`public.ist_today()`, never `current_date`. `istDayStart()` on the front end is
the same boundary.

**Supabase cron runs in UTC.** Read every schedule that way or it lands seven
hours out:

| Job | Cron (UTC) | IST |
|---|---|---|
| `daily-token-reset` | `05 00 * * *` | 05:35 |
| `close-open-cars` | `35 23 * * *` | 05:05 (30 min *before* the reset, deliberately) |
| `ambria-bookings-sync` | `*/2 * * * *` | every 2 min |

### `push_outbox` is both the push queue and the in-app bell

One insert produces the phone notification *and* the bell entry, and they cannot
disagree. `NotificationBell` selects from the table directly and lets RLS scope
it; the `push_outbox_send` trigger nudges `push-send` over `pg_net`.

- The bell shows **today only** (`created_at >= istDayStart()`), so entries
  vanish at 05:30 — read or not.
- Rows are deleted after **14 days** by `prune_push_outbox`, weekly.
- The policy `push_outbox_select_own` matches on `user_role_id` and names no
  role, which is why a new role needs no change to it.

### Every role gate is an allow-list

`operator_check_in` wants `('operator','valet_admin')`; `admin_delete_staff`
wants `'system_admin'`. A role in none of those lists is refused by all of them.
That is why adding `valet_vendor` cost three lines of SQL rather than an audit.
**Keep writing them as allow-lists.**

### A staff "delete" keeps the row

`admin_delete_staff` destroys the *login* — auth account, PIN, push
subscriptions — and frees the phone number, but keeps the `user_roles` row and
sets `deleted_at`. It has to: `parked_by` / `fetched_by` are read through a live
join on that row, so deleting it would blank the operator's name on every car
they ever handled. Five foreign keys would refuse the delete anyway.

### A property delete only works if nothing points at it

Seven tables carry a `property_id`: `parked_vehicles`, `valet_tasks`, `reviews`,
`token_ranges`, `parking_spaces`, `user_roles`, `wa_outbox`.
`admin_delete_property` counts all seven and refuses with a count if any is
non-empty. **The refusal is the feature** — it is what makes the button safe to
show on every card.

---

## 5. Traps that cost real time

Each of these produced a wrong diagnosis at least once.

### `pg_get_constraintdef` uppercases keywords

It deparses the stored expression tree, so a constraint written
`property_id is not null` comes back `property_id IS NOT NULL`. A lowercase
`LIKE` never matches. **Use `ILIKE` in every constraint assertion.**

### `prosrc` includes comments

A verify check like `prosrc not like '%wa_outbox%'` fails on the *comment*
explaining why the function doesn't touch `wa_outbox`. Strip first:

```sql
regexp_replace(prosrc, '--.*', '', 'gn')
```

The `'n'` flag stops `.` at a line end — no `\n` escape needed, which also
avoids the Bash tool turning it into a literal newline.

### A trigger's name is not its function's name

`push_outbox_send` is the trigger; `trg_push_outbox_send` is the function it
calls. Asserting the wrong one fails against working code.

### `create or replace` cannot change a `RETURNS TABLE` row type

Postgres `42P13`. Drop the function first. And when checking whether a function
was already replaced, **grep the bare function name**, not `create or replace` —
a later migration may have used `drop` + `create function`.

### Editing a big function: extract it, don't retype it

`admin_create_staff` writes `auth.users` through a dynamic column list, handles
two shapes of `auth.identities` and stores the encrypted PIN. Migrations 0065
and 0066 pull it out of the previous migration's text and patch one line, then
assert its landmarks survived. Retyping it risks breaking every new account in a
way that only shows up the next time somebody is hired.

### Our own error text was being thrown away, in two places

`raise exception 'CODE: sentence'` produces a message written for the admin —
and both error mappers dropped it unless the code was in a hardcoded list:

- `src/lib/adminApi.js` → `describeRpcError`
- `src/supabase.js` → `describeDbError`

Both now prefer the raise's own detail. If you add a third mapper, do the same.

### Edge functions deployed from the dashboard cannot import `../_shared`

The dashboard bundles only the function's own folder. `ambria-bookings` is
therefore **self-contained** — its CORS helpers and caller check are copied in,
which means a change to `_shared/caller.ts` does *not* reach it. Deploying that
one with the CLI instead would remove the trap.

### Secrets are injected at container boot

Changing a secret does not affect a warm isolate. Redeploy the function, or wait
for it to recycle.

### An inline `style` beats a Tailwind class

The venue tint was an inline `background` on the calendar tile and silently
cancelled the `bg-brand-soft` band. It is now an absolutely-positioned layer, so
band, tint and text compose.

### WhatsApp templates: parameters are counted per component

`#132000 Number of parameters does not match` means the count is wrong for a
*component*, not the message. A variable in the **header** needs a `header`
component; sending it as `body` fails on both counts at once. `TEMPLATE_SLOT` in
`wa-dispatch` records which component each template uses.

Also: template **category is decided by content**. Feedback/survey/brand
language is Marketing however it is declared. And a message card has a total
height budget — three quick-reply buttons eat into the body's share, so a
shorter body with three buttons can truncate where a longer one with a single
button does not.

---

## 6. Runbook

### Migrations

Numbered files in `supabase/migrations/`, run **in order** in the Supabase SQL
Editor of the **valet** project. Each ends with a verify block — every row must
read `PASS`.

If the editor warns *"creates a table without enabling RLS"* on a migration that
creates no table, choose **Run without RLS**. It is pattern-matching on
`auth.users` appearing inside a function body.

> Two queries have been run against the **wrong project** in the past. Check
> which project the SQL Editor is on before pressing Run.

### Edge functions

| Function | JWT | Called by |
|---|---|---|
| `wa-dispatch`, `wa-webhook` | **off** | pg_net / Meta |
| `push-send` | **off** | pg_net |
| `ambria-bookings-sync` | **off** | pg_cron via pg_net |
| `ambria-bookings` | **on** | the browser |
| `valet-report` | — | Ambria's proxy (no CORS, deliberately) |

"JWT off" endpoints are publicly callable. That is acceptable only because they
are idempotent — re-running them does nothing. Keep it that way.

### Secrets (never in the repo)

`WA_*` for WhatsApp, `AMBRIA_FEED_URL` + `AMBRIA_FEED_KEY` for the bookings
feed, `REPORT_API_KEY` for the report API.

### Checks

`npm run check` runs eight scripts — unbound identifiers, icon names, the PWA
update path, auto-translation, i18n coverage, `selectOptional` usage, Hindi
input, and the service-day boundary. **All eight must print OK.**

The i18n check cannot see keys built at runtime — `t(\`role.${role}\`)`,
`t(\`nav.${item.key}\`)`. Adding a role or a nav item means adding those keys by
hand; nothing will warn you.

---

## 7. The log

Newest at the bottom. One entry per piece of work: what changed, and anything
learned that the sections above should eventually absorb.

### 2026-09-05 — Valet Bookings, the vendor role, and booking alerts

**Valet Bookings tab.** A read-only calendar of Ambria's bookings, built to
`AMBRIA_VALET_BOOKINGS_FEED.md`. Month grid, day panel beside it, Daily /
Weekly / Monthly totals with the counted days banded in the grid. Weekly is a
**rolling seven days** from the anchor, not Mon–Sun, so the fetch reaches six
days either side of the month or the total is silently short.

- `supabase/functions/ambria-bookings/index.ts` — the proxy holding the feed key
- `src/lib/ambriaFeed.js` — `ambriaFeed()`, `AmbriaFeedError` with `.isSetup`
- `src/pages/admin/ValetBookings.jsx`
- Routes for valet admin, system admin and vendor; all three render one component

The CRM **events** leg was removed on request, so the request sends
`events: false`. That took every call from ~2s (and a ~15s worst case when
Ambria's sweep cache expired) down to ~1s with no worst case, and collapsed two
poll intervals into one.

**`valet_vendor` role** (migrations 0065, 0066). An outside staffing firm that
sees the bookings calendar and nothing else. No property. A valet admin cannot
create one — that branch of `admin_create_staff` hardcodes `'operator'`.

**A vendor sees only their own bookings.** Filtered in the **proxy**, not the
page: filtering in the browser would still ship every vendor every rival firm's
customer names, guest counts and contact numbers, one DevTools tab away. Matched
on `valet_phone` normalised to the **last 10 digits** — numbers on file were
hand-typed in three different shapes (bare, `+91 ` prefixed, and with an
internal space), so a raw string compare fails on most of them while looking
perfectly correct in the code.

**Booking alerts** (migration 0067 + `ambria-bookings-sync`). Ambria's database
never calls us, so a `pg_cron` job every two minutes reads the feed and diffs it
against `ambria_booking_seen`. New or reassigned booking → one `push_outbox` row
→ phone notification and bell entry.

- **The first run announces nothing** — it seeds silently, or it would push a
  year of bookings at once.
- **It records before it notifies.** The other order re-announces forever if the
  record fails.
- The seen table stores *who* each was announced to, so a reassignment reaches
  the new firm.

**Property delete** (migration 0068), described in §4.

**Also:** Inter is now actually loaded. `tailwind.config.js` had asked for it
since the project started and nothing ever served it, so every device fell
through to Segoe UI / Roboto / San Francisco. Self-hosted via
`@fontsource-variable/inter` (~48 kB latin) rather than Google Fonts, because
this is an offline-capable PWA and `sw.js` already caches `.woff2` cache-first.
Inter has no Devanagari, so Hindi still uses the system font — matching it would
mean a second family and roughly double the bytes.

**Wrong diagnoses made along the way**, recorded because the pattern matters
more than the instances: the LMS cache migration was blamed for slow loads (it
was already applied), then the CRM leg was blamed (measurement showed 2.67s and
2.16s — the two-stage load I had added was itself the cost). Both were guesses
where the answer was one measurement away. **Measure before diagnosing.**
