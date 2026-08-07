/**
 * ┌─────────────────────────────────────────────────────────────────────┐
 * │ FILE: src/context/AuthContext.jsx                                   │
 * │                                                                     │
 * │ WHAT THIS FILE IS                                                   │
 * │   Who is logged in, what role they hold, and which property they     │
 * │   belong to — available anywhere via useAuth(). The actions are:      │
 * │     signInWithPin(phone, pin)  — mobile number + 6-digit PIN          │
 * │     changePin(currentPin, newPin)                                    │
 * │     signOut()                                                       │
 * │     refreshProfile()                                                │
 * │                                                                     │
 * │   LOGIN IS NUMBER + PIN. There is no email field in this app. See     │
 * │   src/lib/phoneAuth.js for how the number reaches Supabase Auth, and  │
 * │   why `phone` — not session.user.email — is what the UI displays.     │
 * │                                                                     │
 * │   It resolves TWO separate things:                                   │
 * │     1. the Supabase auth session  (email, auth.users.id)            │
 * │     2. the user_roles row         (role, property, display name)    │
 * │   Both must be loaded before any page may render, because every      │
 * │   query in this app is scoped by property_id.                        │
 * │                                                                     │
 * │ THE TRAP THIS FILE AVOIDS — read this before editing                  │
 * │   The obvious implementation is to fetch the user_roles row INSIDE   │
 * │   the onAuthStateChange callback. Do not. That callback runs while   │
 * │   the Supabase client holds an internal lock, and awaiting another   │
 * │   supabase call inside it can deadlock — the app hangs on the        │
 * │   spinner forever, with no error anywhere. It is intermittent, so it │
 * │   usually survives testing and appears in production.                │
 * │                                                                     │
 * │   So: the callback ONLY does synchronous setState. A separate effect │
 * │   keyed on the user id does the fetching.                            │
 * │                                                                     │
 * │ WHY THREE IDs ARE NOT INTERCHANGEABLE                                │
 * │   user.id       = auth.users.id      -> auth only                    │
 * │   userRole.id   = user_roles.id      -> what valet_tasks             │
 * │                                        .assigned_operator_id points  │
 * │                                        at. Exposed as `operatorId`.  │
 * │   propertyId    = properties.id                                      │
 * │   Mixing up the first two is the single easiest bug to write here:   │
 * │   the insert succeeds, and the task simply never appears in any      │
 * │   operator's task list.                                              │
 * │                                                                     │
 * │ USED BY                                                             │
 * │   ProtectedRoute, AppShell, Login, and every page.                   │
 * │                                                                     │
 * │ DEPENDS ON                                                          │
 * │   src/supabase, src/types (ROLES, ROLE_META)                         │
 * └─────────────────────────────────────────────────────────────────────┘
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import { pickLang } from '@/i18n/activeLang'
import { useI18n } from '@/i18n'
import { supabase, describeDbError, selectOptional } from '@/supabase'
import { phoneToAuthEmail } from '@/lib/phoneAuth'
import { unsubscribeFromPush } from '@/lib/pushApi'
import { ROLES, ROLE_META } from '@/types'

const AuthContext = createContext(null)

/** Where each role lands after login, and what its route prefix is. */
const ROLE_HOME = {
  [ROLES.OPERATOR]: '/operator/checkin',
  [ROLES.VALET_ADMIN]: '/admin/dashboard',
  [ROLES.SYSTEM_ADMIN]: '/system/properties',
}

export function AuthProvider({ children }) {
  // Read only so the context value can be re-derived on a language change —
  // see the dependency note on the useMemo at the bottom of this file.
  // AuthProvider sits INSIDE I18nProvider (App.jsx), so this is safe.
  const { lang } = useI18n()

  // ── auth session ────────────────────────────────────────────────────
  const [session, setSession] = useState(null)
  // False until the FIRST session check resolves. Without this the app
  // renders <Navigate to="/login"> for a split second on every refresh,
  // bouncing an already-logged-in operator back to the login screen.
  const [sessionReady, setSessionReady] = useState(false)

  // ── user_roles row ──────────────────────────────────────────────────
  const [userRole, setUserRole] = useState(null)
  const [profileStatus, setProfileStatus] = useState('idle') // idle|loading|ready|error
  const [profileError, setProfileError] = useState(null)

  // Bumped by refreshProfile() to force the fetch effect to re-run.
  const [reloadKey, setReloadKey] = useState(0)

  const userId = session?.user?.id ?? null

  // ══════════════════════════════════════════════════════════════════
  // EFFECT 1 — track the auth session. SYNCHRONOUS ONLY.
  // No await on any supabase call in here. See "THE TRAP" above.
  // ══════════════════════════════════════════════════════════════════
  useEffect(() => {
    let cancelled = false

    supabase.auth
      .getSession()
      .then(({ data, error }) => {
        if (cancelled) return
        if (error) console.error('[auth] getSession failed:', error)
        setSession(data?.session ?? null)
        setSessionReady(true)
      })
      .catch((error) => {
        if (cancelled) return
        console.error('[auth] getSession threw:', error)
        // Still mark ready — otherwise a network blip on load traps the user
        // on the spinner with no way forward.
        setSessionReady(true)
      })

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((event, nextSession) => {
      setSession(nextSession)
      setSessionReady(true)

      // Clear the profile immediately on sign-out so no stale property_id can
      // be read by a component that renders during the transition.
      if (event === 'SIGNED_OUT') {
        setUserRole(null)
        setProfileStatus('idle')
        setProfileError(null)
      }
    })

    return () => {
      cancelled = true
      subscription.unsubscribe()
    }
  }, [])

  // ══════════════════════════════════════════════════════════════════
  // EFFECT 2 — fetch the user_roles row. Safe to await here.
  // ══════════════════════════════════════════════════════════════════
  useEffect(() => {
    if (!userId) {
      setUserRole(null)
      setProfileStatus('idle')
      return
    }

    // Guards against a slow response from a previous user overwriting the
    // current one (happens when switching accounts quickly).
    let stale = false
    setProfileStatus('loading')
    setProfileError(null)

    ;(async () => {
      // The nested select pulls the joined properties row in ONE round trip.
      // property_id alone is not enough — every screen shows the property
      // NAME, and a second query per page load is wasted latency.
      //
      // maybeSingle, not single: single() throws when zero rows match, and
      // "this login has no user_roles row yet" is a normal provisioning state
      // that deserves a clear message, not a stack trace.
      const BASE = 'id, user_id, property_id, role, name, phone, is_active'
      const JOIN = 'properties(id, name, address, phone, is_active)'
      const read = (columns) =>
        supabase.from('user_roles').select(columns).eq('user_id', userId).maybeSingle()

      // name_hi (migration 0022) is asked for optimistically and its absence is
      // survivable. THIS query in particular must never hard-fail on it: it is
      // the profile read behind every screen, so a missing optional column
      // would lock every user out of a database that is otherwise fine — which
      // is exactly what happened once. See selectOptional in src/supabase.
      const { data, error } = await selectOptional(
        () => read(`${BASE}, name_hi, ${JOIN}`),
        () => read(`${BASE}, ${JOIN}`),
        'user_roles.name_hi',
      )

      if (stale) return

      if (error) {
        setProfileStatus('error')
        setProfileError(describeDbError(error, pickLang('Could not load your account.', 'आपका अकाउंट लोड नहीं हो सका।')))
        return
      }

      if (!data) {
        setProfileStatus('error')
        setProfileError(
          pickLang(
            'Your login works, but no role is assigned to it yet. Ask your system admin to add you in Users.',
            'आपका लॉगिन ठीक है, पर अभी कोई रोल नहीं मिला है। सिस्टम एडमिन से यूज़र्स में जुड़वाइए।',
          ),
        )
        return
      }

      if (data.is_active === false) {
        setProfileStatus('error')
        setProfileError(
          pickLang(
            'Your account has been deactivated. Contact your system admin.',
            'आपका अकाउंट बंद कर दिया गया है। सिस्टम एडमिन से बात कीजिए।',
          ),
        )
        return
      }

      // Constraint user_roles_property_scope_chk (migration 0002) should make
      // this impossible, but check anyway: a non-system_admin with a NULL
      // property_id would see an entirely empty app, because every RLS policy
      // compares against my_property_id() and NULL never matches.
      if (data.role !== ROLES.SYSTEM_ADMIN && !data.property_id) {
        setProfileStatus('error')
        setProfileError(
          pickLang(
            'No property is linked to your account. Ask your system admin to set one.',
            'आपके अकाउंट से कोई प्रॉपर्टी जुड़ी नहीं है। सिस्टम एडमिन से लगवाइए।',
          ),
        )
        return
      }

      setUserRole(data)
      setProfileStatus('ready')
    })()

    return () => {
      stale = true
    }
  }, [userId, reloadKey])

  // ══════════════════════════════════════════════════════════════════
  // ACTIONS
  // ══════════════════════════════════════════════════════════════════

  /**
   * Signs in with a mobile number and a 6-digit PIN.
   *
   * The phone is converted to the account's derived auth email and the PIN is
   * passed straight through as the password — Supabase Auth does the bcrypt
   * comparison. Nothing here ever sees a stored PIN. See src/lib/phoneAuth.js.
   *
   * Returns { error } instead of throwing so Login.jsx can render the message
   * inline beside the fields, rather than in a toast that covers the form.
   */
  const signInWithPin = useCallback(async (phone, pin) => {
    const authEmail = phoneToAuthEmail(phone)

    // Should be unreachable — Login validates first — but a malformed address
    // must never reach the auth endpoint.
    if (!authEmail) {
      return { error: pickLang('Enter a valid 10-digit mobile number.', 'सही 10 अंकों का मोबाइल नंबर डालिए।') }
    }

    const { data, error } = await supabase.auth.signInWithPassword({
      email: authEmail,
      password: pin,
    })

    if (error) {
      // Deliberately vague, and identical whether the NUMBER is unknown or the
      // PIN is wrong. Saying "no account with this number" would let anyone
      // enumerate which numbers belong to staff, one guess at a time.
      const raw = error.message || ''

      if (raw.includes('Invalid login credentials')) {
        // Identical whether the NUMBER is unknown or the PIN is wrong, and it
        // deliberately reveals nothing about the internal derived address —
        // an operator has no idea that exists and should never be shown it.
        return { error: pickLang('Wrong mobile number or PIN.', 'मोबाइल नंबर या पिन ग़लत है।') }
      }
      // This one is worth naming: it means the auth user was created without
      // "Auto Confirm" turned on. Since the derived address is unroutable, no
      // confirmation email can ever arrive, so the account is stuck until an
      // admin confirms it manually.
      if (raw.includes('Email not confirmed')) {
        return {
          error: pickLang(
            'This account is not activated. Ask your admin to confirm it in Supabase.',
            'यह अकाउंट चालू नहीं है। एडमिन से चालू करवाइए।',
          ),
        }
      }
      // Supabase's per-IP rate limit — the only real brute-force throttle in
      // this system, so a legitimate operator can occasionally see it too.
      if (raw.includes('rate limit') || raw.includes('Too many requests')) {
        return {
          error: pickLang(
            'Too many attempts from this network. Wait a minute and try again.',
            'इस नेटवर्क से बहुत बार कोशिश हुई है। एक मिनट रुककर दोबारा कीजिए।',
          ),
        }
      }

      return { error: describeDbError(error, 'Could not sign in.') }
    }

    return { error: null, session: data.session }
  }, [])

  const signOut = useCallback(async () => {
    // ── THE UI GOES FIRST. NOTHING BELOW IS ALLOWED TO HOLD IT ────────
    //
    // session is cleared HERE, not just userRole. isReady is
    //   sessionReady && (!session || profileStatus is ready/error)
    // so nulling profileStatus while session is still set makes isReady
    // FALSE — and ProtectedRoute answers that with "Checking your access".
    // Sign-out used to sit on that spinner for the length of two network
    // round trips, which read as the app hanging. With session gone the
    // route bounces to /login on this render.
    //
    // supabase.auth keeps its own copy of the session, so clearing this
    // mirror does not invalidate the JWT the calls below still need.
    setSession(null)
    setUserRole(null)
    setProfileStatus('idle')
    setProfileError(null)

    // Unregister this device from push while the JWT is still valid —
    // delete_push_subscription needs an authenticated caller, so after
    // auth.signOut() it would simply be refused.
    //
    // This matters because a porch handset is shared. The push subscription
    // belongs to the BROWSER, not the person, so skipping it means the
    // operator who went home keeps receiving "Fetch a car" for the next
    // shift's tasks while whoever is actually on duty gets nothing.
    //
    // Time-boxed inside unsubscribeFromPush, so a service worker that never
    // becomes ready cannot stall the sign-out.
    await unsubscribeFromPush()

    const { error } = await supabase.auth.signOut()

    if (error) {
      console.error('[auth] signOut failed:', error)

      // The screen already says signed out, so the device must actually BE
      // signed out. Without this the stored session survives and the next
      // reload puts the operator who went home straight back into the app —
      // on a handset the next shift is holding.
      //
      // scope 'local' clears the browser's copy with no network call, so it
      // works in exactly the situation that made the first attempt fail. The
      // refresh token stays valid server-side until it expires, which is the
      // right trade: a token nobody holds beats a session anyone can reopen.
      const { error: localError } = await supabase.auth.signOut({ scope: 'local' })
      if (localError) console.error('[auth] local signOut also failed:', localError)
    }
  }, [])

  /**
   * Changes the signed-in user's own PIN.
   *
   * An admin sets the FIRST PIN when creating the account. From then on the
   * operator owns it. An admin can still look a forgotten one up or replace it
   * from the staff screen (migrations 0007 and 0009) — that path runs through
   * its own logged RPCs, not through here.
   *
   * WHY THE CURRENT PIN IS RE-VERIFIED FIRST
   *   supabase.auth.updateUser() does NOT require the old password. It trusts
   *   the session. In this app that is a real hole: operators work a porch,
   *   put the phone down mid-shift, and stay signed in for eight hours. Anyone
   *   who picked up an unlocked phone could otherwise change the PIN silently
   *   and lock the operator out of their own account.
   *
   *   So we sign in again with the claimed current PIN first. Wrong PIN, stop.
   *   The re-sign-in also refreshes the session, which satisfies Supabase's
   *   "recent login required" rule if secure password change is ever switched
   *   on in the dashboard.
   *
   *   This cannot lock anyone out: it authenticates the account that is
   *   already signed in, so a failed attempt leaves the session untouched.
   */
  const changePin = useCallback(async (currentPin, newPin) => {
    const { error } = await supabase.rpc('change_my_pin', {
      p_current: currentPin,
      p_new: newPin,
    })

    if (!error) return { error: null }

    // Our SQL raises 'CODE: human sentence'. Prefer the sentence — it is written
    // for the person reading it and interpolates real detail.
    const raw = error.message || ''
    const match = raw.match(/\b([A-Z][A-Z_]{2,})\s*:\s*(.+)/)

    if (match) {
      const [, code, detail] = match
      const sentence = detail.trim()
      const capitalised = sentence.charAt(0).toUpperCase() + sentence.slice(1)

      if (code === 'WRONG_PIN') return { error: 'Your current PIN is wrong.' }
      if (code === 'BAD_PIN' || code === 'PIN_TAKEN') return { error: capitalised }
      if (code === 'FORBIDDEN') return { error: 'You are not signed in. Sign in again.' }
    }

    // The RPC does not exist yet — migration 0007 has not been run.
    if (error.code === 'PGRST202' || raw.includes('Could not find the function')) {
      return {
        error: 'PIN changing is not set up yet. Run migration 0007 in the Supabase SQL Editor.',
      }
    }

    return { error: describeDbError(error, 'Could not change your PIN.') }
  }, [])

  /** Re-reads the user_roles row — used after a system admin edits a user. */
  const refreshProfile = useCallback(() => setReloadKey((k) => k + 1), [])

  // ══════════════════════════════════════════════════════════════════
  // DERIVED VALUES
  // Computed once here so pages never re-derive them (and never disagree).
  // ══════════════════════════════════════════════════════════════════
  const value = useMemo(() => {
    const role = userRole?.role ?? null
    const property = userRole?.properties ?? null

    return {
      // raw
      session,
      user: session?.user ?? null,
      userRole,

      // identity, unpacked
      role,
      /** user_roles.id — what valet_tasks.assigned_operator_id references. */
      operatorId: userRole?.id ?? null,
      /**
       * The English name, RAW.
       *
       * Deliberately not run through personName() here: this object is a
       * useMemo keyed on the profile, and the language is not part of that
       * key — so a name formatted at this point would keep the language it
       * had when the profile loaded and never follow the EN/हिं toggle.
       *
       * Formatting is the renderer's job. Consumers pair this with
       * displayNameHi below: personName(displayName, displayNameHi).
       */
      displayName: userRole?.name ?? userRole?.phone ?? '',
      /** The Hindi spelling, or null. See displayName. */
      displayNameHi: userRole?.name_hi ?? null,

      /**
       * The login identifier, as a human knows it: the 10-digit mobile number.
       * This is what the UI shows.
       *
       * NOT session.user.email. That holds the derived internal address
       * (9876543210@phone.invalid) which exists only because this project's
       * Supabase has the phone provider disabled — see src/lib/phoneAuth.js.
       * Showing it would make an operator think they have an email account and
       * try to reset a password that was never sent anywhere.
       */
      phone: userRole?.phone ?? null,

      /**
       * The derived internal auth address. Exposed for debugging only. Do not
       * render it in the UI.
       */
      authEmail: session?.user?.email ?? '',

      // property scope
      propertyId: userRole?.property_id ?? null,
      property,
      // A property NAME is a proper noun ("Ambria Exotica") and is never
      // translated. The stand-in shown to a system_admin IS a phrase, so it
      // goes through pickLang — and `lang` is in this memo's dependency list
      // below, which is what makes it follow the EN/हिं toggle rather than
      // freezing at whatever was active when the profile loaded.
      propertyName:
        property?.name ??
        (role === ROLES.SYSTEM_ADMIN ? pickLang('All properties', 'सभी प्रॉपर्टी') : ''),

      // role predicates — clearer at a call site than role === '...'
      isOperator: role === ROLES.OPERATOR,
      isValetAdmin: role === ROLES.VALET_ADMIN,
      isSystemAdmin: role === ROLES.SYSTEM_ADMIN,
      /**
       * English, RAW — same reason as displayName above: this memo does not
       * re-run on a language change. AppShell resolves t(`role.${role}`)
       * itself. Kept for anything that wants a label without a hook.
       */
      roleLabel: role ? ROLE_META[role]?.label : '',

      // routing
      homePath: role ? (ROLE_HOME[role] ?? '/login') : '/login',

      // loading state
      /** True until BOTH the session and the role row have settled. */
      isReady: sessionReady && (!session || profileStatus === 'ready' || profileStatus === 'error'),
      isAuthenticated: Boolean(session && profileStatus === 'ready'),
      profileStatus,
      profileError,

      // actions
      signInWithPin,
      signOut,
      changePin,
      refreshProfile,
    }
    // `lang` is a dependency even though nothing above reads it directly:
    // pickLang() and describeDbError() inside this memo read the active
    // language from a plain module (src/i18n/activeLang), which React cannot
    // see. Without it, every language-dependent string in this object would
    // keep the language that was active when the profile loaded.
  }, [
    lang,
    session,
    sessionReady,
    userRole,
    profileStatus,
    profileError,
    signInWithPin,
    signOut,
    changePin,
    refreshProfile,
  ])

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth() {
  const context = useContext(AuthContext)
  if (!context) {
    throw new Error('useAuth must be used inside <AuthProvider>. Check App.jsx.')
  }
  return context
}
