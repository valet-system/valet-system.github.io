# Notifications

How a notification gets from something happening in the database to a banner on
somebody's locked phone.

There are **two independent channels**, and they do not depend on each other:

| | In-app bell | OS push |
|---|---|---|
| Where it shows | the bell in the app header | the phone's notification tray |
| Needs the app open? | yes | **no** |
| Needs permission? | no | yes, once per device |
| How it arrives | polling + Supabase Realtime | Web Push, via the browser vendor |

If push is off or unsupported, the bell still works. If the app is closed, only
push works. Both read the same `notifications` table, so nothing is ever visible
in one and missing from the other.

---

## The chain

```
something happens (a task is assigned, a repair is raised, work is logged)
        │
        │  a PL/pgSQL trigger on tasks / work_board / training
        ▼
INSERT into  notifications  (type, task_text, for_user, property, entity_id, …)
        │
        ├──────────────► the bell picks it up          → in-app
        │                (Realtime, plus a 60s poll)
        │
        │  Supabase Database Webhook on INSERT
        ▼
Edge Function  send-push
        │  · reads the recipient's devices from push_subscriptions
        │  · reads their language from users.lang
        │  · signs each message with the VAPID private key
        ▼
the browser vendor's push service   (FCM for Chrome/Android, Apple, Mozilla)
        │
        ▼
service worker wakes on the device  →  showNotification()  →  banner
```

Every notification is a **row first**. Nothing is sent directly from the app, and
nothing is sent that is not also in the table — which is why the bell and the
banner can never disagree.

---

## Why it arrives with the screen off and the app not running

This is the part people expect not to work, so it is worth being precise.

The app is not what is listening. When a device turns push on, the browser opens a
subscription with **its own vendor's push service** and hands back an endpoint URL.
That endpoint is stored in `push_subscriptions`. From then on:

1. `send-push` posts an encrypted message to that endpoint. It never contacts the
   phone directly and does not need the app to be reachable.
2. The vendor's push service holds a connection to the device at the **operating
   system** level — the same one that delivers WhatsApp and email. It is alive
   whether or not the browser is open, and whether or not the screen is on.
3. When the message arrives, the OS wakes **the service worker**, not the app.
   The service worker is a small script (`public/push-sw.js`) that the browser can
   run for a few seconds with no page, no tab and no window.
4. It calls `showNotification()`, and the OS draws the banner.

So: screen off, app closed, browser closed — the banner still arrives. What is
running is the OS push service and, for a moment, the service worker.

Two consequences worth knowing:

- **The banner must be shown.** The subscription is created with
  `userVisibleOnly: true`, which is a promise to the browser that every push
  results in a visible notification. Silent pushes are not permitted, and a
  browser that catches you breaking the promise will revoke the subscription.
- **Delivery is immediate, not batched.** Messages are sent with
  `urgency: 'high'`, which tells FCM and Apple to deliver at once rather than
  holding them to save battery. `TTL: 300` means a push that cannot be delivered
  within five minutes is dropped rather than arriving stale hours later.

---

## What has to be true on a device

For a person to get push on a phone, all of these:

1. **They turned it on.** Account → the push toggle. This calls
   `enablePush()`, which asks for permission and stores the subscription. It can
   only be triggered by a tap — browsers refuse to prompt otherwise.
2. **Permission is granted.** Denied is sticky: the app cannot ask again, the
   person has to clear it in browser settings. `getPushState()` reports
   `unsupported | unconfigured | denied | on | off` so the toggle can say which.
3. **`VITE_VAPID_PUBLIC_KEY` is set** in the build. Without it the toggle reads
   `unconfigured` and does not offer itself.
4. **On iPhone, the app is installed to the Home Screen.** Safari does not give
   push to a page in a tab — only to an installed PWA, and only on iOS 16.4+.
   Add to Home Screen first, then turn push on from inside the installed app.
5. **The browser is not force-stopped.** On stock Android and desktop this is
   fine. Some Chinese OEM builds (Xiaomi, Oppo, Vivo, Realme) kill background
   apps aggressively — the device has to allow the browser to run in the
   background, or nothing arrives until it is opened again.

If a notification is in the bell but no banner came, it is one of these five,
not a bug in the sending.

---

## One device, several people

A shared phone must never show the previous user's notifications. Three
functions in `src/lib/push.js` keep that true, and they run without prompting:

- `syncSubscription(userId)` — on login and on session restore, re-points this
  device's existing subscription at whoever is now signed in.
- `releaseSubscription()` — on logout, deletes the row so nothing more is sent
  here. The browser subscription itself is kept, so the next user is claimed
  silently rather than being asked for permission again.
- `disablePush()` — the toggle going off. Deletes the row *and* unsubscribes.

Dead devices clean themselves up: when a push comes back `404` or `410` — the app
was uninstalled, or the browser dropped the subscription — `send-push` deletes
that row on the spot.

---

## Where the wording lives

**The text of every notification is written in two places, and both must be
edited together:**

| | file | shows |
|---|---|---|
| in-app | `src/components/layout/NotificationBell.jsx` | the bell list |
| push | `supabase/functions/send-push/index.ts` | the OS banner |

They are separate because one runs in the browser with the app's translations,
and the other runs in Deno with none. There is no shared source. Adding a type to
one and not the other gives a notification that reads correctly in the bell and
says "Ambria WorkForce" on the phone.

Both render Hindi and English. The bell uses the current UI language; the push
uses `users.lang`, because a banner is drawn while nobody is looking at the app.

### Adding a new type

1. Insert a `notifications` row with the new `type` (from a trigger, or from the
   app for something a user did).
2. Add the type to the `switch` in `NotificationBell.jsx` — icon, title, link.
3. Add it to the `M` map in `send-push/index.ts` — English title, Hindi title,
   deep-link path.
4. If the banner should name who caused it, add the type to `needsWho` in the
   same file.
5. **Redeploy `send-push`.** It does not ship with the frontend — see below.

---

## Scheduled notifications

Not everything comes from a trigger. Two `pg_cron` jobs run daily:

- **`due-task-reminders`** (03:30 UTC ≈ 09:00 IST) — one digest row per person
  for tasks due today, rather than one per task. It has no `entity_id`, which is
  how `send-push` knows to render "N tasks due today" instead of a task name.
- **`purge-old-notifications`** (03:45 UTC) — deletes rows older than 6 days.
  The bell is a list of what is current, not a log.

---

## Deploying

The frontend and the edge function ship **separately**, and forgetting the second
is the usual reason a new notification type reads wrong on phones:

```bash
# the app — pushed with the rest of the frontend
git push

# the function — manual, and not part of any CI
supabase functions deploy send-push --no-verify-jwt

# its secrets, set once
supabase secrets set \
  VAPID_PUBLIC_KEY=...  \
  VAPID_PRIVATE_KEY=... \
  VAPID_SUBJECT=mailto:software@ambria.in
```

`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are injected by Supabase; do not
set them yourself. `--no-verify-jwt` is required because the caller is a Database
Webhook, not a signed-in user.

The **Database Webhook** is configured in the Supabase dashboard: Database →
Webhooks → on `notifications`, event `INSERT`, pointing at the `send-push`
function. Without it the table fills up and no phone ever hears about it.

---

## When something does not arrive

Work down this list; it is ordered by how often each one is the answer.

1. **Is the row in `notifications`?**
   ```sql
   select type, for_user, task_text, created_at
     from notifications order by created_at desc limit 20;
   ```
   No row → the trigger did not fire, and push is not the problem. Check the
   trigger for that table.

2. **Does the recipient have a device registered?**
   ```sql
   select user_id, count(*) from push_subscriptions group by 1;
   ```
   No row for them → they never turned push on, or logged out on that device.

3. **Did the function run?** Supabase dashboard → Edge Functions → `send-push` →
   Logs. It logs every invocation: the type, the recipient, how many
   subscriptions it found, and each send result. `subscriptions found: 0` means
   step 2. Nothing at all means the webhook is not wired.

4. **Did the send fail?** The log prints the status code. `404`/`410` are dead
   subscriptions and are cleaned up automatically — the person needs to turn push
   on again. `403` usually means the VAPID keys do not match the ones the
   subscription was created with; if the keys are rotated, every existing
   subscription is void and everyone must re-subscribe.

5. **Is it the device?** Sent OK but no banner → permission, iOS install, or OEM
   battery killing, in that order. See "What has to be true on a device".

---

## Files

| path | what it is |
|---|---|
| `src/lib/push.js` | subscribe / unsubscribe / re-bind a device |
| `src/hooks/useNotifications.js` | the bell's data — Realtime plus a 60s poll |
| `src/components/layout/NotificationBell.jsx` | the bell, and the in-app wording |
| `public/push-sw.js` | service worker push + click handlers |
| `vite.config.js` | pulls `push-sw.js` into the generated worker (`importScripts`) |
| `supabase/functions/send-push/index.ts` | the only thing that can send a push |
| `supabase/db/migrations/SUPABASE-MIGRATION-PUSH.sql` | `push_subscriptions` |
| `supabase/db/migrations/SUPABASE-MIGRATION-NOTIFICATIONS.sql` | `notifications` + triggers |

Note that `push-sw.js` and `send-push/index.ts` each hard-code
`/Ambria---Workforce/` to build deep links. It must match `base` in
`vite.config.js`; if the site ever moves, all three change together.
