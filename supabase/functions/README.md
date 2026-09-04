# Edge Functions

## Status: none of these are in use yet

`admin-users/` is written and complete, but **the app does not call it**. Staff
management runs through Postgres RPC instead — see
`supabase/migrations/20260731090400_staff_management_rpc.sql` and
`src/lib/adminApi.js`.

Why: deploying an Edge Function requires the Supabase CLI authenticated to the
account that owns the project. On a machine with several Supabase accounts that
turned into a real obstacle, and it puts an everyday operation (adding a valet)
behind a developer toolchain. The Postgres version needs nothing but a migration
pasted into the SQL Editor.

The Postgres version is also **atomic**: creating a staff member writes an auth
account and a `user_roles` row in one transaction, so a failure part-way cannot
leave an auth account with no role. The Edge Function cannot do that — GoTrue and
Postgres share no transaction — so it has to delete the auth user by hand on
failure, and if that delete also fails you get an account that can sign in, shows
"Account not ready" forever, and whose number is now taken.

`admin-users/` is kept because the RPC version writes to `auth.users` and
`auth.identities` directly. If a future GoTrue release changes that schema and
creating users starts failing, deploy this instead and point
`src/lib/adminApi.js` back at `supabase.functions.invoke()`.

`wa-dispatch/` and `wa-webhook/` are written. There is no `wa-send`: an earlier
plan had one function per message, but every message is already queued into
`wa_outbox` by the RPC that earns it, so a second sending path would have been a
way for the two to disagree about what was sent.

`wa-webhook` genuinely **must** be an Edge Function — Meta calls it over HTTPS and
Postgres cannot receive an inbound request.

`ambria-bookings/` is the one door to Ambria Admin's valet bookings feed. It is
also the first function in this project the **browser** actually calls, so it is
the only one that needs the CORS helpers in `_shared/http.ts` to be right.

It exists for one reason: Ambria's feed is gated by an `x-feed-key` header, and a
key in a Vite bundle is not a key — `view-source` is the whole attack. The key
lives here as a secret and never leaves the server.

Two secrets, both on **this** project:

```
AMBRIA_FEED_URL   https://<ambria-ref>.supabase.co
AMBRIA_FEED_KEY   the same string Ambria set as VALET_FEED_KEY
```

JWT verification stays **on** — unlike the WhatsApp pair. The caller must be a
signed-in valet admin or system admin, and the role is read from the database
rather than the request body.

It is **deployed from the dashboard**, which is why it is the one function here
that imports nothing from `_shared/`: the dashboard bundles only the function's
own folder, so a `../_shared/http.ts` import fails at deploy time with a
module-not-found. The CORS helpers and the caller check are copied into the file
instead.

That copy is a standing cost, and worth knowing about before editing either
side: a change to the "never trust a role from the request body" rule in
`_shared/caller.ts` does **not** reach this file. Moving it to the CLI would let
it import the shared version and remove the trap.

```bash
# either — dashboard: Edge Functions → Deploy a new function → paste index.ts,
#                     name it exactly `ambria-bookings`, JWT verification ON
# or     — CLI:
supabase functions deploy ambria-bookings --project-ref <valet-ref>
```

The response is passed through verbatim. Ambria owns the staffing snapshot, the
event matching and `events_error`; re-deriving any of it here would put a second
opinion in the middle of the wire. See `AMBRIA_VALET_BOOKINGS_FEED.md`.

### Deploying the two WhatsApp functions

Both need `--no-verify-jwt`, for different reasons. Meta cannot attach a Supabase
JWT to a webhook, and `wa-dispatch` is called by pg_net from a migration that
must not contain a service role key — this repo is public.

```bash
supabase functions deploy wa-dispatch --no-verify-jwt --project-ref <ref>
supabase functions deploy wa-webhook  --no-verify-jwt --project-ref <ref>
```

`wa-webhook` is public once deployed, so its safety rests entirely on the
`X-Hub-Signature-256` check against `WA_APP_SECRET`. It refuses to process
anything if that secret is unset rather than falling back to trusting the
payload — an endpoint that dispatches a real operator to a real car on the say-so
of a phone number in the body must not be open.

Secrets, all set in the dashboard and never in the repo:

| secret | used by | what it is |
|---|---|---|
| `WA_PHONE_NUMBER_ID` | both | the sending number's ID, not the number |
| `WA_ACCESS_TOKEN` | both | permanent system-user token |
| `WA_APP_SECRET` | webhook | app secret, for the signature |
| `WA_VERIFY_TOKEN` | webhook | any string; must match what Meta is given |
| `WA_TEMPLATE_LANG` | dispatch | must match the approved template's language |
| `WA_TEMPLATE_CAR_PARKED` | dispatch | approved template name |
| `WA_TEMPLATE_CAR_DELIVERED` | dispatch | approved template name |
| `WA_TEMPLATE_NOT_AVAILABLE` | dispatch | approved template name |
| `WA_TEMPLATE_CAR_RETURNED` | dispatch | approved template name |
| `WA_BTN_*` | webhook | optional; exact button texts, if the keyword match is wrong |

---

## Why every file starts with `// @ts-nocheck`

These files target **Deno**, not the browser. VS Code's built-in TypeScript
server checks them against browser/Node types, so it reports errors that are
wrong here:

```
Cannot find name 'Deno'.
Cannot find module 'https://esm.sh/@supabase/supabase-js@2.49.4'.
Parameter 'req' implicitly has an 'any' type.
```

All three are correct in the Supabase Edge runtime. Nothing is broken.

Real type checking still happens: `supabase functions deploy` type-checks with
Deno before bundling, so a genuine error fails the deploy rather than shipping.

### To get proper checking in the editor instead

Install the **Deno** VS Code extension, then add to `.vscode/settings.json`:

```json
{
  "deno.enable": false,
  "deno.enablePaths": ["supabase/functions"]
}
```

`deno.enable: false` keeps Deno away from `src/` (which is a normal Vite app);
`enablePaths` turns it on for this folder only. Once that works you can delete
the `@ts-nocheck` lines.

---

## Deploying, when the time comes

```bash
# One-time, per machine. --no-browser prints a URL you paste into the browser
# that is signed into the account owning this project — `supabase login` alone
# opens your DEFAULT browser, which may be signed into a different account.
supabase login --profile valet --no-browser

# Confirm the project is visible BEFORE deploying. If it is not listed, the
# wrong account was authorised.
supabase projects list --profile valet

supabase functions deploy admin-users \
  --project-ref vyirixtdgheypbpffsct \
  --profile valet
```

`--profile valet` keeps this credential separate, so other Supabase accounts on
the same machine stay logged in. Omit it and the CLI uses the default
credential, which may belong to a different account — the usual symptom is
`Cannot find project ref`.

### Secrets

`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are injected automatically into
every Edge Function. Nothing to set.

The WhatsApp functions will need real secrets:

```bash
supabase secrets set WA_PHONE_NUMBER_ID=... --profile valet
supabase secrets set WA_ACCESS_TOKEN=...    --profile valet
supabase secrets set WA_VERIFY_TOKEN=...    --profile valet
supabase secrets set WA_APP_SECRET=...      --profile valet
```

### `verify_jwt` in `config.toml`

Set to `false` for every function, deliberately. A browser does **not** send the
`Authorization` header on a CORS preflight — that is per spec, preflights are
credential-free. With `verify_jwt = true` the gateway can reject the `OPTIONS`
request for having no token, and the browser reports:

```
Response to preflight request doesn't pass access control check:
It does not have HTTP ok status
```

which reads like a CORS bug and sends you hunting through response headers that
are already correct.

The functions verify the JWT themselves instead: `identifyCaller()` in
`_shared/caller.ts` calls `admin.auth.getUser(jwt)`, which asks GoTrue to check
the token's signature, then reads the caller's role from the database.

**If you edit a function, `identifyCaller()` must stay the first thing every
action does.** With `verify_jwt = false` it is the only thing between the
endpoint and the internet.
