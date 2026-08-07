/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      // Every colour resolves to a CSS variable defined in src/index.css.
      // Consequence: swapping the whole palette (or adding dark mode) is a
      // change in ONE file, not a find-and-replace across 12 pages.
      colors: {
        surface: {
          DEFAULT: 'rgb(var(--c-surface) / <alpha-value>)',
          sunken: 'rgb(var(--c-surface-sunken) / <alpha-value>)',
          raised: 'rgb(var(--c-surface-raised) / <alpha-value>)',
        },
        ink: {
          DEFAULT: 'rgb(var(--c-ink) / <alpha-value>)',
          muted: 'rgb(var(--c-ink-muted) / <alpha-value>)',
          subtle: 'rgb(var(--c-ink-subtle) / <alpha-value>)',
          inverse: 'rgb(var(--c-ink-inverse) / <alpha-value>)',
        },
        line: {
          DEFAULT: 'rgb(var(--c-line) / <alpha-value>)',
          strong: 'rgb(var(--c-line-strong) / <alpha-value>)',
        },
        brand: {
          DEFAULT: 'rgb(var(--c-brand) / <alpha-value>)',
          hover: 'rgb(var(--c-brand-hover) / <alpha-value>)',
          soft: 'rgb(var(--c-brand-soft) / <alpha-value>)',
        },
        accent: {
          DEFAULT: 'rgb(var(--c-accent) / <alpha-value>)',
          soft: 'rgb(var(--c-accent-soft) / <alpha-value>)',
        },
        success: {
          DEFAULT: 'rgb(var(--c-success) / <alpha-value>)',
          hover: 'rgb(var(--c-success-hover) / <alpha-value>)',
          soft: 'rgb(var(--c-success-soft) / <alpha-value>)',
        },
        danger: {
          DEFAULT: 'rgb(var(--c-danger) / <alpha-value>)',
          hover: 'rgb(var(--c-danger-hover) / <alpha-value>)',
          soft: 'rgb(var(--c-danger-soft) / <alpha-value>)',
        },
        warning: {
          DEFAULT: 'rgb(var(--c-warning) / <alpha-value>)',
          soft: 'rgb(var(--c-warning-soft) / <alpha-value>)',
        },
        info: {
          DEFAULT: 'rgb(var(--c-info) / <alpha-value>)',
          soft: 'rgb(var(--c-info-soft) / <alpha-value>)',
        },
        vip: {
          DEFAULT: 'rgb(var(--c-vip) / <alpha-value>)',
          soft: 'rgb(var(--c-vip-soft) / <alpha-value>)',
        },
      },
      fontFamily: {
        sans: ['Inter var', 'Inter', 'system-ui', '-apple-system', 'Segoe UI', 'Roboto', 'sans-serif'],
        // Token numbers and countdowns: fixed-width digits so the layout
        // does not jitter every time a digit changes (e.g. 09:59 -> 09:58).
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'Consolas', 'monospace'],
      },
      fontSize: {
        // Token number hero display
        token: ['3.5rem', { lineHeight: '1', letterSpacing: '-0.03em', fontWeight: '800' }],
        'token-lg': ['5rem', { lineHeight: '1', letterSpacing: '-0.04em', fontWeight: '800' }],
      },
      spacing: {
        // Spec rule 20: minimum 56px touch target for operator phone use.
        touch: '3.5rem',
      },
      borderRadius: {
        card: '0.875rem',
      },
      boxShadow: {
        card: '0 1px 2px 0 rgb(15 23 42 / 0.04), 0 1px 3px 0 rgb(15 23 42 / 0.06)',
        raised: '0 4px 6px -1px rgb(15 23 42 / 0.07), 0 2px 4px -2px rgb(15 23 42 / 0.05)',
        pop: '0 10px 25px -5px rgb(15 23 42 / 0.12), 0 8px 10px -6px rgb(15 23 42 / 0.08)',
        focus: '0 0 0 3px rgb(var(--c-brand) / 0.25)',
      },
      keyframes: {
        'toast-in': {
          from: { opacity: '0', transform: 'translateY(-8px) scale(0.98)' },
          to: { opacity: '1', transform: 'translateY(0) scale(1)' },
        },
        'fade-in': {
          from: { opacity: '0' },
          to: { opacity: '1' },
        },
        'slide-up': {
          from: { opacity: '0', transform: 'translateY(10px)' },
          to: { opacity: '1', transform: 'translateY(0)' },
        },
        // Used on urgent cards (new retrieval request) to pull the eye
        // without an animated GIF or emoji.
        'pulse-ring': {
          '0%': { boxShadow: '0 0 0 0 rgb(var(--c-danger) / 0.45)' },
          '70%': { boxShadow: '0 0 0 12px rgb(var(--c-danger) / 0)' },
          '100%': { boxShadow: '0 0 0 0 rgb(var(--c-danger) / 0)' },
        },
        shimmer: {
          '100%': { transform: 'translateX(100%)' },
        },
        // The phone nav drawer. Slides from the left edge it is anchored to,
        // so the motion says where it came from and where a tap will send it.
        'slide-in-left': {
          from: { transform: 'translateX(-100%)' },
          to: { transform: 'translateX(0)' },
        },
      },
      animation: {
        'toast-in': 'toast-in 180ms cubic-bezier(0.16, 1, 0.3, 1)',
        'fade-in': 'fade-in 150ms ease-out',
        'slide-up': 'slide-up 200ms cubic-bezier(0.16, 1, 0.3, 1)',
        'pulse-ring': 'pulse-ring 1.8s cubic-bezier(0.66, 0, 0, 1) infinite',
        shimmer: 'shimmer 1.4s infinite',
        'slide-in-left': 'slide-in-left 220ms cubic-bezier(0.16, 1, 0.3, 1)',
      },
    },
  },
  plugins: [],
}
