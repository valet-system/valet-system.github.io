// @ts-nocheck — Deno file. See supabase/functions/README.md for why.
/**
 * ┌─────────────────────────────────────────────────────────────────────┐
 * │ FILE: supabase/functions/_shared/http.ts                            │
 * │                                                                     │
 * │ WHAT THIS FILE IS                                                   │
 * │   CORS headers, the OPTIONS preflight reply, and two response        │
 * │   helpers. Shared by every Edge Function the browser calls.           │
 * │                                                                     │
 * │ WHY THE PREFLIGHT HANDLING MATTERS                                    │
 * │   A browser will not let our page read a cross-origin POST response  │
 * │   unless the server answers a preflight OPTIONS request with the      │
 * │   right headers. Our app runs on localhost:5173 or vercel.app; the    │
 * │   function runs on *.supabase.co. Different origin, so every call is  │
 * │   preflighted.                                                       │
 * │                                                                     │
 * │   Get this wrong and the symptom is genuinely misleading: the         │
 * │   function runs, the operator IS created, but the browser refuses to  │
 * │   hand the response to our JavaScript — so the UI reports failure on  │
 * │   a call that succeeded. The admin retries and gets "already exists". │
 * │                                                                     │
 * │ WHY Allow-Origin IS `*`                                              │
 * │   CORS is not the access control here. These functions verify the     │
 * │   caller's Supabase JWT and their role on every single request.       │
 * │   Restricting the origin would only stop other websites' JavaScript;  │
 * │   it does nothing against curl, which sends no Origin at all. The JWT │
 * │   check is what actually protects the endpoint.                       │
 * │                                                                     │
 * │   `authorization` MUST appear in allow-headers — that is where the    │
 * │   caller's JWT travels, and browsers drop any header not listed.      │
 * │                                                                     │
 * │ USED BY                                                             │
 * │   admin-users, and later wa-send.                                    │
 * │   NOT wa-webhook — Meta calls that server-to-server, no preflight.    │
 * └─────────────────────────────────────────────────────────────────────┘
 */

export const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers':
    'authorization, x-client-info, apikey, content-type, x-application-name',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  // Lets the browser skip the preflight for 24h. The admin screen may create
  // several operators in a row; without this each one costs an extra round trip.
  'Access-Control-Max-Age': '86400',
}

/** Returns a preflight response for OPTIONS, or null to continue handling. */
export function handlePreflight(req: Request): Response | null {
  if (req.method !== 'OPTIONS') return null
  return new Response(null, { status: 204, headers: corsHeaders })
}

/** JSON success response with CORS headers attached. */
export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

/**
 * JSON error response.
 *
 * Two fields on purpose: `code` is a stable machine-readable string the
 * frontend switches on, `error` is the human sentence shown to the admin.
 * Matching on message text instead is how error handling silently breaks the
 * day someone rewords a message.
 */
export function fail(code: string, error: string, status = 400): Response {
  return json({ ok: false, code, error }, status)
}
