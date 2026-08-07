/**
 * ┌─────────────────────────────────────────────────────────────────────┐
 * │ FILE: scripts/generate-vapid.mjs        run with `npm run vapid`      │
 * │                                                                     │
 * │ Prints a fresh VAPID keypair for Web Push, in the exact shape the     │
 * │ two places that need it expect.                                      │
 * │                                                                     │
 * │ WHY A SCRIPT AND NOT AN ONLINE GENERATOR                              │
 * │   The private key can send a notification to every device that ever    │
 * │   subscribed to this app. Pasting that into a web page hands it to    │
 * │   whoever runs the page. This uses node:crypto locally and touches    │
 * │   no network.                                                        │
 * │                                                                     │
 * │ ROTATING THE KEY INVALIDATES EVERY EXISTING SUBSCRIPTION              │
 * │   A browser's subscription is bound to the public key it was created  │
 * │   with, so after a rotation every device must subscribe again — and   │
 * │   until it does, it silently receives nothing. Rotate only if the     │
 * │   private key leaks, and clear push_subscriptions when you do.        │
 * └─────────────────────────────────────────────────────────────────────┘
 */

import { generateKeyPairSync } from 'node:crypto'

const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })

const b64url = (buf) =>
  Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

// The VAPID public key is the uncompressed EC point: 0x04 || X || Y = 65 bytes.
// It is the last 65 bytes of the SPKI DER encoding.
const rawPublic = publicKey.export({ type: 'spki', format: 'der' }).subarray(-65)
const jwk = privateKey.export({ format: 'jwk' })

if (rawPublic.length !== 65 || rawPublic[0] !== 0x04) {
  console.error('Unexpected public key encoding — aborting rather than printing a bad key.')
  process.exit(1)
}

console.log(`
VAPID keypair
═════════════════════════════════════════════════════════════════

1. Put the PUBLIC key in .env (it ships in the bundle — that is fine):

   VITE_VAPID_PUBLIC_KEY=${b64url(rawPublic)}

2. Give BOTH to the Edge Function. These are secrets; never commit them:

   supabase secrets set \\
     VAPID_PUBLIC_KEY=${b64url(rawPublic)} \\
     VAPID_PRIVATE_KEY=${jwk.d} \\
     VAPID_SUBJECT=mailto:you@yourdomain.com

3. Deploy the sender:

   supabase functions deploy push-send

The public key in .env and the one in the secrets MUST be the same, or every
send comes back 403 VapidPkHashMismatch.
`)
