/**
 * ┌─────────────────────────────────────────────────────────────────────┐
 * │ FILE: src/components/ui/Icon.jsx                                    │
 * │                                                                     │
 * │ WHAT THIS FILE IS                                                   │
 * │   The complete icon set for the entire app. Every SVG path in this  │
 * │   project lives in the PATHS map below and nowhere else.            │
 * │                                                                     │
 * │ WHY IT EXISTS                                                       │
 * │   Two reasons. (1) Zero emoji: emoji render differently on every    │
 * │   Android version, break vertical alignment inside buttons, cannot  │
 * │   inherit colour, and read as unserious in an operations tool.      │
 * │   (2) Zero dependency: no icon library to install and no network    │
 * │   request — operators work on patchy 4G in basement car parks.      │
 * │                                                                     │
 * │ HOW TO ADD AN ICON                                                  │
 * │   Add one entry to PATHS. Must be a 24x24 viewBox, stroke-only      │
 * │   (fill="none"), so it matches the existing set's weight and can    │
 * │   inherit currentColor.                                             │
 * │                                                                     │
 * │ USED BY                                                             │
 * │   Everything. Buttons, badges, nav, empty states, toasts, cards.    │
 * │                                                                     │
 * │ DEPENDS ON                                                          │
 * │   Nothing.                                                          │
 * └─────────────────────────────────────────────────────────────────────┘
 *
 * Usage:  <Icon name="car" />                 // 20px, inherits colour
 *         <Icon name="check" size={28} />
 *         <Icon name="alert" className="text-danger" />
 *
 * Design constants shared by every icon:
 *   - one consistent 24x24 grid at 1.75 stroke, so nothing looks mismatched
 *   - `currentColor` everywhere, so an icon inherits its parent's colour
 *     and needs no variant per context
 */

// Each entry is the inner markup of a 24x24 viewBox.
// prettier-ignore
const PATHS = {
  // ── navigation / chrome ────────────────────────────────────────────
  menu:        <><path d="M3 6h18M3 12h18M3 18h18" /></>,
  close:       <><path d="M18 6 6 18M6 6l12 12" /></>,
  'chevron-down':  <><path d="m6 9 6 6 6-6" /></>,
  'chevron-right': <><path d="m9 6 6 6-6 6" /></>,
  'arrow-left':    <><path d="M19 12H5M12 19l-7-7 7-7" /></>,
  'arrow-right':   <><path d="M5 12h14M12 5l7 7-7 7" /></>,
  logout:      <><path d="M9 21H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3M16 17l5-5-5-5M21 12H9" /></>,
  settings:    <><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-2.9 1.2v.2a2 2 0 1 1-4 0v-.1A1.7 1.7 0 0 0 7 19.4a1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1A1.7 1.7 0 0 0 2.6 14H2.4a2 2 0 1 1 0-4h.2A1.7 1.7 0 0 0 4.6 7L4.5 7a2 2 0 1 1 2.8-2.8l.1.1A1.7 1.7 0 0 0 10 4.6V4.4a2 2 0 1 1 4 0v.2a1.7 1.7 0 0 0 2.9 1.2l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1A1.7 1.7 0 0 0 21.4 10h.2a2 2 0 1 1 0 4h-.2a1.7 1.7 0 0 0-1.5 1Z" /></>,

  // A globe for the language switch. The two vertical arcs plus the equator
  // read as "world" at 19px, which a filled continent map does not.
  globe:       <><circle cx="12" cy="12" r="9" /><path d="M3.2 9.5h17.6M3.2 14.5h17.6" /><path d="M12 3a15 15 0 0 1 0 18a15 15 0 0 1 0-18Z" /></>,

  // ── domain ─────────────────────────────────────────────────────────
  car:         <><path d="M4 15.5V11l1.7-4.4A2 2 0 0 1 7.6 5.2h8.8a2 2 0 0 1 1.9 1.4L20 11v4.5" /><path d="M2.5 15.5h19" /><circle cx="7.2" cy="17.8" r="1.7" /><circle cx="16.8" cy="17.8" r="1.7" /></>,
  key:         <><circle cx="8" cy="15.5" r="4" /><path d="m10.9 12.6 8.3-8.3M17.2 4.4 20 7.2M14.6 7 17.4 9.8" /></>,
  parking:     <><rect x="3" y="3" width="18" height="18" rx="3" /><path d="M9.5 17V7.5h3a3 3 0 0 1 0 6h-3" /></>,
  location:    <><path d="M20 10.3c0 5.7-8 11.7-8 11.7s-8-6-8-11.7a8 8 0 0 1 16 0Z" /><circle cx="12" cy="10.2" r="2.8" /></>,
  ticket:      <><path d="M3 9.2V7a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v2.2a2.8 2.8 0 0 0 0 5.6V17a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-2.2a2.8 2.8 0 0 0 0-5.6Z" /><path d="M13.5 5v14" /></>,
  clock:       <><circle cx="12" cy="12" r="9" /><path d="M12 7v5.3l3.4 2" /></>,
  timer:       <><path d="M10 2h4M12 6v3" /><circle cx="12" cy="14" r="8" /><path d="M12 14v-2.5" /></>,
  building:    <><path d="M4 21V5.5A2.5 2.5 0 0 1 6.5 3h6A2.5 2.5 0 0 1 15 5.5V21" /><path d="M15 10h2.5A2.5 2.5 0 0 1 20 12.5V21" /><path d="M2.5 21h19" /><path d="M7.5 7.5h4M7.5 11.5h4M7.5 15.5h4" /></>,
  star:        <><path d="m12 3.2 2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17.2l-5.4 2.9 1-6.1-4.4-4.3 6.1-.9Z" /></>,
  phone:       <><path d="M15.8 21A12.8 12.8 0 0 1 3 8.2 2 2 0 0 1 5 6l2 .3a2 2 0 0 1 1.7 1.6l.3 1.6a2 2 0 0 1-.6 1.9l-.6.5a13 13 0 0 0 4.3 4.3l.5-.6a2 2 0 0 1 1.9-.6l1.6.3a2 2 0 0 1 1.6 1.7l.3 2a2 2 0 0 1-2.2 2.2Z" /></>,

  // ── people ─────────────────────────────────────────────────────────
  user:        <><circle cx="12" cy="8" r="4" /><path d="M4.5 21a7.5 7.5 0 0 1 15 0" /></>,
  users:       <><circle cx="9.5" cy="8" r="3.6" /><path d="M2.5 21a7 7 0 0 1 14 0" /><path d="M16.5 4.7a3.6 3.6 0 0 1 0 6.9M18 14.4a7 7 0 0 1 3.5 6.1" /></>,
  shield:      <><path d="M12 22s8-3.6 8-10V5.6l-8-3-8 3V12c0 6.4 8 10 8 10Z" /><path d="m9 12 2.2 2.2L15.5 10" /></>,
  lock:        <><rect x="4" y="10.5" width="16" height="10.5" rx="2.5" /><path d="M8 10.5V7a4 4 0 0 1 8 0v3.5" /></>,

  // ── state / feedback ───────────────────────────────────────────────
  check:       <><path d="M20 6.5 9.2 17.3 4 12.1" /></>,
  'check-circle': <><circle cx="12" cy="12" r="9" /><path d="m8.2 12.2 2.6 2.6 5-5" /></>,
  x:           <><path d="M18 6 6 18M6 6l12 12" /></>,
  'x-circle':  <><circle cx="12" cy="12" r="9" /><path d="m15 9-6 6M9 9l6 6" /></>,
  alert:       <><path d="M10.3 3.9 2 18.2A2 2 0 0 0 3.7 21h16.6a2 2 0 0 0 1.7-2.8L13.7 3.9a2 2 0 0 0-3.4 0Z" /><path d="M12 9.5v4M12 17.2h.01" /></>,
  info:        <><circle cx="12" cy="12" r="9" /><path d="M12 11v5M12 7.8h.01" /></>,
  bell:        <><path d="M6 8.5a6 6 0 0 1 12 0c0 5.5 2 7.5 2 7.5H4s2-2 2-7.5Z" /><path d="M10.2 19.5a2 2 0 0 0 3.6 0" /></>,
  'bell-off':  <><path d="M8.7 4.5A6 6 0 0 1 18 8.5c0 5.5 2 7.5 2 7.5H8" /><path d="M10.2 19.5a2 2 0 0 0 3.6 0M3 3l18 18" /></>,

  // ── actions ────────────────────────────────────────────────────────
  plus:        <><path d="M12 5.5v13M5.5 12h13" /></>,
  search:      <><circle cx="11" cy="11" r="7" /><path d="m20.5 20.5-4.2-4.2" /></>,
  refresh:     <><path d="M21 12a9 9 0 1 1-2.6-6.4" /><path d="M21 3.5V10h-6.4" /></>,
  download:    <><path d="M12 3.5v11M7.5 10.5 12 15l4.5-4.5" /><path d="M4 19.5h16" /></>,
  edit:        <><path d="M17.5 3.5a2.1 2.1 0 0 1 3 3L8 19l-4 1 1-4Z" /><path d="m15 6 3 3" /></>,
  filter:      <><path d="M3.5 5.5h17l-6.5 8v6l-4-2v-4Z" /></>,
  eye:         <><path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z" /><circle cx="12" cy="12" r="3" /></>,
  'eye-off':   <><path d="M10 5.8a9.6 9.6 0 0 1 2-.3c6 0 9.5 6.5 9.5 6.5a17 17 0 0 1-2.4 3.3M6.4 7.8A17 17 0 0 0 2.5 12S6 18.5 12 18.5c.9 0 1.7-.1 2.5-.4" /><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2M3 3l18 18" /></>,

  // ── data ───────────────────────────────────────────────────────────
  chart:       <><path d="M3.5 21h17" /><path d="M7 21V12M12 21V4.5M17 21v-6" /></>,
  list:        <><path d="M8.5 6.5h12M8.5 12h12M8.5 17.5h12" /><path d="M4 6.5h.01M4 12h.01M4 17.5h.01" /></>,
  grid:        <><rect x="3.5" y="3.5" width="7" height="7" rx="1.5" /><rect x="13.5" y="3.5" width="7" height="7" rx="1.5" /><rect x="3.5" y="13.5" width="7" height="7" rx="1.5" /><rect x="13.5" y="13.5" width="7" height="7" rx="1.5" /></>,
  inbox:       <><path d="M21 12.5V19a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-6.5" /><path d="M3 12.5h5l1.5 2.5h5L16 12.5h5L18.4 4.8A2 2 0 0 0 16.5 3.5h-9A2 2 0 0 0 5.6 4.8Z" /></>,
  trend:       <><path d="M3.5 17 9 11.5l3.5 3.5L20.5 7" /><path d="M15 7h5.5v5.5" /></>,
}

export const ICON_NAMES = Object.keys(PATHS)

export default function Icon({ name, size = 20, className = '', strokeWidth = 1.75, ...rest }) {
  const path = PATHS[name]

  if (!path) {
    // Fail loud in dev, invisible in prod. A missing icon should never be
    // the reason a page crashes mid-shift.
    if (import.meta.env.DEV) {
      console.error(`[Icon] unknown name "${name}". Available: ${ICON_NAMES.join(', ')}`)
    }
    return null
  }

  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      // Icons here are always decorative — the adjacent text carries the
      // meaning. Hiding them from screen readers avoids double announcements.
      aria-hidden="true"
      focusable="false"
      className={`shrink-0 ${className}`}
      {...rest}
    >
      {path}
    </svg>
  )
}
