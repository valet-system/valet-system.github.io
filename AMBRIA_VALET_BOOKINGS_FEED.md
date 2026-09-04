# Ambria valet feed — bookings + venue events, for the Valet Admin project

**Give this file to Claude in the Valet Admin project.** It describes an endpoint
that already exists on the Ambria Admin side, and what to build against it.

---

## 1. What this is for

Valet bookings are created in **Ambria Admin** (a separate app, on a separate
Supabase project). Each booking says: on this date, at this venue, for this many
guests, this many valet staff are needed.

Underneath the bookings, Ambria also lists **confirmed venue events from the CRM
(LMS) that have no valet booking yet** — that is the "what still needs a booking"
list.

The valet team needs to see the same screen inside **Valet Admin**. This feed
returns both lists, and mirrors what Ambria's own **valet role** sees.

**It is read-only, and it must stay read-only.** Bookings are created, edited and
deleted in Ambria Admin only — that app owns the unique constraint, the staffing
matrix and the event matching. A second writer would quietly break all three. If
the valet team needs to *change* a booking, that is a different feature and needs
a conversation, not a POST.

---

## 2. Architecture — and why it is not a shared Supabase key

```
Valet Admin browser
      │  (your own project's anon key)
      ▼
Valet Admin edge function          ← holds the feed key as a secret
      │  (x-feed-key: <secret>)
      ▼
Ambria: valet-bookings-feed        ← the endpoint below
      │                                    │
      ▼                                    ▼
Ambria DB: valet_bookings          Ambria: lms-proxy ──> CRM
```

**Do not ask for Ambria's anon key, and do not accept it if offered.** Every
table in the Ambria project carries a permissive `"Allow all"` RLS policy — that
app authenticates against its own `users` table and gates on roles in the UI, not
in the database. So Ambria's anon key is not a read key for valet bookings; it is
full read and write on staff, attendance, tasks, repair requests and everything
else. A shared secret that unlocks exactly one read is the correct blast radius.

**Put the feed key in an edge function on your side, not in the React bundle.**
Anything in a Vite bundle is public — `view-source` is enough. Your app calls
your own function; your function holds the key. This mirrors how Ambria already
talks to the valet report API, so the pattern is not new to either codebase.

---

## 3. The endpoint

```
POST https://<AMBRIA_PROJECT>.supabase.co/functions/v1/valet-bookings-feed
Header:  x-feed-key: <the shared secret>
Header:  content-type: application/json
Body:    { "from": "2026-09-01", "to": "2026-12-31" }
```

`GET` with a query string works identically, if that is easier.

No `Authorization` header is needed — the function is deployed with
`--no-verify-jwt` and the `x-feed-key` header is the gate.

### Request parameters

| Name | Required | Notes |
|---|---|---|
| `from` | yes | `YYYY-MM-DD`. Inclusive. |
| `to` | yes | `YYYY-MM-DD`. Inclusive. Must not be before `from`. |
| `property` | no | One of `pp`, `ex`, `mk`, `rs`, `jp`. Omit for all venues. |
| `events` | no | `"false"` skips the CRM leg and returns bookings only. Default on. |

The range is capped at **400 days**. A wider one is a `400 RANGE_TOO_WIDE`, not a
truncated list — a silently short answer is worse than an error.

### Success response

```json
{
  "ok": true,
  "from": "2026-09-01",
  "to": "2027-12-31",
  "properties": [
    { "code": "pp", "name": "Pushpanjali", "color": "#2a78d6" },
    { "code": "ex", "name": "Exotica",     "color": "#e87ba4" },
    { "code": "mk", "name": "Manaktala",   "color": "#008300" },
    { "code": "rs", "name": "Restro",      "color": "#eda100" },
    { "code": "jp", "name": "Janakpuri",   "color": "#4a3aa7" }
  ],
  "count": 1,
  "bookings": [
    {
      "id": "v_1784526630906_412",
      "property": "ex",
      "property_name": "Exotica",
      "event_date": "2027-02-16",
      "event_time": "9:00 AM",
      "customer_name": "Vikram Bhardwaj",
      "guests": 30,
      "staff_total": 3,
      "staff_breakdown": [
        { "role": "Key Man", "count": 1 },
        { "role": "Driver",  "count": 2 },
        { "role": "Guard",   "count": 0 },
        { "role": "Rider",   "count": 0 }
      ],
      "heavy_date": false,
      "notes": null,
      "created_at": "2026-08-30T11:04:22.418Z"
    }
  ],
  "events_count": 1,
  "events": [
    {
      "id": 572,
      "entry_no": "00543",
      "property": "mk",
      "property_name": "Manaktala",
      "event_date": "2027-02-16",
      "event_time": "7:00 PM",
      "customer_name": "Vikram Bhardwaj",
      "function_type": "Wedding",
      "guests": 0
    }
  ],
  "events_error": null
}
```

### Errors

Every error is `{ "ok": false, "code": "...", "error": "..." }`.

| HTTP | `code` | Means |
|---|---|---|
| 403 | `FORBIDDEN` | Missing or wrong `x-feed-key`. |
| 400 | `BAD_RANGE` | `from`/`to` missing, malformed, or reversed. |
| 400 | `RANGE_TOO_WIDE` | More than 400 days. |
| 400 | `NO_SUCH_PROPERTY` | `property` is not one of the five codes. |
| 503 | `FEED_NOT_CONFIGURED` | `VALET_FEED_KEY` is not set on the Ambria project. |
| 502 | `QUERY_FAILED` / `UNREACHABLE` | Ambria's own database call failed. |

Check `ok` before reading anything. Show the `error` string when it is false —
all six are diagnosable from the message, and swallowing it turns a one-minute
fix into an afternoon.

**`events_error` is separate from `ok` on purpose, and it is a warning rather
than a failure.** The CRM is an outside system; the bookings come from Ambria's
own database and are fine regardless. Two things put a string in this field:

- The CRM was unreachable **and a cached sweep was available**. Then `events` is
  populated but a few hours old, and the message says how old. Render the events
  and show the note — stale events are far better than an empty list, because
  "nothing scheduled" is a much more misleading thing to show than "this is a few
  hours old".
- The CRM was unreachable **and there was no cache at all**. Then `events` is
  empty and the message says why.

Either way `ok` stays `true`. Render the bookings normally and put the note where
the events go. Never treat this as "no events" — an empty list and a failed fetch
need different reactions from whoever is looking.

---

## 4. Field notes — read these before rendering anything

Each of these is a real property of the data, not a hypothetical.

### Guest phone is not in this feed, by design

Ambria hides the guest's phone number from its **valet role**, and the audience
on this side of the feed is the valet team. Sending it here would route around a
rule that already exists. Do not add a phone column and do not source it from
somewhere else. If the valet project genuinely needs it, raise it as a decision
rather than a patch.

### Bookings

**`staff_breakdown` and `staff_total` are a snapshot. Do not recompute them.**
Ambria computes staffing from an editable per-venue matrix, and an admin can
override the result for one booking. What you receive is what that booking was
actually saved with. Recomputing from guest count would silently disagree with
the number the admin decided on, and there is no way to tell from here which of
you is wrong. Render them as given.

**`staff_breakdown` can be `null`** on older bookings. `staff_total` is still
correct — show the total and skip the per-role chips.

**Filter `staff_breakdown` to `count > 0` when rendering chips.** Roles a venue
does not use come through as zero (`Rider: 0` above), and a row of zeroes reads
as a mistake.

**`heavy_date: true`** means the admin marked it a heavy date, and the staffing
snapshot already includes the extra drivers that flag adds. It is a label to
show, not a multiplier to apply.

**`id` is a `TEXT` string like `v_1784526630906_412`, not a UUID.** Opaque, and
stable, so it is a good React `key`.

**At most one booking per venue per day.** Ambria enforces
`UNIQUE (property, event_date)`, so one day holds at most five bookings.

### Events

**`events` only contains events with no booking yet.** A booking made in Ambria
makes its event disappear from this list on the next fetch, and deleting that
booking brings it back. That is the whole point of the list — it is the
"still needs a valet booking" queue, not a copy of the CRM calendar.

The match is on **date + customer name + time**, deliberately ignoring venue: a
booking recorded against the wrong venue should still mark its event handled.
Two consequences worth knowing rather than discovering: two CRM events on the
same day with the same name and time collapse to one slot, and a booking whose
customer name was edited away from the CRM's spelling stops hiding its event.

**`property` is always one of the five codes** — events at venues Ambria does
not run valet for are already filtered out. Janakpuri has no CRM venue id, so it
produces bookings but never events.

**`guests` can genuinely be `0`.** The CRM really sends 0 for some events. Show
`0`, do not hide the field, and do not substitute anything — Ambria shows `0`
too, and the two apps disagreeing about the same event is the confusing outcome.

**`event_time` is free text, not a time.** Real values include `"9:00 AM"`,
`"7:00 PM"` and `"7 PM onwards"`. Do not parse it into a `Date`, and do not sort
on it expecting chronology. Display as-is.

**`function_type` is already resolved** to `"Wedding"`, `"Haldi"` and so on. It
can be absent.

**`id` here is the CRM's row id, a number.** Use it as the key — **not
`entry_no`**, which is not unique: rows 668 and 669 share one entry number in the
live data. That is exactly the bug this note exists to prevent.

### Venues

**Use the `properties` array. Do not hardcode names or colours.** The five
colours are the ones Ambria shades its calendar with, so taking them from here is
what makes the two calendars look like the same product. If a sixth venue is
added, this array is what keeps you correct.

---

## 5. Keeping it live

**Poll. There is no cross-project Realtime here** — a Supabase Realtime
subscription against the Ambria project would need Ambria's anon key in your
browser, which is exactly what section 2 rules out.

Three things matter more than the interval:

- **Gate polling on tab visibility.** Browsers throttle timers in a hidden tab to
  roughly once a minute and freeze one hidden long enough, so an interval alone
  gives you stale data that *looks* current. Refetch on
  `visibilitychange` → visible, and skip ticks while hidden.
- **Never let two fetches overlap.** Hold an in-flight flag and drop the tick if
  the previous request has not returned.
- **Allow a generous timeout — 60s, not 10s.** Measured on the Ambria side: the
  CRM sweep takes **14–16 seconds**, every time, and that is the CRM's cost, not
  something either app can optimise away. Ambria caches the result for ten
  minutes in a table, so most calls skip it — but the call that refreshes the
  cache pays the full 15s, and a 10s timeout turns that into an error you will
  chase for an hour.

Two intervals work better than one, because bookings and events do not change at
the same rate:

| Call | Interval | Cost |
|---|---|---|
| `{"events":"false"}` | 30s | ~1s — bookings only, no CRM leg |
| full call | 5–10 min | ~1s cached, ~15s when it refreshes |

Bookings are what changes during a working day; CRM events barely move
hour to hour. Ambria's own tabs poll at 5s for a reason that does not apply to
you — they are the app doing the editing.

Deletions handle themselves: each poll replaces both lists, so a booking deleted
in Ambria disappears here on the next fetch, and its event reappears. Do not
merge results into existing state by id — that is exactly how deleted rows become
immortal and how a booked event stays hidden forever.

---

## 6. What to build

A **Valet Bookings** view, visible to **the valet admin and system admin roles
only** — use whichever role constants this project already has; do not invent a
new permission concept for one read-only tab.

Matching how Ambria presents the same data:

**A calendar**, month at a time, with each day tinted by the venue colours of
that day's bookings (several bookings split the tile). A month picker drives
`from`/`to`. Clicking a day opens the day's detail.

**The day detail, in two sections** — this order carries the meaning, so keep it:

1. **Valet Booking** — one card per booking: customer name, venue name under it,
   then time and guest count as a row of small labelled items. Inside the card, a
   staffing block: the words "Valet staff needed", `staff_total` large and
   right-aligned, and the non-zero `staff_breakdown` roles as chips
   (`Key Man: 1`, `Driver: 2`). A "heavy date" badge when `heavy_date` is true,
   and `notes` as a paragraph when present.

2. **Venue events (LMS)** — the events with no booking yet: name, time, function
   type, venue. When some of the day's events are already booked, say so quietly
   rather than silently showing a shorter list — Ambria prints
   `"2 already booked, so not listed here"`, and when every event is booked it
   says `"All 3 events booked"` instead of "no events", because those are
   different facts.

**Empty and error states must differ.** "No bookings in this range", "the request
failed", and "the CRM leg failed but bookings are fine" need three different
messages. Whoever is looking reacts differently to each.

Mark the view clearly as read-only. Someone will otherwise try to edit a card,
and finding out there is no save button is a worse way to learn it than a label.

---

## 7. Test it first, with curl, before writing UI

Ask for the feed key and the Ambria project URL, then:

```bash
curl -s -X POST \
  "https://<AMBRIA_PROJECT>.supabase.co/functions/v1/valet-bookings-feed" \
  -H "x-feed-key: <secret>" \
  -H "content-type: application/json" \
  -d '{"from":"2026-01-01","to":"2027-12-31"}'
```

Expect `{"ok":true,...}` with `bookings`, `events` and `properties`. The first
call may take a while — see the timeout note in section 5.

Then check the failure paths on purpose, because these are the ones you will hit:

- Wrong key → `403 FORBIDDEN`
- No `from` → `400 BAD_RANGE`
- `{"events":"false"}` → returns fast, with `events: []` and no `events_error`

If you get a Supabase gateway `{"code":"NOT_FOUND"}` instead, the function is not
deployed under that name — an Ambria-side step, section 8, not a bug in your
request. If you get `401 UNAUTHORIZED_NO_AUTH_HEADER`, the function exists but
was deployed with JWT verification **on**; also section 8.

---

## 8. Steps, and who does them

### On the Ambria Admin side (code is written; needs deploying)

1. Generate a long random secret, e.g. `openssl rand -hex 32`.
2. Supabase Dashboard → **Ambria Admin** project → Edge Functions → Secrets →
   add `VALET_FEED_KEY` = that secret. Secrets are project-wide, so this is set
   once. Do **not** add `SUPABASE_URL` or `SUPABASE_SERVICE_ROLE_KEY` — the
   platform injects both.
3. Deploy as **`valet-bookings-feed`**, spelled exactly, with JWT verification
   **off** (`--no-verify-jwt`, or the toggle in the function's Settings tab).
4. Share **the secret and the Ambria project URL** with the valet project. Share
   nothing else — not the anon key, not the service role key.

### On the Valet Admin side (what Claude in that project does)

5. Add an edge function there holding `AMBRIA_FEED_KEY` and `AMBRIA_FEED_URL` as
   secrets, forwarding `from` / `to` / `property` / `events` to the endpoint.
6. Build the view in section 6, fetching through that function.
7. Gate it to the valet admin and system admin roles.
8. Poll per section 5 — visibility-gated, no overlap, 60s timeout.

### SQL migrations to run

**On the Ambria project, one file:**

```
SUPABASE-MIGRATION-LMS-FEED-CACHE.sql
```

It creates `lms_feed_cache`, a one-row table holding the CRM sweep so that
repeated calls do not each pay 15 seconds for it. Ambria's developer runs this in
the Supabase SQL Editor; it is safe to run more than once, and it prints PASS
rows to confirm.

The feed still works without it — `readCache` treats a missing table as a cache
miss — it is just slow on every single call. If every request takes ~15s, this
file has not been run.

**On the Valet Admin project: none.** Nothing here needs a table on your side.

---

## 9. Reference — the Ambria side, for when something does not add up

| What | Where |
|---|---|
| The feed function | `supabase/functions/valet-bookings-feed/index.ts` |
| The CRM proxy it calls | `supabase/functions/lms-proxy/index.ts` |
| The sweep cache table | `supabase/db/migrations/SUPABASE-MIGRATION-LMS-FEED-CACHE.sql` |
| `valet_bookings` schema | `supabase/db/migrations/SUPABASE-MIGRATION-VALET-BOOKINGS.sql` |
| `heavy_date` column | `supabase/db/migrations/SUPABASE-MIGRATION-VALET-HEAVY-DATE.sql` |
| Staffing matrix + override | `supabase/db/migrations/SUPABASE-MIGRATION-VALET-STAFF-EDIT.sql` |
| The staffing rule | `src/constants/valetMatrix.js` (`allocateValet`) |
| Venue codes, names, colours | `src/constants/org.js`, `src/lib/lms.js` |
| CRM normalisation this feed mirrors | `src/lib/lms.js` |
| How Ambria renders the same screen | `src/pages/admin/Valet.jsx` (`BookingCard`, `LmsVenuePanel`) |

Paths are inside the **ambria-workforce** repo. The migration files are
git-ignored, so they exist on the Ambria developer's machine rather than in a
clone — ask for the one you need instead of assuming it is missing.