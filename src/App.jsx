/**
 * ┌─────────────────────────────────────────────────────────────────────┐
 * │ FILE: src/App.jsx                                                   │
 * │                                                                     │
 * │ WHAT THIS FILE IS                                                   │
 * │   The route table and the provider stack. Read this file first to    │
 * │   understand the shape of the whole app: every URL and who may see   │
 * │   it is listed here in one place.                                    │
 * │                                                                     │
 * │ THE PROVIDER ORDER MATTERS — from outside in                          │
 * │   BrowserRouter -> I18nProvider -> ToastProvider -> AuthProvider     │
 * │     -> routes                                                        │
 * │                                                                     │
 * │   Router outermost: ProtectedRoute calls useLocation(), which throws  │
 * │     if there is no Router above it.                                   │
 * │   I18n above everything that renders words — including Login, which   │
 * │     sits outside AppShell. An operator who cannot read English needs   │
 * │     the login screen in Hindi most of all. Toast reads it too, for    │
 * │     its dismiss label.                                                │
 * │   Toast above Auth: AuthProvider surfaces errors, so the toast API    │
 * │     must already exist when it does.                                 │
 * │   Auth above routes: every route depends on knowing the role.         │
 * │                                                                     │
 * │ ROUTE MAP                                                            │
 * │   /login                  public (redirects away if already signed in)│
 * │   /                       redirects to the signed-in role's home      │
 * │   /operator/checkin       operator                                    │
 * │   /operator/tasks         operator                                    │
 * │   /operator/cars          operator                                    │
 * │   /admin/dashboard        valet_admin                                 │
 * │   /admin/car-status       valet_admin — where every car is today       │
 * │   /admin/tokens           valet_admin                                 │
 * │   /admin/spaces           valet_admin                                 │
 * │   /admin/reviews          valet_admin                                 │
 * │   /admin/analytics        valet_admin                                 │
 * │   /system/properties      system_admin                                │
 * │   /system/users           system_admin                                │
 * │   /system/records        system_admin — all cars, CSV export           │
 * │   /system/analytics       system_admin                                │
 * │   *                       404                                         │
 * │                                                                     │
 * │   `allow` is an array so a route can later be shared — e.g. giving a  │
 * │   system_admin access to an admin dashboard is one array entry, not a │
 * │   refactor.                                                         │
 * │                                                                     │
 * │ WHY THE SETUP SCREEN IS CHECKED FIRST                                 │
 * │   With an empty .env, every Supabase call fails with an opaque        │
 * │   network error and the app looks broken for a reason nothing on      │
 * │   screen explains. Checking isConfigured up front turns that into    │
 * │   instructions.                                                      │
 * │                                                                     │
 * │ DEPENDS ON                                                          │
 * │   react-router-dom, context/*, components/*, pages/*, src/supabase    │
 * └─────────────────────────────────────────────────────────────────────┘
 */

import { lazy } from 'react'
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import { AuthProvider, useAuth } from '@/context/AuthContext'
import { ToastProvider } from '@/context/ToastContext'
import { I18nProvider, useT } from '@/i18n'
import ProtectedRoute, { PublicRoute } from '@/components/ProtectedRoute'
import AppShell from '@/components/AppShell'
import PwaStatus from '@/components/PwaStatus'
import Login from '@/pages/Login'

/**
 * Login is EAGER — everything below is lazy.
 *
 * Two reasons Login is the exception. It is the first paint for anyone not
 * already signed in, so a second round trip to fetch it is a straight loss.
 * And it renders OUTSIDE AppShell, which is where the Suspense boundary
 * lives — lazy here would throw with no boundary above it.
 *
 * The rest are split per route. The win is not really total size; it is that
 * an operator on a cheap Android over hotel wifi no longer downloads the
 * admin dashboards, the charting code and the CSV export in order to check a
 * car in. Each role pays for its own screens.
 *
 * The Suspense boundary is inside AppShell, not here — see the note there.
 * Anything added outside AppShell must be eager too.
 */
const ChangePin = lazy(() => import('@/pages/ChangePin'))
const StaffManager = lazy(() => import('@/pages/StaffManager'))
const CheckIn = lazy(() => import('@/pages/operator/CheckIn'))
const MyTasks = lazy(() => import('@/pages/operator/MyTasks'))
const TodaysCars = lazy(() => import('@/pages/operator/TodaysCars'))
const Dashboard = lazy(() => import('@/pages/admin/Dashboard'))
const CarStatus = lazy(() => import('@/pages/admin/CarStatus'))
const TokenMgmt = lazy(() => import('@/pages/admin/TokenMgmt'))
const Spaces = lazy(() => import('@/pages/admin/Spaces'))
const Reviews = lazy(() => import('@/pages/admin/Reviews'))
const Analytics = lazy(() => import('@/pages/admin/Analytics'))
const Properties = lazy(() => import('@/pages/system/Properties'))
const SystemAnalytics = lazy(() => import('@/pages/system/Analytics'))
const Records = lazy(() => import('@/pages/system/Records'))
import Icon from '@/components/ui/Icon'
import Button from '@/components/ui/Button'
import { isConfigured } from '@/supabase'
import { ROLES } from '@/types'

export default function App() {
  // Before anything else: is the app even configured? Nothing below can work
  // without Supabase credentials, so fail with instructions, not with silence.
  if (!isConfigured) return <SetupRequired />

  return (
    <BrowserRouter>
      {/* I18n is OUTSIDE everything that renders text — including Login, which
          sits outside AppShell. An operator who cannot read English needs the
          login screen in Hindi most of all. */}
      <I18nProvider>
        <ToastProvider>
          <AuthProvider>
            {/* Outside <Routes> so the offline strip and update banner persist
                across navigation instead of unmounting on every route change. */}
            <PwaStatus />

            <Routes>
              {/* ── public ─────────────────────────────────────────────── */}
              <Route
                path="/login"
                element={
                  <PublicRoute>
                    <Login />
                  </PublicRoute>
                }
              />

              {/* ── authenticated: everything inside the AppShell frame ── */}
              <Route
                element={
                  <ProtectedRoute>
                    <AppShell />
                  </ProtectedRoute>
                }
              >
                {/* "/" has no page of its own — it just forwards to whichever
                    home page matches the signed-in role. */}
                <Route index element={<RoleHomeRedirect />} />

                {/* No `allow` list: every role changes their own PIN. */}
                <Route path="change-pin" element={<ChangePin />} />

                {/* ── OPERATOR ────────────────────────────────────────── */}
                <Route
                  path="operator/checkin"
                  element={
                    <ProtectedRoute allow={[ROLES.OPERATOR]}>
                      <CheckIn />
                    </ProtectedRoute>
                  }
                />
                <Route
                  path="operator/tasks"
                  element={
                    <ProtectedRoute allow={[ROLES.OPERATOR]}>
                      <MyTasks />
                    </ProtectedRoute>
                  }
                />
                <Route
                  path="operator/cars"
                  element={
                    <ProtectedRoute allow={[ROLES.OPERATOR]}>
                      <TodaysCars />
                    </ProtectedRoute>
                  }
                />

                {/* ── VALET ADMIN ─────────────────────────────────────── */}
                <Route
                  path="admin/dashboard"
                  element={
                    <ProtectedRoute allow={[ROLES.VALET_ADMIN]}>
                      <Dashboard />
                    </ProtectedRoute>
                  }
                />
                {/* Valet staff. Same component as /system/users — it adapts to
                    the caller's role. A valet_admin sees only operators at their
                    own property and can only create operators. */}
                <Route
                  path="admin/staff"
                  element={
                    <ProtectedRoute allow={[ROLES.VALET_ADMIN]}>
                      <StaffManager />
                    </ProtectedRoute>
                  }
                />
                <Route
                  path="admin/car-status"
                  element={
                    <ProtectedRoute allow={[ROLES.VALET_ADMIN]}>
                      <CarStatus />
                    </ProtectedRoute>
                  }
                />
                <Route
                  path="admin/tokens"
                  element={
                    <ProtectedRoute allow={[ROLES.VALET_ADMIN]}>
                      <TokenMgmt />
                    </ProtectedRoute>
                  }
                />
                <Route
                  path="admin/spaces"
                  element={
                    <ProtectedRoute allow={[ROLES.VALET_ADMIN]}>
                      <Spaces />
                    </ProtectedRoute>
                  }
                />
                <Route
                  path="admin/reviews"
                  element={
                    <ProtectedRoute allow={[ROLES.VALET_ADMIN]}>
                      <Reviews />
                    </ProtectedRoute>
                  }
                />
                <Route
                  path="admin/analytics"
                  element={
                    <ProtectedRoute allow={[ROLES.VALET_ADMIN]}>
                      <Analytics />
                    </ProtectedRoute>
                  }
                />

                {/* ── SYSTEM ADMIN ────────────────────────────────────── */}
                <Route
                  path="system/properties"
                  element={
                    <ProtectedRoute allow={[ROLES.SYSTEM_ADMIN]}>
                      <Properties />
                    </ProtectedRoute>
                  }
                />
                <Route
                  path="system/users"
                  element={
                    <ProtectedRoute allow={[ROLES.SYSTEM_ADMIN]}>
                      <StaffManager />
                    </ProtectedRoute>
                  }
                />
                <Route
                  path="system/records"
                  element={
                    <ProtectedRoute allow={[ROLES.SYSTEM_ADMIN]}>
                      <Records />
                    </ProtectedRoute>
                  }
                />
                <Route
                  path="system/analytics"
                  element={
                    <ProtectedRoute allow={[ROLES.SYSTEM_ADMIN]}>
                      <SystemAnalytics />
                    </ProtectedRoute>
                  }
                />
              </Route>

              {/* ── 404 ────────────────────────────────────────────────── */}
              <Route path="*" element={<NotFound />} />
            </Routes>
          </AuthProvider>
        </ToastProvider>
      </I18nProvider>
    </BrowserRouter>
  )
}

/**
 * Sends "/" to the right dashboard. homePath comes from AuthContext, so the
 * mapping lives in exactly one place and cannot drift from ROLE_HOME.
 */
function RoleHomeRedirect() {
  const { homePath } = useAuth()
  return <Navigate to={homePath} replace />
}

function NotFound() {
  const t = useT()
  const { isAuthenticated, homePath } = useAuth()

  return (
    <div className="flex min-h-app items-center justify-center bg-surface-sunken px-4">
      <div className="w-full max-w-sm rounded-card border border-line bg-surface p-8 text-center shadow-card">
        <span className="mx-auto mb-5 flex h-14 w-14 items-center justify-center rounded-2xl bg-brand-soft text-ink-subtle">
          <Icon name="search" size={26} />
        </span>
        <h1 className="text-lg font-semibold text-ink">{t('notFound.title')}</h1>
        <p className="mt-2 text-sm text-ink-muted">{t('notFound.body')}</p>
        <Button
          variant="primary"
          size="md"
          fullWidth
          className="mt-6"
          onClick={() => {
            // Full assignment rather than navigate(): this component can render
            // outside the authenticated tree, where a router push may land
            // somewhere that immediately bounces again.
            window.location.href = isAuthenticated ? homePath : '/login'
          }}
        >
          {t(isAuthenticated ? 'notFound.backHome' : 'notFound.signIn')}
        </Button>
      </div>
    </div>
  )
}

/**
 * Shown when .env has no Supabase credentials.
 *
 * Deliberately verbose. This screen is seen by whoever clones the repo on a
 * new machine, and the two mistakes that cause it are both easy to miss: the
 * VITE_ prefix, and the fact that Vite reads .env only at startup, so editing
 * it while the dev server runs appears to change nothing.
 *
 * NOT TRANSLATED, on purpose. Its reader is whoever is setting the project up
 * on a laptop, not an operator on a porch, and the thing it talks about — env
 * var names, .env.example, the Supabase dashboard — is English either way.
 * Same reasoning as the "run migration 00NN" hints in src/supabase.js.
 */
function SetupRequired() {
  const url = import.meta.env.VITE_SUPABASE_URL
  const key = import.meta.env.VITE_SUPABASE_ANON_KEY

  return (
    <div className="flex min-h-app items-center justify-center bg-surface-sunken px-4 py-10">
      <div className="w-full max-w-lg rounded-card border border-line bg-surface p-6 shadow-card sm:p-8">
        <span className="mb-5 flex h-12 w-12 items-center justify-center rounded-xl bg-warning-soft text-warning">
          <Icon name="settings" size={24} />
        </span>

        <h1 className="text-xl font-bold text-ink">Setup required</h1>
        <p className="mt-2 text-sm leading-relaxed text-ink-muted">
          The app cannot reach Supabase because <code className="rounded bg-surface-sunken px-1 py-0.5 text-xs">.env</code> is
          incomplete.
        </p>

        <ul className="mt-5 space-y-2">
          <EnvRow name="VITE_SUPABASE_URL" ok={Boolean(url)} />
          <EnvRow name="VITE_SUPABASE_ANON_KEY" ok={Boolean(key)} />
        </ul>

        <ol className="mt-6 space-y-2.5 text-sm text-ink-muted">
          <li>
            <span className="font-semibold text-ink">1.</span> Copy{' '}
            <code className="rounded bg-surface-sunken px-1 py-0.5 text-xs">.env.example</code> to{' '}
            <code className="rounded bg-surface-sunken px-1 py-0.5 text-xs">.env</code>
          </li>
          <li>
            <span className="font-semibold text-ink">2.</span> Fill both values from Supabase →
            Settings → Data API and API Keys
          </li>
          <li>
            <span className="font-semibold text-ink">3.</span>{' '}
            <span className="font-semibold text-ink">Restart the dev server.</span> Vite reads{' '}
            <code className="rounded bg-surface-sunken px-1 py-0.5 text-xs">.env</code> only at
            startup — saving the file is not enough.
          </li>
        </ol>

        <p className="mt-6 rounded-lg bg-info-soft px-3.5 py-3 text-xs leading-relaxed text-info">
          The variable names must start with <strong>VITE_</strong>. Vite refuses to expose any
          other name to the browser, on purpose, so a secret cannot leak into the bundle by
          accident.
        </p>
      </div>
    </div>
  )
}

function EnvRow({ name, ok }) {
  return (
    <li className="flex items-center gap-2.5 rounded-lg bg-surface-sunken px-3 py-2.5 text-sm">
      <Icon
        name={ok ? 'check-circle' : 'x-circle'}
        size={18}
        className={ok ? 'text-success' : 'text-danger'}
      />
      <code className="text-xs font-medium text-ink">{name}</code>
      <span className={`ml-auto text-xs font-semibold ${ok ? 'text-success' : 'text-danger'}`}>
        {ok ? 'set' : 'missing'}
      </span>
    </li>
  )
}
