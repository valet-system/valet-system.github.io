/**
 * ┌─────────────────────────────────────────────────────────────────────┐
 * │ FILE: src/supabase.js                                               │
 * │                                                                     │
 * │ WHAT THIS FILE IS                                                   │
 * │   The one and only Supabase client for the whole app, plus two       │
 * │   helpers used everywhere:                                          │
 * │     supabase          — the singleton client                        │
 * │     isConfigured      — are the env vars actually filled in?         │
 * │     describeDbError() — turns a Postgres error into human text       │
 * │                                                                     │
 * │ WHY IT EXISTS — spec rule 24: never create a second client           │
 * │   A second createClient() call creates a second auth store and a     │
 * │   second realtime socket. Symptoms are horrible to debug: the user   │
 * │   looks logged out in one component but not another, token refresh   │
 * │   fights itself, and realtime events arrive on a channel nobody is   │
 * │   listening to. Always import from here.                            │
 * │                                                                     │
 * │ TWO BUGS IN THE SPEC'S VERSION OF THIS FILE, FIXED HERE               │
 * │   1. It used TypeScript's non-null assertion inside a .js file:      │
 * │        process.env.REACT_APP_SUPABASE_URL!                           │
 * │      That trailing `!` is a hard syntax error in JavaScript. The     │
 * │      app would not compile at all.                                  │
 * │   2. `process.env` does not exist in a Vite browser bundle. Vite     │
 * │      exposes env vars on import.meta.env and requires the VITE_      │
 * │      prefix. With process.env this module throws "process is not     │
 * │      defined" the instant it loads.                                 │
 * │                                                                     │
 * │ SECURITY NOTE                                                        │
 * │   The anon key is SUPPOSED to be in the browser bundle — that is     │
 * │   what it is for. It is safe only because Row Level Security limits  │
 * │   what it can reach, which is why migration 0002 matters so much.    │
 * │   The service_role key must NEVER appear in a VITE_ variable; it     │
 * │   lives only in Supabase Edge Function secrets.                     │
 * │                                                                     │
 * │ USED BY                                                             │
 * │   AuthContext, and every page that reads or writes data.             │
 * │                                                                     │
 * │ DEPENDS ON                                                          │
 * │   @supabase/supabase-js, .env (VITE_SUPABASE_URL / _ANON_KEY)        │
 * └─────────────────────────────────────────────────────────────────────┘
 */

import { createClient } from '@supabase/supabase-js'
import { pickLang } from '@/i18n/activeLang'

const url = import.meta.env.VITE_SUPABASE_URL
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY

/**
 * Whether .env is filled in. Exported so App.jsx can render a readable setup
 * screen instead of a wall of failed network requests — which is exactly what
 * a fresh clone with an empty .env would otherwise produce.
 */
export const isConfigured = Boolean(url && anonKey)

if (!isConfigured) {
  console.error(
    '[supabase] Missing configuration.\n' +
      `  VITE_SUPABASE_URL      = ${url ? 'set' : 'MISSING'}\n` +
      `  VITE_SUPABASE_ANON_KEY = ${anonKey ? 'set' : 'MISSING'}\n` +
      'Fill in .env, then RESTART `npm run dev`. Vite reads .env only at startup.',
  )
}

export const supabase = createClient(
  // Placeholders keep createClient from throwing at import time when .env is
  // empty. The app then shows the setup screen and explains the problem,
  // instead of a blank white page.
  url || 'http://localhost:54321',
  anonKey || 'placeholder-anon-key',
  {
    auth: {
      // An operator's shift is 8+ hours; an access token lives 1 hour.
      // Without autoRefreshToken they get logged out mid-shift.
      persistSession: true,
      autoRefreshToken: true,
      // No magic links or OAuth here, so there is never a token in the URL.
      // Off = no pointless hash parse on every page load.
      detectSessionInUrl: false,
      storageKey: 'valet-auth',
    },
    realtime: {
      params: {
        // Events per second ceiling per client. With 8 operators plus an admin
        // on one property, a burst of check-ins could otherwise flood a cheap
        // Android phone and drop frames.
        eventsPerSecond: 10,
      },
    },
    global: {
      headers: {
        // Lets you tell app traffic from Edge Function traffic in Supabase logs.
        'x-application-name': 'valet-ops-web',
      },
    },
  },
)

/**
 * Runs a query; if Postgres says a column does not exist, runs the fallback.
 *
 * ── WHY THIS EXISTS ───────────────────────────────────────────────────
 * A column added by a migration that has not been run yet must never be able
 * to take the app down. This was learned the hard way: adding name_hi to the
 * profile read locked EVERY user out at the login screen with "column
 * user_roles.name_hi does not exist" — including the system admin, on a
 * database that was otherwise completely healthy.
 *
 * The rule that follows: a column carrying an OPTIONAL display value is
 * requested optimistically and its absence is survivable. A column the
 * feature cannot work without is not — that one should fail loudly, because
 * silently returning half a screen is worse than an error naming the
 * migration.
 *
 * @param run         the query with the optional columns
 * @param runWithout  the same query without them
 * @param what        named in the console warning, e.g. 'user_roles.name_hi'
 */
export async function selectOptional(run, runWithout, what = 'an optional column') {
  const result = await run()

  // 42703 is undefined_column. The message test is a belt-and-braces fallback
  // for PostgREST versions that report it without the SQLSTATE.
  const missing =
    result?.error &&
    (result.error.code === '42703' ||
      /column .* does not exist/i.test(result.error.message ?? ''))

  if (!missing) return result

  console.warn(
    `[supabase] ${what} is not in the database yet — falling back. ` +
      'Run the pending migrations in supabase/migrations.',
  )
  return runWithout()
}

/**
 * Turns a Supabase/Postgres error into something an operator can act on.
 *
 * Why: the raw messages are written for developers. An operator who sees
 *   duplicate key value violates unique constraint "parked_vehicles_token_..."
 * phones the admin and stops working. An operator who sees
 *   "That token is already used today. Please check in again."
 * just retries.
 *
 * Every custom string matched below is raised deliberately by our own SQL —
 * see supabase/migrations/20260731090100_fixes_and_hardening.sql.
 */
/**
 * Which migration adds each function, for the PGRST202 branch below.
 *
 * Longest-lived first is not the ordering that matters — SPECIFICITY is. The
 * match is a substring test, so a name that is a prefix of another would claim
 * both; none here are, and a new entry should be checked against that.
 */
const FN_MIGRATION = {
  parking_space_usage: '0035 (no_capacity_and_system_spaces)',
  add_parking_spaces: '0035 (no_capacity_and_system_spaces)',
  task_complete_parking: '0035 (no_capacity_and_system_spaces)',
  task_complete_reparking: '0035 (no_capacity_and_system_spaces)',
  nag_unaccepted_retrievals: '0032 (nag_unaccepted)',
  guest_request_retrieval: '0033 (guest_whatsapp_rpc)',
  guest_record_review: '0033 (guest_whatsapp_rpc)',
  task_accept: '0031 (task_accept)',
  admin_set_space_label_hi: '0029 (space_label_hi)',
  set_guest_name_hi: '0030 (guest_name_hi)',
}

export function describeDbError(error, fallback = null) {
  if (!error) return null

  const raw = error.message || error.error_description || String(error)
  const code = error.code

  // pickLang rather than a t() hook: this is called from catch blocks and
  // event handlers all over the app, none of which are component bodies.
  // See src/i18n/activeLang for why reading the language that way is safe.
  const generic = pickLang('Something went wrong. Please try again.', 'कुछ गड़बड़ हो गई। दोबारा कोशिश करें।')
  const message = fallback ?? generic

  // ── raised on purpose by our Postgres functions ──────────────────────
  if (raw.includes('TOKEN_RANGE_EXHAUSTED')) {
    return pickLang(
      "Today's token range is finished. Ask your admin to extend it in Token Management.",
      'आज की टोकन रेंज खत्म हो गई है। एडमिन से टोकन मैनेजमेंट में बढ़वाइए।',
    )
  }
  if (raw.includes('FORBIDDEN_PROPERTY')) {
    return pickLang('You do not have access to that property.', 'उस प्रॉपर्टी तक आपकी पहुँच नहीं है।')
  }
  if (raw.includes('PROPERTY_REQUIRED')) {
    return pickLang(
      'No property is linked to your account. Contact your system admin.',
      'आपके अकाउंट से कोई प्रॉपर्टी जुड़ी नहीं है। सिस्टम एडमिन से बात कीजिए।',
    )
  }

  // ── the function is not in the database yet ───────────────────────────
  //
  // PostgREST answers PGRST202 both when a function is missing and when it
  // exists but no overload matches the arguments sent — which is what a front
  // end deployed ahead of its migration produces.
  //
  // Raw, that reads "Could not find the function
  // public.parking_space_usage(p_property_id) in the schema cache", which is
  // useful to a developer and useless to an admin looking at a broken screen.
  // Naming the migration turns it into something they can act on.
  //
  // Keyed on the function name because one message cannot be right for all of
  // them: somebody told to run the wrong migration will run it, watch it
  // succeed, find the screen still broken, and conclude the app is broken
  // rather than unmigrated. lib/valetApi learned that the hard way.
  if (code === 'PGRST202' || raw.includes('Could not find the function')) {
    const hit = Object.entries(FN_MIGRATION).find(([fn]) => raw.includes(fn))
    const which = hit ? hit[1] : null
    return which
      ? pickLang(
          `This screen needs a database update. Run migration ${which} in the Supabase SQL Editor.`,
          `इस स्क्रीन के लिए डेटाबेस अपडेट चाहिए। Supabase SQL Editor में migration ${which} चलाइए।`,
        )
      : pickLang(
          'This screen needs a database update. Run the pending migrations in the Supabase SQL Editor.',
          'इस स्क्रीन के लिए डेटाबेस अपडेट चाहिए। Supabase SQL Editor में बाकी migrations चलाइए।',
        )
  }

  // ── Postgres error codes ─────────────────────────────────────────────
  if (code === '23505' || code === '23P01' || raw.includes('duplicate key')) {
    if (raw.includes('one_open_retrieval')) {
      return pickLang(
        'This car already has a pending retrieval request.',
        'इस गाड़ी की माँग पहले से दर्ज है।',
      )
    }
    if (raw.includes('token_per_day')) {
      return pickLang(
        'That token number is already used today. Please try again.',
        'यह टोकन नंबर आज पहले ही इस्तेमाल हो चुका है। दोबारा कोशिश कीजिए।',
      )
    }
    if (raw.includes('user_roles_user_id')) {
      return pickLang('That user already has a role assigned.', 'इस यूज़र को पहले से एक रोल मिला हुआ है।')
    }
    return pickLang('This record already exists.', 'यह रिकॉर्ड पहले से मौजूद है।')
  }
  if (code === '23514' || raw.includes('violates check constraint')) {
    return pickLang(
      'That value is not allowed. Please check the form and try again.',
      'यह वैल्यू सही नहीं है। फ़ॉर्म देखकर दोबारा कोशिश कीजिए।',
    )
  }
  if (code === '23503' || raw.includes('violates foreign key')) {
    return pickLang(
      'A linked record is missing. Refresh the page and try again.',
      'कोई जुड़ा हुआ रिकॉर्ड नहीं मिला। पेज रिफ़्रेश करके दोबारा कोशिश कीजिए।',
    )
  }
  if (code === '42501' || raw.includes('row-level security')) {
    return pickLang('You do not have permission to do that.', 'आपको यह करने की अनुमति नहीं है।')
  }
  // The recursion bug that migration 0002 fixes. Kept mapped because if the
  // original policies are ever re-applied, this message names the cause.
  if (code === '42P17' || raw.includes('infinite recursion')) {
    return 'Database policy error. Run migration 0002 (fixes_and_hardening) in the SQL Editor.'
  }

  // ── network / auth ───────────────────────────────────────────────────
  if (raw.includes('Failed to fetch') || raw.includes('NetworkError') || raw.includes('fetch failed')) {
    return pickLang(
      'No internet connection. Check your network and try again.',
      'इंटरनेट नहीं है। नेटवर्क देखकर दोबारा कोशिश कीजिए।',
    )
  }
  if (raw.includes('Invalid login credentials')) {
    return pickLang('Invalid email or password.', 'ईमेल या पासवर्ड ग़लत है।')
  }
  if (raw.includes('Email not confirmed')) {
    return pickLang(
      'This account is not confirmed yet. Contact your admin.',
      'यह अकाउंट अभी चालू नहीं हुआ है। एडमिन से बात कीजिए।',
    )
  }
  if (raw.includes('rate limit') || code === 'over_request_rate_limit') {
    return pickLang(
      'Too many attempts. Please wait a minute and try again.',
      'बहुत बार कोशिश हो गई। एक मिनट रुककर दोबारा कीजिए।',
    )
  }

  // Log the real error for whoever debugs it; show plain language to the user.
  console.error('[supabase] unmapped error:', error)
  return import.meta.env.DEV ? `${message} (${raw})` : message
}

export default supabase
