/**
 * Render the REAL authenticated pages at phone widths and name whatever
 * overflows.
 *
 * No credentials are used. A fake session is planted in localStorage — the
 * client only DECODES that JWT, it never verifies it — and every call to
 * Supabase is intercepted and answered with canned rows. So the components,
 * the CSS and the layout are the shipped ones; only the data is invented.
 *
 * Usage: node audit-mobile.mjs <outDir> [width]
 */
import puppeteer from 'puppeteer-core'

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const BASE = process.env.BASE ?? 'http://localhost:4001'
const REF = 'vyirixtdgheypbpffsct'
const OUT = process.argv[2] ?? '.'
const ROLE = process.env.ROLE ?? 'system_admin'
const WIDTH = Number(process.argv[3] ?? 390)
const HEIGHT = Number(process.env.H ?? 900)
const SWEEP = (process.env.SWEEP ?? '').split(',').filter(Boolean).map(Number)

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url')
const exp = Math.floor(Date.now() / 1000) + 3600
const jwt = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({
  sub: '00000000-0000-0000-0000-0000000000aa',
  role: 'authenticated',
  aud: 'authenticated',
  email: '9000000001@phone.invalid',
  exp,
})}.x`

const SESSION = {
  access_token: jwt,
  refresh_token: 'fake',
  expires_at: exp,
  expires_in: 3600,
  token_type: 'bearer',
  user: {
    id: '00000000-0000-0000-0000-0000000000aa',
    aud: 'authenticated',
    role: 'authenticated',
    email: '9000000001@phone.invalid',
    app_metadata: { provider: 'email' },
    user_metadata: {},
    created_at: new Date().toISOString(),
  },
}

const PROPS = [
  { id: 'p1', name: 'Ambria Exotica', address: 'New Delhi', phone: '011-12345678', is_active: true },
  { id: 'p2', name: 'Ambria Manaktala', address: 'New Delhi', phone: '0120-3456789', is_active: true },
  { id: 'p3', name: 'Ambria Pushpanjali Banquets', address: 'Ghaziabad', phone: '0120-9876543', is_active: true },
  { id: 'p4', name: 'Ambria Restro', address: 'New Delhi', phone: '011-99887766', is_active: false },
]

/** Longest realistic content, because that is what actually overflows. */
function canned(url) {
  const u = new URL(url)
  const path = u.pathname

  if (path.includes('/auth/v1/token')) return SESSION
  if (path.includes('/auth/v1/user')) return SESSION.user
  if (path.includes('/auth/v1/logout')) return {}

  if (path.endsWith('/rest/v1/user_roles')) {
    return [
      {
        id: 'r1',
        user_id: SESSION.user.id,
        property_id: ROLE === 'system_admin' ? null : 'p1',
        role: ROLE,
        name: 'Sandeep Kumar Sharma',
        name_hi: 'संदीप कुमार शर्मा',
        phone: '9000000001',
        is_active: true,
        properties: ROLE === 'system_admin' ? null : PROPS[0],
      },
    ]
  }
  if (path.endsWith('/rest/v1/properties')) return PROPS
  if (path.endsWith('/rest/v1/push_outbox')) return []
  if (path.endsWith('/rest/v1/parked_vehicles')) return []
  if (path.endsWith('/rest/v1/valet_tasks')) return []
  if (path.endsWith('/rest/v1/token_ranges')) return []
  if (path.endsWith('/rest/v1/reviews')) return []
  if (path.endsWith('/rest/v1/parking_spaces')) return []

  if (path.includes('/rest/v1/rpc/property_overview')) {
    return PROPS.map((p, i) => ({
      property_id: p.id,
      cars_today: [4, 0, 12, 0][i],
      operators: [2, 1, 5, 0][i],
    }))
  }
  if (path.includes('/rest/v1/rpc/')) return []

  return null
}

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: ['--no-sandbox', '--hide-scrollbars'],
})
const page = await browser.newPage()
await page.setViewport({ width: WIDTH, height: HEIGHT, deviceScaleFactor: 2, isMobile: true, hasTouch: true })

await page.setRequestInterception(true)
page.on('request', (req) => {
  const url = req.url()
  if (!url.includes('supabase.co') && !url.includes('inputtools.google.com')) return req.continue()

  // A cross-origin fetch carrying apikey/authorization headers is preflighted,
  // and the browser drops the real response unless BOTH the preflight and the
  // response say it is allowed. Without this every mocked call fails CORS and
  // the app sits on "Checking your access".
  const CORS = {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET,POST,PATCH,DELETE,OPTIONS',
    // Echo whatever the preflight asked for. Naming them by hand missed
    // x-application-name, which src/supabase.js sets on every request so app
    // traffic can be told from Edge Function traffic in the Supabase logs.
    'access-control-allow-headers':
      req.headers()['access-control-request-headers'] ??
      'authorization,apikey,content-type,accept,prefer,x-client-info,x-application-name,range',
    'access-control-expose-headers': 'content-range,content-profile',
    'access-control-max-age': '600',
  }
  if (req.method() === 'OPTIONS') {
    return req.respond({ status: 204, headers: CORS, body: '' })
  }
  let body = canned(url)

  // .single() / .maybeSingle() ask for a single OBJECT via this Accept header,
  // and choke on an array. AuthContext reads the profile that way, so without
  // this the app sits on "Checking your access" for ever.
  const accept = req.headers().accept ?? ''
  if (accept.includes('vnd.pgrst.object') && Array.isArray(body)) {
    body = body[0] ?? null
  }

  req.respond({
    status: 200,
    contentType: accept.includes('vnd.pgrst.object')
      ? 'application/vnd.pgrst.object+json'
      : 'application/json',
    headers: { ...CORS, 'content-range': '0-0/*' },
    body: JSON.stringify(body ?? (accept.includes('vnd.pgrst.object') ? null : [])),
  })
})

// storageKey is 'valet-auth' — set explicitly in src/supabase.js, not the
// default sb-<ref>-auth-token. supabase-js v2 stores the session object as-is.
await page.evaluateOnNewDocument(
  (key, session) => {
    localStorage.setItem(key, JSON.stringify(session))
  },
  'valet-auth',
  SESSION,
)

const ROUTES = (process.env.ROUTES ?? '/system/properties').split(',')
let problems = 0

for (const route of ROUTES) {
  // STRESS: widen every glyph before measuring.
  //
  // `Inter` is in the font stack and is never actually loaded, so the app runs
  // on system-ui — Segoe UI on Windows, San Francisco on iOS, Roboto on
  // Android. Those are not the same widths. An element that fits in the browser
  // you tested is not proof it fits in the one an operator has, and the
  // difference is a few percent per line.
  //
  // WIDEN=4 adds 4% of letter-spacing to everything, which is more than that
  // spread. Whatever overflows under it is a genuinely tight spot.
  if (process.env.WIDEN) {
    await page.evaluateOnNewDocument((pct) => {
      const style = document.createElement('style')
      style.textContent = `* { letter-spacing: ${pct / 100}em !important }`
      document.addEventListener('DOMContentLoaded', () => document.head.appendChild(style))
    }, Number(process.env.WIDEN))
  }

  await page.goto(`${BASE}${route}`, { waitUntil: 'domcontentloaded', timeout: 20000 })
  await new Promise((r) => setTimeout(r, 2000))

  const report = await page.evaluate(() => {
    const D = document.documentElement
    const W = D.clientWidth
    const guilty = []
    for (const el of document.querySelectorAll('body *')) {
      const r = el.getBoundingClientRect()
      if (!r.width) continue
      if (r.right <= W + 1 && r.left >= -1) continue
      let p = el.parentElement
      let scrollable = false
      while (p && p !== document.body) {
        const o = getComputedStyle(p).overflowX
        if (o === 'auto' || o === 'scroll' || o === 'clip' || o === 'hidden') { scrollable = true; break }
        p = p.parentElement
      }
      if (scrollable) continue
      guilty.push({
        tag: el.tagName.toLowerCase(),
        cls: (el.getAttribute('class') ?? '').slice(0, 100),
        left: Math.round(r.left),
        right: Math.round(r.right),
        txt: (el.textContent ?? '').trim().slice(0, 45),
      })
    }
    // Outermost offenders only.
    const outer = guilty.filter(
      (g, i) => !guilty.some((o, j) => j < i && o.left <= g.left && o.right >= g.right),
    )
    return {
      W,
      // NOT documentElement.scrollWidth. src/index.css sets overflow-x: clip
      // on <html>, so the root can no longer report more than its own width —
      // measuring it there says "clean" because of the clip, which is exactly
      // the mistake that let a real overflow through. body is not clipped.
      scrollWidth: document.body.scrollWidth,
      overflow: document.body.scrollWidth - W,
      title: document.querySelector('h1')?.textContent ?? '(no h1)',
      guilty: outer.slice(0, 8),
    }
  })

  console.log(`\n=== ${route}   [${report.title}]`)
  console.log(`    viewport ${report.W}   page ${report.scrollWidth}   overflow ${report.overflow}px`)
  // Report on the ELEMENT list, not only on the number: a browser that clips
  // hides the number while the element is still sticking out, and the element
  // is what a browser without `clip` support will happily scroll to.
  if (report.overflow > 1 || report.guilty.length) {
    problems += 1
    for (const g of report.guilty) {
      console.log(`    >>> <${g.tag}> ${g.left}..${g.right}  "${g.txt}"`)
      console.log(`        ${g.cls}`)
    }
  } else {
    console.log('    clean')
  }

  await page.screenshot({ path: `${OUT}/p${route.replace(/\//g, '_')}-${WIDTH}.png`, fullPage: true })

  // ── how narrow can it go before something pokes out? ────────────────
  for (const w of SWEEP) {
    await page.setViewport({ width: w, height: HEIGHT, deviceScaleFactor: 2, isMobile: true })
    await new Promise((r) => setTimeout(r, 350))
    const o = await page.evaluate(() => {
      const D = document.documentElement
      const over = D.scrollWidth - D.clientWidth
      if (over <= 1) return { over }
      const W = D.clientWidth
      const worst = [...document.querySelectorAll('body *')]
        .map((e) => ({ e, r: e.getBoundingClientRect() }))
        .filter(({ r }) => r.width && r.right > W + 1)
        .sort((a, b) => b.r.right - a.r.right)[0]
      return {
        over,
        tag: worst?.e.tagName.toLowerCase(),
        cls: (worst?.e.getAttribute('class') ?? '').slice(0, 90),
        txt: (worst?.e.textContent ?? '').trim().slice(0, 35),
        right: Math.round(worst?.r.right ?? 0),
      }
    })
    if (o.over > 1) {
      problems += 1
      console.log(`    ${w}px  OVERFLOW ${o.over}px  <${o.tag}> right=${o.right} "${o.txt}"`)
      console.log(`           ${o.cls}`)
    }
  }
  if (SWEEP.length) await page.setViewport({ width: WIDTH, height: HEIGHT, deviceScaleFactor: 2, isMobile: true })

  // ── the drawer: is its bottom block reachable without scrolling? ─────
  const burger = await page.$('header button')
  if (burger && process.env.DRAWER) {
    await burger.click()
    await new Promise((r) => setTimeout(r, 500))
    const d = await page.evaluate(() => {
      const panel = document.querySelector('[role="dialog"][aria-modal="true"]')
      if (!panel) return { open: false }
      const pr = panel.getBoundingClientRect()
      const nav = panel.querySelector('nav')
      const foot = panel.lastElementChild
      const fr = foot.getBoundingClientRect()
      return {
        open: true,
        viewportH: innerHeight,
        panelTop: Math.round(pr.top),
        panelBottom: Math.round(pr.bottom),
        panelH: Math.round(pr.height),
        footTop: Math.round(fr.top),
        footBottom: Math.round(fr.bottom),
        footVisible: fr.bottom <= innerHeight + 1,
        navScrolls: nav ? nav.scrollHeight > nav.clientHeight + 1 : false,
        panelScrolls: panel.scrollHeight > panel.clientHeight + 1,
      }
    })
    console.log(`    drawer h=${HEIGHT}: panel ${d.panelTop}..${d.panelBottom} (h ${d.panelH}) vs viewport ${d.viewportH}`)
    console.log(`            footer ${d.footTop}..${d.footBottom}  visible=${d.footVisible}  navScrolls=${d.navScrolls}  panelScrolls=${d.panelScrolls}`)
    if (!d.footVisible) problems += 1
    await page.screenshot({ path: `${OUT}/drawer-${WIDTH}x${HEIGHT}.png` })
  }
}

await browser.close()
process.exit(problems ? 1 : 0)
