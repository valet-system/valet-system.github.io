-- ═══════════════════════════════════════════════════════════════════════
-- MIGRATION 0033 — what a guest can do from inside WhatsApp
--
-- WHAT THIS ADDS
--   guest_request_retrieval(phone)   "Get my car" was tapped
--   guest_record_review(phone, rating) a rating button was tapped
--
-- WHY NEW FUNCTIONS INSTEAD OF THE EXISTING ONES
--   request_retrieval(vehicle_id) reads auth.uid() and is granted only to
--   `authenticated`. A guest in WhatsApp has no Supabase session and no idea
--   what a vehicle_id is — all we ever learn about them is the phone number
--   the message came from. So the lookup has to go the other way: phone to
--   car, not caller to permission.
--
-- ── WHY THESE RETURN A CODE INSTEAD OF RAISING ────────────────────────
--   Every other RPC in this system raises on a bad state, because a
--   logged-in operator gets the message rendered on their screen. These are
--   called by wa-webhook, which has to answer the guest in WhatsApp — and
--   "no car found" is not an error, it is one of the normal answers. Making
--   the caller catch an exception and match on the text of its message to
--   decide what to reply is exactly the kind of thing that breaks the first
--   time an error string is reworded. So the outcome is data:
--
--     { ok: true,  code: 'requested',  token_number, vehicle_id, task_id }
--     { ok: false, code: 'no_car' | 'already_requested' | 'not_parked' | ... }
--
--   The webhook maps code -> reply text. Unknown code, generic reply.
--
-- ── PHONE MATCHING ────────────────────────────────────────────────────
--   WhatsApp delivers the sender as E.164 digits — 919812345678. Check-in
--   stores what the operator typed, which the form holds to 10 digits. So
--   both sides are reduced to digits and compared on the LAST TEN. Comparing
--   the whole string would never match, and comparing a shorter tail would
--   eventually collide between two real guests.
--
-- SECURITY
--   service_role only. These take a phone number and act on the car it
--   belongs to with no further proof, which is safe from an Edge Function
--   holding a verified webhook payload from Meta, and is not safe from
--   anywhere else. Never grant these to anon or authenticated: that would
--   let anybody request any car by typing a phone number.
-- ═══════════════════════════════════════════════════════════════════════

begin;

-- One review per task. Without this a guest tapping the rating button twice —
-- or Meta redelivering the webhook, which it does — writes two rows and the
-- averages drift. wa_message_log dedupes the message, this dedupes the effect.
create unique index if not exists reviews_task_uniq
  on public.reviews(task_id)
  where task_id is not null;


-- Digits only, last ten. Used by both functions and by the webhook's lookups,
-- so the rule lives in one place rather than being re-typed per query.
create or replace function public.phone_tail(p_phone text)
returns text
language sql
immutable
set search_path = public, pg_temp
as $fn$
  select right(regexp_replace(coalesce(p_phone, ''), '\D', '', 'g'), 10)
$fn$;


-- ═══════════════════════════════════════════════════════════════════════
-- "Get my car"
-- ═══════════════════════════════════════════════════════════════════════

create or replace function public.guest_request_retrieval(p_phone text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_tail    text := public.phone_tail(p_phone);
  v_vehicle public.parked_vehicles;
  v_task_id uuid;
begin
  if length(v_tail) < 10 then
    return jsonb_build_object('ok', false, 'code', 'bad_phone');
  end if;

  -- The most recent car for this number that is actually sitting parked.
  --
  -- 'returned' counts as parked: it means a no-show was re-parked, and that
  -- guest is exactly the one who is likely to ask again.
  --
  -- The 24h floor matters. Without it a guest who visited last month and
  -- whose car was never marked delivered would re-request that stale row, and
  -- an operator would be dispatched to a car that is not there.
  select * into v_vehicle
  from public.parked_vehicles v
  where public.phone_tail(v.guest_phone) = v_tail
    and v.status in ('parked', 'returned')
    and v.parked_at > now() - interval '24 hours'
  order by v.parked_at desc
  limit 1
  for update;

  if v_vehicle.id is null then
    return jsonb_build_object('ok', false, 'code', 'no_car');
  end if;

  begin
    insert into public.valet_tasks (property_id, vehicle_id, task_type, status)
    values (v_vehicle.property_id, v_vehicle.id, 'retrieval', 'pending')
    returning id into v_task_id;
  exception when unique_violation then
    -- The partial unique index on open retrievals. They tapped twice, or Meta
    -- redelivered — either way their car is already coming.
    return jsonb_build_object(
      'ok', false,
      'code', 'already_requested',
      'token_number', v_vehicle.token_number
    );
  end;

  update public.parked_vehicles
     set status = 'requested'
   where id = v_vehicle.id;

  -- No wa_outbox row here on purpose: the guest is standing in WhatsApp and
  -- gets their answer from the webhook's own reply. The admins get told by the
  -- existing push trigger on valet_tasks, which fires on this insert.
  return jsonb_build_object(
    'ok',           true,
    'code',         'requested',
    'task_id',      v_task_id,
    'vehicle_id',   v_vehicle.id,
    'property_id',  v_vehicle.property_id,
    'token_number', v_vehicle.token_number
  );
end $fn$;

revoke execute on function public.guest_request_retrieval(text) from public, anon, authenticated;


-- ═══════════════════════════════════════════════════════════════════════
-- A rating button
-- ═══════════════════════════════════════════════════════════════════════

create or replace function public.guest_record_review(p_phone text, p_rating text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_tail text := public.phone_tail(p_phone);
  v_task record;
begin
  if p_rating not in ('excellent', 'good', 'poor') then
    return jsonb_build_object('ok', false, 'code', 'bad_rating');
  end if;

  if length(v_tail) < 10 then
    return jsonb_build_object('ok', false, 'code', 'bad_phone');
  end if;

  -- The car they just collected. Bounded to a day: a rating that arrives a
  -- week later is about a visit nobody remembers, and attaching it to their
  -- newest completed job would credit the wrong shift.
  select t.id, t.property_id
    into v_task
  from public.valet_tasks t
  join public.parked_vehicles v on v.id = t.vehicle_id
  where t.task_type = 'retrieval'
    and t.status    = 'completed'
    and t.completed_at > now() - interval '24 hours'
    and public.phone_tail(v.guest_phone) = v_tail
  order by t.completed_at desc
  limit 1;

  if v_task.id is null then
    return jsonb_build_object('ok', false, 'code', 'no_recent_visit');
  end if;

  insert into public.reviews (task_id, property_id, guest_phone, rating)
  values (v_task.id, v_task.property_id, v_tail, p_rating)
  on conflict (task_id) where task_id is not null do nothing;

  -- Reported distinctly from a fresh insert so the webhook can say "thanks,
  -- already noted" rather than pretending it recorded a second opinion.
  if not found then
    return jsonb_build_object('ok', true, 'code', 'already_rated');
  end if;

  return jsonb_build_object('ok', true, 'code', 'rated', 'task_id', v_task.id);
end $fn$;

revoke execute on function public.guest_record_review(text, text) from public, anon, authenticated;

commit;
