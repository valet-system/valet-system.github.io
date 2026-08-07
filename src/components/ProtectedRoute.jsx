/**
 * ┌─────────────────────────────────────────────────────────────────────┐
 * │ FILE: src/components/ProtectedRoute.jsx                             │
 * │                                                                     │
 * │ WHAT THIS FILE IS                                                   │
 * │   The route guard. Wraps a route and decides one of four outcomes:   │
 * │     - still loading         -> full page spinner                     │
 * │     - not logged in         -> redirect to /login                    │
 * │     - logged in, no role    -> AccountProblem screen                 │
 * │     - wrong role for route  -> redirect to their own home page       │
 * │   Also exports PublicRoute, the mirror image, for /login.            │
 * │                                                                     │
 * │ WHY IT EXISTS — and what it is NOT                                    │
 * │   This is a UX guard, not a security boundary. It stops an operator  │
 * │   from wandering into /admin and seeing a broken screen. It does     │
 * │   NOT stop them reading admin DATA — anyone can edit a URL, and in   │
 * │   a client-side app anyone can edit the JavaScript too.               │
 * │                                                                     │
 * │   The real boundary is Row Level Security in Postgres. That is why   │
 * │   migration 0002 rewrote every policy: even with this component      │
 * │   deleted entirely, an operator's queries would still return only    │
 * │   their own property's rows. Treat any route guard as cosmetic.       │
 * │                                                                     │
 * │ WHY replace ON THE REDIRECT                                          │
 * │   <Navigate replace> overwrites the history entry instead of adding  │
 * │   one. Without it, pressing Back re-enters the forbidden route,      │
 * │   bounces out again, and the user is stuck in a loop unable to go    │
 * │   back at all.                                                       │
 * │                                                                     │
 * │ USED BY                                                             │
 * │   App.jsx — wraps every route.                                       │
 * │                                                                     │
 * │ DEPENDS ON                                                          │
 * │   context/AuthContext, ui/Spinner, ui/Button, ui/Icon                │
 * └─────────────────────────────────────────────────────────────────────┘
 */

import { Navigate, useLocation } from 'react-router-dom'
import { useAuth } from '@/context/AuthContext'
import { authEmailToPhone } from '@/lib/phoneAuth'
import { PageSpinner } from '@/components/ui/Spinner'
import Button from '@/components/ui/Button'
import Icon from '@/components/ui/Icon'
import { useT } from '@/i18n'

export default function ProtectedRoute({ children, allow }) {
  const t = useT()
  const { isReady, session, profileStatus, role, homePath } = useAuth()
  const location = useLocation()

  // 1. Session or profile still resolving. Rendering anything else here would
  //    flash the login page at an already-authenticated user on every refresh.
  if (!isReady) return <PageSpinner label={t('common.checkingAccess')} />

  // 2. Not logged in. `state` remembers where they were headed so login can
  //    send them back there — an operator who bookmarked /operator/tasks
  //    should land on tasks, not on the generic home page.
  if (!session) return <Navigate to="/login" replace state={{ from: location.pathname }} />

  // 3. Logged in, but the user_roles row is missing / inactive / broken.
  if (profileStatus === 'error') return <AccountProblem />

  // 4. Logged in and valid, but this route is not for their role.
  if (allow && !allow.includes(role)) return <Navigate to={homePath} replace />

  return children
}

/**
 * The mirror guard for /login: if an authenticated user opens the login page,
 * send them to their dashboard instead of showing a form they do not need.
 */
export function PublicRoute({ children }) {
  const t = useT()
  const { isReady, isAuthenticated, homePath } = useAuth()

  if (!isReady) return <PageSpinner label={t('common.loading')} />
  if (isAuthenticated) return <Navigate to={homePath} replace />

  return children
}

/**
 * Shown when auth succeeded but the account is not usable — no user_roles row,
 * deactivated, or missing a property.
 *
 * This exists as a real screen rather than a redirect-to-login because
 * bouncing someone back to a login form they just used correctly is baffling.
 * The message states the actual cause and who can fix it.
 */
function AccountProblem() {
  // `phone` is null in the most common case here — no user_roles row exists at
  // all — so fall back to the digits in the derived auth address. This is the
  // ONE screen allowed to touch authEmail, because the number it would
  // normally show is exactly the thing that is missing.
  const t = useT()
  const { profileError, signOut, phone, authEmail } = useAuth()
  const identifier = phone ?? authEmailToPhone(authEmail) ?? authEmail

  return (
    <div className="flex min-h-app items-center justify-center bg-surface-sunken px-4">
      <div className="w-full max-w-md rounded-card border border-line bg-surface p-6 text-center shadow-card sm:p-8">
        <span className="mx-auto mb-5 flex h-14 w-14 items-center justify-center rounded-2xl bg-warning-soft text-warning">
          <Icon name="alert" size={26} />
        </span>

        <h1 className="text-lg font-semibold text-ink">{t('account.notReady')}</h1>

        <p className="mt-2 text-sm leading-relaxed text-ink-muted">
          {profileError ?? t('account.couldNotLoad')}
        </p>

        {identifier && (
          <p className="mt-4 rounded-lg bg-surface-sunken px-3 py-2 text-xs text-ink-subtle">
            Signed in as <span className="tnum font-medium text-ink-muted">{identifier}</span>
          </p>
        )}

        <Button variant="secondary" size="md" fullWidth className="mt-6" onClick={signOut} icon="logout">
          {t('common.signOut')}
        </Button>
      </div>
    </div>
  )
}
