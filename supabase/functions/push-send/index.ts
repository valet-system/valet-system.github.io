/**
 * ┌─────────────────────────────────────────────────────────────────────┐
 * │ FILE: supabase/functions/push-send/index.ts                         │
 * │                                                                     │
 * │ WHAT THIS IS                                                        │
 * │   The push dispatcher. Drains public.push_outbox and delivers each   │
 * │   message to every device the recipient has registered.              │
 * │                                                                     │
 * │   Deploy:  supabase functions deploy push-send                        │
 * │   Secrets: supabase secrets set VAPID_PUBLIC_KEY=… VAPID_PRIVATE_KEY=…│
 * │                                VAPID_SUBJECT=mailto:you@example.com   │
 * │                                                                     │
 * │ WHY IT IS A QUEUE DRAIN AND NOT A TRIGGER CALLING OUT                │
 * │   A Postgres trigger that makes an HTTP request holds its transaction │
 * │   open across the network. A push service having a slow minute would  │
 * │   then slow down — or roll back — an operator's tap on "Car Parked".  │
 * │   The trigger writes a row; this reads it. See migration 0014.        │
 * │                                                                     │
 * │ ══ NO THIRD-PARTY LIBRARY, AND WHY ══                                │
 * │   The usual answer is the `web-push` npm package. Web Push is two     │
 * │   RFCs and Deno ships all the primitives, so the whole thing is       │
 * │   ~120 lines of WebCrypto against a written spec:                    │
 * │                                                                     │
 * │     RFC 8292  VAPID — an ES256 JWT proving who is sending             │
 * │     RFC 8291  payload encryption — ECDH + HKDF + AES-128-GCM          │
 * │     RFC 8188  the aes128gcm content encoding the body is wrapped in   │
 * │                                                                     │
 * │   A dependency here would be one more thing to audit in a function    │
 * │   that holds the signing key.                                        │
 * │                                                                     │
 * │ ══ THE STATUS CODES THAT MATTER ══                                    │
 * │   404 / 410  the subscription is DEAD — the browser was uninstalled,  │
 * │              data cleared, or the push service rotated it. Deleted    │
 * │              immediately: retrying it forever is how an outbox fills  │
 * │              with rows that can never succeed.                       │
 * │   413        payload too large (>4096 bytes after encryption).        │
 * │   429        rate limited — left queued, tried next run.              │
 * └─────────────────────────────────────────────────────────────────────┘
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
// './webpush.ts' — the extension is REQUIRED and must be .ts.
// Deno resolves imports by exact filename, and Supabase's dashboard editor
// only creates .ts files. Naming it .js failed to bundle with
// "Module not found …/webpush.js". The file itself is plain JavaScript with no
// type annotations, which is what lets the Node test load it — see below.
//
// The crypto lives in its own file so it can be tested without Deno or a
// Supabase project — see scripts/test-webpush.mjs, `npm run test:push`.
// Web Push fails SILENTLY: a wrong HKDF info string or a missing delimiter
// byte produces a body the browser discards while the push service still
// answers 201. That test is the only thing standing between a spec mistake
// and an operator quietly never being told about a car.
import { encryptPayload, importVapidKey, vapidHeader } from './webpush.ts'

// ═══════════════════════════════════════════════════════════════════
// SEND ONE
// ═══════════════════════════════════════════════════════════════════

interface Subscription {
  id: string
  endpoint: string
  p256dh: string
  auth: string
}

async function sendOne(
  sub: Subscription,
  payload: string,
  vapidKey: CryptoKey,
  vapidPublic: string,
  vapidSubject: string,
) {
  const body = await encryptPayload(payload, sub.p256dh, sub.auth)
  const authorization = await vapidHeader(sub.endpoint, vapidKey, vapidPublic, vapidSubject)

  const res = await fetch(sub.endpoint, {
    method: 'POST',
    headers: {
      Authorization: authorization,
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      // How long the push service holds it if the device is offline. 30
      // minutes: a valet task that is half an hour stale is not worth waking
      // someone for, and a stale alert is worse than none.
      TTL: '1800',
      Urgency: 'high',
    },
    body,
  })

  return { status: res.status, text: res.ok ? '' : await res.text().catch(() => '') }
}

// ═══════════════════════════════════════════════════════════════════
// HANDLER
// ═══════════════════════════════════════════════════════════════════

Deno.serve(async (req) => {
  // FIRST LINE, before any check that can return.
  //
  // The logging added earlier sat after four early exits — the method check,
  // the VAPID presence check, and importVapidKey throwing. Any of those answered
  // 500 and wrote NOTHING, so the Logs tab showed only "booted" and "shutdown"
  // and looked as if the function had never run. A webhook never shows anyone
  // the response body, so a log that only happens on the happy path is no log
  // at all.
  console.log(`[push-send] invoked: ${req.method}`)

  if (req.method !== 'POST' && req.method !== 'GET') {
    console.warn(`[push-send] refused method ${req.method}`)
    return new Response('Method not allowed', { status: 405 })
  }

  const vapidPublic = Deno.env.get('VAPID_PUBLIC_KEY') ?? ''
  const vapidPrivate = Deno.env.get('VAPID_PRIVATE_KEY') ?? ''
  const vapidSubject = Deno.env.get('VAPID_SUBJECT') ?? 'mailto:admin@example.com'

  // The PUBLIC key is printed in full, and that is not a leak: it is compiled
  // into the frontend bundle and handed to every browser that subscribes. It is
  // printed because the failure it causes cannot be diagnosed any other way —
  // FCM answers a mismatch with `403 {"reason":"BadJwtToken"}` and says nothing
  // about which key it expected. Compare this line against .env's
  // VITE_VAPID_PUBLIC_KEY; if they differ, that is the bug.
  //
  // The PRIVATE key is a length only, always. It is the one value here that
  // must never be written anywhere.
  console.log(`[push-send] vapid public  = ${vapidPublic}`)
  console.log(
    `[push-send] vapid private len = ${vapidPrivate.length}, subject = ${vapidSubject}`,
  )

  if (!vapidPublic || !vapidPrivate) {
    console.error('[push-send] VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY are not set — stopping')
    return Response.json(
      { ok: false, error: 'VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY are not set' },
      { status: 500 },
    )
  }

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    // service_role: push_outbox has RLS on and no policies at all, so nothing
    // less can read it. This key never reaches a browser.
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    { auth: { persistSession: false } },
  )

  let vapidKey: CryptoKey
  try {
    vapidKey = await importVapidKey(vapidPublic, vapidPrivate)
  } catch (err) {
    // The likeliest cause by far: the keys are a valid pair but not in the
    // base64url form this expects — a public key that is not a 65-byte point,
    // or a private key with padding or whitespace. It threw silently before.
    console.error('[push-send] VAPID keys were rejected:', String(err))
    return Response.json({ ok: false, error: String(err) }, { status: 500 })
  }

  // Oldest first, and a bounded batch: a function that tries to drain an
  // unbounded queue times out and then retries the same head of the queue
  // forever, delivering nothing.
  const { data: queued, error } = await supabase
    .from('push_outbox')
    .select('id, user_role_id, title, body, url, tag, critical, attempts')
    .eq('status', 'queued')
    .order('created_at', { ascending: true })
    .limit(50)

  if (error) {
    console.error('[push-send] could not read the outbox:', error.message)
    return Response.json({ ok: false, error: error.message }, { status: 500 })
  }

  // Logged at every step, deliberately. Everything from here on happens on a
  // server nobody watches, and the failure mode that matters — a push the
  // service accepts and the phone never shows — leaves no trace anywhere else.
  // Without these lines the only way to find out where delivery stops is to
  // guess, and guessing cost real days on this feature.
  console.log(`[push-send] queued rows in this batch: ${queued?.length ?? 0}`)

  if (!queued?.length) return Response.json({ ok: true, sent: 0, note: 'queue empty' })

  let sent = 0
  let failed = 0
  let noDevice = 0

  for (const msg of queued) {
    const { data: subs } = await supabase
      .from('push_subscriptions')
      .select('id, endpoint, p256dh, auth')
      .eq('user_role_id', msg.user_role_id)

    console.log(
      `[push-send] msg ${msg.id} for role ${msg.user_role_id}: ${subs?.length ?? 0} device(s)`,
    )

    if (!subs?.length) {
      // Not a failure. They have simply never granted permission or have no
      // device registered — recorded distinctly so "nobody subscribed" is not
      // mistaken for "delivery is broken".
      await supabase
        .from('push_outbox')
        .update({ status: 'no_device', attempts: msg.attempts + 1, sent_at: new Date().toISOString() })
        .eq('id', msg.id)
      noDevice += 1
      continue
    }

    const payload = JSON.stringify({
      title: msg.title,
      body: msg.body,
      url: msg.url ?? '/',
      tag: msg.tag ?? 'valet',
      critical: Boolean(msg.critical),
    })

    let anyDelivered = false
    const errors: string[] = []

    for (const sub of subs as Subscription[]) {
      try {
        const { status, text } = await sendOne(sub, payload, vapidKey, vapidPublic, vapidSubject)

        // The endpoint's host is the useful part — it says WHICH push service
        // answered (fcm.googleapis.com for Chrome/Android, web.push.apple.com
        // for iOS) and platforms fail differently. The rest of the endpoint is
        // a device secret and is deliberately not logged.
        const host = (() => {
          try {
            return new URL(sub.endpoint).host
          } catch {
            return 'unparseable endpoint'
          }
        })()
        console.log(`[push-send]   -> ${host} answered ${status}${text ? ` ${text.slice(0, 120)}` : ''}`)

        if (status >= 200 && status < 300) {
          anyDelivered = true
          continue
        }

        if (status === 404 || status === 410) {
          // Dead for good. Delete rather than counting failures, or the outbox
          // accumulates rows that can never succeed.
          await supabase.from('push_subscriptions').delete().eq('id', sub.id)
          errors.push(`${status} gone (subscription removed)`)
          continue
        }

        errors.push(`${status} ${text}`.trim())
      } catch (err) {
        errors.push(String(err))
      }
    }

    // Delivered to at least ONE device is success. An operator with a phone
    // and a spare tablet does not need both to succeed.
    if (anyDelivered) {
      await supabase
        .from('push_outbox')
        .update({ status: 'sent', attempts: msg.attempts + 1, sent_at: new Date().toISOString() })
        .eq('id', msg.id)
      sent += 1
    } else {
      await supabase
        .from('push_outbox')
        .update({
          status: 'failed',
          attempts: msg.attempts + 1,
          last_error: errors.join(' | ').slice(0, 500),
        })
        .eq('id', msg.id)
      failed += 1
    }
  }

  // A 2xx from the push service means it ACCEPTED the message, not that the
  // phone showed it. Said plainly here so "sent: 1" in the logs is not read as
  // proof the operator was told.
  console.log(
    `[push-send] done. accepted=${sent} failed=${failed} no_device=${noDevice} batch=${queued.length}`,
  )

  return Response.json({ ok: true, sent, failed, no_device: noDevice, batch: queued.length })
})
