# Valet Parking Management System
## Complete Project Brief — 4 Properties, Multi-User, Scalable

> **How to use:** Put this file in VS Code project root.
> First message to Claude Code:
> "Read VALET_SYSTEM_FINAL.md completely, then start building step by step."

---

## CREDENTIALS TO COLLECT BEFORE STARTING

### From Meta (account already verified)

```
Ask your social media manager for these exact values:

1. PHONE_NUMBER_ID
   developers.facebook.com → Your App → WhatsApp → API Setup
   → "Phone Number ID" field → Copy

2. PERMANENT ACCESS TOKEN (system user token — NOT the 24hr temp token)
   business.facebook.com/settings → Users → System Users
   → Create system user if not exists:
     Name: valet-bot  |  Role: Admin
   → Generate New Token → Select app → Permissions:
     ✅ whatsapp_business_messaging
     ✅ whatsapp_business_management
   → Copy immediately — shown only once

3. APP SECRET
   developers.facebook.com → Your App → Settings → Basic
   → App Secret → Show → Copy

4. WABA ID
   developers.facebook.com → Your App → WhatsApp → API Setup
   → "WhatsApp Business Account ID" → Copy

5. Payment Method added?
   business.facebook.com/wa/manage → Settings → Payment Methods
   → Add credit/debit card
```

### From Supabase (you create this)

```
supabase.com → New Project
Name: valet-system
Region: South Asia (ap-south-1)
Password: strong one, save it

After project creates (2 min):
Settings → API:
  → Project URL      (https://xxxxx.supabase.co)
  → anon public key  (eyJhbGc...)
  → service_role key (keep secret)
  → Reference ID     (for CLI linking)
```

### You decide

```
VERIFY_TOKEN = any string e.g. valetapp2024secure
TIMER        = 10 minutes (confirm with property owner)
TOKEN_RANGE  = 1 to 300 per property per day
```

---

## PROJECT OVERVIEW

### What this system does
A Valet Parking Management System for 4 properties with WhatsApp integration.
Operators check in cars, park them, and retrieve them.
Admin assigns retrieval tasks.
Guests interact only via WhatsApp — 2 messages total.

### Key rules (read carefully)
```
1. Operator = Valet = SAME PERSON
   The person who fills the check-in form also parks the car.
   The same person can be assigned to retrieve a different car later.

2. Only 2 WhatsApp messages per guest:
   MSG 1: After car is parked — Template + Get My Car button (Rs. 0.115)
   MSG 2: After car is delivered — Review message (Rs. 0 today)

3. Admin does NOT assign for parking — only for retrieval.

4. 4 properties, completely isolated data per property.
   An operator of Property 1 cannot see Property 2 data.

5. Multi-user — 7-8 operators per property work simultaneously.
   Token allocation is atomic — no two operators get same token.
   Concurrent task assignments handled safely.
```

---

## TECH STACK

| Layer | Technology | Why |
|---|---|---|
| Frontend | React + Tailwind CSS | Fast, component-based UI |
| Database | Supabase PostgreSQL | Scalable, RLS built-in |
| Auth | Supabase Auth | Per-role access |
| Realtime | Supabase Realtime | Instant updates, no polling |
| Backend | Supabase Edge Functions (Deno) | Serverless, auto-scale |
| WhatsApp | Meta Cloud API direct | Cheapest, no BSP markup |
| Notifications | Web Notifications API + Audio | Browser push + sound |
| Deploy | Vercel | Free, auto-deploy from GitHub |

---

## 4 PROPERTIES SETUP

```
Property 1: Ambria Exotica
Property 2: Ambria Pushpanjali
Property 3: Ambria Manaktala
Property 4: Ambria Restro

Each property has:
  - Its own Valet Admin (1 per property)
  - Its own Operators (7-8 per property)
  - Its own token range (daily, 1-300 default)
  - Completely isolated data (RLS enforced)

System Admin sees ALL 4 properties combined.
```

### Property isolation rule
Every table has `property_id`.
Every RLS policy filters by `property_id`.
No user can ever read or write another property's data.
This is enforced at database level — not just UI level.

---

## USER ROLES

| Role | Count | Access | Responsibility |
|---|---|---|---|
| `operator` | 7-8 per property | /operator/* | Fills form + parks + retrieves |
| `valet_admin` | 1 per property | /admin/* | Assigns retrieval + tokens + analytics |
| `system_admin` | 1 overall | /system/* | All 4 properties + all users |

---

## COMPLETE WORKFLOW

### Phase A — Parking (operator does everything, no admin)

```
1. Guest arrives → hands keys to operator at gate
2. Operator fills check-in form:
   - Guest name, phone, car number, tier (VIP/Premium/Standard)
   - Token auto-assigned atomically (no duplicates even with 8 operators)
   - NO WhatsApp yet
3. App shows TOKEN NUMBER big on screen
4. Admin gets FYI notification (no action needed)
5. Operator drives car to parking spot himself
6. Operator taps "Car Parked" → enters exact location (e.g. L2 Bay B4)
7. ── WHATSAPP MESSAGE 1 SENT ──
   Template: car_parked_notification
   "Namaste {{1}}, aapki car park ho gayi."
   Car: {{2}} · Token: {{3}} · Location: {{4}}
   Button: "Get My Car" (payload: GET_CAR:{vehicle_id})
   Cost: Rs. 0.115
```

### Phase B — Retrieval (admin assigns)

```
8.  Guest taps "Get My Car" on WhatsApp
    → Inbound, always free
    → 24-hour window opens NOW
9.  Admin gets LOUD notification + sound + vibrate
10. Admin opens Retrieval Queue
    → get_available_operators() shows only FREE operators
    → Selects one → Assign
11. Operator gets LOUD notification: "Fetch DL8CAF1234 from L2 Bay B4"
    NO WhatsApp to guest (they pressed the button, they know)
12. Operator fetches car → drives to delivery point
13. Operator taps "Car at Delivery Point"
```

### Phase C — 10 Minute Timer

```
14. 10:00 countdown starts on operator screen
    Both buttons always visible (no need to wait):
    ✅ "Guest Arrived"    ❌ "Guest Not Here"

IF GUEST ARRIVES (within 10 min):
    Operator taps "Guest Arrived"
    ── WHATSAPP MESSAGE 2 SENT ──
    Free-form interactive: "Car delivered! Rate us?"
    Buttons: Excellent · Good · Poor
    Cost: Rs. 0 today / Rs. 0.115 after Oct 2026
    Guest rates → review saved → DONE

IF TIMER HITS 00:00 OR OPERATOR TAPS "Not Here":
    → pg_cron backend auto-triggers (even if app is closed)
    → Operator LOUD alert: "Guest not arrived. Park car again."
    → Guest WhatsApp: "Aap available nahi the. Car wapas park ho rahi hai."
    → Operator re-parks → taps "Car Re-parked" → enters location
    → Guest WhatsApp: "Car wapas park ho gayi. Get My Car dobara dabayein."
    → Flow repeats from step 8
```

---

## SCALABILITY DESIGN

### Concurrent operator handling

```
Problem: 8 operators check in cars simultaneously.
         Two could get the same token number.

Solution: Postgres atomic function (SELECT ... FOR UPDATE)
          allocate_token() uses row-level lock.
          Two simultaneous calls CANNOT return same token.
          This is guaranteed at database level.

Never do token logic in React — race condition guaranteed.
Always use supabase.rpc('allocate_token', {...})
```

### Realtime at scale

```
Each Supabase Realtime subscription filtered by property_id.
Admin subscribes only to their property's tasks.
Operator subscribes only to their assigned tasks.
No subscription sees cross-property data.

Channel naming:
  admin-{property_id}-tasks
  operator-{user_role_id}-tasks
  
This prevents data leaks and reduces unnecessary traffic.
```

### Available operator query

```
Never filter operators in React (stale data risk).
Always call: get_available_operators(property_id)
This Postgres function does a real-time locked query.
Returns only operators with no active task at that exact moment.
```

### Session handling

```
Multiple tabs: each tab shares the same Supabase session.
Token refresh: Supabase handles automatically.
Logout: clears session across all tabs.
Realtime: re-subscribes automatically on reconnect.
```

---

## FOLDER STRUCTURE

```
valet-system/
├── public/
│   ├── loud-alert.mp3        (admin + operator high priority alert)
│   ├── notification.mp3      (soft FYI notification)
│   ├── timer-warning.mp3     (plays at 2 min remaining)
│   └── manifest.json         (PWA config)
├── src/
│   ├── supabase.js           (Supabase client singleton)
│   ├── App.jsx               (routes + auth guard)
│   ├── types/
│   │   └── index.ts          (all JS data structures (no TypeScript))
│   ├── context/
│   │   └── AuthContext.jsx   (user + role + property_id + property_name)
│   ├── hooks/
│   │   ├── useRealtime.js    (Supabase realtime subscriptions)
│   │   ├── useNotification.js(browser notification + permission)
│   │   └── useTimer.js       (10 min countdown + auto-trigger)
│   ├── utils/
│   │   ├── sounds.js         (playLoud, playSoft, playWarning)
│   │   └── format.js         (phone masking, date formatting)
│   ├── components/
│   │   ├── Navbar.jsx
│   │   ├── ProtectedRoute.jsx
│   │   ├── LoadingSpinner.jsx
│   │   ├── Toast.jsx         (success/error/warning toasts)
│   │   ├── Badge.jsx         (VIP/Premium/Standard badges)
│   │   └── EmptyState.jsx    (reusable empty state component)
│   └── pages/
│       ├── Login.jsx
│       ├── operator/
│       │   ├── CheckIn.jsx   (form + token display)
│       │   ├── MyTasks.jsx   (parking + retrieval cards + timer)
│       │   └── TodaysCars.jsx
│       ├── admin/
│       │   ├── Dashboard.jsx (retrieval queue + realtime)
│       │   ├── TokenMgmt.jsx
│       │   ├── Reviews.jsx
│       │   └── Analytics.jsx
│       └── system/
│           ├── Properties.jsx
│           ├── Users.jsx
│           └── Analytics.jsx
├── supabase/
│   ├── config.toml
│   └── functions/
│       ├── wa-send/
│       │   └── index.ts
│       └── wa-webhook/
│           └── index.ts
├── .env
├── tailwind.config.js
└── package.json
```

---

## COMPLETE DATABASE SCHEMA

Run this entire block in Supabase SQL Editor:

```sql
-- ═══════════════════════════════════════
-- TABLES
-- ═══════════════════════════════════════

-- 1. Properties (4 hotels/malls)
create table properties (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  address     text,
  phone       text,
  is_active   boolean default true,
  created_at  timestamptz default now()
);

-- 2. User roles (all users linked to a property)
create table user_roles (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid references auth.users on delete cascade,
  property_id uuid references properties,
  role        text check (role in ('system_admin','valet_admin','operator')),
  name        text not null,
  phone       text,
  is_active   boolean default true,
  created_at  timestamptz default now()
);

-- 3. Token ranges (daily, per property)
create table token_ranges (
  id          uuid primary key default gen_random_uuid(),
  property_id uuid references properties,
  range_date  date default current_date,
  range_start int default 1,
  range_end   int default 300,
  next_token  int default 1,
  created_at  timestamptz default now(),
  unique(property_id, range_date)
);

-- 4. Parked vehicles
create table parked_vehicles (
  id               uuid primary key default gen_random_uuid(),
  property_id      uuid references properties,
  token_number     int not null,
  car_number       text not null,
  guest_phone      text not null,
  guest_name       text,
  car_tier         text default 'Standard'
                   check (car_tier in ('VIP','Premium','Standard')),
  parking_location text,
  notes            text,
  status           text default 'checked_in' check (status in (
                     'checked_in',
                     'parking',
                     'parked',
                     'requested',
                     'fetching',
                     'at_pickup',
                     'delivered',
                     're_parking',
                     'returned'
                   )),
  parked_at        timestamptz default now(),
  service_date     date default current_date
);

-- Index for fast daily queries
create index idx_vehicles_property_date
  on parked_vehicles(property_id, service_date);
create index idx_vehicles_status
  on parked_vehicles(property_id, status);

-- 5. Valet tasks (parking + retrieval)
create table valet_tasks (
  id                  uuid primary key default gen_random_uuid(),
  property_id         uuid references properties,
  vehicle_id          uuid references parked_vehicles,
  task_type           text check (task_type in ('parking','retrieval')),
  status              text default 'pending' check (status in (
                        'pending',
                        'assigned',
                        'in_progress',
                        'at_pickup',
                        'completed',
                        're_parking',
                        'returned'
                      )),
  assigned_operator_id uuid references user_roles,
  return_count        int default 0,
  pickup_started_at   timestamptz,
  assigned_at         timestamptz,
  completed_at        timestamptz,
  wa_payload          text,
  created_at          timestamptz default now()
);

-- Index for admin queue queries
create index idx_tasks_property_status
  on valet_tasks(property_id, task_type, status);
create index idx_tasks_operator
  on valet_tasks(assigned_operator_id, status);

-- 6. Reviews
create table reviews (
  id          uuid primary key default gen_random_uuid(),
  task_id     uuid references valet_tasks,
  property_id uuid references properties,
  guest_phone text,
  rating      text check (rating in ('excellent','good','poor')),
  created_at  timestamptz default now()
);

-- 7. WhatsApp message log (for deduplication)
create table wa_message_log (
  id             uuid primary key default gen_random_uuid(),
  wa_message_id  text unique,
  vehicle_id     uuid references parked_vehicles,
  direction      text check (direction in ('inbound','outbound')),
  message_type   text,
  created_at     timestamptz default now()
);


-- ═══════════════════════════════════════
-- POSTGRES FUNCTIONS
-- ═══════════════════════════════════════

-- 1. Atomic token allocation
-- Uses row-level lock so 8 operators can call simultaneously
-- and NEVER get the same token
create or replace function allocate_token(p_property_id uuid)
returns int language plpgsql as $$
declare
  v_token int;
begin
  update token_ranges
  set next_token = next_token + 1
  where property_id = p_property_id
    and range_date = current_date
    and next_token <= range_end
  returning next_token - 1 into v_token;

  if v_token is null then
    raise exception 'TOKEN_RANGE_EXHAUSTED';
  end if;

  return v_token;
end $$;

-- 2. Get operators who are currently FREE
-- Free = no task with status assigned/in_progress/at_pickup/re_parking
create or replace function get_available_operators(p_property_id uuid)
returns table(id uuid, name text) language sql as $$
  select ur.id, ur.name
  from user_roles ur
  where ur.property_id = p_property_id
    and ur.role = 'operator'
    and ur.is_active = true
    and ur.id not in (
      select assigned_operator_id
      from valet_tasks
      where status in ('assigned','in_progress','at_pickup','re_parking')
        and assigned_operator_id is not null
    )
  order by ur.name;
$$;

-- 3. Daily token reset (called by pg_cron at midnight)
create or replace function reset_daily_tokens()
returns void language plpgsql as $$
begin
  -- Create fresh ranges for tomorrow for all active properties
  insert into token_ranges (property_id, range_date, range_start, range_end, next_token)
  select
    p.id,
    current_date + 1,
    1,
    300,
    1
  from properties p
  where p.is_active = true
  on conflict (property_id, range_date) do nothing;
end $$;


-- ═══════════════════════════════════════
-- RLS POLICIES
-- ═══════════════════════════════════════

alter table properties       enable row level security;
alter table user_roles       enable row level security;
alter table parked_vehicles  enable row level security;
alter table valet_tasks      enable row level security;
alter table reviews          enable row level security;
alter table token_ranges     enable row level security;
alter table wa_message_log   enable row level security;

-- Properties: everyone can read (needed for UI labels)
create policy "read properties"
on properties for select using (true);

-- User roles: users see only their own role record
create policy "see own role"
on user_roles for select
using (user_id = auth.uid());

-- System admin sees all user_roles (for management)
create policy "system admin sees all roles"
on user_roles for all
using (
  exists (
    select 1 from user_roles ur
    where ur.user_id = auth.uid()
      and ur.role = 'system_admin'
  )
);

-- Parked vehicles: users see only their property
create policy "own property vehicles"
on parked_vehicles for all
using (
  property_id in (
    select property_id from user_roles
    where user_id = auth.uid()
  )
);

-- Valet tasks: users see only their property
create policy "own property tasks"
on valet_tasks for all
using (
  property_id in (
    select property_id from user_roles
    where user_id = auth.uid()
  )
);

-- Reviews: users see only their property
create policy "own property reviews"
on reviews for all
using (
  property_id in (
    select property_id from user_roles
    where user_id = auth.uid()
  )
);

-- Token ranges: users see only their property
create policy "own property tokens"
on token_ranges for all
using (
  property_id in (
    select property_id from user_roles
    where user_id = auth.uid()
  )
);

-- WA message log: service role only (edge functions use service key)
create policy "service role only"
on wa_message_log for all using (true);


-- ═══════════════════════════════════════
-- PG_CRON JOBS
-- Enable pg_cron extension first:
-- Database → Extensions → pg_cron → Enable
-- ═══════════════════════════════════════

-- Timer safety: auto-trigger not-arrived flow
-- Runs every minute, catches any task stuck in at_pickup > 10 min
select cron.schedule(
  'check-expired-pickups',
  '* * * * *',
  $$
    update valet_tasks
    set
      status = 'returned',
      return_count = return_count + 1
    where status = 'at_pickup'
      and pickup_started_at < now() - interval '10 minutes'
      and completed_at is null;
  $$
);

-- Daily token reset: runs at 11:59 PM every night
select cron.schedule(
  'daily-token-reset',
  '59 23 * * *',
  $$
    select reset_daily_tokens();
  $$
);


-- ═══════════════════════════════════════
-- SEED DATA — 4 PROPERTIES
-- ═══════════════════════════════════════

insert into properties (name, address, phone) values
  ('Ambria Exotica',        'New Delhi',    '011-12345678'),
  ('Ambria Pushpanjali',  'New Delhi',       '011-23456789'),
  ('Ambria Manaktala',              'New Delhi',              '0120-3456789'),
  ('Ambria Restro',       'New Delhi',        '011-45678901');

-- After running this, check the IDs:
-- select id, name from properties;
-- Use those IDs when creating user_roles below.
```

---

## ENVIRONMENT VARIABLES

### .env (React app — never commit to git)
```
REACT_APP_SUPABASE_URL=https://xxxxx.supabase.co
REACT_APP_SUPABASE_ANON_KEY=eyJhbGc...
REACT_APP_WA_FUNCTION_URL=https://xxxxx.supabase.co/functions/v1/wa-send
```

### Supabase Secrets (set via terminal)
```bash
supabase secrets set WA_PHONE_NUMBER_ID=paste_here
supabase secrets set WA_ACCESS_TOKEN=paste_here
supabase secrets set WA_VERIFY_TOKEN=valetapp2024secure
supabase secrets set WA_APP_SECRET=paste_here
supabase secrets set SUPABASE_SERVICE_ROLE_KEY=paste_here
```

---

## TYPESCRIPT TYPES

```javascript
// src/types/index.js
// Data constants — use these everywhere for consistency

export const ROLES = {
  SYSTEM_ADMIN: 'system_admin',
  VALET_ADMIN:  'valet_admin',
  OPERATOR:     'operator'
}

export const CAR_TIERS = {
  VIP:      'VIP',
  PREMIUM:  'Premium',
  STANDARD: 'Standard'
}

export const TASK_TYPES = {
  PARKING:   'parking',
  RETRIEVAL: 'retrieval'
}

export const TASK_STATUS = {
  PENDING:     'pending',
  ASSIGNED:    'assigned',
  IN_PROGRESS: 'in_progress',
  AT_PICKUP:   'at_pickup',
  COMPLETED:   'completed',
  RE_PARKING:  're_parking',
  RETURNED:    'returned'
}

export const VEHICLE_STATUS = {
  CHECKED_IN: 'checked_in',
  PARKING:    'parking',
  PARKED:     'parked',
  REQUESTED:  'requested',
  FETCHING:   'fetching',
  AT_PICKUP:  'at_pickup',
  DELIVERED:  'delivered',
  RE_PARKING: 're_parking',
  RETURNED:   'returned'
}

export const RATINGS = {
  EXCELLENT: 'excellent',
  GOOD:      'good',
  POOR:      'poor'
}
```

---

## KEY FILES IMPLEMENTATION

### src/supabase.js
```javascript
import { createClient } from '@supabase/supabase-js'

// Singleton — same client reused across all components
export const supabase = createClient(
  process.env.REACT_APP_SUPABASE_URL!,
  process.env.REACT_APP_SUPABASE_ANON_KEY!,
  {
    realtime: {
      params: {
        eventsPerSecond: 10  // Rate limit realtime events
      }
    }
  }
)
```

### src/context/AuthContext.jsx
```typescript
// On login: supabase.auth.signInWithPassword()
// Fetch user_roles joined with properties:
//   select *, properties(*) from user_roles
//   where user_id = user.id
// Store in context: user, userRole (with property info)
// On logout: supabase.auth.signOut()
//
// Redirect after login based on role:
//   operator     → /operator/checkin
//   valet_admin  → /admin/dashboard
//   system_admin → /system/properties
//
// system_admin has property_id = null
// All other roles must have a property_id
```

### src/hooks/useRealtime.js
```typescript
// Subscribe to valet_tasks for this property
// Filter: property_id=eq.{property_id}
// On INSERT: add to state + trigger notification
// On UPDATE: update item in state
// Channel name: `tasks-{property_id}` (unique per property)
// IMPORTANT: unsubscribe in useEffect cleanup
// IMPORTANT: reconnect automatically on network drop
//
// Example:
// const channel = supabase
//   .channel(`tasks-${propertyId}`)
//   .on('postgres_changes', {
//     event: '*',
//     schema: 'public',
//     table: 'valet_tasks',
//     filter: `property_id=eq.${propertyId}`
//   }, handleChange)
//   .subscribe()
// return () => supabase.removeChannel(channel)
```

### src/hooks/useTimer.js
```typescript
// Manages 10-minute countdown for at_pickup tasks
// Props: task_id, pickup_started_at, onExpired callback
// Calculates remaining seconds from pickup_started_at
// Updates every second via setInterval
// Calls onExpired when remaining <= 0
// Plays warning sound at 2 minutes remaining
// Red color when < 2 minutes remaining
// IMPORTANT: clear interval on unmount
// IMPORTANT: handle tab switching (document.visibilitychange)
// pg_cron handles the actual DB update if timer fires server-side
```

### src/utils/sounds.js
```typescript
export const playLoud = () => {
  const audio = new Audio('/loud-alert.mp3')
  audio.volume = 1.0
  audio.play().catch(() => {})
}

export const playSoft = () => {
  const audio = new Audio('/notification.mp3')
  audio.volume = 0.7
  audio.play().catch(() => {})
}

export const playWarning = () => {
  const audio = new Audio('/timer-warning.mp3')
  audio.volume = 1.0
  audio.play().catch(() => {})
}

export const showNotification = (title: string, body: string) => {
  if (Notification.permission === 'granted') {
    new Notification(title, {
      body,
      icon: '/logo192.png',
      requireInteraction: true  // Stays until dismissed
    })
  }
}

export const vibrate = () => {
  if (navigator.vibrate) navigator.vibrate([500, 200, 500])
}

export const requestNotificationPermission = async () => {
  if (Notification.permission === 'default') {
    await Notification.requestPermission()
  }
}
```

---

## PAGE SPECIFICATIONS

### pages/operator/CheckIn.jsx

```typescript
// FORM FIELDS:
// - Guest Name (text, required)
// - Guest Phone (10 digits, no country code, required)
// - Car Number (text, auto-uppercase, required)
// - Car Tier (select: Standard / Premium / VIP)
// - Notes (optional, e.g. "scratched bumper")

// ON SUBMIT:
// 1. Validate all fields (show inline errors)
// 2. Set loading state — disable button
// 3. Call: supabase.rpc('allocate_token', { p_property_id })
//    Handle TOKEN_RANGE_EXHAUSTED error clearly
// 4. Insert into parked_vehicles:
//    { property_id, token_number, car_number, guest_phone,
//      guest_name, car_tier, notes, status: 'checked_in' }
// 5. Insert into valet_tasks:
//    { property_id, vehicle_id, task_type: 'parking',
//      status: 'assigned',
//      assigned_operator_id: userRole.id,  ← assigns to himself
//      assigned_at: new Date().toISOString() }
// 6. Update parked_vehicles status to 'parking'
// 7. Show TOKEN NUMBER big on screen (success state)
// 8. Reset form after 3 seconds for next car

// ALSO SHOW:
// - Today's check-in count (live, from parked_vehicles)
// - Last 5 cars (token, car number, tier badge, time)
// - Token range remaining (e.g. "Token 47 / 300")

// NO WhatsApp sent here
```

### pages/operator/MyTasks.jsx

```typescript
// Fetch tasks assigned to this operator:
//   select *, parked_vehicles(*) from valet_tasks
//   where assigned_operator_id = userRole.id
//   and status in ('assigned','in_progress','at_pickup','re_parking')
//
// Realtime: subscribe to UPDATE on valet_tasks
//   filter: assigned_operator_id=eq.{userRole.id}
// On new task: playLoud() + showNotification() + vibrate()

// ─────────────────────────────────
// PARKING TASK CARD:
// ─────────────────────────────────
// Shows: Token (big, 48px), Car number, Tier badge
// Input: "Enter parking location" (required before submit)
// Button: "Car Parked ✅" (green, min-height 56px)
// On tap:
//   1. Validate location is entered
//   2. UPDATE valet_tasks: status='completed', completed_at=now()
//   3. UPDATE parked_vehicles:
//      status='parked', parking_location=location_input
//   4. Call wa-send: type='car_parked' → MSG 1 to guest
//   5. Remove card from active tasks
//   6. Show success toast

// ─────────────────────────────────
// RETRIEVAL TASK CARD:
// ─────────────────────────────────
// Shows: Token (big), Car number, "Fetch from: L2 Bay B4"
// Button: "Car at Delivery Point" (blue)
// On "Car at Delivery Point" tap:
//   1. UPDATE valet_tasks: status='at_pickup', pickup_started_at=now()
//   2. UPDATE parked_vehicles: status='at_pickup'
//   3. Start useTimer hook → 10:00 countdown

// DURING TIMER:
// Shows countdown (red when < 2 min, playWarning at 2 min)
// Button: "Guest Arrived ✅" (always visible)
// Button: "Guest Not Here ❌" (always visible)

// On "Guest Arrived":
//   1. UPDATE valet_tasks: status='completed', completed_at=now()
//   2. UPDATE parked_vehicles: status='delivered'
//   3. Call wa-send: type='car_delivered' → MSG 2 to guest
//   4. Remove card

// On "Guest Not Here" OR timer auto-fires:
//   1. UPDATE valet_tasks: status='returned', return_count+1
//   2. UPDATE parked_vehicles: status='re_parking'
//   3. Call wa-send: type='not_available'
//   4. Show: "Park car again. Enter new location."
//   5. Location input appears
//   6. On "Car Re-parked":
//      UPDATE valet_tasks: status='completed', completed_at=now()
//      UPDATE parked_vehicles: status='returned', new location
//      Call wa-send: type='car_returned'
//      Task done, operator free

// BOTTOM: Completed Today (smaller cards)
```

### pages/operator/TodaysCars.jsx

```typescript
// All parked_vehicles for today (service_date = today) for this property
// Columns: Token, Car number, Guest name (truncated),
//          Tier badge, Status badge, Time (relative)
// Search: by token number or car number (client-side filter)
// Color-coded status badges
// Realtime: subscribe to changes
// Empty state: "No cars checked in today"
```

### pages/admin/Dashboard.jsx

```typescript
// RETRIEVAL QUEUE ONLY (no parking assignment)
//
// Fetch: valet_tasks where task_type='retrieval' AND status='pending'
// Realtime: subscribe INSERT on valet_tasks for this property
// On new retrieval task: playLoud() + showNotification() + vibrate()
//
// EACH CARD SHOWS:
// - Token number (big, bold)
// - Car number + Tier badge (VIP = red border highlight)
// - Guest name
// - Parking location (where to fetch from)
// - Time waiting (e.g. "3 min ago")
// - Assign dropdown: supabase.rpc('get_available_operators', { p_property_id })
// - "Assign" button
//
// ON ASSIGN:
// 1. UPDATE valet_tasks:
//    status='assigned', assigned_operator_id, assigned_at=now()
// 2. UPDATE parked_vehicles: status='fetching'
// 3. NO WhatsApp to guest
// 4. Remove from Retrieval Queue
// 5. Move to "In Progress" section
//
// ALSO SHOW:
// Stats bar at top:
//   Cars today | Pending retrieval | In progress | Delivered today
// In Progress section:
//   Assigned tasks — which operator, which car, time since assigned
// FYI: Today's check-ins count (no assign button for parking)
```

### pages/admin/TokenMgmt.jsx

```typescript
// Today's token range for this property
// If no range: "Create Range" form (start, end)
// If exists:
//   - Next available token
//   - Used count (next_token - range_start)
//   - Remaining count (range_end - next_token + 1)
//   - Progress bar
//   - Extend range button (increase range_end only)
// Create tomorrow's range (date picker)
// Hourly check-in chart (CSS bars, no library needed)
//   - Count cars by hour from parked_vehicles today
```

### pages/admin/Reviews.jsx

```typescript
// All reviews for this property
// Summary cards: Total | Excellent % | Good % | Poor %
// Filter by: date range, rating, operator
// Table: Token, Car, Guest phone (masked 98765XXXXX),
//        Rating (emoji), Operator name, Time
// Export CSV button
// Empty state: "No reviews yet"
```

### pages/admin/Analytics.jsx

```typescript
// This property only
// Cards: Cars today | This week | This month
// Average wait time (task created_at to completed_at, in minutes)
// Peak hours bar chart (6am-11pm, CSS bars)
// Top 5 operators by completed tasks this month
// Return rate % (returned tasks / total retrieval tasks)
// VIP cars % of total
// Rating trend (last 7 days)
```

### pages/system/Properties.jsx

```typescript
// All 4 properties
// Each property card: name, address, today's cars count, valets count
// Add new property form
// Edit property details
// Enable/disable property toggle
// Click property → drill down to that property's analytics
```

### pages/system/Users.jsx

```typescript
// All users across all 4 properties
// Filter by: property, role, active/inactive
// Table: Name, Role, Property, Phone, Status, Created
// Add new user:
//   1. supabase.auth.admin.createUser({ email, password })
//   2. Insert into user_roles
//   (requires service_role key — use Edge Function)
// Deactivate/activate toggle (sets is_active)
// Reset password button
```

### pages/system/Analytics.jsx

```typescript
// All 4 properties combined + per-property breakdown
// Top section: combined totals
// Property comparison: side-by-side bar chart (CSS)
// Best performing property this month
// Monthly trend (last 6 months)
// System-wide review scores
```

---

## WHATSAPP EDGE FUNCTIONS

### supabase/functions/wa-send/index.ts

```typescript
import { serve } from "https://deno.land/std@0.168.0/http/server.ts"

const PHONE_ID = Deno.env.get('WA_PHONE_NUMBER_ID')!
const TOKEN    = Deno.env.get('WA_ACCESS_TOKEN')!
const BASE_URL = `https://graph.facebook.com/v18.0/${PHONE_ID}/messages`

serve(async (req) => {
  const { type, to, data } = await req.json()

  // Phone number format for India: 91XXXXXXXXXX
  // to is already formatted before calling this function

  let body: Record<string, unknown> = {}

  // ─────────────────────────────────────────────
  // MSG 1: Car Parked — TEMPLATE (Rs. 0.115)
  // Template: car_parked_notification
  // ─────────────────────────────────────────────
  if (type === 'car_parked') {
    body = {
      messaging_product: "whatsapp",
      to,
      type: "template",
      template: {
        name: "car_parked_notification",
        language: { code: "en" },
        components: [
          {
            type: "body",
            parameters: [
              { type: "text", text: data.guest_name },
              { type: "text", text: data.car_number },
              { type: "text", text: String(data.token_number) },
              { type: "text", text: data.parking_location || "Parking area" }
            ]
          },
          {
            type: "button",
            sub_type: "quick_reply",
            index: "0",
            parameters: [{
              type: "payload",
              payload: `GET_CAR:${data.vehicle_id}`
            }]
          }
        ]
      }
    }
  }

  // ─────────────────────────────────────────────
  // MSG 2: Car Delivered — FREE-FORM (24hr window)
  // ─────────────────────────────────────────────
  if (type === 'car_delivered') {
    body = {
      messaging_product: "whatsapp",
      to,
      type: "interactive",
      interactive: {
        type: "button",
        body: {
          text:
            `Namaste ${data.guest_name},\n\n` +
            `Aapki car ${data.car_number} deliver ho gayi! ✅\n` +
            `Token: ${data.token_number}\n\n` +
            `Humari service kaisi lagi?`
        },
        action: {
          buttons: [
            { type: "reply", reply: {
              id: `REVIEW_EXCELLENT:${data.task_id}`,
              title: "⭐ Excellent"
            }},
            { type: "reply", reply: {
              id: `REVIEW_GOOD:${data.task_id}`,
              title: "👍 Good"
            }},
            { type: "reply", reply: {
              id: `REVIEW_POOR:${data.task_id}`,
              title: "👎 Poor"
            }}
          ]
        }
      }
    }
  }

  // ─────────────────────────────────────────────
  // Guest not available — FREE-FORM (window open)
  // ─────────────────────────────────────────────
  if (type === 'not_available') {
    body = {
      messaging_product: "whatsapp",
      to,
      type: "text",
      text: {
        body:
          `Namaste ${data.guest_name},\n\n` +
          `Aap delivery point par available nahi the.\n` +
          `Aapki car ${data.car_number} (Token: ${data.token_number}) ` +
          `wapas park ho rahi hai.\n\n` +
          `Jab ready hon, Get My Car dobara dabayein. 🙏`
      }
    }
  }

  // ─────────────────────────────────────────────
  // Car re-parked — FREE-FORM (window open)
  // ─────────────────────────────────────────────
  if (type === 'car_returned') {
    body = {
      messaging_product: "whatsapp",
      to,
      type: "text",
      text: {
        body:
          `Aapki car ${data.car_number} wapas park ho gayi hai.\n` +
          `Token: ${data.token_number}\n` +
          `Location: ${data.parking_location}\n\n` +
          `Jab ready hon, neeche button dabayein. 🙏`
      }
    }
  }

  try {
    const res = await fetch(BASE_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    })
    const result = await res.json()
    return new Response(JSON.stringify(result), {
      headers: { 'Content-Type': 'application/json' }
    })
  } catch (err) {
    console.error('wa-send error:', err)
    return new Response(JSON.stringify({ error: String(err) }), { status: 500 })
  }
})
```

### supabase/functions/wa-webhook/index.ts

```typescript
import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const VERIFY_TOKEN = Deno.env.get('WA_VERIFY_TOKEN')!
const APP_SECRET   = Deno.env.get('WA_APP_SECRET')!

serve(async (req) => {

  // Meta webhook verification handshake (one-time setup)
  if (req.method === 'GET') {
    const url = new URL(req.url)
    const mode      = url.searchParams.get('hub.mode')
    const token     = url.searchParams.get('hub.verify_token')
    const challenge = url.searchParams.get('hub.challenge')
    if (mode === 'subscribe' && token === VERIFY_TOKEN) {
      return new Response(challenge, { status: 200 })
    }
    return new Response('Forbidden', { status: 403 })
  }

  // Verify request is genuinely from Meta
  const signature = req.headers.get('x-hub-signature-256') || ''
  const rawBody   = await req.text()
  const expected  = await computeHmac(rawBody, APP_SECRET)
  if (signature !== `sha256=${expected}`) {
    return new Response('Unauthorized', { status: 401 })
  }

  // Return 200 immediately — Meta retries if you're slow
  const response = new Response('OK', { status: 200 })

  // Process async (don't await)
  ;(async () => {
    try {
      const payload = JSON.parse(rawBody)
      const message = payload?.entry?.[0]
        ?.changes?.[0]?.value?.messages?.[0]
      if (!message) return

      const supabase = createClient(
        Deno.env.get('SUPABASE_URL')!,
        Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
      )

      // Deduplication — same message can arrive multiple times
      const { error: dupError } = await supabase
        .from('wa_message_log')
        .insert({
          wa_message_id: message.id,
          direction: 'inbound',
          message_type: message.type
        })
      if (dupError) return  // Already processed, skip

      const guestPhone = message.from
      const payload_str =
        message?.button?.payload ||
        message?.interactive?.button_reply?.id || ''

      // Guest tapped "Get My Car"
      if (payload_str.startsWith('GET_CAR:')) {
        const vehicleId = payload_str.split(':')[1]

        const { data: vehicle } = await supabase
          .from('parked_vehicles')
          .select('*')
          .eq('id', vehicleId)
          .single()
        if (!vehicle) return

        // Create retrieval task (admin will assign operator)
        await supabase.from('valet_tasks').insert({
          vehicle_id:  vehicleId,
          property_id: vehicle.property_id,
          task_type:   'retrieval',
          status:      'pending'
        })

        await supabase
          .from('parked_vehicles')
          .update({ status: 'requested' })
          .eq('id', vehicleId)
      }

      // Guest tapped review button
      if (payload_str.startsWith('REVIEW_')) {
        const parts    = payload_str.split(':')
        const ratingStr = parts[0].replace('REVIEW_', '').toLowerCase()
        const taskId    = parts[1]

        const { data: task } = await supabase
          .from('valet_tasks')
          .select('property_id, parked_vehicles(property_id)')
          .eq('id', taskId)
          .single()
        if (!task) return

        await supabase.from('reviews').insert({
          task_id:     taskId,
          property_id: task.property_id,
          guest_phone: guestPhone,
          rating:      ratingStr
        })
      }

    } catch (e) {
      console.error('Webhook processing error:', e)
    }
  })()

  return response
})

async function computeHmac(body: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  )
  const sig = await crypto.subtle.sign(
    'HMAC', key, new TextEncoder().encode(body)
  )
  return Array.from(new Uint8Array(sig))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')
}
```

### supabase/config.toml

```toml
[functions.wa-webhook]
verify_jwt = false
```

---

## WHATSAPP TEMPLATE TO SUBMIT

Submit at: `business.facebook.com/wa/manage/message-templates`

```
Category:  UTILITY
Name:      car_parked_notification
Language:  English

HEADER: (none)

BODY:
Namaste {{1}},

Aapki car park ho gayi hai.
Car Number: {{2}}
Token: {{3}}
Location: {{4}}

Jab ready hon, button dabayein.

FOOTER: (none)

BUTTON:
Type: Quick Reply
Button text: Get My Car

VARIABLES:
{{1}} = Guest name      (e.g. Rahul)
{{2}} = Car number      (e.g. DL8CAF1234)
{{3}} = Token number    (e.g. 47)
{{4}} = Location        (e.g. Level 2 Bay B4)
```

Submit this FIRST. Approval takes 2-24 hours.
Cannot send MSG 1 until this is approved.

---

## WHATSAPP COST SUMMARY

```
MSG 1 — car_parked (Template)
  When:  After operator taps "Car Parked"
  Cost:  Rs. 0.115 always billed
  Type:  Pre-approved template

MSG 2 — car_delivered (Free-form)
  When:  After operator taps "Guest Arrived"
  Cost:  Rs. 0 today / Rs. 0.115 after Oct 1, 2026
  Type:  Free-form (inside 24hr window from GET_CAR tap)

not_available + car_returned (Free-form, only on re-park)
  Cost:  Rs. 0 today / Rs. 0.115 each after Oct 2026
  These only send when guest is absent

Guest taps (inbound): ALWAYS FREE

Cost per guest (normal flow):
  Today:       Rs. 0.115
  Oct 2026+:   Rs. 0.23

500 cars/day across all 4 properties:
  15,000 cars/month
  Today:       ~Rs. 2,035/month
  Oct 2026+:   ~Rs. 4,100/month
```

---

## SETUP ORDER

```
Step 1: Collect credentials (Meta + Supabase)
Step 2: supabase.com → new project
Step 3: SQL Editor → run full schema above
Step 4: Enable pg_cron:
        Database → Extensions → pg_cron → Enable
        Then run both cron.schedule() calls
Step 5: npm install -g supabase → supabase login
        supabase link --project-ref YOUR_REF
Step 6: supabase secrets set (all 5 secrets)
Step 7: Build the app (follow build order)
Step 8: supabase functions deploy wa-send
        supabase functions deploy wa-webhook
Step 9: Register webhook on Meta:
        developers.facebook.com → App
        → WhatsApp → Configuration → Webhook → Edit
        Callback URL: https://XXX.supabase.co/functions/v1/wa-webhook
        Verify Token: valetapp2024secure
        → Verify and Save → Subscribe: messages ✅
Step 10: Submit car_parked_notification template
         business.facebook.com/wa/manage/message-templates
         Wait 2-24 hours
Step 11: Add payment method to Meta
         business.facebook.com/wa/manage
         → Settings → Payment Methods
Step 12: Test with Meta test number (API Setup page)
Step 13: Test with real phone end-to-end
Step 14: Create users for all 4 properties
Step 15: Deploy to Vercel
```

---

## BUILD ORDER

### Day 1 — Project Setup
```
npx create-react-app . 
npm install @supabase/supabase-js react-router-dom
npm install -D tailwindcss postcss autoprefixer
npx tailwindcss init -p
Create all folders from structure above
Create src/supabase.js
Create src/types/index.js
Create .env with all credentials
```

### Day 2 — Database
```
Run full SQL schema in Supabase SQL Editor
Enable pg_cron extension
Run cron.schedule() calls
Insert 4 properties (seed data above)
Create test users for each property
Create token_ranges for today for each property
Verify all tables in Supabase Table Editor
```

### Day 3 — Auth + Routing
```
AuthContext.jsx — login, role fetch, property context
Login.jsx — email + password
ProtectedRoute.jsx — role-based guard
Navbar.jsx — user name, property name, logout
App.jsx — all routes
sounds.ts + format.ts utilities
Test: each role logs in → correct page
```

### Day 4 — Operator: CheckIn
```
CheckIn.jsx — form + atomic token + task creation
TodaysCars.jsx — list with realtime
Test: 2 operators check in simultaneously → different tokens
Test: token exhausted → clear error message
```

### Day 5 — Operator: MyTasks + Timer
```
useTimer.ts hook
MyTasks.jsx — parking card + retrieval card + timer
useNotification.ts + requestPermission
Test: parking task → "Car Parked" → MSG 1 WhatsApp
Test: retrieval → timer → Guest Arrived → MSG 2
Test: timer expires → auto re-park flow
```

### Day 6 — Admin Dashboard
```
useRealtime.ts hook
Dashboard.jsx — retrieval queue + assign
Test: guest taps button → admin sees instantly (no refresh)
Test: admin assigns → operator sees task instantly
Test: 2 retrieval requests at same time → both show
```

### Day 7 — WhatsApp End-to-End
```
Deploy wa-send + wa-webhook functions
Register webhook on Meta
Test with real phone — full flow
Verify deduplication (tap button twice → 1 task only)
Verify signature check (reject fake webhooks)
```

### Day 8 — Remaining Admin + System Pages
```
TokenMgmt.jsx
Reviews.jsx
Analytics.jsx (this property)
Properties.jsx (system admin)
Users.jsx (system admin — with Edge Function for user creation)
Analytics.jsx (system admin — all properties)
```

### Day 9 — Polish + Edge Cases
```
Loading states on ALL buttons (no double submit)
Toast notifications (success / error / warning)
Empty states on ALL lists
Mobile responsive — operators use phones
Timer edge cases (tab hidden, network drop)
Test all 4 properties independently
Test 8 simultaneous operators on same property
```

### Day 10 — Deploy
```
Push to GitHub
Deploy on Vercel — set all env vars
Update webhook URL if Supabase URL changed
Create all production users (all 4 properties)
Create token ranges for all 4 properties
Final end-to-end test on real devices
```

---

## MULTI-USER TESTING

```
Test these specific concurrent scenarios:

□ 8 operators check in cars at exactly the same time
  → All get different tokens (no duplicates)
  → parked_vehicles has 8 distinct rows

□ 2 admins open dashboard on same property
  → Both see the same retrieval queue
  → One assigns → card disappears for both

□ Same guest taps "Get My Car" twice quickly
  → Only 1 retrieval task created (wa_message_id dedupe)

□ Admin assigns while operator is already assigned
  → get_available_operators() shows correct free list

□ Operator closes app during 10-min timer
  → pg_cron fires after 10 min
  → parked_vehicles status updates
  → Guest gets retry WhatsApp (sent by Edge Function)

□ Network drops for operator mid-task
  → Realtime reconnects automatically
  → Task still visible on reconnect
  → No duplicate tasks created
```

---

## RULES FOR CLAUDE CODE

```
ARCHITECTURE:
1. Operator assigns parking task to himself: assigned_operator_id = userRole.id
2. Admin only assigns retrieval tasks — never parking
3. System admin: property_id = null in user_roles, sees all properties
4. All queries must include property_id filter (RLS enforces this too)

SCALABILITY:
5. Token allocation: ALWAYS use allocate_token() RPC — never in React
6. Available operators: ALWAYS use get_available_operators() RPC — never filter in React
7. Realtime channels: name as tasks-{property_id} to avoid cross-property leaks
8. Never query without property_id — add it to every select and insert

WHATSAPP:
9. Only 2 messages per normal flow (car_parked + car_delivered)
10. WhatsApp fetch() calls in try/catch — failure must NOT block main flow
11. Phone: stored without 91 in DB, add "91" prefix only when calling wa-send
12. Template car_parked_notification must be approved before MSG 1 can send

TIMER:
13. Frontend: countdown display only (useTimer.js hook)
14. Backend: pg_cron is the source of truth for timer expiry
15. Both run simultaneously — pg_cron saves the operator if app closes

UI/UX:
16. Every async button: loading state + disabled during request (prevent double submit)
17. Every form: inline validation before submit
18. Every list: empty state component
19. Every error: toast notification (not console.log)
20. Mobile first: operators use phones. Min button 56px. Min font 16px.
21. Sounds: always .catch(() => {}) — browsers block autoplay
22. Notification: requireInteraction: true for critical alerts (LOUD ones)
23. useRealtime: always unsubscribe in useEffect cleanup
24. Supabase client: singleton from supabase.ts — never create new instances
```

---

## FIRST MESSAGE FOR CLAUDE CODE

Copy and paste this exactly:

```
Read VALET_SYSTEM_FINAL.md completely before writing any code.

Key facts:
- 4 properties: Ambria Exotica, Ambria Pushpanjali,
  Ambria Manaktala, Ambria Restro
- Operator = Valet = same person. No separate roles.
- Admin assigns retrieval only — never parking
- Only 2 WhatsApp messages per guest (car_parked + car_delivered)
- Multi-user: 7-8 operators per property work simultaneously
- Token allocation is atomic via Postgres function — never in React
- Meta account is verified — WhatsApp integrated from Day 1
- Timer: 10 minutes, frontend countdown + pg_cron backend safety net
- All data isolated per property via RLS + property_id on every table

Start with Day 1 setup only:
1. Create complete folder structure
2. Install all dependencies
3. Configure Tailwind CSS
4. Create src/supabase.js (singleton)
5. Create src/types/index.js (data constants)
6. Create .env with placeholder values
7. Create .gitignore (include .env)

Do not build any pages yet. Setup only. Tell me when done.
```

