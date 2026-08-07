# Mobile layout audit

Two scripts that load the **real** app at phone widths and report, with the
element's name, anything that overflows sideways.

They exist because "it looks wrong on my phone" took many rounds to pin down by
eye, and because the faults involved are invisible on a laptop: at 1280px
nothing overflows, so they ship.

## Why they are not part of `npm run build`

They need a running dev server and a real Chrome, and `puppeteer-core` is not a
dependency of this project. Keeping them out of the build means `npm install`
stays small and CI does not need a browser.

```bash
npm install --no-save puppeteer-core     # once per machine, not saved
npm run dev                              # in another terminal
```

Then, from the repo root:

```bash
# every route, both languages of chrome, at one width
MSYS_NO_PATHCONV=1 ROLE=valet_admin \
  ROUTES=/admin/dashboard,/admin/staff,/admin/tokens \
  BASE=http://localhost:4000 \
  node scripts/mobile/audit-routes.mjs ./tmp 390

# the operator screens in states a URL cannot reach —
# the token panel after a check-in, a retrieval mid-countdown
BASE=http://localhost:4000 node scripts/mobile/audit-operator-states.mjs ./tmp 360
```

`MSYS_NO_PATHCONV=1` matters on Git Bash: without it a leading `/` in an env
value is rewritten into a Windows path, and `ROUTES=/admin/x` arrives as
`C:/Program Files/Git/admin/x`.

### Options

| env | meaning |
|---|---|
| `BASE` | dev server origin (default `http://localhost:4001`) |
| `ROLE` | `operator` \| `valet_admin` \| `system_admin` — decides the nav and which routes are allowed |
| `ROUTES` | comma-separated paths |
| `SWEEP` | extra widths to re-measure each route at, e.g. `280,320,360,390,440` |
| `H` | viewport height (default 900). Use a short one to test the drawer. |
| `DRAWER` | set to open the hamburger drawer and check its footer is reachable |

Exit code is non-zero if anything overflowed, so it can gate a commit.

## How they get past the login screen

No credentials. A fake session is written to `localStorage` under the app's
`storageKey` (`valet-auth`) — the client only DECODES that JWT, it never
verifies it — and every request to Supabase is intercepted and answered with
canned rows. The components, the CSS and the layout are the shipped ones; only
the data is invented.

Three things that were not obvious while building this, kept here so nobody
rediscovers them:

- the storage key is **`valet-auth`**, set explicitly in `src/supabase.js`, not
  the default `sb-<ref>-auth-token`
- `.single()` / `.maybeSingle()` send `Accept: application/vnd.pgrst.object+json`
  and choke on an array, so those responses must be unwrapped to one object —
  `AuthContext` reads the profile that way, and without it the app sits on
  "Checking your access" for ever
- the CORS preflight must echo `Access-Control-Request-Headers`. Listing them by
  hand missed `x-application-name`, which `src/supabase.js` sets on every
  request so app traffic can be told from Edge Function traffic in the logs.

## What has already been measured clean

Every route below, at 280 / 300 / 320 / 360 / 375 / 390 / 400 / 414 / 430 /
440px, plus the sticky top bar still sticking and the drawer footer reachable at
560 / 640 / 700px tall:

```
/login
/operator/checkin  /operator/tasks  /operator/cars      (+ token panel, countdown)
/admin/dashboard  /admin/car-status  /admin/staff  /admin/tokens
/admin/spaces  /admin/reviews  /admin/analytics
/system/properties  /system/users  /system/records  /system/analytics
/change-pin
```

## What these scripts CANNOT see

Anything that depends on browser chrome. `100vh` versus `100dvh` is the big
one: neither DevTools device mode nor headless Chrome has an address bar, so a
panel sized to the layout viewport looks perfect here and is cut off on every
real phone. Both known cases are handled by the `min-h-app` / `h-app` utilities
in `src/index.css` — if a new full-height element appears, use those, because no
script here will catch it.
