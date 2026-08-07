/**
 * The operator screens in the STATES a harness does not reach by loading a URL:
 * the token panel after a check-in, and a retrieval card mid-countdown.
 *
 * Loading /operator/checkin only ever shows the empty form. The panel with the
 * 72px token number and the place picker under it appears solely after a
 * successful submit — so it had never been measured, and it is the busiest
 * thing an operator looks at.
 */
import puppeteer from 'puppeteer-core'

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const BASE = process.env.BASE ?? 'http://localhost:4000'
const OUT = process.argv[2] ?? '.'
const WIDTH = Number(process.argv[3] ?? 390)

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url')
const exp = Math.floor(Date.now() / 1000) + 3600
const jwt = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({
  sub: '00000000-0000-0000-0000-0000000000aa',
  role: 'authenticated',
  aud: 'authenticated',
  exp,
})}.x`
const SESSION = {
  access_token: jwt,
  refresh_token: 'fake',
  expires_at: exp,
  expires_in: 3600,
  token_type: 'bearer',
  user: { id: '00000000-0000-0000-0000-0000000000aa', aud: 'authenticated', role: 'authenticated' },
}

const PROPERTY = {
  id: 'p1',
  name: 'Ambria Pushpanjali Banquets',
  address: 'Ghaziabad',
  phone: '0120-9876543',
  is_active: true,
}

/** The widest realistic values, because those are what overflow. */
function canned(url) {
  const u = new URL(url)
  const p = u.pathname

  if (p.includes('/auth/v1/')) return SESSION

  if (p.endsWith('/rest/v1/user_roles')) {
    return [
      {
        id: 'r1',
        user_id: SESSION.user.id,
        property_id: 'p1',
        role: 'operator',
        name: 'Test Operator Number Six',
        name_hi: 'टेस्ट ऑपरेटर नंबर सिक्स',
        phone: '7777777777',
        is_active: true,
        properties: PROPERTY,
      },
    ]
  }

  // The check-in RPC: this is what makes the token panel appear.
  if (p.includes('/rest/v1/rpc/operator_check_in')) {
    return {
      vehicle_id: 'v1',
      task_id: 't1',
      token_number: 1087,
      car_number: '4821',
      car_tier: 'VIP',
      guest_name: 'Rajeshwari Venkataraman Iyer',
      parked_at: new Date().toISOString(),
    }
  }

  if (p.includes('/rest/v1/rpc/parking_space_usage')) {
    return [
      { id: 's1', label: 'Basement 2 far corner', capacity: 20, in_use: 20, is_active: true },
      { id: 's2', label: 'Behind the kitchen block', capacity: 6, in_use: 2, is_active: true },
      { id: 's3', label: 'Front porch ramp', capacity: 4, in_use: 4, is_active: true },
      { id: 's4', label: 'L2 Bay B4', capacity: 8, in_use: 1, is_active: true },
    ]
  }

  // A retrieval already at the delivery point, so the countdown renders.
  if (p.endsWith('/rest/v1/valet_tasks')) {
    return [
      {
        id: 't9',
        task_type: 'retrieval',
        status: 'at_pickup',
        return_count: 2,
        created_at: new Date(Date.now() - 9 * 60000).toISOString(),
        assigned_at: new Date(Date.now() - 5 * 60000).toISOString(),
        pickup_started_at: new Date(Date.now() - 60000).toISOString(),
        completed_at: null,
        assigned_operator_id: 'r1',
        parked_vehicles: {
          id: 'v9',
          token_number: 1087,
          car_number: '4821',
          car_tier: 'VIP',
          guest_name: 'Rajeshwari Venkataraman Iyer',
          guest_phone: '9876543210',
          parking_location: 'Basement 2 far corner',
          notes: 'Scratched rear bumper, child seat inside, keys have a red tag',
        },
        operator: { id: 'r1', name: 'Test Operator Number Six', name_hi: 'टेस्ट ऑपरेटर नंबर सिक्स' },
      },
    ]
  }

  if (p.endsWith('/rest/v1/parked_vehicles')) {
    return [
      {
        id: 'v9',
        token_number: 1087,
        car_number: '4821',
        car_tier: 'VIP',
        guest_name: 'Rajeshwari Venkataraman Iyer',
        guest_phone: '9876543210',
        status: 'parked',
        parking_location: 'Basement 2 far corner',
        notes: 'Scratched rear bumper, child seat inside',
        parked_at: new Date().toISOString(),
        service_date: new Date().toISOString().slice(0, 10),
      },
    ]
  }
  if (p.endsWith('/rest/v1/token_ranges')) {
    return [{ range_date: new Date().toISOString().slice(0, 10), range_start: 1, range_end: 1100, next_token: 1088 }]
  }
  if (p.includes('/rest/v1/rpc/')) return []
  return []
}

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: ['--no-sandbox', '--hide-scrollbars'],
})
const page = await browser.newPage()
await page.setViewport({ width: WIDTH, height: 780, deviceScaleFactor: 2, isMobile: true, hasTouch: true })

await page.setRequestInterception(true)
page.on('request', (req) => {
  const url = req.url()
  if (!url.includes('supabase.co') && !url.includes('inputtools.google.com')) return req.continue()
  const CORS = {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET,POST,PATCH,DELETE,OPTIONS',
    'access-control-allow-headers': req.headers()['access-control-request-headers'] ?? '*',
    'access-control-expose-headers': 'content-range,content-profile',
  }
  if (req.method() === 'OPTIONS') return req.respond({ status: 204, headers: CORS, body: '' })

  let body = canned(url)
  const accept = req.headers().accept ?? ''
  const single = accept.includes('vnd.pgrst.object')
  if (single && Array.isArray(body)) body = body[0] ?? null
  req.respond({
    status: 200,
    contentType: single ? 'application/vnd.pgrst.object+json' : 'application/json',
    headers: { ...CORS, 'content-range': '0-0/*' },
    body: JSON.stringify(body ?? (single ? null : [])),
  })
})
await page.evaluateOnNewDocument((s) => localStorage.setItem('valet-auth', JSON.stringify(s)), SESSION)

const measure = () =>
  page.evaluate(() => {
    const D = document.documentElement
    const W = D.clientWidth
    // The root clips now, so the honest number is the CONTENT's, not the root's.
    const overflow = Math.round(document.body.scrollWidth - W)
    let worst = null
    for (const el of document.querySelectorAll('body *')) {
      const r = el.getBoundingClientRect()
      if (!r.width) continue
      if (r.right <= W + 1 && r.left >= -1) continue
      let par = el.parentElement
      let handled = false
      while (par && par !== document.body) {
        const o = window.getComputedStyle(par).overflowX
        if (o === 'auto' || o === 'scroll' || o === 'clip' || o === 'hidden') { handled = true; break }
        par = par.parentElement
      }
      if (handled) continue
      if (!worst || r.right > worst.right) {
        worst = {
          tag: el.tagName.toLowerCase(),
          cls: (el.getAttribute('class') ?? '').slice(0, 90),
          left: Math.round(r.left),
          right: Math.round(r.right),
          txt: (el.textContent ?? '').trim().slice(0, 40),
        }
      }
    }
    return { W, overflow, worst }
  })

let bad = 0
const report = async (label) => {
  const m = await measure()
  const ok = m.overflow <= 1
  if (!ok) bad += 1
  console.log(`  ${ok ? 'clean   ' : `OVERFLOW ${m.overflow}px`}  ${label}  (viewport ${m.W})`)
  if (!ok && m.worst) {
    console.log(`            <${m.worst.tag}> ${m.worst.left}..${m.worst.right} "${m.worst.txt}"`)
    console.log(`            ${m.worst.cls}`)
  }
  await page.screenshot({ path: `${OUT}/op-${label.replace(/[^a-z0-9]+/gi, '-')}-${WIDTH}.png`, fullPage: true })
}

// ── 1. the empty form ────────────────────────────────────────────────
await page.goto(`${BASE}/operator/checkin`, { waitUntil: 'domcontentloaded' })
await new Promise((r) => setTimeout(r, 2000))
await report('checkin form')

// ── 2. fill it and submit -> the TOKEN PANEL ─────────────────────────
await page.type('#\\:r0\\:', 'x').catch(() => {})
await page.evaluate(() => {
  const setVal = (el, v) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    setter.call(el, v)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  }
  const inputs = [...document.querySelectorAll('form input')]
  const byPlaceholder = (frag) => inputs.find((i) => (i.placeholder ?? '').includes(frag))
  const name = inputs[0]
  const phone = byPlaceholder('932') ?? inputs[1]
  const car = byPlaceholder('1234') ?? inputs[2]
  if (name) setVal(name, 'Rajeshwari Venkataraman Iyer')
  if (phone) setVal(phone, '9876543210')
  if (car) setVal(car, '4821')
})
await new Promise((r) => setTimeout(r, 300))
await page.evaluate(() => document.querySelector('form button[type="submit"]')?.click())
await new Promise((r) => setTimeout(r, 1800))
await report('token panel after check-in')

// ── are the FULL chips actually unselectable? ─────────────────────────
const chips = await page.evaluate(() => {
  const out = []
  for (const b of document.querySelectorAll('button')) {
    const txt = (b.textContent ?? '').trim()
    if (!/FULL|free|भरी|खाली/.test(txt)) continue
    out.push({
      label: txt.replace(/\s+/g, ' '),
      disabled: b.disabled,
      pointer: window.getComputedStyle(b).cursor,
    })
  }
  const note = [...document.querySelectorAll('p')].find((p) =>
    /Somewhere else|कोई और जगह/.test(p.textContent ?? ''),
  )
  return { out, note: note ? note.textContent.trim().slice(0, 70) : null }
})
console.log('  parking chips:')
for (const c of chips.out) {
  console.log(`    ${c.disabled ? 'DISABLED' : 'tappable'}  ${c.label}   (cursor: ${c.pointer})`)
}
console.log(`  note shown: ${chips.note ?? 'NONE'}`)

// Prove a full one cannot be chosen: click it and see if anything got selected.
const clicked = await page.evaluate(() => {
  const full = [...document.querySelectorAll('button')].find((b) => /FULL|भरी/.test(b.textContent ?? ''))
  if (!full) return 'no full chip found'
  full.click()
  // Scoped to the PICKER's chips. The language toggle also uses aria-pressed,
  // and counting it made a refusal look like a selection.
  const selected = [...document.querySelectorAll('button[aria-pressed="true"]')]
    .filter((b) => /FULL|free|भरी|खाली/.test(b.textContent ?? ''))
    .map((b) => (b.textContent ?? '').trim().replace(/\s+/g, ' '))
  return selected.length ? `SELECTED: ${selected.join(', ')}` : 'nothing selected — refused'
})
console.log(`  after clicking a FULL chip: ${clicked}`)

// ── 3. My Tasks with a live countdown ────────────────────────────────
await page.goto(`${BASE}/operator/tasks`, { waitUntil: 'domcontentloaded' })
await new Promise((r) => setTimeout(r, 2200))
await report('my tasks at delivery point')

// ── 4. Today's Cars ──────────────────────────────────────────────────
await page.goto(`${BASE}/operator/cars`, { waitUntil: 'domcontentloaded' })
await new Promise((r) => setTimeout(r, 2000))
await report("today's cars")

await browser.close()
process.exit(bad ? 1 : 0)
