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

Still to be written: `wa-send`, `wa-webhook`, `wa-dispatch` (the WhatsApp phase).
`wa-webhook` genuinely **must** be an Edge Function — Meta calls it over HTTPS and
Postgres cannot receive an inbound request.

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
