# WhatsApp secrets — where each one comes from

Every value below is set in **Supabase → Project Settings → Edge Functions →
Secrets**, or with `supabase secrets set`. None of them ever goes in the repo,
in `.env`, or in a `VITE_` variable — a `VITE_` variable is compiled into the
JavaScript every visitor downloads.

Two functions read these: **`wa-dispatch`** (sends the outbound template
messages) and **`wa-webhook`** (receives the guest's replies). The table says
which needs which, because setting a dispatch-only secret will not fix a
webhook problem and vice versa.

---

## Read this before copying from a generic guide

Guides for the WhatsApp Cloud API name these variables differently from this
project. Three in particular will waste your afternoon:

| A generic guide says | This project reads | What happens if you follow the guide |
|---|---|---|
| `WA_WEBHOOK_VERIFY_TOKEN` | **`WA_VERIFY_TOKEN`** | `wa-webhook` reads an empty string, no token can ever match it, and Meta's "Verify and save" fails with no useful error. This is the expensive one. |
| `WA_WABA_ID` | *nothing* | Harmless but pointless — no function reads it. The WABA ID is not needed to send or receive. |
| `WA_API_VERSION` | *nothing* | The Graph version is **hard-coded**, not a secret. Setting this changes nothing. See below. |

And a generic guide will not mention the six template-name secrets this project
needs, which is the usual reason messages stop arriving after everything else
looks correct.

### The Graph API version is in the code, not in a secret

```
supabase/functions/wa-dispatch/index.ts:70   const GRAPH = 'https://graph.facebook.com/v21.0'
supabase/functions/wa-webhook/index.ts:50    const GRAPH = 'https://graph.facebook.com/v21.0'
```

Changing it means editing **both** files and redeploying both — they must not
drift apart. Don't take a version number from a guide or from me; open Meta's
Graph API changelog and use what is current and not near its sunset date.

---

## The credentials

| Secret | Used by | Where to get it |
|---|---|---|
| `WA_PHONE_NUMBER_ID` | both | Meta App → WhatsApp → API Setup → **"Phone number ID"**. A long number, *not* the phone number itself. Copying the phone number here is a common slip and produces a `#100` error. |
| `WA_ACCESS_TOKEN` | both | Business Manager → Business Settings → Users → **System Users** → add one → Generate token. Pick the app, tick **`whatsapp_business_messaging`** and **`whatsapp_business_management`**, and set expiry to **Never**. |
| `WA_APP_SECRET` | webhook | Meta App → Settings → Basic → **App Secret** (click Show). |
| `WA_VERIFY_TOKEN` | webhook | **You invent this.** Any random string, 32+ characters. You type the same value into Meta's webhook config. It is not a credential Meta issues. |

### Why the access token must say "Never expires"

The token offered on the API Setup page is a **24-hour** token for testing. Use
it and WhatsApp works today and stops tomorrow, silently — the messages just
stop, with the failure only visible in the function logs. A System User token
is the only kind that lasts.

### Why `WA_APP_SECRET` is not optional

`wa-webhook` is deployed `--no-verify-jwt`, so it is a public URL. Its only
protection is the `X-Hub-Signature-256` check against this secret. It refuses
to process anything when the secret is unset rather than trusting the payload —
an endpoint that dispatches a real operator to a real car on the say-so of a
phone number in the request body must not be open to anyone who finds the URL.

---

## The template names

These are the **names you gave the templates in Meta**, not their text. A
template must be **Approved** before it will send.

| Secret | Used by | Sent when |
|---|---|---|
| `WA_TEMPLATE_LANG` | both | Not a template — the language code, e.g. `en`, `en_US`, `hi`. It must match the approved template's language **exactly**; `en` against an `en_US` template fails. |
| `WA_TEMPLATE_CAR_PARKED` | dispatch | the car has been parked |
| `WA_TEMPLATE_CAR_AT_PICKUP` | dispatch | the car is waiting at the pickup point |
| `WA_TEMPLATE_CAR_DELIVERED` | dispatch | handed back to the guest |
| `WA_TEMPLATE_NOT_AVAILABLE` | dispatch | the car cannot be brought right now |
| `WA_TEMPLATE_CAR_RETURNED` | dispatch | the car was returned to the bay |
| `WA_TEMPLATE_REQUEST_RECEIVED` | webhook | acknowledges the guest's "bring my car". **Optional** — leave it unset while the template is in review and the webhook still works, it just does not acknowledge. |
| `WA_BTN_*` | webhook | **Optional.** Exact button texts, only needed if the default keyword matching reads a reply wrongly. |

### The parameter trap

Template variables are counted **per component**. A variable in the template's
**header** must be sent as a `header` component; sending it in `body` fails
both counts and Meta returns **`#132000`** — "number of parameters does not
match". If you edit a template in Meta and move a variable between the header
and the body, `wa-dispatch` has to be changed to match and redeployed.

---

## Setting them

```bash
supabase secrets set WA_PHONE_NUMBER_ID=... --project-ref <ref>
supabase secrets set WA_ACCESS_TOKEN=...    --project-ref <ref>
supabase secrets set WA_APP_SECRET=...      --project-ref <ref>
supabase secrets set WA_VERIFY_TOKEN=...    --project-ref <ref>
# ... and each WA_TEMPLATE_* above
```

Paste them into the Supabase dashboard instead if you prefer — the shell writes
them into your history file, which is one more place a permanent token lives.

**Secrets are injected when the container boots.** Changing one does not reach a
running function: redeploy it, or wait for the isolate to recycle. A secret that
"did not work" is usually a secret that was set after the last deploy.

```bash
supabase functions deploy wa-dispatch --project-ref <ref>
supabase functions deploy wa-webhook  --no-verify-jwt --project-ref <ref>
```

`wa-webhook` **must** keep `--no-verify-jwt`. Meta sends no Supabase JWT, so
with verification on, every inbound message is rejected before the function runs.

---

## Registering the webhook with Meta

Meta App → WhatsApp → Configuration → Webhooks:

- **Callback URL** — `https://<project-ref>.supabase.co/functions/v1/wa-webhook`
- **Verify token** — the same string you put in `WA_VERIFY_TOKEN`
- Subscribe to the **`messages`** field

Deploy the function *before* clicking "Verify and save". Meta calls the URL
during verification, and a URL that 404s fails with an error that does not say
the function is missing.
