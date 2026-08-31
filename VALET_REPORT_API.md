# Valet Report API

**Read-only analytics from the Valet Parking system, for another app.**

This document is the handover spec. It is written for a developer working on
**Ambria Admin** (`ambria-workforce`), who wants the valet analytics screen —
cars per day, guest wait times, peak hours, per-operator workload — inside their
own app, with a CSV download of the guest list.

---

## 0. Start here — what is already done

**The valet side is finished and live.** You do not need to touch it, and you
cannot see it from this repo — it is a different Supabase project.

Already done for you:

| | |
|---|---|
| Valet API deployed at | `https://vyirixtdgheypbpffsct.supabase.co/functions/v1/valet-report` |
| Its `REPORT_API_KEY` | set, on the valet project |
| Migration 0037 | run, so the database allows a server to read |
| **This project's secrets** | `VALET_REPORT_URL` and `VALET_REPORT_KEY` — already set in Ambria Admin's own Edge Function secrets |

Note the function name is **`valet-report` with a hyphen**, not an underscore.
It briefly existed under the underscore spelling and that URL is now a `404`, so
if a call comes back "Requested function was not found", check this first.

**So your job is only the three things in section 4:**

1. A proxy Edge Function in *this* project (`valet-analytics`) — section 4.2
2. The analytics page that calls it — section 4.3 and section 5
3. The CSV download button — section 8

Do **not** put the API key in the frontend. Section 3 explains why, and it is
enforced — a direct browser call physically cannot work.

If a call comes back `503 NOT_MIGRATED` or `401 UNAUTHORISED`, that is a valet-side
or secret problem, not your code. Section 6 says which is which.

---

## 1. Why an API at all

Ambria Admin and Valet Parking are **two different Supabase projects**. They do
not share a database and they do not share users.

That matters more than it sounds. Every reporting function in the valet database
starts by asking *who are you*:

```sql
select ur.role, ur.property_id into v_role, v_mine
from public.user_roles ur
where ur.user_id = auth.uid() and ur.is_active = true;

if v_role is null then
  raise exception 'FORBIDDEN: you are not signed in as an active user';
end if;
```

An Ambria Admin user's JWT is signed by the *Ambria Admin* project. Presented to
the valet project it is not a valid token, so `auth.uid()` is null, so there is
no row to find, so the answer is always `FORBIDDEN`.

Three ways out, and why this is the one:

| Approach | Why not |
|---|---|
| Share the valet **anon key** | Grants nothing. The anon key is not a user, and these functions are explicitly `revoke`d from `anon`. It would fail identically. |
| Give every Ambria Admin user a **valet account too** | Works, but means a second login, two places to add a new manager, and two places to deactivate someone who leaves. The accounts drift apart and one day somebody who left still has access. |
| **A server-to-server API** ← this one | One secret, held by one server. Nobody gets a second login, and access is revoked by rotating one key. |

---

## 2. What the valet side gave you

Both are **already stored as secrets in this project** (see section 0), so you
read them from `Deno.env`, never from a file you can see.

| | |
|---|---|
| **Base URL** | `https://vyirixtdgheypbpffsct.supabase.co/functions/v1/valet-report` — in `VALET_REPORT_URL` |
| **API key** | A long random string, in `VALET_REPORT_KEY`. Goes in the `X-API-Key` header. |

The URL is not a secret — it is in the valet app's public bundle already. The
key is. If you ever need the key changed, the valet team rotates
`REPORT_API_KEY` on their side and re-issues it; nothing is redeployed.

---

## 3. The one rule that matters

> ### The API key must never reach a browser.
>
> Not in `VITE_…`, not in `.env` on the frontend, not in a `fetch()` from a React
> component. Anything in a Vite bundle is **public** — `view-source` is enough.
> This key reads every property's figures.

Your **frontend** calls **your own Edge Function**, which holds the key and
calls this API. Three hops, and the secret stays on a server:

```
Ambria Admin browser
   │  (the user's own Ambria Admin JWT)
   ▼
Ambria Admin Edge Function  ──── holds VALET_REPORT_KEY as a Supabase secret
   │  (X-API-Key)
   ▼
Valet  /functions/v1/valet-report
   │  (service_role, inside the valet project only)
   ▼
Valet Postgres — aggregates and returns
```

**This is enforced, not just advised.** The API sends **no CORS headers** and
answers `OPTIONS` with `405`. A `fetch()` from your frontend will fail the
browser's CORS check before you can read the response. That is deliberate: the
wrong integration breaks loudly on day one instead of shipping a leaked key
quietly.

---

## 4. Setup on the Ambria Admin side

### 4.1 The secrets — already set, just confirm

Supabase dashboard → **Edge Functions → Secrets** (of the *Ambria Admin*
project). These two should already be there:

```
VALET_REPORT_URL = https://vyirixtdgheypbpffsct.supabase.co/functions/v1/valet-report
VALET_REPORT_KEY = <the key>
```

If they are missing, ask for the key — do not invent one, it has to match the
valet side exactly or every call is a `401`.

### 4.2 Add a proxy function

`supabase/functions/valet-analytics/index.ts` — this is the whole thing:

```ts
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type',
  'Content-Type': 'application/json',
}

Deno.serve(async (req) => {
  // Your frontend IS a browser, so this half does need CORS.
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })

  // ── 1. Who is asking? Their Ambria Admin JWT, verified here. ──────────
  const authHeader = req.headers.get('Authorization') ?? ''
  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_ANON_KEY')!,
    { global: { headers: { Authorization: authHeader } } },
  )

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) {
    return new Response(JSON.stringify({ error: 'Sign in first.' }), {
      status: 401, headers: CORS,
    })
  }

  // ── 2. Are they allowed? Use YOUR OWN admin check here. ───────────────
  // Whatever Ambria Admin already uses to gate an admin page — the same thing.
  // Without this, any signed-in employee can read every property's figures.
  //
  //   const { data: profile } = await supabase.from('profiles')
  //     .select('role').eq('id', user.id).single()
  //   if (profile?.role !== 'admin') return 403

  // ── 3. Forward. The key never leaves this function. ───────────────────
  const url = new URL(req.url)
  const report = url.searchParams.get('report') ?? 'summary'
  const params = new URLSearchParams(url.searchParams)
  params.delete('report')

  const upstream = await fetch(
    `${Deno.env.get('VALET_REPORT_URL')}/${report}?${params}`,
    { headers: { 'X-API-Key': Deno.env.get('VALET_REPORT_KEY')! } },
  )

  // Passed through as-is, status included, so a 503 NOT_MIGRATED stays a 503
  // and does not get flattened into a generic failure you cannot diagnose.
  return new Response(await upstream.text(), {
    status: upstream.status,
    headers: CORS,
  })
})
```

Deploy it:

```bash
supabase functions deploy valet-analytics
```

Or without the CLI: Supabase dashboard → **Edge Functions → Deploy a new
function → Via editor**, name it `valet-analytics`, paste the code above, Deploy.

**Leave JWT verification ON for this one.** Its callers are your own users with
your own project's tokens, so the gateway can and should check them. (The valet
function has it off, for the opposite reason — its caller's token comes from a
different project and could never verify.)

### 4.3 Call it from the page

```js
import { supabase } from '../lib/supabase'

async function valetReport(report, params = {}) {
  const query = new URLSearchParams({ report, ...params })
  const { data, error } = await supabase.functions.invoke(
    `valet-analytics?${query}`,
    { method: 'GET' },
  )
  if (error) throw error
  if (!data?.ok) throw new Error(data?.error ?? 'Could not load the figures.')
  return data
}

// Last 30 days, all properties
const { summary } = await valetReport('summary')

// One property, a named month
const { summary } = await valetReport('summary', {
  property_id: '…uuid…',
  from: '2026-07-01',
  to: '2026-07-31',
})
```

---

## 5. Endpoints

All are `GET`. All take `X-API-Key`. All return
`{ ok: true, … }` or `{ ok: false, code, error }`.

### Common parameters

| Param | Format | Default | Notes |
|---|---|---|---|
| `from` | `YYYY-MM-DD` | `to` − 29 days | Inclusive. |
| `to` | `YYYY-MM-DD` | today, **IST** | Inclusive. |
| `property_id` | uuid | *(omitted)* = all properties combined | |

Two behaviours worth knowing before you build a date picker:

- **A span over 730 days is clamped, not refused.** Ask for 2019 and you get the
  most recent 730 days of real numbers. Nothing tells you it was clamped except
  the `from` in the response — **read `from`/`to` back from the response** rather
  than echoing what you sent.
- **Dates are service days, not calendar days, and the service day starts at
  05:30 IST.** A car checked in at 01:00 on Saturday belongs to Friday. This is
  consistent across the whole valet system; do not re-bucket by timestamp.

---

### `GET /properties`

The property list, so you can build a picker without hardcoding uuids — they
differ between the valet team's dev and live projects.

```json
{
  "ok": true,
  "properties": [
    { "id": "…uuid…", "name": "Ambria Pushpanjali", "is_active": true }
  ]
}
```

---

### `GET /summary`

Everything one analytics screen draws, in one round trip.

```json
{
  "ok": true,
  "summary": {
    "from": "2026-07-25",
    "to": "2026-08-23",
    "days": 30,

    "cars": 4182,
    "delivered": 4090,
    "parked": 92,
    "no_shows": 37,

    "tiers": { "VIP": 210, "Standard": 3972 },

    "retrieval_wait": 7.5,
    "retrieval_count": 4090,
    "parking_time": 3.2,
    "parking_count": 4182,

    "per_day":  [{ "d": "2026-07-25", "cars": 131 }],
    "per_hour": [{ "h": 0, "cars": 4 }]
  }
}
```

| Field | Meaning |
|---|---|
| `days` | Days in the range, **inclusive of both ends** — a single day is 1, not 0. Divide by this for "cars per day". |
| `cars` | Vehicles with a service date in the range. |
| `delivered` / `parked` | `parked` counts both `parked` and `returned` — a car brought out for a guest who never came is still on site. |
| `no_shows` | Total times a car was brought out and not collected. Can exceed `cars`: one guest can no-show twice. |
| `tiers` | Object keyed by tier name, not an array. A tier with no cars is **absent**, not zero — read it as `tiers[t] ?? 0`. |
| `retrieval_wait` | **Median minutes** a guest waited: from asking to getting the car. This is the number the screen exists for. |
| `parking_time` | **Median minutes** to park a car on arrival. |
| `per_day` | One entry per day in the range, zero-filled — safe to plot directly. |
| `per_hour` | Always 24 entries, `h` = 0–23, **IST**, zero-filled. |

Three things that will bite you if you assume otherwise:

1. **`retrieval_wait` and `parking_time` are medians, and they are `null` when
   nothing completed in the range.** Not `0` — `null`. A `0` would read as
   "instant service".
2. **Always show the median next to its `_count`.** A median of 4 cars is not a
   fact anyone should re-roster a shift on, and shown alone it looks as solid as
   a median of 4,000.
3. **The wait is measured from when the guest ASKED**, not from when an admin
   dispatched someone. That is the point — a queue nobody was watching would
   otherwise score perfectly.

---

### `GET /operators`

Per-operator workload. Accepts `from`, `to`, `property_id`.

```json
{
  "ok": true,
  "operators": [
    {
      "operator_id": "…uuid…",
      "operator_name": "Sandeep",
      "operator_name_hi": "संदीप",
      "is_active": true,
      "parked": 412,
      "fetched": 388,
      "no_shows": 6,
      "retrieval_wait": 6.9,
      "total_tasks": 800
    }
  ]
}
```

Counts **completed** tasks only. A reassigned retrieval would otherwise count
for two people, and someone handed a car who never finished it would score for
it.

`operator_name_hi` is `null` for most staff. Fall back to `operator_name`.
`is_active: false` means they have left — keep them in a historical range, since
dropping them makes the totals stop adding up.

---

### `GET /by-property`

All properties side by side. Takes `from` and `to` only — comparing one property
with itself is what `/summary` is for.

```json
{
  "ok": true,
  "properties": [
    {
      "property_id": "…uuid…",
      "property_name": "Ambria Pushpanjali",
      "is_active": true,
      "cars": 1204,
      "delivered": 1180,
      "no_shows": 11,
      "retrieval_wait": 7.1,
      "retrieval_count": 1180,
      "operators": 6
    }
  ]
}
```

---

### `GET /records`

The rows behind the CSV download — **one per car**, not per guest. This is what
the download button in section 8 uses.

| Param | Format | Default | Notes |
|---|---|---|---|
| `from` / `to` / `property_id` | as above | | |
| `limit` | 1–1000 | 1000 | Hard ceiling of 1000. Asking for more is a `400`, not a silent clamp. |
| `offset` | 0+ | 0 | |
| `query` | text | *(none)* | Matches token, car number, guest name, or 4+ digits of a phone. |

```json
{
  "ok": true,
  "total": 4182,
  "limit": 1000,
  "offset": 0,
  "records": [
    {
      "id": "…uuid…",
      "service_date": "2026-08-22",
      "property_id": "…uuid…",
      "property_name": "Ambria Pushpanjali",
      "token_number": 47,
      "guest_name": "Anil Sharma",
      "guest_phone": "9876543210",
      "car_number": "DL8CAF1234",
      "car_tier": "VIP",
      "parking_location": "L2 Bay B4",
      "notes": null,
      "status": "delivered",
      "auto_delivered": false,
      "parked_at": "2026-08-22T14:12:00Z",
      "delivered_at": "2026-08-22T19:40:00Z",
      "retrievals": 1,
      "no_shows": 0,
      "parked_by": "Sandeep",
      "parked_by_hi": "संदीप",
      "fetched_by": "Vikash",
      "fetched_by_hi": null,
      "rating": "excellent",
      "review_comment": null,
      "total_count": 4182
    }
  ]
}
```

#### `auto_delivered`

`true` means **nobody handed this car over.** Half an hour before the valet day
rolls over, anything still open — parked, being fetched, standing at the
entrance — is closed out automatically so the night's cars reach the reports at
all. Those rows read `status: "delivered"` like any other, and this is the only
field that says a guest never actually collected the car.

The delivered COUNT includes them. If you show a delivery rate, decide which
number you mean and label it:

```js
const handedOver = rows.filter((r) => r.status === 'delivered' && !r.auto_delivered)
```

An older valet deployment omits the field, so test `r.auto_delivered === true`
rather than truthiness on undefined.

#### The two rating fields

| Field | What it holds |
|---|---|
| `rating` | `excellent`, `good`, `poor`, or `null` |
| `review_comment` | Free text, and **only ever on a `poor` rating** |

`null` on `rating` is not "bad service" — it is **no answer**. The guest is only
asked once, in the hand-over message, and most people do not reply. Counting
nulls as anything other than "did not answer" will make every property look
worse than it is.

`review_comment` fills in minutes AFTER the rating, in a second message: a guest
who taps Poor is asked what went wrong, and types back. So a `poor` row with a
null comment usually means the reply has not arrived yet — not that they had
nothing to say.

Both arrived with migration 0044. A valet database that has not run it yet
returns the row **without these two keys**, rather than with them set to null —
so read them defensively (`row.rating ?? null`) instead of assuming the key is
present.

---

**You must page. This endpoint will not do it for you.**

A busy quarter is several thousand rows and the ceiling is 1000 per call, so a
single call returns a *partial* export that looks complete. `total` is on every
response — loop until you have it.

```js
async function allRecords(params) {
  const rows = []
  let offset = 0
  let total = Infinity

  while (offset < total) {
    const page = await valetReport('records', { ...params, limit: 1000, offset })
    total = page.total
    if (!page.records.length) break        // guards against a total that never falls
    rows.push(...page.records)
    offset += page.records.length          // += records.length, NOT += 1000
  }
  return rows
}
```

Two details in that loop that are not decoration:

- **`offset += page.records.length`, not `+= 1000`.** If a page ever comes back
  short, adding a flat 1000 skips rows and nobody notices — the file is just
  quietly missing cars.
- **The `break` on an empty page.** Without it, a `total` that is briefly higher
  than the rows available (a car deleted mid-export) spins forever.

Paging is safe to do this way because the RPC orders by `service_date desc,
token_number desc` — a stable sort. Ordering on the date alone would let rows
shuffle between pages, duplicating some and skipping others.

**Cap it.** The valet app refuses its own export above **5000 rows** and tells
the user to narrow the dates, rather than hand over a file that takes a minute
to build. Worth copying — a manager who picks "this year" on four properties
otherwise waits on 40 sequential queries.

---

## 6. Errors

Always `{ ok: false, code, error }`.

| HTTP | `code` | What it means | What to do |
|---|---|---|---|
| 400 | `BAD_REQUEST` | A malformed `from`/`to`/`property_id`. | Fix the call. `error` names the parameter. |
| 400 | `BAD_RANGE` | `from` is after `to`. | Fix the call. |
| 401 | `UNAUTHORISED` | Bad or missing `X-API-Key`. | Check the secret is set on **your** function. Deliberately does not say which. |
| 404 | `NO_SUCH_REPORT` | Unknown endpoint name. | One of `properties`, `summary`, `operators`, `by-property`. |
| 405 | `METHOD` | Not a `GET` — **or a browser preflight**. | If you see this from a frontend `fetch`, you are calling it directly. Go through your own function. |
| 503 | `NOT_CONFIGURED` | `REPORT_API_KEY` unset on the valet side. | Tell the valet team. Not retryable. |
| 503 | `NOT_MIGRATED` | Migration 0037 has not been run. | Tell the valet team. Not retryable. |
| 502 | `DB_ERROR` | The database read failed. | Retryable. Details are in the valet function's logs, not in the response. |

`NOT_CONFIGURED` and `NOT_MIGRATED` are worth surfacing differently in your UI
from `DB_ERROR`: they are setup problems, and a spinner-and-retry on them just
hides the thing somebody needs to go fix.

---

## 7. Testing it

From a terminal. Not from browser devtools — pasting the key into a console is
one copy-paste away from pasting it into a component, and it will not work from
a browser anyway (no CORS headers, by design):

```bash
KEY='…'
BASE='https://vyirixtdgheypbpffsct.supabase.co/functions/v1/valet-report'

# Should list the properties
curl -s -H "X-API-Key: $KEY" "$BASE/properties"

# Should be 401
curl -s -o /dev/null -w '%{http_code}\n' "$BASE/summary"

# Last 7 days
curl -s -H "X-API-Key: $KEY" "$BASE/summary?from=2026-08-17&to=2026-08-23"
```

If `/properties` works and `/summary` returns `NOT_MIGRATED`, the function is
deployed but migration 0037 has not been run.

---

## 8. The download button

A **CSV** of the guest list, with three columns: guest name, phone number, car
tier. No library and no `npm install` — CSV is plain text.

> The valet app's own export is the same three columns, so the two files match.
> Everything else the valet screen shows — date, property, car number, who parked
> it, who fetched it — stays on the screen. The table is for verifying a visit;
> the file is for taking a guest list away.

### 8.1 The helper

`src/utils/csv.js`:

```js
/**
 * Turns rows into a CSV file and hands it to the user.
 *
 * @param filename e.g. 'valet-guests-2026-08-23.csv'
 * @param cols     [{ key, label }]
 * @param rows     plain objects keyed by `key`
 */
export function downloadCsv(filename, cols, rows) {
  if (!rows?.length) return

  const cell = (col, value) => {
    // '' as well as null. A text column left to handle '' emits ="" — which
    // looks blank in Excel but is a formula, so ISBLANK disagrees with the eye.
    if (value === null || value === undefined || value === '') return ''
    const s = String(value)
    const needsQuoting = /[",\n\r]/.test(s)

    // ── THE PHONE COLUMN MUST BE FORCED TO TEXT ──────────────────────────
    // CSV carries no cell types, so Excel guesses "number" for a phone and
    // renders it in scientific notation. MEASURED, from a real export:
    //
    //     Guest name   Number        Car tier
    //     Kbks         6.576E+09     Standard
    //     Msm          1E+10         VIP
    //
    // The digits are still in the file; Excel is only displaying them that way.
    // But the column is unreadable, and widening it is a per-open workaround,
    // not a fix. ="…" is read as a formula returning a string, which pins the
    // value to text regardless of column width.
    //
    // UNQUOTED on purpose — quoting it makes Excel show the literal ="123…",
    // which is worse. So a value containing a comma falls through to ordinary
    // quoting instead of breaking the row. Phones never contain one.
    if (col.text && !needsQuoting) return `="${s}"`

    // Quote only when needed, and double any inner quote. A guest called
    // "Sharma, Anil" would otherwise split into two columns and shift every
    // field after it on that row.
    return needsQuoting ? `"${s.replace(/"/g, '""')}"` : s
  }

  const csv = [
    cols.map((c) => cell({}, c.label)).join(','),
    ...rows.map((row) => cols.map((c) => cell(c, row[c.key])).join(',')),
  ].join('\r\n')

  // ── THE BOM IS NOT OPTIONAL ──────────────────────────────────────────
  // '﻿' first, or Excel opens the file as the system codepage and every
  // Hindi name becomes mojibake — "अनिल" reads as "à¤…à¤¨à¤¿à¤²". The file is
  // valid UTF-8 either way; Excel simply does not look unless the BOM is there.
  const blob = new Blob(['﻿', csv], { type: 'text/csv;charset=utf-8;' })

  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  document.body.appendChild(link)
  link.click()
  link.remove()

  // ── RELEASE ON pagehide, NOT ON A TIMER ──────────────────────────────
  // A one-second timer was tried on the valet side and MEASURED failing:
  //
  //     download begin  valet-guests.csv
  //     download inProgress   (x5)
  //     download canceled
  //
  // The browser writes the file asynchronously and takes longer than a second
  // even for a small CSV, so revoking on a timer cancels a download that had
  // already started — and nothing surfaces, because the click succeeded and any
  // success toast has already been shown.
  //
  // pagehide rather than beforeunload: beforeunload does not fire reliably on
  // mobile Safari, which is where a tab is most likely to be discarded.
  window.addEventListener('pagehide', () => URL.revokeObjectURL(url), { once: true })
}
```

### 8.2 The button

```jsx
import { useState } from 'react'
import { downloadCsv } from '../utils/csv'

// THREE columns: who came, what they drove, how to reach them.
//
// >>> 'Number' MUST STAY LAST. Do not add a column after it. <<<
// CSV cannot carry a column width, so Excel opens every column at its default
// 8.43 characters and a ten-digit phone does not fit. Excel DOES spill text past
// a cell's edge when the cells to its right are empty — so as the last column
// the phone shows in full. Add a fourth and it silently starts clipping again.
const COLUMNS = [
  { key: 'name', label: 'Guest name' },
  { key: 'tier', label: 'Car tier' },
  // text: true, or Excel shows 6.576E+09 instead of the number. See 8.1.
  { key: 'phone', label: 'Number', text: true },
]

function ExportButton({ range, propertyId }) {
  const [busy, setBusy] = useState(false)

  async function onExport() {
    setBusy(true)
    try {
      const rows = await allRecords({          // the paging loop from section 5
        from: range.from,
        to: range.to,
        ...(propertyId ? { property_id: propertyId } : {}),
      })
      if (!rows.length) {
        alert('Nothing to export for those dates.')
        return
      }

      downloadCsv(
        `valet-guests-${range.to}.csv`,
        COLUMNS,
        rows.map((r) => ({
          name: r.guest_name ?? '',
          phone: r.guest_phone ?? '',
          tier: r.car_tier ?? '',
        })),
      )
    } catch (err) {
      alert(err.message ?? 'Could not build the file.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <button onClick={onExport} disabled={busy}>
      {busy ? 'Preparing…' : 'Download CSV'}
    </button>
  )
}
```

### 8.3 Three things worth knowing

**One row per CAR, not per guest.** `/records` returns vehicles, so a guest who
came twice in the range appears twice, and a regular appears every visit. If you
want one row per person, dedupe on `guest_phone` before passing the rows in —
the phone is the identity in this system, not the name.

**Phone numbers do NOT survive Excel unless you force them to text.** This was
tried the naive way first and it failed — a real export opened as:

```
Guest name   Number        Car tier
Kbks         6.576E+09     Standard
Msm          1E+10         VIP
```

CSV carries no cell types, so Excel guesses "number". Widening the column makes
the digits reappear, which is why this is easy to dismiss as cosmetic — it is
not, because every person who opens the file has to do it again. `text: true` on
that column is the fix, and 8.1 explains why the `="…"` goes in unquoted.

**Do not add the token number.** It is a per-property, per-day counter, so across
a date range or several properties the same number repeats constantly and
identifies nothing.

---

## 9. Valet-side setup — ALREADY DONE

> **If you are working on Ambria Admin, skip this section.** It is done, and it
> is on a Supabase project you do not have access to. It is kept here as the
> record of what was set up, and for rotating the key later.

1. **Generate a key** (32+ bytes; the function refuses anything shorter):

   ```bash
   node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
   ```

2. **Run migration** `20260731093700_report_api.sql` in the SQL Editor. Every
   verify row must read `PASS`.

3. **Set the secret** — dashboard → Edge Functions → Secrets:

   ```
   REPORT_API_KEY = <the key>
   ```

   `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are injected automatically.

4. **Deploy:**

   ```bash
   supabase functions deploy valet-report --no-verify-jwt
   ```

   `--no-verify-jwt` is required. Ambria Admin's JWTs are signed by a different
   project, so this project's gateway would reject every one of them as invalid
   — verification here could only ever fail. The `X-API-Key` check inside the
   function is the real gate, and it runs before anything touches the database.

5. **Give the Ambria Admin developer** the base URL and the key. Send the key
   through something that is not a chat log.

**To revoke access:** change `REPORT_API_KEY`. Takes effect on the next call, no
redeploy needed.
