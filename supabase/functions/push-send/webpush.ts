/**
 * ┌─────────────────────────────────────────────────────────────────────┐
 * │ FILE: supabase/functions/push-send/webpush.ts                       │
 * │                                                                     │
 * │ WHAT THIS IS                                                        │
 * │   The Web Push cryptography, on its own, with no Deno or Supabase    │
 * │   dependency: plain WebCrypto, which Deno and Node both provide.     │
 * │                                                                     │
 * │     RFC 8292  VAPID — an ES256 JWT proving who is sending            │
 * │     RFC 8291  payload encryption — ECDH + HKDF + AES-128-GCM         │
 * │     RFC 8188  the aes128gcm content encoding wrapping the body       │
 * │                                                                     │
 * │ WHY THE .ts EXTENSION, AND WHY THE TEST NEEDS A FLAG                 │
 * │   Deno resolves imports by exact filename, and Supabase's dashboard  │
 * │   editor only creates .ts files — so naming this .js fails to bundle │
 * │   with "Module not found …/webpush.js".                              │
 * │                                                                     │
 * │   Being .ts means the parameters need REAL annotations. JSDoc types   │
 * │   do not work here: TypeScript only reads those in .js files, so a    │
 * │   JSDoc-typed .ts file still reports every parameter as an implicit   │
 * │   `any` — seventeen red marks on a file that is not broken, which is  │
 * │   how a genuine error later goes unnoticed. `@ts-nocheck` was tried   │
 * │   and was not honoured either.                                        │
 * │                                                                     │
 * │   So the test runs Node with --experimental-strip-types (see the      │
 * │   test:push script). Keep the syntax ERASABLE — plain annotations     │
 * │   only. An enum, a namespace or a constructor parameter property      │
 * │   cannot be stripped and would break the test.                       │
 * │                                                                     │
 * │ WHY IT IS A SEPARATE FILE                                           │
 * │   So it can be TESTED. This is code that fails silently: a wrong     │
 * │   info string or a missing delimiter byte produces a body the        │
 * │   browser discards without telling anybody, and the push service     │
 * │   still answers 201. Shipping it unverified means finding out from   │
 * │   an operator who missed a car.                                     │
 * │                                                                     │
 * │   scripts/test-webpush.mjs encrypts, then decrypts from the          │
 * │   browser's side of the protocol and checks the plaintext matches.   │
 * │   `npm run test:push`                                               │
 * │                                                                     │
 * │ WHY NO `web-push` LIBRARY                                            │
 * │   Deno ships every primitive, so this is ~120 lines against a        │
 * │   written spec. A dependency in the one function that holds the      │
 * │   signing key is a dependency worth avoiding.                        │
 * └─────────────────────────────────────────────────────────────────────┘
 */

// ═══════════════════════════════════════════════════════════════════
// BASE64URL — used by every layer, in both directions
// ═══════════════════════════════════════════════════════════════════

export function b64urlToBytes(input: string): Uint8Array {
  const padded = String(input).replace(/-/g, '+').replace(/_/g, '/')
  const withPad = padded + '='.repeat((4 - (padded.length % 4)) % 4)
  const raw = atob(withPad)
  const out = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i)
  return out
}

export function bytesToB64url(bytes: Uint8Array): string {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0)
  const out = new Uint8Array(total)
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s)

// ═══════════════════════════════════════════════════════════════════
// VAPID — RFC 8292
// ═══════════════════════════════════════════════════════════════════

/**
 * Turns the stored keypair into a signing key.
 *
 * Only the private scalar `d` had to be stored separately: x and y are simply
 * the two halves of the uncompressed public point, so the JWK is reassembled
 * from the pair rather than stored a second time.
 */
export async function importVapidKey(
  publicKeyB64: string,
  privateKeyB64: string,
): Promise<CryptoKey> {
  const pub = b64urlToBytes(publicKeyB64)
  if (pub.length !== 65 || pub[0] !== 0x04) {
    throw new Error('VAPID_PUBLIC_KEY must be a 65-byte uncompressed P-256 point (starts 0x04)')
  }

  return crypto.subtle.importKey(
    'jwk',
    {
      kty: 'EC',
      crv: 'P-256',
      x: bytesToB64url(pub.slice(1, 33)),
      y: bytesToB64url(pub.slice(33, 65)),
      d: privateKeyB64,
      ext: true,
    },
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign'],
  )
}

/**
 * The Authorization header value for one endpoint.
 *
 * `aud` MUST be the endpoint's ORIGIN, not the full URL. Sending the whole URL
 * is the classic mistake and comes back as a flat 401 with no explanation.
 */
export async function vapidHeader(
  endpoint: string,
  key: CryptoKey,
  publicKeyB64: string,
  subject: string,
): Promise<string> {
  const audience = new URL(endpoint).origin

  const header = bytesToB64url(utf8(JSON.stringify({ typ: 'JWT', alg: 'ES256' })))
  const payload = bytesToB64url(
    utf8(
      JSON.stringify({
        aud: audience,
        // 12 hours. The spec allows 24; shorter limits the damage if a signed
        // token ever ends up in a log.
        exp: Math.floor(Date.now() / 1000) + 12 * 60 * 60,
        sub: subject,
      }),
    ),
  )

  const signingInput = `${header}.${payload}`
  const signature = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    key,
    utf8(signingInput),
  )

  // WebCrypto returns the raw r||s form JWS wants. Node's older `crypto` module
  // returns DER and would need converting — worth knowing if this is ported.
  const jwt = `${signingInput}.${bytesToB64url(new Uint8Array(signature))}`
  return `vapid t=${jwt}, k=${publicKeyB64}`
}

// ═══════════════════════════════════════════════════════════════════
// PAYLOAD ENCRYPTION — RFC 8291 + RFC 8188
//
// WebCrypto's HKDF performs Extract-then-Expand in a single call, which maps
// exactly onto what these RFCs specify — so each derivation is one deriveBits.
// ═══════════════════════════════════════════════════════════════════

export async function hkdf(
  salt: Uint8Array,
  ikm: Uint8Array,
  info: Uint8Array,
  bytes: number,
): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits'])
  const bits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt, info },
    key,
    bytes * 8,
  )
  return new Uint8Array(bits)
}

/**
 * Encrypts one payload for one subscription.
 *
 * @param plaintext  the JSON string the service worker will receive
 * @param p256dhB64  the browser's public key, from getKey('p256dh')
 * @param authB64    the browser's auth secret, from getKey('auth')
 * @returns the complete aes128gcm request body
 */
export async function encryptPayload(
  plaintext: string,
  p256dhB64: string,
  authB64: string,
): Promise<Uint8Array> {
  const uaPublic = b64urlToBytes(p256dhB64)
  const authSecret = b64urlToBytes(authB64)

  if (uaPublic.length !== 65 || uaPublic[0] !== 0x04) {
    throw new Error('subscription p256dh is not a 65-byte uncompressed P-256 point')
  }
  if (authSecret.length !== 16) {
    throw new Error('subscription auth secret must be 16 bytes')
  }

  // A fresh ephemeral keypair per message, as the RFC requires.
  const ephemeral = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, [
    'deriveBits',
  ])
  const asPublic = new Uint8Array(await crypto.subtle.exportKey('raw', ephemeral.publicKey))

  const uaKey = await crypto.subtle.importKey(
    'raw',
    uaPublic,
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    [],
  )
  const ecdhSecret = new Uint8Array(
    await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, ephemeral.privateKey, 256),
  )

  // RFC 8291 §3.3. The context binds the result to BOTH public keys, so a
  // captured ciphertext cannot be replayed against a different subscription.
  const ikm = await hkdf(
    authSecret,
    ecdhSecret,
    concat(utf8('WebPush: info\0'), uaPublic, asPublic),
    32,
  )

  const salt = crypto.getRandomValues(new Uint8Array(16))
  const cek = await hkdf(salt, ikm, utf8('Content-Encoding: aes128gcm\0'), 16)
  const nonce = await hkdf(salt, ikm, utf8('Content-Encoding: nonce\0'), 12)

  const aesKey = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt'])

  // RFC 8188 delimiter: 0x02 marks the last record. Omit it and the browser
  // discards the message without any error being reported anywhere.
  const padded = concat(utf8(plaintext), new Uint8Array([0x02]))

  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, tagLength: 128 }, aesKey, padded),
  )

  // aes128gcm header: salt(16) | record size(4, big-endian) | keyid len(1) | keyid
  const recordSize = new Uint8Array(4)
  new DataView(recordSize.buffer).setUint32(0, 4096, false)

  return concat(salt, recordSize, new Uint8Array([asPublic.length]), asPublic, ciphertext)
}
