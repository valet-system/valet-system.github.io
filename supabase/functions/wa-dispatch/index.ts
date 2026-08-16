// @ts-nocheck — Deno file. See supabase/functions/README.md for why.
/**
 * ┌─────────────────────────────────────────────────────────────────────┐
 * │ FILE: supabase/functions/wa-dispatch/index.ts                       │
 * │                                                                     │
 * │ WHAT THIS FILE IS                                                   │
 * │   The other half of the WhatsApp outbox. Postgres queues a row in    │
 * │   wa_outbox inside the same transaction as the state change that     │
 * │   earned it; this drains that queue and calls the WhatsApp Cloud     │
 * │   API. Nothing else in the system talks to Meta outbound.            │
 * │                                                                     │
 * │   Shaped after push-send, deliberately: same batch-and-mark loop,    │
 * │   same noisy logging, same "never let one bad row block the queue".  │
 * │                                                                     │
 * │ ── WHY TEMPLATE NAMES ARE ENV VARS ──────────────────────────────────│
 * │   A template message must name a template that Meta has approved,    │
 * │   exactly, with its parameters in the approved order. Get the name   │
 * │   wrong and every send fails with a 132000-series error. Those names │
 * │   live in someone's Meta Business account, they get re-submitted     │
 * │   under new names when the wording changes, and they differ between  │
 * │   the test number and the live one.                                  │
 * │                                                                     │
 * │   So they are configuration, not code. Renaming a template is a      │
 * │   secret update, not a redeploy — and this file stays truthful about │
 * │   what it does not know.                                             │
 * │                                                                     │
 * │ ── WHAT IT SENDS ────────────────────────────────────────────────────│
 * │   wa_outbox.message_type -> WA_TEMPLATE_<TYPE>                       │
 * │     car_parked     token, car number     + "Get my car" button       │
 * │     car_delivered  token                 + the three rating buttons  │
 * │     not_available  token                                             │
 * │     car_returned   token                                             │
 * │                                                                     │
 * │   The button REPLIES come back to wa-webhook. This file only sends.  │
 * │                                                                     │
 * │ SECRETS (Supabase dashboard, never the repo — it is public)          │
 * │   WA_PHONE_NUMBER_ID   the sending number's id, not the number       │
 * │   WA_ACCESS_TOKEN      permanent token for the system user           │
 * │   WA_TEMPLATE_LANG     e.g. en, en_US, hi — must match the template  │
 * │   WA_TEMPLATE_CAR_PARKED / _CAR_DELIVERED / _NOT_AVAILABLE /         │
 * │   WA_TEMPLATE_CAR_RETURNED                                           │
 * └─────────────────────────────────────────────────────────────────────┘
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { json, fail } from '../_shared/http.ts'

const GRAPH = 'https://graph.facebook.com/v21.0'

/** How many queued rows one invocation will attempt. */
const BATCH = 25

/**
 * Give up on a row after this many tries.
 *
 * Without a ceiling a permanently bad row — a guest whose number was typed
 * wrong at check-in — is retried by every sweep forever, and it sits at the
 * head of the oldest-first queue delaying everything behind it.
 */
const MAX_ATTEMPTS = 5

/** wa_outbox.message_type -> the env var naming its approved template. */
const TEMPLATE_ENV = {
  car_parked: 'WA_TEMPLATE_CAR_PARKED',
  car_delivered: 'WA_TEMPLATE_CAR_DELIVERED',
  not_available: 'WA_TEMPLATE_NOT_AVAILABLE',
  car_returned: 'WA_TEMPLATE_CAR_RETURNED',
}

/**
 * The body parameters each template expects, in order.
 *
 * Meta matches these positionally to {{1}}, {{2}} … in the approved body, so
 * the ORDER here is part of the contract with the template. If a template is
 * re-approved with its variables rearranged, this is the list to change.
 */
function templateParams(type: string, row: Record<string, unknown>) {
  const token = String(row.token_number ?? '')
  const car = String(row.car_number ?? '')

  switch (type) {
    case 'car_parked':
      return [token, car]
    case 'car_delivered':
    case 'not_available':
    case 'car_returned':
      return [token]
    default:
      return [token]
  }
}

/** E.164 without the +, which is what the Cloud API wants in `to`. */
function toE164(phone: string): string | null {
  const digits = String(phone ?? '').replace(/\D/g, '')
  if (digits.length === 10) return `91${digits}` // stored as 10 digits at check-in
  if (digits.length === 12 && digits.startsWith('91')) return digits
  if (digits.length >= 11 && digits.length <= 15) return digits
  return null
}

Deno.serve(async (req) => {
  // No CORS/preflight handling and no JWT check: nothing in the browser calls
  // this. It is driven by the database (pg_net) and by cron, both of which
  // present the service role key.
  console.log('[wa-dispatch] booted')

  const phoneNumberId = Deno.env.get('WA_PHONE_NUMBER_ID') ?? ''
  const accessToken = Deno.env.get('WA_ACCESS_TOKEN') ?? ''
  const lang = Deno.env.get('WA_TEMPLATE_LANG') ?? 'en'

  // Checked first and reported by NAME, not value. "It is not sending" with no
  // further information cost days on the push side; the fix was saying which
  // secret was missing, out loud, at the top.
  const missing = []
  if (!phoneNumberId) missing.push('WA_PHONE_NUMBER_ID')
  if (!accessToken) missing.push('WA_ACCESS_TOKEN')
  if (missing.length) {
    console.error(`[wa-dispatch] missing secrets: ${missing.join(', ')}`)
    return fail('no_config', `Missing secrets: ${missing.join(', ')}`, 500)
  }

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  )

  // The queue carries ids, not text. Everything the template needs about the
  // guest and the car is joined in here so the outbox stays a queue rather
  // than a copy of the vehicle row that can drift from it.
  const { data: queued, error } = await supabase
    .from('wa_outbox')
    .select('id, property_id, vehicle_id, task_id, message_type, attempts, parked_vehicles(token_number, car_number, guest_phone)')
    .eq('status', 'queued')
    .lt('attempts', MAX_ATTEMPTS)
    .order('created_at', { ascending: true })
    .limit(BATCH)

  if (error) {
    console.error('[wa-dispatch] could not read the outbox:', error.message)
    return fail('read_failed', error.message, 500)
  }

  console.log(`[wa-dispatch] queued rows in this batch: ${queued?.length ?? 0}`)
  if (!queued?.length) return json({ ok: true, sent: 0, note: 'queue empty' })

  let sent = 0
  let failed = 0

  for (const row of queued) {
    const vehicle = row.parked_vehicles ?? {}
    const templateName = Deno.env.get(TEMPLATE_ENV[row.message_type] ?? '') ?? ''
    const to = toE164(vehicle.guest_phone)

    // Both of these are permanent for this row — a missing template name will
    // still be missing next sweep, and a malformed number will still be
    // malformed. Fail them outright instead of burning five attempts each.
    if (!templateName) {
      const msg = `no template configured for ${row.message_type} (set ${TEMPLATE_ENV[row.message_type]})`
      console.error(`[wa-dispatch] row ${row.id}: ${msg}`)
      await supabase.from('wa_outbox')
        .update({ status: 'failed', attempts: MAX_ATTEMPTS, last_error: msg })
        .eq('id', row.id)
      failed += 1
      continue
    }
    if (!to) {
      const msg = `unusable guest phone "${vehicle.guest_phone ?? ''}"`
      console.error(`[wa-dispatch] row ${row.id}: ${msg}`)
      await supabase.from('wa_outbox')
        .update({ status: 'failed', attempts: MAX_ATTEMPTS, last_error: msg })
        .eq('id', row.id)
      failed += 1
      continue
    }

    const params = templateParams(row.message_type, vehicle)
    const body = {
      messaging_product: 'whatsapp',
      to,
      type: 'template',
      template: {
        name: templateName,
        language: { code: lang },
        components: params.length
          ? [{ type: 'body', parameters: params.map((text) => ({ type: 'text', text })) }]
          : [],
      },
    }

    try {
      const res = await fetch(`${GRAPH}/${phoneNumberId}/messages`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      })
      const text = await res.text()

      if (!res.ok) {
        // Meta's error body is the only place that says WHY, and its codes are
        // specific (132001 template not found, 131047 outside the 24h window).
        // Logged and stored verbatim — paraphrasing it here would throw away
        // the one thing that makes these diagnosable.
        console.error(`[wa-dispatch] row ${row.id} -> HTTP ${res.status}: ${text}`)
        await supabase.from('wa_outbox')
          .update({
            status: row.attempts + 1 >= MAX_ATTEMPTS ? 'failed' : 'queued',
            attempts: row.attempts + 1,
            last_error: `HTTP ${res.status}: ${text}`.slice(0, 1000),
          })
          .eq('id', row.id)
        failed += 1
        continue
      }

      const waId = JSON.parse(text)?.messages?.[0]?.id ?? null
      console.log(`[wa-dispatch] row ${row.id} sent as ${waId}`)

      await supabase.from('wa_outbox')
        .update({
          status: 'sent',
          attempts: row.attempts + 1,
          wa_message_id: waId,
          sent_at: new Date().toISOString(),
          last_error: null,
        })
        .eq('id', row.id)

      // The log is what lets wa-webhook tie an inbound reply back to a car,
      // and what stops a redelivered webhook being processed twice.
      await supabase.from('wa_message_log').insert({
        wa_message_id: waId,
        vehicle_id: row.vehicle_id,
        direction: 'outbound',
        message_type: row.message_type,
      })

      sent += 1
    } catch (err) {
      // A thrown fetch is a network fault, not a rejection by Meta — worth
      // retrying, so the row goes back to 'queued' until attempts run out.
      console.error(`[wa-dispatch] row ${row.id} threw:`, err?.message ?? err)
      await supabase.from('wa_outbox')
        .update({
          status: row.attempts + 1 >= MAX_ATTEMPTS ? 'failed' : 'queued',
          attempts: row.attempts + 1,
          last_error: String(err?.message ?? err).slice(0, 1000),
        })
        .eq('id', row.id)
      failed += 1
    }
  }

  console.log(`[wa-dispatch] done: sent ${sent}, failed ${failed}`)
  return json({ ok: true, sent, failed })
})
