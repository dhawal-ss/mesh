import type { Config } from 'tailwindcss'

export default {
  content: ['./src/**/*.{tsx,ts}', './index.html'],
  theme: {
    extend: {
      colors: {
        // ── Surface hierarchy ──
        'bg-tertiary': '#1e1f22',
        'bg-secondary': '#2b2d31',
        'bg-primary': '#313338',
        'bg-modifier-hover': '#2e3035',
        'bg-modifier-active': '#404249',
        'bg-modifier-selected': '#404249',
        'bg-floating': '#111214',

        // ── Legacy aliases (used by shared components) ──
        bg: '#313338',
        surface: '#2b2d31',
        'surface-raised': '#35373c',
        'surface-float': '#111214',

        // ── Borders ──
        border: '#3f4147',
        'border-light': '#4e5058',

        // ── Text ──
        primary: '#f2f3f5',
        secondary: '#b5bac1',
        muted: '#949ba4',
        'text-link': '#00a8fc',

        // ── Accent (warm gold — Mesh brand) ──
        accent: '#d4c0a1',
        'accent-bright': '#efe0c3',
        'accent-dim': '#8d7d67',

        // ── Status ──
        green: '#23a559',
        red: '#da373c',
        yellow: '#f0b232',
        blue: '#5865f2',
        danger: '#da373c',
      },
      fontFamily: {
        sans: ['Inter', 'gg sans', 'system-ui', '-apple-system', 'BlinkMacSystemFont', 'sans-serif'],
        mono: ['Consolas', 'Andale Mono WT', 'Andale Mono', 'Menlo', 'monospace'],
      },
      fontSize: {
        '2xs': ['10px', { lineHeight: '1.4', letterSpacing: '0.02em' }],
        'xs':  ['12px', { lineHeight: '1.35' }],
        'sm':  ['14px', { lineHeight: '1.375' }],
        'base': ['16px', { lineHeight: '1.375' }],
        'md':  ['20px', { lineHeight: '1.3' }],
        'lg':  ['24px', { lineHeight: '1.25' }],
      },
      borderRadius: {
        DEFAULT: '4px',
        sm: '3px',
        md: '4px',
        lg: '8px',
        xl: '16px',
      },
      boxShadow: {
        'elevation-low': '0 1px 0 rgba(0, 0, 0, 0.2), 0 1.5px 0 rgba(0, 0, 0, 0.05), 0 2px 0 rgba(0, 0, 0, 0.05)',
        'elevation-high': '0 8px 16px rgba(0, 0, 0, 0.24)',
        floating: '0 0 0 1px rgba(0, 0, 0, 0.15), 0 8px 16px rgba(0, 0, 0, 0.3)',
        pane: '0 8px 16px rgba(0, 0, 0, 0.24)',
      },
      animation: {
        'pulse-soft': 'pulseSoft 2s ease infinite',
      },
      keyframes: {
        pulseSoft: { '0%, 100%': { opacity: '1' }, '50%': { opacity: '0.4' } },
      },
    },
  },
  plugins: [],
} satisfies Config
