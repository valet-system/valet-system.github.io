# Valet Report API

**Read-only analytics from the Valet Parking system, for another app.**

This document is the handover spec. It is written for a developer working on
**Ambria Admin** (`ambria-workforce`), who wants the valet analytics screen —
cars per day, guest wait times, peak hours, per-operator workload — inside their
own app.

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

## 2. What you need from the valet team

Two things. Ask for them directly — they are not in any repo.

| | |
|---|---|
| **Base URL** | `https://<valet-project-ref>.supabase.co/functions/v1/valet-report` |
| **API key** | A long random string. Goes in the `X-API-Key` header. |

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

### 4.1 Store the key

Supabase dashboard → **Edge Functions → Secrets** (of the *Ambria Admin*
project):

```
VALET_REPORT_URL = https://<valet-project-ref>.supabase.co/functions/v1/valet-report
VALET_REPORT_KEY = <the key the valet team gave you>
```

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

The rows behind the spreadsheet export — one per car. This is what the download
button uses.

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
      "parked_at": "2026-08-22T14:12:00Z",
      "delivered_at": "2026-08-22T19:40:00Z",
      "retrievals": 1,
      "no_shows": 0,
      "parked_by": "Sandeep",
      "parked_by_hi": "संदीप",
      "fetched_by": "Vikash",
      "fetched_by_hi": null,
      "total_count": 4182
    }
  ]
}
```

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
BASE='https://<valet-project-ref>.supabase.co/functions/v1/valet-report'

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

The valet app puts an **Export** button on its records screen that produces a
formatted `.xlsx`. Here is how to put the same button on your analytics page.

### 8.1 Install

```bash
npm install write-excel-file
```

### 8.2 The helper

`src/utils/xlsx.js`:

```js
/** Header cells: bold, tinted band, one rule underneath. */
const HEADER = {
  fontWeight: 'bold',
  backgroundColor: '#F4EFE6',
  textColor: '#14120E',
  align: 'left',
  bottomBorderColor: '#D4C9B6',
  bottomBorderStyle: 'thin',
}

export async function downloadXlsx(filename, cols, rows) {
  if (!rows?.length) return

  // Imported HERE, not at the top of the file. This is the biggest thing in the
  // bundle and one button on one admin screen uses it — a top-level import
  // makes every user download it. '/browser', not the bare name: the package
  // ships no "." export and the bare import fails the build outright.
  const { default: writeXlsxFile } = await import('write-excel-file/browser')

  const columns = cols.map((col) => ({
    header: { ...HEADER, value: col.label, align: col.align ?? 'left' },
    cell: (row) => {
      const v = row[col.key]
      return {
        // Every cell a STRING, deliberately. A phone number is an identifier
        // that happens to be digits — as a number it loses its leading zero and
        // goes scientific past 11 digits. Nothing here is ever summed.
        value: v === null || v === undefined || v === '' ? null : String(v),
        type: String,
        align: col.align ?? 'left',
      }
    },
    width: col.width,
  }))

  const blob = await writeXlsxFile(rows, { columns, stickyRowsCount: 1 }).toBlob()

  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  document.body.appendChild(link)
  link.click()
  link.remove()

  // Released on pagehide, NOT on a timer. The browser writes the file
  // asynchronously; revoking while that is in flight CANCELS the download, and
  // nothing surfaces because the click already succeeded. See 8.4.
  const release = () => URL.revokeObjectURL(url)
  window.addEventListener('pagehide', release, { once: true })
}
```

### 8.3 The button

```jsx
import { downloadXlsx } from '../utils/xlsx'

const COLUMNS = [
  { key: 'date',      label: 'Date',       width: 12 },
  { key: 'property',  label: 'Property',   width: 20 },
  { key: 'name',      label: 'Guest',      width: 22 },
  { key: 'phone',     label: 'Number',     width: 14 },
  { key: 'car',       label: 'Car',        width: 12 },
  { key: 'tier',      label: 'Tier',       width: 10 },
  { key: 'parkedBy',  label: 'Parked by',  width: 18 },
  { key: 'fetchedBy', label: 'Fetched by', width: 18 },
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
      if (!rows.length) return alert('Nothing to export for those dates.')

      await downloadXlsx(
        `valet-guests-${range.to}.xlsx`,
        COLUMNS,
        rows.map((r) => ({
          // service_date, NOT parked_at. A car checked in at 01:00 belongs to
          // the night before, and the whole valet system agrees on that.
          date: r.service_date ?? '',
          property: r.property_name ?? '',
          name: r.guest_name ?? '',
          phone: r.guest_phone ?? '',
          car: r.car_number ?? '',
          tier: r.car_tier ?? '',
          // English names, not the _hi variants: the file is for payroll and
          // comparison, and one stable spelling per person beats matching
          // whichever language the exporter happened to have selected.
          parkedBy: r.parked_by ?? '',
          fetchedBy: r.fetched_by ?? '',
        })),
      )
    } finally {
      setBusy(false)
    }
  }

  return (
    <button onClick={onExport} disabled={busy}>
      {busy ? 'Preparing…' : 'Export to Excel'}
    </button>
  )
}
```

**`token_number` is deliberately not a column.** It is a per-property,
per-day counter, so across a date range or several properties the same number
repeats constantly and identifies nothing — and as digits in a text cell it puts
a warning triangle on every row. `Date` + `Property` + `Car` is the identifier
that actually works.

### 8.4 Four traps in `write-excel-file` v4

All four cost real time on the valet side. None of them fail the build — they
fail silently at runtime, or produce a file with no error at all.

| Trap | Symptom | Fix |
|---|---|---|
| `writeXlsxFile()` does not download | Builds the whole spreadsheet, no file, **no error** | It returns `{ toBlob(), toFile() }`. One must be called. There is no `fileName` option. |
| `schema:` was removed in v4 | Throws `` `schema` parameter was removed `` on click | Use `columns:`, and note `value:` moved into a nested `cell()` that returns the cell object |
| `color:` was renamed in 3.x | Header band renders with black text, style looks ignored | `textColor:` |
| Its own `.toFile()` revokes after 100ms | A large export **cancels** part-way, silently | Take `.toBlob()` and download it yourself, releasing on `pagehide` — as in 8.2 |

One more, on bundling: if your build config has a `manualChunks` rule that
sweeps `node_modules` into a vendor chunk, it will pull this library into the
eagerly-preloaded chunk and defeat the `await import()` entirely — every user
downloads ~60KB for a button they cannot see. Exclude it:

```js
if (id.includes('write-excel-file')) return undefined
```

### 8.5 About the green triangles

Excel puts a *"number stored as text"* warning triangle on the phone column.
That is expected and correct — the cells are strings on purpose so `0123456789`
keeps its leading zero. Do not "fix" it by making them numbers.

---

## 9. Valet-side setup

*For the valet team, not the Ambria Admin developer.*

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
