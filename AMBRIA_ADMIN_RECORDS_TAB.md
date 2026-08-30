# Brief — add a **Records** tab to Valet in Ambria Admin

For whoever builds this in the **ambria-workforce** repo. Everything it needs is
already in that repo; nothing new is required on the valet side.

---

## What to build

A fifth tab beside Calendar / Bookings / Staffing Calculator / Analytics, showing
the valet system's per-car records as a table on screen.

Today that data is already fetched in this app — the Analytics tab's
**"Guest list (CSV)"** button downloads it. It just never appears on screen. This
tab shows it instead of writing it to a file.

---

## What already exists (do not rebuild any of it)

| File | What it gives you |
|---|---|
| `src/lib/valetReport.js` | `valetReport(report, params)` — one call. `allValetRecords(params, onProgress)` — the same thing with paging handled. `EXPORT_CAP = 5000`. `ValetReportError` with `.code` and `.isSetup`. |
| `src/pages/admin/ValetAnalytics.jsx` | A working example of every part of this: the date range, the property filter, the CSV export, and the error handling. **Read it before writing anything.** |
| `src/pages/admin/Valet.jsx` | The `tabs` array (~line 162) and the `view === …` switch below it. |
| `src/translations/index.js` | English labels ~line 20, Hindi ~line 588. |
| `src/components/common/UI.jsx` | `Tabs`, and the rest of the shared UI. |
| `supabase/functions/valet-analytics/` | The proxy that holds the API key. Untouched. |

---

## The four changes

**1. `src/translations/index.js`** — one label in each block:

```js
records: 'Records',      // English, near `analytics:`
records: 'रिकॉर्ड',       // Hindi, near the other `analytics:`
```

**2. `src/pages/admin/Valet.jsx`** — one entry in `tabs`, after `analytics`:

```js
{ key: 'records', label: t.records },
```

**3. `src/pages/admin/Valet.jsx`** — one branch in the view switch:

```jsx
{view === 'records' ? (
  <ValetRecords visibleProps={visibleProps} scopeAll={scopeAll} />
) : view === 'analytics' ? (
  …
```

`visibleProps` and `scopeAll` are the same two props `ValetAnalytics` takes —
pass them the same way.

**4. `src/pages/admin/ValetRecords.jsx`** — the new component. The rest of this
document is about that file.

---

## The call

```js
import { valetReport, allValetRecords, ValetReportError } from '../../lib/valetReport'

const page = await valetReport('records', {
  from: '2026-08-01',        // ISO date, optional
  to:   '2026-08-31',        // ISO date, optional
  property_id: propId,       // omit entirely for all properties
  query: 'sharma',           // optional: name, phone, car number or token
  limit: 100,                // max 1000
  offset: 0,
})
```

Response:

```json
{ "ok": true, "total": 4182, "limit": 100, "offset": 0, "records": [ … ] }
```

`total` is the count for the whole query, not the page. Use it for the pager.

---

## The fields on each record

| Field | Notes |
|---|---|
| `id` | uuid |
| `service_date` | The valet day, which **starts at 05:30 IST, not midnight**. A car checked in at 01:00 belongs to the night before. |
| `property_id`, `property_name` | |
| `token_number` | The number on the guest's stub |
| `guest_name`, `guest_phone` | |
| `car_number` | Last 4 digits of the plate |
| `car_tier` | `VIP` · `Premium` · `Standard` |
| `parking_location` | Free text — `L2 Bay B4` |
| `notes` | Being retired; null on anything checked in from late Aug 2026 |
| `status` | `parked` · `delivered` · `returned` · … |
| `parked_at`, `delivered_at` | timestamptz; `delivered_at` is null until handed over |
| `retrievals` | How many times the guest asked for the car |
| `no_shows` | How many times they did not turn up for it |
| `parked_by`, `parked_by_hi` | Operator who parked it |
| `fetched_by`, `fetched_by_hi` | Operator who brought it back |
| `rating` | `excellent` · `good` · `poor` · `null` |
| `review_comment` | Free text, **only ever on a `poor`** |
| `total_count` | Ignore it — read `total` at the top level instead |

Use `hi ? x_hi || x : x` for the operator names, the way the rest of the app does.

---

## Five things that will bite

### 1. Paging is not optional

`/records` returns at most **1000 rows per call**, and a busy month is more than
that. One call returns a *partial* result that looks complete.

For the table, page properly — `limit` + `offset`, and drive the pager off
`total`. For a "download everything" button, use `allValetRecords()`, which
already does the loop and reports progress.

### 2. `rating: null` is "did not answer", not "bad"

The guest is asked once, in the hand-over WhatsApp message, and most people never
reply. Counting nulls as anything but "no answer" makes every property look worse
than it is. Show them as `—`, and if you show a percentage, say what it is a
percentage **of**.

### 3. `review_comment` arrives late

A guest who taps Poor is asked what went wrong and types back minutes later. So a
`poor` row with no comment usually means *the reply has not arrived yet* — not
that they had nothing to say. Do not render it as "no comment given".

### 4. A valet database that has not run migration 0044 omits two keys

`rating` and `review_comment` are simply **absent** from the row, not null. Read
them defensively — `row.rating ?? null` — or the table throws on an older valet
deployment.

### 5. Never put the API key in the browser

The key lives in the `valet-analytics` edge function's secrets and must stay
there. Call it only through `valetReport()`, which goes via that proxy.

The valet API deliberately sends **no CORS headers**, so a direct browser call
cannot work. That is not a bug to work around — it is the guard. If a direct
`fetch()` seems necessary, something has gone wrong in the design.

Remember what is in this data: **every guest's name and phone number.**

---

## Errors

`valetReport()` throws `ValetReportError` with a `.code` and an `.isSetup` flag.

```js
catch (e) {
  if (e instanceof ValetReportError && e.isSetup) {
    // NOT_CONFIGURED, NOT_MIGRATED, PROXY_NOT_CONFIGURED,
    // UPSTREAM_NOT_FOUND, UNAUTHORISED
    // Somebody has to go and fix something. Say which, do not offer Retry.
  } else {
    // A real failure. Retry is reasonable.
  }
}
```

`ValetAnalytics.jsx` already handles this exact split — copy its treatment rather
than inventing a second one.

---

## Suggested table

Sensible defaults; adjust to taste.

| Column | Source |
|---|---|
| Date | `service_date` |
| Token | `token_number` |
| Guest | `guest_name` + `guest_phone` underneath |
| Car | `car_number` + `car_tier` chip |
| Property | `property_name` — only when viewing all properties |
| Parked / Fetched | `parked_by` / `fetched_by` |
| Rating | `rating` chip; `review_comment` underneath when present |
| Status | `status` |

Controls: a search box (`query`), the date range and property filter reused from
Analytics, and a pager.

Wrap the table in `overflow-x: auto` — it is wide, and the page body must never
scroll sideways.

---

## Definition of done

- The tab appears for the same admins who can see Analytics
- Searching by guest name, phone, car number and token all return rows
- The property filter and date range behave as they do on Analytics
- A range with more than 1000 cars pages correctly, and the count matches `total`
- A row with no rating shows `—`, not `0` and not a blank cell
- The English and Hindi tab labels both render
- `npm run build` passes
