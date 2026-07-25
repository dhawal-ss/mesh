import type { Config } from 'tailwindcss'

const withAlpha = (variable: string) => `rgb(var(${variable}) / <alpha-value>)`

export default {
  content: ['./src/**/*.{tsx,ts}', './index.html'],
  theme: {
    extend: {
      colors: {
        surface: {
          DEFAULT: withAlpha('--surface-sidebar-rgb'),
          sunken: withAlpha('--surface-sunken-rgb'),
          sidebar: withAlpha('--surface-sidebar-rgb'),
          base: withAlpha('--surface-base-rgb'),
          raised: withAlpha('--surface-raised-rgb'),
          overlay: withAlpha('--surface-overlay-rgb'),
          hover: withAlpha('--surface-hover-rgb'),
          active: withAlpha('--surface-active-rgb'),
          scrim: 'var(--surface-scrim)',
          qr: withAlpha('--surface-qr-rgb'),
        },
        content: {
          DEFAULT: withAlpha('--content-primary-rgb'),
          normal: withAlpha('--content-normal-rgb'),
          secondary: withAlpha('--content-secondary-rgb'),
          muted: withAlpha('--content-muted-rgb'),
          link: withAlpha('--content-link-rgb'),
          'on-accent': withAlpha('--content-on-accent-rgb'),
          'on-status': withAlpha('--content-on-status-rgb'),
        },
        accent: {
          DEFAULT: withAlpha('--accent-rgb'),
          hover: withAlpha('--accent-hover-rgb'),
          muted: withAlpha('--accent-muted-rgb'),
          content: withAlpha('--content-on-accent-rgb'),
        },
        status: {
          success: withAlpha('--success-rgb'),
          danger: withAlpha('--danger-rgb'),
          warning: withAlpha('--warning-rgb'),
          info: withAlpha('--info-rgb'),
          offline: withAlpha('--presence-offline-rgb'),
        },
        scrim: 'var(--surface-scrim)',
        'pane-tint': 'var(--surface-pane-tint)',
        'border-subtle': 'var(--border-subtle)',
        'border-strong': 'var(--border-strong)',

        // Compatibility names. Values live in globals.css.
        'bg-tertiary': withAlpha('--bg-tertiary-rgb'),
        'bg-secondary': withAlpha('--bg-secondary-rgb'),
        'bg-primary': withAlpha('--bg-primary-rgb'),
        'bg-modifier-hover': withAlpha('--bg-modifier-hover-rgb'),
        'bg-modifier-active': withAlpha('--bg-modifier-active-rgb'),
        'bg-modifier-selected': withAlpha('--bg-modifier-selected-rgb'),
        'bg-floating': withAlpha('--bg-floating-rgb'),

        // Legacy aliases used by shared components.
        bg: withAlpha('--surface-base-rgb'),
        'surface-raised': withAlpha('--surface-raised-rgb'),
        'surface-float': withAlpha('--surface-overlay-rgb'),

        // Borders.
        border: withAlpha('--border-default-rgb'),
        'border-light': withAlpha('--border-emphasis-rgb'),

        // Content.
        primary: withAlpha('--content-primary-rgb'),
        secondary: withAlpha('--content-secondary-rgb'),
        muted: withAlpha('--content-muted-rgb'),
        'text-link': withAlpha('--content-link-rgb'),

        // Brand.
        'accent-bright': withAlpha('--accent-hover-rgb'),
        'accent-dim': withAlpha('--accent-muted-rgb'),

        // Status.
        green: withAlpha('--success-rgb'),
        red: withAlpha('--danger-rgb'),
        yellow: withAlpha('--warning-rgb'),
        blue: withAlpha('--info-rgb'),
        danger: withAlpha('--danger-rgb'),
      },
      fontFamily: {
        sans: ['var(--font-sans)'],
        mono: ['var(--font-mono)'],
      },
      fontWeight: {
        normal: 'var(--font-weight-regular)',
        medium: 'var(--font-weight-medium)',
        semibold: 'var(--font-weight-semibold)',
      },
      fontSize: {
        micro: ['var(--font-size-micro)', { lineHeight: 'var(--line-height-micro)' }],
        caption: ['var(--font-size-2xs)', { lineHeight: 'var(--line-height-2xs)' }],
        meta: ['var(--font-size-meta)', { lineHeight: 'var(--line-height-meta)' }],
        code: ['var(--font-size-code)', { lineHeight: 'var(--line-height-code)' }],
        '2xs': ['var(--font-size-2xs)', { lineHeight: 'var(--line-height-2xs)', letterSpacing: 'var(--letter-spacing-2xs)' }],
        'xs': ['var(--font-size-xs)', { lineHeight: 'var(--line-height-xs)' }],
        'sm': ['var(--font-size-sm)', { lineHeight: 'var(--line-height-sm)' }],
        'base': ['var(--font-size-base)', { lineHeight: 'var(--line-height-base)' }],
        'md': ['var(--font-size-md)', { lineHeight: 'var(--line-height-md)' }],
        'lg': ['var(--font-size-lg)', { lineHeight: 'var(--line-height-lg)' }],
      },
      lineHeight: {
        prose: 'var(--line-height-prose)',
      },
      letterSpacing: {
        signal: 'var(--letter-spacing-signal)',
        caption: 'var(--letter-spacing-2xs)',
        eyebrow: 'var(--letter-spacing-eyebrow)',
        section: 'var(--letter-spacing-section)',
        control: 'var(--letter-spacing-control)',
        status: 'var(--letter-spacing-status)',
      },
      borderRadius: {
        DEFAULT: 'var(--radius-default)',
        sm: 'var(--radius-sm)',
        md: 'var(--radius-md)',
        lg: 'var(--radius-lg)',
        xl: 'var(--radius-xl)',
        control: 'var(--radius-control)',
        panel: 'var(--radius-panel)',
        community: 'var(--radius-community-rest)',
        'community-active': 'var(--radius-community-active)',
      },
      spacing: {
        'density-row': 'var(--density-row-block)',
        'control-sm': 'var(--density-control-sm)',
        'control-md': 'var(--density-control-md)',
        'control-lg': 'var(--density-control-lg)',
        'panel-gap': 'var(--density-panel-gap)',
        'message-gutter': 'var(--message-gutter)',
        'message-group': 'var(--message-group-gap)',
        'empty-icon': 'var(--empty-state-icon)',
        'community-marker': 'var(--community-marker)',
        'user-panel': 'var(--user-panel-height)',
        'rail-separator': 'var(--rail-separator-height)',
      },
      width: {
        'member-list': 'var(--member-list-width)',
        'settings-drawer': 'var(--settings-drawer-width)',
        'context-action': 'var(--context-action-width)',
        'file-browser': 'var(--file-browser-width)',
        'content-error': 'var(--content-error-width)',
        'onboarding-shell': 'var(--onboarding-shell-width)',
        'voice-label': 'var(--voice-controls-label-width)',
      },
      maxWidth: {
        'attachment-name': 'var(--attachment-name-width)',
        'onboarding-shell': 'var(--onboarding-shell-width)',
      },
      maxHeight: {
        modal: 'var(--modal-content-height)',
        settings: 'var(--settings-content-height)',
        composer: 'var(--composer-content-height)',
        'file-browser': 'var(--file-browser-height)',
      },
      minHeight: {
        'onboarding-shell': 'var(--onboarding-shell-height)',
        'voice-tile': 'var(--voice-tile-min-height)',
      },
      gridAutoRows: {
        voice: 'minmax(var(--voice-tile-min-height), 1fr)',
      },
      borderWidth: {
        status: 'var(--border-width-status)',
      },
      zIndex: {
        base: 'var(--z-base)',
        sticky: 'var(--z-sticky)',
        dropdown: 'var(--z-dropdown)',
        drawer: 'var(--z-drawer)',
        overlay: 'var(--z-overlay)',
        modal: 'var(--z-modal)',
        popover: 'var(--z-popover)',
        toast: 'var(--z-toast)',
        tooltip: 'var(--z-tooltip)',
      },
      transitionDuration: {
        instant: 'var(--duration-instant)',
        fast: 'var(--duration-fast)',
        normal: 'var(--duration-normal)',
        slow: 'var(--duration-slow)',
      },
      boxShadow: {
        'elevation-low': 'var(--shadow-elevation-low)',
        'elevation-high': 'var(--shadow-elevation-high)',
        floating: 'var(--shadow-floating)',
        pane: 'var(--shadow-pane)',
      },
      animation: {
        'pulse-soft': 'var(--animation-pulse-soft)',
      },
      keyframes: {
        pulseSoft: { '0%, 100%': { opacity: '1' }, '50%': { opacity: '0.4' } },
      },
    },
  },
  plugins: [],
} satisfies Config
