# How this project fits together

A map of every file, and the four journeys that pass through them. Read this
before the code; then read the header comment at the top of any file you open.

---

## 1. The boot flow — what happens when someone opens the app

```
index.html
  └─ loads /src/main.jsx
       │
       ├─ createRoot().render(<App/>)  inside <StrictMode>
       │     StrictMode double-mounts every component in dev on purpose.
       │     It is our free test that effect cleanups are correct — we
       │     subscribe to realtime and run countdown intervals, and a missing
       │     cleanup shows up as duplicate alerts or a double-speed timer.
       │
       ├─ registerServiceWorker()   → src/pwa.js  (skipped in dev)
       └─ global error handlers

src/App.jsx
  │
  ├─ isConfigured?  → NO  → <SetupRequired/>  "fill in .env, restart dev"
  │                              Nothing below can work without credentials,
  │                              so fail with instructions, not a blank page.
  │
  └─ YES → provider stack, OUTSIDE-IN:
        BrowserRouter          Router first: ProtectedRoute calls useLocation()
          └─ ToastProvider     Toast above Auth: AuthProvider surfaces errors
              └─ AuthProvider  Auth above routes: every route needs the role
                  └─ <Routes>

src/context/AuthContext.jsx     ← resolves TWO separate things
  │
  ├─ EFFECT 1  getSession() + onAuthStateChange()
  │            SYNCHRONOUS ONLY. Never await a supabase call in that
  │            callback — it runs while the client holds an internal lock and
  │            can deadlock. The app then hangs on the spinner with no error.
  │
  └─ EFFECT 2  keyed on user.id → fetch the user_roles row + joined property
               Sets isReady only when BOTH have settled.

src/components/ProtectedRoute.jsx      ← four outcomes, in order
  1. !isReady              → <PageSpinner/>
  2. !session              → /login  (remembers where they were going)
  3. profileStatus=='error'→ <AccountProblem/>
  4. wrong role for route  → their own home page
                           → otherwise render the page

src/components/AppShell.jsx   the frame: top bar + nav + <Outlet/>
```

---

## 2. The login flow

```
src/pages/Login.jsx
  │  operator types  9876543210  +  482913
  │
  ├─ normalisePhone()          src/utils/format.js
  │     Strips +91, spaces, dashes, leading 0. This is the ONLY length
  │     limiter — the inputs carry no maxLength, because maxLength counts raw
  │     characters and truncates a pasted "+91 98765 43210" before any
  │     handler runs.
  │
  ├─ primeAudio()              src/utils/sounds.js
  │     Unlocks the AudioContext. Browsers block audio until a real user
  │     gesture, and a realtime event is not a gesture — miss this tap and
  │     every alert for the whole shift is SILENT.
  │
  ├─ signInWithPin(phone, pin) src/context/AuthContext.jsx
  │     │
  │     ├─ phoneToAuthEmail()  src/lib/phoneAuth.js
  │     │     9876543210 → 9876543210@phone.invalid
  │     │     Supabase's login endpoint accepts only `email` or `phone`, and
  │     │     `phone` is disabled on this project. The address is internal,
  │     │     never shown, and `.invalid` (RFC 2606) can never receive mail.
  │     │
  │     └─ supabase.auth.signInWithPassword({ email, password: pin })
  │           The PIN is the password. Supabase bcrypt-hashes it. THIS PROJECT
  │           HAS NO `pin` COLUMN AND MUST NEVER HAVE ONE.
  │
  └─ requestNotificationPermission()   fire-and-forget

then AuthContext EFFECT 2 loads the role → ProtectedRoute routes by role:
   operator     → /operator/checkin
   valet_admin  → /admin/dashboard
   system_admin → /system/properties
```

---

## 3. The "add a valet" flow

```
src/pages/StaffManager.jsx        (served at /system/users AND /admin/staff)
  │  admin fills name + number + PIN
  │
  ├─ isPinAcceptable()   src/lib/phoneAuth.js   rejects 111111, 123456, ...
  │       Only when SETTING a PIN, never at login — refusing a weak PIN at
  │       login would tell an attacker it is not the right one.
  │
  ├─ createStaff()       src/lib/adminApi.js
  │       └─ supabase.rpc('admin_create_staff', ...)
  │
  └─ Postgres: admin_create_staff()   migration 0005 / 0006
        1. read the CALLER's role from the DB via auth.uid()
        2. if valet_admin → DISCARD their requested role and property,
           substitute 'operator' + their own property.
           Discarded, not validated. Validating means there is a check to get
           wrong; discarding means there is nothing to get wrong.
        3. validate name / phone / PIN
        4. insert auth.users      (bcrypt PIN, email_confirmed_at = now())
        5. insert auth.identities (GoTrue resolves users through this —
                                   skip it and the account looks healthy in
                                   the dashboard and cannot log in)
        6. insert public.user_roles
        7. re-read all of it and RAISE if anything is missing
        ALL ONE TRANSACTION → a partial account is impossible.

  ← returns { user, pin }
  → PinRevealModal shows the PIN once. Nothing stores it recoverably.
```

---

## 4. The car's journey — the one the whole system exists for

Every arrow is ONE RPC, which is ONE Postgres transaction. Nothing in the
browser ever writes a status.

```
                    src/pages/operator/CheckIn.jsx
  car arrives  ──────────────────────────────────────►  operator_check_in()
                                                         │ allocate_token()
                                                         │ insert vehicle  'parking'
                                                         │ insert task     'assigned' (to self)
                                                         ▼
                                                    token on screen
                                                         │
                    src/pages/operator/MyTasks.jsx       │  PARKING CARD
   "Car parked" + location  ───────────────────────►  task_complete_parking()
                                                         │ task    'completed'
                                                         │ vehicle 'parked' + location
                                                         │ wa_outbox 'car_parked'      MSG 1
                                                         ▼
                                                   sitting in the car park
                                                         │
   guest taps Get My Car in WhatsApp   ─┐                │
   (wa-webhook — NOT BUILT YET)         ├───────────►  request_retrieval()
   or an operator taps "Request car"    │                │ task    'pending', unassigned
   in TodaysCars.jsx                   ─┘                │ vehicle 'requested'
                                                         ▼
                    src/pages/admin/Dashboard.jsx   retrieval queue
                                                         │
   admin picks a free operator  ─────────────────────►  assign_retrieval()
                                                         │ task    'assigned'
                                                         │ vehicle 'fetching'
                                                         ▼
                                          operator's phone ALARMS
                    src/pages/operator/MyTasks.jsx       │  RETRIEVAL CARD
   "Car at delivery point"  ─────────────────────────►  task_start_pickup()
                                                         │ task 'at_pickup' + server clock
                                                         ▼
                                              10:00 countdown running
                                              (useTimer — display only)
                          ┌──────────────────────────────┴───────────────┐
                          ▼                                              ▼
   "Guest arrived"  ─► task_guest_arrived()      "Guest not here", OR the phone is
                        │ task    'completed'    locked and pg_cron fires:
                        │ vehicle 'delivered'    task_guest_absent() /
                        │ wa_outbox              expire_stale_pickups()
                        │   'car_delivered' MSG 2  │ task    're_parking'  ← NOT 'returned'
                        ▼                          │ vehicle 're_parking'
                       DONE                        │ wa_outbox 'not_available'  MSG 3
                                                   ▼
                                          card STAYS on this operator's screen
   "Car re-parked" + location  ──────────────────►  task_complete_reparking()
                                                   │ task    'completed'
                                                   │ vehicle 'returned' + new location
                                                   │ wa_outbox 'car_returned'    MSG 4
                                                   ▼
                                          back in the car park, requestable again
```

The `'re_parking'` marked above is the defect migration 0008 fixes. Under the
spec's `'returned'`, the card disappeared from the screen of the operator
holding the keys and that operator was offered another car. See 0008's header.

---

## 5. File map

### Config — how the app builds

| File | What |
|---|---|
| `package.json` | Deps + scripts. `npm run icons` regenerates PWA icons from the SVG |
| `scripts/check-undefined.mjs` | `npm run check`, and `npm run build` runs it first. **`vite build` does not catch an undefined identifier** — a bundler treats an unresolved name as a runtime global lookup, so the build passes and the page throws ReferenceError and renders blank. That exact bug shipped in StaffManager once |
| `vite.config.js` | `@/` alias, LAN binding (`host: true`) so phones can test, prod sourcemaps |
| `tailwind.config.js` | Every colour maps to a CSS variable → re-theming is one file |
| `index.html` | Meta tags, PWA manifest link, iOS-specific tags, no-JS fallback |
| `.env` / `.env.example` | `VITE_*` only. Anything with that prefix ships in the public bundle |

### Database — `supabase/migrations/`, all applied

| Migration | What it did |
|---|---|
| `0001_initial_schema` | The 7 tables from the spec. Kept for `db reset`; already run |
| `0002_fixes_and_hardening` | **10 defects in the spec's SQL.** Biggest: an RLS policy on `user_roles` that queried `user_roles` (Postgres `42P17 infinite recursion` — broke every query for every role); `current_date` defaults while the DB runs in UTC (mis-dates the whole late shift, since IST rolls over at 05:30 UTC); no tables in the realtime publication (realtime said SUBSCRIBED and fired zero events) |
| `0003_explicit_grants` | Table-level GRANTs. Postgres checks permission in **two** layers — GRANT ("may you touch this table?") then RLS ("which rows?"). Almost every tutorial only covers RLS. `anon` gets nothing; nobody gets DELETE, because this is an audit trail of cars |
| `0004_phone_pin_login` | Promotes `user_roles.phone` from a note to the login identifier (format + unique + NOT NULL), and lets a valet_admin manage their own operators |
| `0005_staff_management_rpc` | `admin_create_staff` etc. as Postgres functions, so adding a valet needs no CLI and no deploy |
| `0006_auth_schema_hardening` | Scheduled the cron jobs (pg_cron was enabled after 0002 ran, so 0002 skipped them), made the auth writes resilient to GoTrue schema changes, added `check_auth_schema_compat()` |
| `0007_viewable_pins` | Encrypted PIN storage in `staff_pins` so an admin can read a PIN back, with the key in Supabase Vault and every read logged to `staff_pin_access` |
| `0008_operator_flow_rpc` | The whole car lifecycle as atomic functions. **Fixes a defect in the spec's flow:** a no-show sent the task to `'returned'`, which is in neither the MyTasks query nor the busy list in `get_available_operators()` — the card vanished off the screen of the operator still holding the keys, and that operator was immediately offered another car. Now it goes to `'re_parking'`, and `expire_stale_pickups()` was rewritten to match, because that is the path that runs when the phone is locked |

Key Postgres functions:

| Function | Why it exists |
|---|---|
| `allocate_token()` | One atomic UPDATE takes a row lock, so 8 simultaneous operators serialise on one row and each gets a distinct token. **Never do this in React** — read-then-write is a guaranteed race |
| `get_available_operators()` | A locked, live query. Filtering operators in React means acting on stale data |
| `my_role()`, `my_property_id()` | `SECURITY DEFINER`, so they do not re-enter RLS. This is what breaks the recursion cycle from 0002 |
| `expire_stale_pickups()` | The 10-minute safety net, every minute via pg_cron. The **only** thing that fires when the operator's phone is locked |
| `ist_today()` | The business date in Asia/Kolkata. The DB is UTC; never use `current_date` |
| `operator_check_in()` | Token + vehicle + parking task in ONE transaction. Four separate calls from the browser can half-land, and the half that loses is a guest holding a stub for a token no car is attached to |
| `claim_task()` | The guard every transition shares: proves who you are, that the move is legal from the current status, and takes a row lock so a double-tap cannot fire the guest's WhatsApp twice. Internal — not granted to `authenticated` |
| `task_*()` | One function per button on MyTasks. Each writes `valet_tasks` **and** `parked_vehicles` **and** queues `wa_outbox` together |
| `request_retrieval()` | Raises a pending retrieval. What the wa-webhook will call, and what the porch uses today |

### Core library

| File | What |
|---|---|
| `src/supabase.js` | The ONE client. A second `createClient()` gives you a second auth store and a second socket — the user looks logged out in one component but not another. Also `describeDbError()`, which turns Postgres errors into sentences an operator can act on |
| `src/types/index.js` | Every enum the DB enforces, plus each value's label/colour/icon. No page ever types `'at_pickup'` — a typo there is not caught at build time and surfaces at 9pm as a CHECK constraint violation |
| `src/lib/phoneAuth.js` | phone ↔ auth email, PIN rules, `generatePin()` using `crypto.getRandomValues` |
| `src/lib/adminApi.js` | Wraps the staff-management RPCs. Never throws — returns `{ ok, error }`, because eight try/catch call sites is eight chances to leave a spinner running |
| `src/lib/valetApi.js` | Same contract, for the car lifecycle. **No function takes a target status** — the SQL decides what a task becomes and refuses a move from the wrong one, so a stale screen cannot skip a step |
| `src/lib/serverClock.js` | How far this phone's clock is from the database's, learned free from timestamps the server already returns. The countdown has to agree with `expire_stale_pickups()`, and operator handsets routinely have automatic time switched off |
| `src/lib/analyticsApi.js` | Takes a **date range**, not a day count (migration 0018) — a rolling window can only answer "the last N days", never "last Saturday" or "September". The old `p_days` signatures are **dropped, not left as overloads**: a caller passing the wrong shape would resolve to the old one and get a different period than the screen claims, silently. Aggregates come from Postgres, never from counting fetched rows. At 1000 tokens a day a quarter is tens of thousands of rows — and if PostgREST is ever given a row ceiling, an over-long query returns a **short list with no error** and the chart is silently wrong |
| `src/utils/format.js` | Phone / car number / date / duration formatting. Two rules: phones are 10 bare digits (91 added only for WhatsApp), and every date a human sees is IST |
| `src/utils/sounds.js` | Alerts synthesized with Web Audio — no mp3 files to go missing, and "silent" is the one failure an alert system cannot have |
| `src/utils/cn.js` | Joins Tailwind classes, drops falsy values |

### Design system — `src/components/ui/`

| File | The decision worth knowing |
|---|---|
| `Icon.jsx` | Every SVG path in the project. **Zero emoji** — emoji render differently per Android version, break button alignment, and cannot inherit colour |
| `Button.jsx` | If `onClick` returns a Promise, the button manages its own loading + disabled state. This deletes double-submits as a class of bug instead of policing them in review |
| `Field.jsx` | Inputs are 56px tall and never below 16px font — below 16px iOS Safari zooms the page on focus and does not zoom back |
| `Badge.jsx` | Pages pass a domain value, not a colour. `*_META` in `src/types` decides the tone, so "fetching" is the same blue everywhere |
| `Card.jsx` | `urgent` (pulsing ring) is reserved for ONE thing: an unassigned retrieval request. If three things pulse, nothing does |
| `Modal.jsx` | Native `<dialog>`, so focus trapping, Escape, and background inerting come from the browser |
| `EmptyState.jsx` | An empty list and a broken list look identical to a user. Also handles the error variant |
| `StatTile.jsx` | The number is the biggest thing; digits are tabular so a live count going 9→10 does not twitch the row |
| `Spinner.jsx` | Inline / page / skeleton |

### Auth and shell

| File | What |
|---|---|
| `src/context/AuthContext.jsx` | Session + role + property. **Three IDs are not interchangeable**: `user.id` (auth), `userRole.id` (what `valet_tasks.assigned_operator_id` points at — exposed as `operatorId`), `propertyId`. Mixing the first two makes the insert succeed and the task never appear |
| `src/context/ToastContext.jsx` | Errors do NOT auto-dismiss; max 3 on screen; pinned top so they never cover the primary button |
| `src/components/ProtectedRoute.jsx` | Route guard. **UX only, not security** — RLS is the real boundary. Delete this file and an operator's queries would still return only their own property |
| `src/components/AppShell.jsx` | Bottom tabs on phones (thumb reach), left sidebar on desktop. Chosen by breakpoint, not by sniffing the device |

### PWA

| File | What |
|---|---|
| `public/manifest.json` | Name, icons, shortcuts. Chrome needs 192px + 512px **PNG** for installability — an SVG alone is silently ignored |
| `public/sw.js` | Hand-written. **Supabase requests are NEVER cached.** A cached response could say a car is still parked while another operator is fetching it — wrong data is worse than no data here |
| `src/pwa.js` | Registration, update prompt, install prompt. Updates are prompted, not automatic, so an operator mid-check-in is never reloaded out of their form |
| `src/components/PwaStatus.jsx` | Offline banner + update banner. The offline banner is the important one: without it, taps fail silently in a basement and the operator concludes the app is broken |
| `scripts/generate-icons.mjs` | Renders the SVG into all PNG sizes, including Android maskable at 60% inset |

### Pages

| File | Status |
|---|---|
| `src/pages/Login.jsx` | Done — number + 6-digit PIN |
| `src/pages/ChangePin.jsx` | Done — verifies the current PIN first, because `updateUser()` does not |
| `src/pages/StaffManager.jsx` | Done — serves both `/system/users` and `/admin/staff` |
| `src/pages/operator/CheckIn.jsx` | Done — one RPC, then the token stays on screen until dismissed. The spec's 3-second auto-clear is deliberately not implemented: three seconds is how long it takes to be interrupted, and the number would be gone before it was written on the stub |
| `src/pages/operator/MyTasks.jsx` | Done — parking cards, retrieval cards, countdown. Only retrievals sound the alarm; a parking task appears because this operator just tapped the check-in button |
| `src/pages/operator/TodaysCars.jsx` | Done — search, two filters, and "Request car for guest", which is currently the **only** way a retrieval can be created at all |
| `src/pages/admin/Dashboard.jsx` | Done — retrieval queue. `urgent` (pulsing) is used here and nowhere else. Free operators come from `get_available_operators()`, never filtered in React |
| `src/pages/admin/TokenMgmt.jsx` | Done — a range can only ever grow. Extend is guarded by `.lt('range_end', newEnd)` in the query itself, so shrinking matches no rows; tokens already written on a guest's paper stub cannot be migrated |
| `src/pages/admin/Reviews.jsx` | Done, but **empty until WhatsApp exists** — nothing writes `reviews` except the unbuilt wa-webhook. Read-only by design: an operator must not be able to file their own five-star review |
| `src/pages/admin/Analytics.jsx` | Done — retrieval wait measured from `created_at` (when the guest ASKED), not `assigned_at`, or an unwatched queue would score perfectly. Medians, not means, and every median carries its sample size |
| `src/pages/system/Properties.jsx` | Done — never deletes, only `is_active = false`. The confirmation states what that does and does not do: it stops tomorrow's token range, it does **not** sign anyone out |
| `src/pages/system/Analytics.jsx` | Done — the one screen allowed to cross a property boundary. The comparison is a **table**, not a grouped bar chart: "which site is slow" is a lookup, not a shape |
| `src/pages/system/Records.jsx` | Done — every car, every property, searchable + CSV for Excel (`vehicle_records()`, migration 0017). Adds **no columns**: `parked_vehicles` has held name/phone/car/tier/location since 0001. Shows the phone in **full**, unlike Reviews — this *is* the contact record, so masking it would defeat the export. The export has a **hard cap and refuses past it**: a silently truncated CSV opens cleanly and its missing rows are invisible |

### Hooks — `src/hooks/`

| File | The decision worth knowing |
|---|---|
| `useTimer.js` | Recomputes `deadline − now` every tick instead of counting down. `setInterval` does not run while a phone is asleep, and browsers throttle background timers — a counted-down number silently disagrees with the database, which never stopped counting |
| `useRealtime.js` | One subscription, plus `onResync`. **Realtime is a stream, not a queue** — nothing is replayed. A phone that slept through a reassignment reconnects looking perfectly healthy while showing a task somebody else already delivered, so after any gap you must refetch |

### Parking spaces are a master list, not a text field (migration 0016)

The admin types the place names once on `/admin/spaces`; the operator **taps a
chip** (`ui/SpacePicker`). Typing was the slowest step in the flow — a phone
keyboard, on a porch, two hundred times a shift — and it produced four
spellings of one place, so nothing could ever be searched or counted by location.

**It is a name list, not a model of a car park.** No zones, no levels, no
numbering scheme: whatever the admin types is what the operator taps —
"Basement", "Porch", "Behind the kitchen", "L2 B4". Every site is laid out
differently and this app has no business deciding how somebody else's car park
is organised. Entry is bulk (split on commas and newlines) because nobody types
these one at a time.

**`parked_vehicles.parking_location` is still free text and deliberately NOT a
foreign key to `parking_spaces`.** Three reasons, each of which outranks
referential tidiness:

1. A brand-new property has no bays defined — a FK would mean the first car of a
   new site cannot be checked in until data entry is finished.
2. Cars get left on the ramp, in the porch, behind the kitchen. Refusing to
   record that would mean recording nothing.
3. Renaming a bay must not rewrite history.

So the table drives the **chips**, not the constraint — and `SpacePicker` keeps
a text fallback for both "no bays yet" and "somewhere else".

**Each place has a capacity, and occupancy is COUNTED, never stored** (migration
0020). There is no cars_parked column and there must not be: a counter has to be
incremented on park and decremented on hand-back, and the day one path is missed
or a transaction rolls back after the increment, the number is wrong forever with
nothing to reconcile against — an operator told a row is full when it is empty.
parking_space_usage() counts the cars actually at each label, so delivering a car
frees its place with no bookkeeping. The admin screen and the operator chips call
the SAME function, so "in use" cannot mean two things.

**A full place is marked loudly and still tappable.** A chip holding a car shows an amber
dot and stays tappable: valets stack and double-park on purpose, and the system
must never refuse to record where a car actually is.

**Car number is optional and is 4 digits.** The token is what identifies a car —
it is on the guest's stub and it is what they quote — so holding up a check-in
over four digits nobody depends on costs porch time for nothing. Given at all it
must be exactly 4, because a partial one looks like a cross-check and is not.
Both screens prefix it with a car icon: a 4-digit plate beside a 4-digit token is
otherwise two identical-looking numbers.

### Who parked it — and why there is no parked_by column (migration 0021)

"Which operator parked this car" is **derived**, not stored. The fact already
lives in `valet_tasks`: CheckIn creates the parking task assigned to whoever took
the keys, and nothing ever reassigns a parking task. A second copy of a fact is a
second thing that can be wrong — the same reasoning as the missing occupancy
counter above.

Retrieval is the sharper case: a retrieval task **can** be reassigned, so a
stored column would hold whoever was assigned *first*. `vehicle_records()` reads
the **last completed** retrieval, which is whoever actually handed the car over.

**`analytics_by_operator()` counts COMPLETED tasks only.** A reassigned car would
otherwise credit two people, and an operator handed a car who never finished it
would score for it. It appears as **Who did the work** on admin/Analytics — a
table, not a chart, because "who is carrying the shift" is a lookup down a
column. Staff who have left are still listed (marked), because dropping them
makes last month stop adding up.

### The operator flow

One car, start to finish, and where each step happens:

```
CheckIn        form → TOKEN → location → "Car parked"     ← all on one screen
                            ↘ "park later" → MyTasks "Still to park"
TodaysCars     parked car → "Request car for guest"
Dashboard      pending retrieval → assign an operator          (admin)
MyTasks        "Fetch these cars" → at delivery point → 10-min countdown
                            → guest arrived  → done
                            → guest absent   → re-park → confirm spot
```

**Parking finishes on CheckIn, not in MyTasks.** The old path was token →
dismiss → open MyTasks → find the card for the car whose keys are in your hand →
enter location: four steps and a screen change to finish something the operator
is in the middle of. The real porch sequence is one continuous action — keys,
stub, drive, park, walk back — and the panel is still up when they return.
"Next car — park this one later" stays because a second car arriving mid-park is
the normal busy case, not an edge case.

**MyTasks puts retrievals first, always.** Somebody is waiting on a retrieval;
nobody is waiting on a parking job. A parking card appearing there now means a
loose end, and is labelled as one.

**TodaysCars pills carry counts** — "In the car park 8" answers the question
without the tap. Counted from the loaded page, not from the day's total: a pill
promising 340 that then lists 200 would be worse than no number.

### Notifications — three channels, and the gap only push closes

| Channel | Reaches | Fails when |
|---|---|---|
| Sound (`utils/sounds.js`, Web Audio) | operator looking at or near the phone | muted, or `primeAudio()` never ran from a gesture |
| Vibration | pocket, screen on | iOS ignores it |
| `showNotification()` | app open, tab backgrounded | needs the page alive |
| **Web Push** (migration 0014 + `push-send`) | **app closed, screen off** | no permission, or no device registered |

**A bug this uncovered:** `showNotification()` used `new Notification(...)`, which
**throws `Illegal constructor` on Chrome for Android** — every device the
operators use. The old code caught it and did nothing, so OS notifications had
never once worked on the platform that matters and nothing said so. It now goes
through `ServiceWorkerRegistration.showNotification()`, and the catch logs.

**Why an outbox and not a trigger that calls out.** A trigger making an HTTP
request holds its transaction open across the network — a push service having a
slow minute would then slow down, or roll back, an operator's tap on "Car
Parked". `trg_task_push` writes a `push_outbox` row; `push-send` drains it.

**What earns a push** (nothing else does — noise is why people turn
notifications off):

- retrieval goes `pending` → every valet_admin at that property
- retrieval goes `assigned` → that operator
- task goes `re_parking` → that operator. **The most important one**:
  `expire_stale_pickups()` runs on pg_cron and only fires when nobody has
  tapped for ten minutes, overwhelmingly because the phone is locked. The
  operator is standing next to a car whose guest never came.
- parking task completed → every valet_admin at that property, **quietly**
  (migration 0019). This one fires ONCE PER CAR, so at a thousand cars a day a
  buzz per car is forty an hour through a dinner service and the admin's only
  sane response is to mute the app — which would also kill the two above. So it
  is non-critical and carries a **shared** tag (`valet-parked`, not
  `valet-task-<id>`) so each one REPLACES the last instead of stacking.
- **never** to the operator for their own parking task — CheckIn assigns that to
  whoever is already holding the keys — and never to whoever caused the change.

**The crypto is tested, because it fails silently.** `webpush.ts` is separate
from `index.ts` so `npm run test:push` can encrypt a payload and then **decrypt
it from the browser's side** of RFC 8291. A wrong HKDF info string or a missing
`0x02` delimiter produces a body the browser discards **while the push service
still answers 201** — the sender looks healthy and no notification ever appears.

**Sign-out unsubscribes.** A porch handset is shared and the subscription
belongs to the *browser*, not the person; otherwise the operator who went home
keeps getting "Fetch a car". `save_push_subscription()` also reassigns an
existing endpoint to whoever signs in next, so handover is covered from both ends.

**The bell** (`components/NotificationBell.jsx`, migration 0015) reads the *same*
`push_outbox` rows the phone gets — a separate `notifications` table would mean
the trigger writing each row twice, and the day someone edits one INSERT and not
the other, the bell and the phone start disagreeing about what happened.

- **SELECT is a policy, marking read is an RPC.** Realtime delivers changes
  *through* RLS, so without a SELECT policy the bell would only update on a
  reload. But RLS grants a whole row — it cannot allow writing `read_at` while
  forbidding `title`, and a blanket UPDATE policy would let an operator rewrite
  their own notification history. The RPC writes one column.
- **Opening the panel does not mark anything read.** An operator glancing at the
  bell while walking has not dealt with anything; clearing the badge would make
  the one they had not actioned look handled.
- **History is 14 days**, because that is what `prune_push_outbox` keeps.

### Changing a role — `admin_set_staff_role` (migration 0013)

Role and property live behind their **own** RPC, not `admin_update_staff`.
A name is a field; a role is a **permission** — every RLS policy in the project
is written in terms of `role` and `property_id`. **system_admin only**: a
valet_admin who could set a role could promote themselves and switch off the
four-property isolation the whole system rests on.

Two refusals, both of which prevent silent damage rather than being red tape:

| Code | What it stops |
|---|---|
| `HAS_OPEN_TASKS` | Moving somebody **mid-task orphans a real car with no error anywhere**. operator → valet_admin: `get_available_operators()` only returns operators so they vanish from the assignment list, and My Tasks is not in an admin's nav so the card disappears from the screen of the person holding the keys. Moved to another property: `claim_task()` requires the task's property to match the caller's, so every button on their own task fails FORBIDDEN |
| `LAST_SYSTEM_ADMIN` | Demoting the only system admin leaves nobody who can set roles, add properties or promote a replacement — recoverable only in hand-written SQL |

Name, number and PIN are deliberately **not** restricted this way; renaming
someone mid-task breaks nothing. The role call also runs **last** in the Edit
dialog's sequence, so a refusal never discards a name or PIN edit that was fine.
Changing your **own** role calls `refreshProfile()` — AuthContext caches the
`user_roles` row, so without it the admin is left on a page their new role no
longer allows.

### Scale — what breaks at 4000 cars a day, and why it does not

Token range is 1000/day/property × 4 properties. A car makes ~6 row changes
(check-in, parked, requested, assigned, at pickup, delivered), so a peak event
day is ~24,000 writes, bunched into the dinner rush rather than spread evenly.

| Was | Why it broke | Now |
|---|---|---|
| Every page did `onChange: load` — a **full refetch per realtime event** | The cost is a **product, not a sum**. 22 clients on one property × ~3 queries = ~66 queries for ONE check-in, nearly all returning identical data. At 5 changes/sec that is ~330 queries/sec of pure amplification | `useRealtime` **coalesces** (400ms) and **rate limits** (max 1 refetch/1.5s). Both are needed: coalescing alone does nothing to a steady stream spaced 200ms apart. A resync bypasses both — it means data is *already* stale |
| `expire_stale_pickups()` had **no usable index** | It runs **every minute forever** and filters on `status='at_pickup'`. No index led with status (`idx_tasks_property_status` leads with property_id, which that query never mentions) → seq scan 1440×/day over a table that only grows | `valet_tasks_stale_pickup_idx`, partial. Stays constant-size because it only covers open hand-overs |
| `TodaysCars` fetched **the whole day**, searched in JS | ~200kB to a phone at 1000 cars, re-sent on every refetch | `search_todays_cars()` RPC — 200-row page, matching in Postgres. An **RPC not a PostgREST `.or()`**: building an `or=(…)` string from a text box means escaping commas and parens correctly forever; a plpgsql parameter is never text-substituted into SQL at all |
| `Properties` fetched **every vehicle across all properties** to count them | 4000 rows over the wire to produce four integers | `property_overview()` returns the integers |
| `Reviews` fetched a whole range unbounded | Percentages computed from a **silently truncated** result look authoritative and are wrong | Explicit `.limit(500)` + an on-screen notice that the figures are a sample |
| `wa_outbox` grew forever | Table, bloat and every backup grow for data nobody reads after the day it was sent | `prune_wa_outbox(30)`, weekly cron. Only **terminal** rows — a queued message is never deleted however old, because age is not proof it was handled |

Migration `0012_scale_hardening`. Indexes added are **partial** on purpose: a
full index over `valet_tasks` grows with history and is mostly completed rows
no hot query wants, and every index byte is also a write cost on the porch.

### Loading & bundling

| Thing | The decision worth knowing |
|---|---|
| `src/components/ui/PageSkeleton.jsx` | Shaped placeholders per block, composed per page — replaced `PageSpinner` everywhere. A blank page with a dot carries no information and makes the layout jump under a thumb already reaching for a button. Chart bars use a **fixed** pattern, never `Math.random()`, which would re-roll on every render and visibly twitch |
| `React.lazy` per route (`App.jsx`) | **`Login` stays eager** — it is the first paint, and it renders outside `AppShell` where the Suspense boundary lives. The point is not total size: an operator no longer downloads the admin dashboards, charting code and CSV export in order to check a car in |
| `<Suspense>` inside `AppShell` | Deliberately **not** around `<Routes>`. Inside the shell, the top bar, property name and nav stay on screen and stay tappable while a chunk arrives on bad wifi — so an operator can navigate away instead of watching a blank page |
| `manualChunks` (`vite.config.js`) | Matched on module **path**, not package name — the array form left React in the app bundle because JSX imports `react/jsx-runtime`, a specifier the exact-name match never sees. Split for **caching**: app code was 172kB gzipped per deploy, now 20kB, with React/Supabase staying in cache across deploys |
| `src/components/ui/RangePicker.jsx`, `src/utils/chartData.js` | Extracted because `system/Analytics` imported them from `admin/Analytics`, which silently undid route splitting — one page importing another puts both in the same chunk |

### Charts — `src/components/ui/BarChart.jsx`

No charting library: the smallest is ~50kB gzipped, for two shapes that are divs.

| Export | The decision worth knowing |
|---|---|
| `BarChart` | Vertical bars over time. **One hue, no legend** — every bar is the same measure at a different moment, so colour has no job and a second one would imply a difference that does not exist. Non-zero values floor at 2px so "1 car" never looks like "none" |
| `MeterList` | Labelled horizontal rows, for how a total splits up. Identity comes from a **label on every row**, never from the bar colour. Reusing the tier palette as categorical chart colours fails validation — Standard is deliberately near-gray because it is ~80% of cars — and a near-gray slot cannot carry identity alone |

Both render an `sr-only` table of the same numbers. A bar is a div; without it the
data does not exist for anyone not looking at the screen.

### Edge Functions — `supabase/functions/`

Not in use. `admin-users/` is complete but the app calls Postgres RPC instead —
see `supabase/functions/README.md`. Kept as a fallback in case a future GoTrue
release changes the `auth` schema. `wa-send`, `wa-webhook`, `wa-dispatch` are
still to be written; `wa-webhook` genuinely must be an Edge Function, because
Meta calls it over HTTPS and Postgres cannot receive an inbound request.

---

## 6. Rules that must not be broken

1. **One Supabase client.** Always import from `src/supabase.js`.
2. **No raw status strings.** Import from `src/types`. The DB has CHECK
   constraints; a typo is not caught until runtime.
3. **Tokens come from `allocate_token()`.** Never compute one in React.
4. **Free operators come from `get_available_operators()`.** Never filter in React.
5. **Every query is scoped by `property_id`** — RLS enforces it too, but be explicit.
6. **Phones are 10 bare digits.** `91` is added only when calling WhatsApp.
7. **Dates shown to humans are IST.** The DB is UTC. Use `ist_today()` / `istToday()`.
8. **Unsubscribe realtime channels in the effect cleanup.**
9. **WhatsApp calls are wrapped** — a messaging failure must never block a check-in.
10. **No emoji in the UI.** Use `<Icon>`.
11. **Never add a `pin` column.** Supabase's bcrypt hash is the only copy.
12. **Never write `$$` inside a comment in a Postgres function body** — it closes
    the body early. This already cost one failed migration.
13. **A status change is an RPC, never a `.update()`.** Every transition writes
    two tables and queues a guest message, and `wa_outbox` has no RLS policy at
    all, so the browser physically cannot do the third part.
14. **Never write a status change from a timer callback.** `expire_stale_pickups()`
    in pg_cron owns expiry. Several screens watch the same task; each one would
    fire it.
15. **Refetch after any realtime gap** — `onResync` in `useRealtime`. A missed
    event looks exactly like no event.

---

## 7. Where to add things

| To add… | Touch |
|---|---|
| A new status | `src/types/index.js` **and** the CHECK constraint in a migration |
| A new icon | `src/components/ui/Icon.jsx` — one 24×24 stroke-only entry |
| A new colour | `src/index.css` (the token), then `tailwind.config.js` if it needs a utility |
| A new page | `src/pages/…`, then a route in `src/App.jsx`, then a nav item in `AppShell.jsx` |
| A new table | A migration with the table, its RLS policies, **and** its GRANTs |
| A new admin action | A Postgres function in a migration + a wrapper in `src/lib/adminApi.js` |

---

## 8. Verifying the database

```sql
select * from public.check_auth_schema_compat();   -- after any Supabase upgrade
select jobname, schedule, active from cron.job;    -- 2 rows expected
select public.ist_today();                          -- today's Indian date
```

The full 15-point health check is in the git history of this conversation; the
per-migration `VERIFY` blocks at the bottom of each migration file cover the
same ground.
