-- ═══════════════════════════════════════════════════════════════════════
-- 0001 — INITIAL SCHEMA
--
-- This is the schema from VALET_SYSTEM_FINAL.md, kept here verbatim so the
-- repository is the source of truth and `supabase db reset` can rebuild a
-- database from scratch.
--
-- >>> YOU HAVE ALREADY RUN THIS in the Supabase SQL Editor. Do NOT re-run it.
-- >>> Run 20260731090100_fixes_and_hardening.sql instead — that one repairs
-- >>> the defects in this file and is safe to run on your existing database.
--
-- Everything below is wrapped so a re-run is harmless (if exists / if not
-- exists), but there is still no reason to re-run it.
-- ═══════════════════════════════════════════════════════════════════════

-- ───────────────────────────────────────────
-- TABLES
-- ───────────────────────────────────────────

-- 1. Properties (4 hotels/restaurants)
create table if not exists properties (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  address     text,
  phone       text,
  is_active   boolean default true,
  created_at  timestamptz default now()
);

-- 2. User roles (all users linked to a property)
create table if not exists user_roles (
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
create table if not exists token_ranges (
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
create table if not exists parked_vehicles (
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
                     'checked_in','parking','parked','requested','fetching',
                     'at_pickup','delivered','re_parking','returned'
                   )),
  parked_at        timestamptz default now(),
  service_date     date default current_date
);

create index if not exists idx_vehicles_property_date
  on parked_vehicles(property_id, service_date);
create index if not exists idx_vehicles_status
  on parked_vehicles(property_id, status);

-- 5. Valet tasks (parking + retrieval)
create table if not exists valet_tasks (
  id                   uuid primary key default gen_random_uuid(),
  property_id          uuid references properties,
  vehicle_id           uuid references parked_vehicles,
  task_type            text check (task_type in ('parking','retrieval')),
  status               text default 'pending' check (status in (
                         'pending','assigned','in_progress','at_pickup',
                         'completed','re_parking','returned'
                       )),
  assigned_operator_id uuid references user_roles,
  return_count         int default 0,
  pickup_started_at    timestamptz,
  assigned_at          timestamptz,
  completed_at         timestamptz,
  wa_payload           text,
  created_at           timestamptz default now()
);

create index if not exists idx_tasks_property_status
  on valet_tasks(property_id, task_type, status);
create index if not exists idx_tasks_operator
  on valet_tasks(assigned_operator_id, status);

-- 6. Reviews
create table if not exists reviews (
  id          uuid primary key default gen_random_uuid(),
  task_id     uuid references valet_tasks,
  property_id uuid references properties,
  guest_phone text,
  rating      text check (rating in ('excellent','good','poor')),
  created_at  timestamptz default now()
);

-- 7. WhatsApp message log (for deduplication)
create table if not exists wa_message_log (
  id             uuid primary key default gen_random_uuid(),
  wa_message_id  text unique,
  vehicle_id     uuid references parked_vehicles,
  direction      text check (direction in ('inbound','outbound')),
  message_type   text,
  created_at     timestamptz default now()
);

-- ───────────────────────────────────────────
-- ROW LEVEL SECURITY (enable only)
-- Policies live in 0002 — the ones originally specified here caused
-- infinite recursion. See that file for the explanation.
-- ───────────────────────────────────────────

alter table properties      enable row level security;
alter table user_roles      enable row level security;
alter table parked_vehicles enable row level security;
alter table valet_tasks     enable row level security;
alter table reviews         enable row level security;
alter table token_ranges    enable row level security;
alter table wa_message_log  enable row level security;

-- ───────────────────────────────────────────
-- SEED — 4 PROPERTIES
-- Guarded so a re-run cannot create duplicates.
-- ───────────────────────────────────────────

insert into properties (name, address, phone)
select v.name, v.address, v.phone
from (values
  ('Ambria Exotica',     'New Delhi', '011-12345678'),
  ('Ambria Pushpanjali', 'New Delhi', '011-23456789'),
  ('Ambria Manaktala',   'New Delhi', '0120-3456789'),
  ('Ambria Restro',      'New Delhi', '011-45678901')
) as v(name, address, phone)
where not exists (
  select 1 from properties p where p.name = v.name
);
