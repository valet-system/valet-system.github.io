/**
 * ┌─────────────────────────────────────────────────────────────────────┐
 * │ FILE: src/components/NotificationBell.jsx                           │
 * │                                                                     │
 * │ WHAT THIS FILE IS                                                   │
 * │   The bell in the top bar: an unread count, and a panel listing      │
 * │   what this person has been told. Backed by push_outbox — the same   │
 * │   rows the phone gets, so the two can never disagree about what      │
 * │   happened (migration 0015).                                        │
 * │                                                                     │
 * │ WHY IT EXISTS WHEN THERE IS ALREADY A SOUND AND A PUSH               │
 * │   Both of those are momentary. A sound plays while the operator is   │
 * │   parking a car with the phone in their pocket; a push notification  │
 * │   gets swiped away with fifteen others. Neither answers "what was I  │
 * │   told in the last hour", which is exactly the question after you    │
 * │   come back from the third floor of a car park.                     │
 * │                                                                     │
 * │ THE COUNT IS UNREAD, NOT UNSEEN                                      │
 * │   Opening the panel does NOT mark everything read. An operator       │
 * │   glancing at the bell while walking has not dealt with anything,    │
 * │   and clearing the badge for them means the one they had not         │
 * │   actioned yet looks handled. Reading happens on tapping an item,    │
 * │   or on the explicit "Mark all read".                               │
 * │                                                                     │
 * │ IT SHOWS 14 DAYS, BECAUSE THAT IS ALL THERE IS                       │
 * │   The BELL shows the current service day only (05:30 -> 05:30) and   │
 * │   clears with the token range. prune_push_outbox still keeps two     │
 * │   weeks of rows — that is retention, this is a display window.       │
 * │   worth knowing before somebody goes looking for last month.         │
 * │                                                                     │
 * │ DEPENDS ON                                                          │
 * │   src/supabase, context/AuthContext, hooks/useRealtime, ui/Icon,     │
 * │   utils/format                                                      │
 * └─────────────────────────────────────────────────────────────────────┘
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import Icon from '@/components/ui/Icon'
import { useAutoT, useT } from '@/i18n'
import { useAuth } from '@/context/AuthContext'
import useRealtime from '@/hooks/useRealtime'
import { supabase } from '@/supabase'
import { cn } from '@/utils/cn'
import { istDayStart, timeAgo } from '@/utils/format'

/**
 * How many rows the panel holds.
 *
 * Not a scroll limit anybody reaches by hand — it is a ceiling on what a phone
 * downloads every time a notification arrives, since the list refetches on each
 * one.
 */
const PAGE = 30

export default function NotificationBell() {
  const t = useT()
  // The feed's title and body are composed in SQL and stored in English —
  // see i18n/autoTranslate. Car numbers and place names inside them are left
  // exactly as the database wrote them.
  const ta = useAutoT()
  const { operatorId } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()

  const [items, setItems] = useState([])
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  /**
   * Why the list is empty, when it is empty for a reason.
   *
   * This used to be a console.warn and nothing else, which made the single most
   * likely failure — migrations 0014/0015 not run yet, so the table or the
   * read_at column does not exist — look exactly like "you have no
   * notifications". Identical empty bell, no way to tell the difference without
   * opening devtools.
   */
  const [loadError, setLoadError] = useState(null)
  const ref = useRef(null)

  const load = useCallback(async () => {
    if (!operatorId) return

    // No .eq('user_role_id') needed — the RLS policy in migration 0015 already
    // restricts this to own rows. Adding it would be a second, weaker copy of
    // the same rule.
    // ── THIS SERVICE DAY ONLY ─────────────────────────────────────────
    //
    // The bell empties itself at 05:30 IST along with the token range, because
    // that is when the day is new. Yesterday's "fetch token 12" is noise once
    // token 12 has gone home, and a bell that still shows it teaches the
    // operator that the bell is not worth opening.
    //
    // The ROWS are not deleted — prune_push_outbox keeps a fortnight, and the
    // admin's reports read from parked_vehicles and valet_tasks regardless.
    // This is a display window, not a retention policy.
    const { data, error } = await supabase
      .from('push_outbox')
      .select('id, title, body, url, tag, critical, created_at, read_at, status')
      .gte('created_at', istDayStart())
      .order('created_at', { ascending: false })
      .limit(PAGE)

    if (error) {
      console.warn('[bell] could not load notifications:', error.code, error.message)

      // Named precisely, because these two are the whole story in practice and
      // they need completely different fixes.
      const raw = error.message ?? ''
      const missing =
        error.code === '42P01' || raw.includes('does not exist') || raw.includes('schema cache')

      setLoadError(
        missing
          ? t('bell.notSetUp')
          : import.meta.env.DEV
            ? // Kept untranslated on purpose: this branch is for whoever is
              // building the app, not for an operator on a porch.
              `Could not load notifications (${error.code ?? '?'}: ${raw})`
            : t('bell.couldNotLoad'),
      )
      return
    }

    setLoadError(null)
    setItems(data ?? [])
  }, [operatorId, t])

  useEffect(() => {
    load()
  }, [load])

  // Throttled inside the hook, so a burst of task changes is one refetch.
  useRealtime({
    channel: `bell:${operatorId}`,
    table: 'push_outbox',
    filter: operatorId ? `user_role_id=eq.${operatorId}` : undefined,
    enabled: Boolean(operatorId),
    onRefetch: load,
  })

  const unread = useMemo(() => items.filter((n) => !n.read_at).length, [items])

  // ── close on outside click, Escape, or navigation ──────────────────
  useEffect(() => {
    if (!open) return undefined

    const onPointerDown = (event) => {
      if (ref.current && !ref.current.contains(event.target)) setOpen(false)
    }
    const onKeyDown = (event) => {
      if (event.key === 'Escape') setOpen(false)
    }

    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  useEffect(() => setOpen(false), [location.pathname])

  async function markRead(ids) {
    // Optimistic: the panel is a list of things you have just looked at, and
    // waiting on a round trip to grey one out feels broken.
    const stamp = new Date().toISOString()
    setItems((current) =>
      current.map((n) =>
        (ids === null || ids.includes(n.id)) && !n.read_at ? { ...n, read_at: stamp } : n,
      ),
    )

    const { error } = await supabase.rpc('mark_notifications_read', { p_ids: ids })
    // Reload on failure so the badge tells the truth rather than the guess.
    if (error) {
      console.warn('[bell] could not mark read:', error.message)
      load()
    }
  }

  async function handleMarkAll() {
    if (unread === 0) return
    setBusy(true)
    await markRead(null)
    setBusy(false)
  }

  function handleOpenItem(item) {
    setOpen(false)
    if (!item.read_at) markRead([item.id])
    if (item.url) navigate(item.url)
  }

  if (!operatorId) return null

  return (
    <div className="relative shrink-0" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label={
          loadError
            ? t('bell.unavailable')
            : unread > 0
              ? t('bell.unreadCount', { n: unread })
              : t('bell.title')
        }
        className="relative flex h-10 w-10 items-center justify-center rounded-lg text-ink-inverse transition-colors hover:bg-white/10"
      >
        <Icon name={unread > 0 ? 'bell' : 'bell-off'} size={20} />

        {/* An amber dot when the feed is broken, so a permanently empty bell is
            distinguishable from a quiet one without opening the panel. */}
        {loadError && (
          <span
            className="absolute right-1.5 top-1.5 h-2 w-2 rounded-full bg-warning ring-2 ring-brand"
            aria-hidden="true"
          />
        )}

        {!loadError && unread > 0 && (
          <span
            className="tnum absolute right-1 top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-danger px-1 text-[0.625rem] font-bold leading-none text-white"
            // The visible count is decorative — the button's aria-label already
            // says it, and announcing both reads the number twice.
            aria-hidden="true"
          >
            {unread > 9 ? '9+' : unread}
          </span>
        )}
      </button>

      {open && (
        <div
          role="menu"
          className="absolute right-0 top-12 z-50 w-[21rem] max-w-[calc(100vw-1.5rem)] animate-slide-up overflow-hidden rounded-xl border border-line bg-surface shadow-pop"
        >
          <div className="flex items-center justify-between gap-2 border-b border-line px-4 py-3">
            <p className="text-sm font-semibold text-ink">
              {t('bell.title')}
              {unread > 0 && (
                <span className="tnum text-ink-subtle"> · {t('bell.new', { n: unread })}</span>
              )}
            </p>
            {unread > 0 && (
              <button
                type="button"
                onClick={handleMarkAll}
                disabled={busy}
                className="text-xs font-semibold text-info transition-colors hover:text-ink disabled:opacity-50"
              >
                {t('bell.markAll')}
              </button>
            )}
          </div>

          {loadError ? (
            <div className="px-4 py-6">
              <span className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-xl bg-danger-soft text-danger">
                <Icon name="alert" size={18} />
              </span>
              <p className="text-center text-sm font-medium text-ink">
                {t('bell.unavailable')}
              </p>
              <p className="mt-1.5 text-center text-xs leading-relaxed text-ink-subtle">
                {loadError}
              </p>
              <button
                type="button"
                onClick={load}
                className="mx-auto mt-3 block text-xs font-semibold text-info hover:text-ink"
              >
                {t('common.tryAgain')}
              </button>
            </div>
          ) : items.length === 0 ? (
            <div className="px-4 py-8 text-center">
              <span className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-xl bg-surface-sunken text-ink-subtle">
                <Icon name="bell-off" size={18} />
              </span>
              <p className="text-sm font-medium text-ink">{t('bell.nothing')}</p>
              <p className="mt-1 text-xs leading-relaxed text-ink-subtle">
                {t('bell.nothingBody')}
              </p>
            </div>
          ) : (
            <>
              <ul className="scrollbar-slim max-h-[26rem] divide-y divide-line overflow-y-auto">
                {items.map((item) => (
                  <li key={item.id}>
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => handleOpenItem(item)}
                      className={cn(
                        'flex w-full items-start gap-3 px-4 py-3 text-left transition-colors',
                        item.read_at ? 'hover:bg-surface-sunken' : 'bg-info-soft/40 hover:bg-info-soft',
                      )}
                    >
                      <span
                        className={cn(
                          'mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg',
                          item.critical ? 'bg-danger-soft text-danger' : 'bg-brand-soft text-ink-muted',
                        )}
                      >
                        <Icon name={item.critical ? 'bell' : 'info'} size={15} />
                      </span>

                      <span className="min-w-0 flex-1">
                        <span className="flex items-baseline gap-2">
                          <span
                            className={cn(
                              'truncate text-sm',
                              item.read_at ? 'font-medium text-ink-muted' : 'font-semibold text-ink',
                            )}
                          >
                            {ta(item.title)}
                          </span>
                          {!item.read_at && (
                            <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-info" />
                          )}
                        </span>
                        <span className="mt-0.5 block text-xs leading-relaxed text-ink-subtle">
                          {ta(item.body)}
                        </span>
                        <span className="mt-1 block text-[0.6875rem] text-ink-subtle">
                          {timeAgo(item.created_at)}
                        </span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>

              <p className="border-t border-line px-4 py-2.5 text-[0.6875rem] leading-relaxed text-ink-subtle">
                {t('bell.lastFew')}
              </p>
            </>
          )}
        </div>
      )}
    </div>
  )
}
