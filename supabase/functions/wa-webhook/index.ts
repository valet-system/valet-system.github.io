// @ts-nocheck — Deno file. See supabase/functions/README.md for why.
/**
 * ┌─────────────────────────────────────────────────────────────────────┐
 * │ FILE: supabase/functions/wa-webhook/index.ts                        │
 * │                                                                     │
 * │ WHAT THIS FILE IS                                                   │
 * │   Where the guest's tap lands. Meta POSTs here when someone presses  │
 * │   a button on one of our template messages:                          │
 * │                                                                     │
 * │     "Get my car"                -> guest_request_retrieval(phone)    │
 * │     Excellent / Good / Poor     -> guest_record_review(phone, r)     │
 * │                                                                     │
 * │   and it answers the guest in the same chat with the outcome.        │
 * │                                                                     │
 * │ ── WHY THE SIGNATURE CHECK IS NOT OPTIONAL ──────────────────────────│
 * │   The only thing this endpoint learns about a guest is the phone     │
 * │   number the payload claims the message came from, and it acts on    │
 * │   that with no further proof — it will dispatch an operator to a     │
 * │   real car. The URL is public. So if anyone could POST here, anyone  │
 * │   could summon any car by guessing a phone number.                   │
 * │                                                                     │
 * │   X-Hub-Signature-256 is what makes the payload trustworthy: an      │
 * │   HMAC of the exact request body under the app secret, which only    │
 * │   Meta and we know. Unsigned or mis-signed requests are dropped      │
 * │   BEFORE anything is read out of them.                               │
 * │                                                                     │
 * │ ── DEPLOY IT WITH --no-verify-jwt ───────────────────────────────────│
 * │   Edge Functions require a Supabase JWT by default. Meta does not    │
 * │   send one and cannot be made to. Without the flag every webhook is  │
 * │   rejected with 401 before this file runs, and Meta quietly disables │
 * │   the subscription after repeated failures:                          │
 * │                                                                     │
 * │     supabase functions deploy wa-webhook --no-verify-jwt             │
 * │                                                                     │
 * │   The signature check above is what replaces the JWT, which is why   │
 * │   dropping it would leave this endpoint genuinely open.              │
 * │                                                                     │
 * │ SECRETS                                                             │
 * │   WA_VERIFY_TOKEN   any string; must match what is typed into Meta   │
 * │   WA_APP_SECRET     the app secret, for the signature                │
 * │   WA_PHONE_NUMBER_ID / WA_ACCESS_TOKEN   to reply to the guest       │
 * │   WA_TEMPLATE_REQUEST_RECEIVED   the acknowledgement template, if    │
 * │                                  set; free text is used without it   │
 * │   WA_BTN_*          button texts, if they are not the defaults       │
 * └─────────────────────────────────────────────────────────────────────┘
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const GRAPH = 'https://graph.facebook.com/v21.0'

/**
 * Constant-time comparison.
 *
 * A plain === on a signature leaks, through how long it takes to fail, how
 * many leading characters were right — which is enough to reconstruct a valid
 * signature one character at a time.
 */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

async function signatureOk(raw: string, header: string | null, secret: string): Promise<boolean> {
  if (!header?.startsWith('sha256=')) return false
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(raw))
  const hex = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, '0')).join('')
  return safeEqual(`sha256=${hex}`, header)
}

/**
 * Which button was pressed.
 *
 * The text comes from the approved template, so it is configuration — the
 * env vars let it be corrected without a redeploy. The fallbacks are keyword
 * matches rather than exact strings, because the first version of a template
 * is rarely the last and "Get my car" becoming "Get my car 🚗" should not
 * silently stop working.
 */
function classify(label: string): string | null {
  const s = (label ?? '').trim().toLowerCase()
  if (!s) return null

  const env = (name: string) => (Deno.env.get(name) ?? '').trim().toLowerCase()
  const is = (name: string, ...words: string[]) => {
    const configured = env(name)
    if (configured) return s === configured
    return words.some((w) => s.includes(w))
  }

  if (is('WA_BTN_GET_CAR', 'get my car', 'my car', 'gaadi', 'car')) return 'get_car'
  if (is('WA_BTN_RATE_EXCELLENT', 'excellent', 'great')) return 'excellent'
  if (is('WA_BTN_RATE_GOOD', 'good', 'ok')) return 'good'
  if (is('WA_BTN_RATE_POOR', 'poor', 'bad')) return 'poor'
  return null
}

/**
 * The message body sent back to the guest, as a Graph API payload.
 *
 * ── TEMPLATE FOR THE ACKNOWLEDGEMENT, TEXT FOR THE REST ───────────────
 * "We have your request, 15 minutes" goes out as an approved TEMPLATE, on
 * request. Both forms are legal here — the guest tapped a button seconds ago,
 * which opens WhatsApp's 24-hour service window, and inside it free text is
 * allowed and a template is allowed. The difference is cost: free text in the
 * window is included, a template is billed. So this is a fifth billed message
 * per retrieval, and rewording it later needs another Meta review.
 *
 * The other outcomes stay free text deliberately. "We could not find a parked
 * car", "thanks for the feedback" — those are the rare paths, and putting four
 * more templates through review for messages almost nobody sees would cost more
 * review than it is worth.
 *
 * ── AND WHY THE TEXT PATH IS STILL HERE ───────────────────────────────
 * If WA_TEMPLATE_REQUEST_RECEIVED is not set — the template is still in review,
 * or somebody has not added the secret yet — this falls back to the free-text
 * sentence rather than sending nothing. A guest who taps and hears nothing
 * assumes the tap failed and taps again; a plain sentence is worth far more than
 * consistency here.
 */
function payloadFor(to: string, code: string, data: Record<string, unknown>) {
  const templateName = Deno.env.get('WA_TEMPLATE_REQUEST_RECEIVED') ?? ''
  const lang = Deno.env.get('WA_TEMPLATE_LANG') ?? 'en'
  const slip = data?.token_number ? String(data.token_number) : ''

  // Only the two "your car is coming" outcomes have a template. Anything else
  // is an edge case and goes as text.
  const templated = code === 'requested' || code === 'already_requested'

  if (templateName && templated && slip) {
    return {
      messaging_product: 'whatsapp',
      to,
      type: 'template',
      template: {
        name: templateName,
        language: { code: lang },
        components: [{ type: 'body', parameters: [{ type: 'text', text: slip }] }],
      },
    }
  }

  return {
    messaging_product: 'whatsapp',
    to,
    type: 'text',
    text: { body: replyFor(code, data) },
  }
}

/**
 * What the guest reads back, per outcome code from the RPCs.
 *
 * ── THESE ARE NOT TEMPLATES ───────────────────────────────────────────
 * The guest just tapped a button, which counts as them messaging us and opens
 * WhatsApp's 24-hour customer service window. Inside that window free text is
 * allowed, so none of this needs Meta's approval and any of it can be reworded
 * without a review queue. Only the four business-initiated messages in
 * wa-dispatch are templates.
 *
 * ── WHY THE REPLY NAMES A TIME ────────────────────────────────────────
 * "Our valet is on the way" told the guest nothing they could act on, so they
 * stand at the door watching the ramp. A number sets the expectation: they can
 * finish their coffee, and they know when to start worrying.
 *
 * 15 minutes is the promise the business makes, not a measurement — it is
 * deliberately looser than the 10-minute hand-over window the operator sees, so
 * a guest who arrives at minute 12 is early rather than kept waiting.
 *
 * "parking slip", not "token": the word token reads as a passcode to Meta's
 * classifier, which is what pushed the templates towards Authentication. The
 * free-text replies are not classified the same way, but using one vocabulary
 * with the guest across all of it is worth more than the two saved words.
 */
function replyFor(code: string, data: Record<string, unknown>): string {
  const slip = data?.token_number ? ` Parking slip ${data.token_number}.` : ''
  switch (code) {
    case 'requested':
      return `We have your request.${slip} Your car will be at the gate within 15 minutes.`
    case 'already_requested':
      return `Your car is already on its way.${slip} It will be at the gate within 15 minutes.`
    case 'no_car':
      return 'We could not find a parked car for this number. Please show your parking slip at the valet desk.'
    case 'rated':
      return 'Thank you for the feedback.'
    case 'already_rated':
      return 'Thanks — we already have your feedback for this visit.'
    case 'no_recent_visit':
      return 'Thanks for writing in. We could not find a recent visit for this number.'
    default:
      return 'Sorry, something went wrong. Please speak to the valet desk.'
  }
}

Deno.serve(async (req) => {
  const url = new URL(req.url)

  // ── Meta's subscription handshake ────────────────────────────────────
  // Sent once, when the webhook URL is saved in the Meta dashboard. It must
  // echo hub.challenge back as PLAIN TEXT — JSON here fails verification with
  // no explanation of why.
  if (req.method === 'GET') {
    const mode = url.searchParams.get('hub.mode')
    const token = url.searchParams.get('hub.verify_token')
    const challenge = url.searchParams.get('hub.challenge') ?? ''
    const expected = Deno.env.get('WA_VERIFY_TOKEN') ?? ''

    if (mode === 'subscribe' && expected && token === expected) {
      console.log('[wa-webhook] verification handshake accepted')
      return new Response(challenge, { status: 200, headers: { 'Content-Type': 'text/plain' } })
    }
    console.error('[wa-webhook] verification REJECTED — WA_VERIFY_TOKEN does not match')
    return new Response('forbidden', { status: 403 })
  }

  if (req.method !== 'POST') return new Response('method not allowed', { status: 405 })

  // Read the body ONCE, as text. The signature is over these exact bytes, so
  // re-serialising parsed JSON to check it would compare a different string
  // and never match.
  const raw = await req.text()

  const appSecret = Deno.env.get('WA_APP_SECRET') ?? ''
  if (!appSecret) {
    // Refuse rather than degrade. Processing unsigned webhooks would leave a
    // public endpoint that dispatches operators to real cars on request.
    console.error('[wa-webhook] WA_APP_SECRET is not set — refusing to process')
    return new Response('not configured', { status: 500 })
  }
  if (!(await signatureOk(raw, req.headers.get('x-hub-signature-256'), appSecret))) {
    console.error('[wa-webhook] bad signature — dropped')
    return new Response('bad signature', { status: 401 })
  }

  let payload: any = {}
  try {
    payload = JSON.parse(raw)
  } catch {
    // Answer 200 anyway: a non-200 makes Meta retry the same unparseable body
    // on a schedule, forever.
    console.error('[wa-webhook] unparseable body')
    return new Response('ok', { status: 200 })
  }

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  )

  const messages = payload?.entry?.[0]?.changes?.[0]?.value?.messages ?? []
  if (!messages.length) {
    // Delivery receipts and read receipts arrive on the same webhook. Not an
    // error, just not ours.
    return new Response('ok', { status: 200 })
  }

  for (const msg of messages) {
    const from = msg.from
    const waId = msg.id

    // Meta redelivers on any non-200, including one caused by something
    // unrelated later in this loop. The log has a unique index on
    // wa_message_id, so the insert is the lock: if it conflicts, this exact
    // message has already been acted on.
    const { error: dupe } = await supabase
      .from('wa_message_log')
      .insert({ wa_message_id: waId, direction: 'inbound', message_type: msg.type ?? 'unknown' })
    if (dupe) {
      console.log(`[wa-webhook] ${waId} already handled — skipping`)
      continue
    }

    // Quick-reply buttons on a TEMPLATE arrive as type 'button'; buttons on an
    // interactive message arrive as 'interactive'. Our templates use the
    // former, but both are read so a template rebuilt the other way still works.
    const label =
      msg.button?.text ??
      msg.button?.payload ??
      msg.interactive?.button_reply?.title ??
      msg.interactive?.button_reply?.id ??
      msg.text?.body ??
      ''

    const action = classify(label)
    console.log(`[wa-webhook] ${waId} from ${from}: "${label}" -> ${action ?? 'ignored'}`)
    if (!action) continue

    let code = 'error'
    let data: Record<string, unknown> = {}
    try {
      const rpc =
        action === 'get_car'
          ? await supabase.rpc('guest_request_retrieval', { p_phone: from })
          : await supabase.rpc('guest_record_review', { p_phone: from, p_rating: action })

      if (rpc.error) {
        console.error(`[wa-webhook] rpc failed for ${waId}:`, rpc.error.message)
      } else {
        data = rpc.data ?? {}
        code = String(data.code ?? 'error')
      }
    } catch (err) {
      console.error(`[wa-webhook] rpc threw for ${waId}:`, err?.message ?? err)
    }

    // Reply in the same chat. A template for the acknowledgement, free text for
    // everything else — see payloadFor. Both are legal because the guest
    // messaged us seconds ago, which opens the 24-hour service window.
    const phoneNumberId = Deno.env.get('WA_PHONE_NUMBER_ID') ?? ''
    const accessToken = Deno.env.get('WA_ACCESS_TOKEN') ?? ''
    if (phoneNumberId && accessToken) {
      try {
        const res = await fetch(`${GRAPH}/${phoneNumberId}/messages`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(payloadFor(from, code, data)),
        })
        if (!res.ok) console.error(`[wa-webhook] reply failed: ${res.status} ${await res.text()}`)
      } catch (err) {
        console.error('[wa-webhook] reply threw:', err?.message ?? err)
      }
    } else {
      console.error('[wa-webhook] cannot reply — WA_PHONE_NUMBER_ID / WA_ACCESS_TOKEN not set')
    }
  }

  // Always 200 once the signature has passed. A failure inside our own logic
  // is ours to find in the logs; making Meta retry it changes nothing and
  // eventually gets the subscription disabled.
  return new Response('ok', { status: 200 })
})
