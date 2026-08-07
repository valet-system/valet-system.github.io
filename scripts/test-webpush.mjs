/**
 * ┌─────────────────────────────────────────────────────────────────────┐
 * │ FILE: scripts/test-webpush.mjs          run with `npm run test:push`  │
 * │                                                                     │
 * │ WHAT THIS PROVES                                                    │
 * │   That supabase/functions/push-send/webpush.js implements the specs   │
 * │   correctly, by playing the BROWSER's side of the protocol:           │
 * │                                                                     │
 * │     1. mint a subscription keypair + auth secret, exactly as a        │
 * │        browser does in PushManager.subscribe()                       │
 * │     2. encrypt a payload with our sender code                         │
 * │     3. DECRYPT it the way the browser would, from the wire bytes      │
 * │     4. check the plaintext survived                                   │
 * │                                                                     │
 * │   Plus: sign a VAPID JWT and verify the signature against the public  │
 * │   key, and check `aud` is the endpoint ORIGIN and not the full URL.    │
 * │                                                                     │
 * │ WHY IT IS WORTH HAVING                                              │
 * │   Web Push fails SILENTLY. A wrong HKDF info string, a missing 0x02   │
 * │   delimiter or a mis-laid-out header all produce a body the browser   │
 * │   throws away — while the push service still answers 201 Created. The │
 * │   sender looks perfectly healthy and no notification ever appears.    │
 * │   Without this, the first sign of a bug is an operator missing a car. │
 * │                                                                     │
 * │   It needs no network, no VAPID secrets and no Supabase project.      │
 * └─────────────────────────────────────────────────────────────────────┘
 */

import { webcrypto } from 'node:crypto'

// Node exposes WebCrypto as `crypto.webcrypto`; the module under test uses the
// same global name Deno and browsers do.
if (!globalThis.crypto) globalThis.crypto = webcrypto

// The module under test is TypeScript, so this runs under
// --experimental-strip-types — see the test:push script. Importing it directly
// (rather than copying it somewhere) is what guarantees the tested bytes are
// the deployed bytes.
import {
  b64urlToBytes,
  bytesToB64url,
  concat,
  encryptPayload,
  hkdf,
  importVapidKey,
  vapidHeader,
} from '../supabase/functions/push-send/webpush.ts'

const utf8 = (s) => new TextEncoder().encode(s)
let failures = 0

function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`)
  if (!ok) failures += 1
}

// ═══════════════════════════════════════════════════════════════════
// 1. PAYLOAD ROUND TRIP
// ═══════════════════════════════════════════════════════════════════

async function testPayloadRoundTrip() {
  // ── act as the browser: mint a subscription ────────────────────────
  const uaKeys = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, [
    'deriveBits',
  ])
  const uaPublicRaw = new Uint8Array(await crypto.subtle.exportKey('raw', uaKeys.publicKey))
  const authSecret = crypto.getRandomValues(new Uint8Array(16))

  const plaintext = JSON.stringify({
    title: 'Fetch a car',
    body: 'Token 47 · DL8CAF1234 · L2 Bay B4',
    url: '/operator/tasks',
    tag: 'valet-task-abc',
    critical: true,
  })

  const body = await encryptPayload(plaintext, bytesToB64url(uaPublicRaw), bytesToB64url(authSecret))

  // ── header layout, per RFC 8188 ────────────────────────────────────
  const salt = body.slice(0, 16)
  const recordSize = new DataView(body.buffer, body.byteOffset + 16, 4).getUint32(0, false)
  const keyIdLen = body[20]
  const asPublic = body.slice(21, 21 + keyIdLen)
  const ciphertext = body.slice(21 + keyIdLen)

  check('header: salt is 16 bytes', salt.length === 16)
  check('header: record size is 4096', recordSize === 4096, String(recordSize))
  check('header: keyid length is 65', keyIdLen === 65, String(keyIdLen))
  check('header: sender key is an uncompressed point', asPublic[0] === 0x04)
  // utf8(...).length, NOT plaintext.length. A JS string length counts UTF-16
  // code units; the wire carries UTF-8 bytes. This payload contains two '·'
  // (U+00B7), which are two bytes each — so the naive assertion is off by two
  // and would have been "fixed" by loosening it. Body text is Hindi/English in
  // production, so this gap is the normal case, not an edge case.
  const plaintextBytes = utf8(plaintext).length
  check(
    'ciphertext is plaintext + delimiter + GCM tag',
    ciphertext.length === plaintextBytes + 1 + 16,
    `${ciphertext.length} vs expected ${plaintextBytes + 17}`,
  )

  // ── now decrypt as the browser would ───────────────────────────────
  const asKey = await crypto.subtle.importKey(
    'raw',
    asPublic,
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    [],
  )
  const ecdhSecret = new Uint8Array(
    await crypto.subtle.deriveBits({ name: 'ECDH', public: asKey }, uaKeys.privateKey, 256),
  )

  const ikm = await hkdf(
    authSecret,
    ecdhSecret,
    concat(utf8('WebPush: info\0'), uaPublicRaw, asPublic),
    32,
  )
  const cek = await hkdf(salt, ikm, utf8('Content-Encoding: aes128gcm\0'), 16)
  const nonce = await hkdf(salt, ikm, utf8('Content-Encoding: nonce\0'), 12)

  const aesKey = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['decrypt'])

  let decrypted
  try {
    decrypted = new Uint8Array(
      await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce, tagLength: 128 }, aesKey, ciphertext),
    )
  } catch (err) {
    check('browser can decrypt the payload', false, String(err))
    return
  }

  check('browser can decrypt the payload', true)
  check('last byte is the 0x02 record delimiter', decrypted[decrypted.length - 1] === 0x02)

  const recovered = new TextDecoder().decode(decrypted.slice(0, -1))
  check('plaintext survives the round trip', recovered === plaintext)
  check(
    'recovered JSON has the fields sw.js reads',
    (() => {
      try {
        const o = JSON.parse(recovered)
        return Boolean(o.title && o.body && o.url && o.tag)
      } catch {
        return false
      }
    })(),
  )

  // ── a different subscription must NOT be able to read it ───────────
  const otherKeys = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, [
    'deriveBits',
  ])
  const otherSecret = new Uint8Array(
    await crypto.subtle.deriveBits({ name: 'ECDH', public: asKey }, otherKeys.privateKey, 256),
  )
  const otherIkm = await hkdf(
    authSecret,
    otherSecret,
    concat(utf8('WebPush: info\0'), uaPublicRaw, asPublic),
    32,
  )
  const otherCek = await hkdf(salt, otherIkm, utf8('Content-Encoding: aes128gcm\0'), 16)
  const otherAes = await crypto.subtle.importKey('raw', otherCek, 'AES-GCM', false, ['decrypt'])

  let leaked = false
  try {
    await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce, tagLength: 128 }, otherAes, ciphertext)
    leaked = true
  } catch {
    /* expected */
  }
  check('another device cannot decrypt it', !leaked)
}

// ═══════════════════════════════════════════════════════════════════
// 2. VAPID
// ═══════════════════════════════════════════════════════════════════

async function testVapid() {
  // A throwaway keypair in the same shape scripts/… generates for real.
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ])
  const rawPub = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey))
  const jwk = await crypto.subtle.exportKey('jwk', pair.privateKey)

  const publicB64 = bytesToB64url(rawPub)

  let signingKey
  try {
    signingKey = await importVapidKey(publicB64, jwk.d)
    check('VAPID key imports from (public point, private scalar)', true)
  } catch (err) {
    check('VAPID key imports from (public point, private scalar)', false, String(err))
    return
  }

  const endpoint = 'https://fcm.googleapis.com/fcm/send/abc123?token=xyz'
  const header = await vapidHeader(endpoint, signingKey, publicB64, 'mailto:ops@example.com')

  check('header starts with the vapid scheme', header.startsWith('vapid t='))
  check('header carries the public key as k=', header.includes(`, k=${publicB64}`))

  const jwt = header.slice('vapid t='.length, header.indexOf(', k='))
  const [h, p, s] = jwt.split('.')

  const claims = JSON.parse(new TextDecoder().decode(b64urlToBytes(p)))
  check(
    'aud is the ORIGIN, not the full endpoint URL',
    claims.aud === 'https://fcm.googleapis.com',
    claims.aud,
  )
  check('sub is set', typeof claims.sub === 'string' && claims.sub.length > 0)
  check(
    'exp is in the future and within the 24h the spec allows',
    claims.exp > Math.floor(Date.now() / 1000) &&
      claims.exp <= Math.floor(Date.now() / 1000) + 24 * 60 * 60,
  )

  const alg = JSON.parse(new TextDecoder().decode(b64urlToBytes(h)))
  check('alg is ES256', alg.alg === 'ES256')

  const sig = b64urlToBytes(s)
  check('signature is raw r||s (64 bytes), not DER', sig.length === 64, `${sig.length} bytes`)

  const valid = await crypto.subtle.verify(
    { name: 'ECDSA', hash: 'SHA-256' },
    pair.publicKey,
    sig,
    utf8(`${h}.${p}`),
  )
  check('signature verifies against the public key', valid)
}

// ═══════════════════════════════════════════════════════════════════
// 3. INPUT GUARDS
// ═══════════════════════════════════════════════════════════════════

async function testGuards() {
  const good = bytesToB64url(
    new Uint8Array(
      await crypto.subtle.exportKey(
        'raw',
        (await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']))
          .publicKey,
      ),
    ),
  )
  const auth = bytesToB64url(crypto.getRandomValues(new Uint8Array(16)))

  const rejects = async (label, fn) => {
    try {
      await fn()
      check(label, false, 'accepted bad input')
    } catch {
      check(label, true)
    }
  }

  await rejects('rejects a truncated p256dh', () =>
    encryptPayload('x', bytesToB64url(new Uint8Array(32)), auth),
  )
  await rejects('rejects a wrong-length auth secret', () =>
    encryptPayload('x', good, bytesToB64url(new Uint8Array(8))),
  )
  await rejects('rejects a VAPID public key that is not a 65-byte point', () =>
    importVapidKey(bytesToB64url(new Uint8Array(33)), 'AAAA'),
  )
}

console.log('── payload encryption (RFC 8291 / 8188) ──')
await testPayloadRoundTrip()
console.log('\n── VAPID (RFC 8292) ──')
await testVapid()
console.log('\n── input guards ──')
await testGuards()

console.log(failures === 0 ? '\nOK — all web push checks passed.' : `\n${failures} FAILURE(S).`)
process.exit(failures === 0 ? 0 : 1)
