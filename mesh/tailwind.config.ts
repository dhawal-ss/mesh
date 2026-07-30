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
          accent: withAlpha('--content-accent-rgb'),
          'on-accent': withAlpha('--content-on-accent-rgb'),
          'on-status': withAlpha('--content-on-status-rgb'),
          'on-avatar': withAlpha('--content-on-avatar-rgb'),
          'on-media-overlay': withAlpha('--content-on-media-overlay-rgb'),
        },
        accent: {
          DEFAULT: withAlpha('--accent-rgb'),
          hover: withAlpha('--accent-hover-rgb'),
          muted: withAlpha('--accent-muted-rgb'),
          content: withAlpha('--content-on-accent-rgb'),
        },
        status: {
          success: withAlpha('--status-success-rgb'),
          danger: withAlpha('--status-danger-rgb'),
          warning: withAlpha('--status-warning-rgb'),
          info: withAlpha('--status-info-rgb'),
          offline: withAlpha('--presence-offline-rgb'),
        },
        scrim: 'var(--surface-scrim)',
        'pane-tint': 'var(--surface-pane-tint)',
        'border-subtle': 'var(--border-subtle)',
        'border-strong': 'var(--border-strong)',
        focus: withAlpha('--border-focus-rgb'),

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
        // 3:1 boundary for controls whose shape is not conveyed by a fill.
        'border-control': withAlpha('--border-control-rgb'),

        // Content.
        primary: withAlpha('--content-primary-rgb'),
        secondary: withAlpha('--content-secondary-rgb'),
        muted: withAlpha('--content-muted-rgb'),
        'text-link': withAlpha('--content-link-rgb'),

        // Brand.
        'accent-bright': withAlpha('--accent-hover-rgb'),
        'accent-dim': withAlpha('--accent-muted-rgb'),

        // Status.
        green: withAlpha('--status-success-rgb'),
        red: withAlpha('--status-danger-rgb'),
        yellow: withAlpha('--status-warning-rgb'),
        blue: withAlpha('--status-info-rgb'),
        danger: withAlpha('--status-danger-rgb'),
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
        micro: ['var(--font-size-2xs)', { lineHeight: 'var(--line-height-11)', letterSpacing: 'var(--letter-spacing-11)' }],
        caption: ['var(--font-size-2xs)', { lineHeight: 'var(--line-height-11)', letterSpacing: 'var(--letter-spacing-11)' }],
        meta: ['var(--font-size-xs)', { lineHeight: 'var(--line-height-12)', letterSpacing: 'var(--letter-spacing-12)' }],
        code: ['var(--font-size-code)', { lineHeight: 'var(--line-height-13)', letterSpacing: 'var(--letter-spacing-13)' }],
        '2xs': ['var(--font-size-2xs)', { lineHeight: 'var(--line-height-11)', letterSpacing: 'var(--letter-spacing-11)' }],
        xs: ['var(--font-size-xs)', { lineHeight: 'var(--line-height-12)', letterSpacing: 'var(--letter-spacing-12)' }],
        dense: ['var(--font-size-dense)', { lineHeight: 'var(--line-height-13)', letterSpacing: 'var(--letter-spacing-13)' }],
        sm: ['var(--font-size-sm)', { lineHeight: 'var(--line-height-14)', letterSpacing: 'var(--letter-spacing-14)' }],
        base: ['var(--font-size-base)', { lineHeight: 'var(--line-height-15)', letterSpacing: 'var(--letter-spacing-15)' }],
        md: ['var(--font-size-md)', { lineHeight: 'var(--line-height-18)', letterSpacing: 'var(--letter-spacing-18)' }],
        title: ['var(--font-size-title)', { lineHeight: 'var(--line-height-22)', letterSpacing: 'var(--letter-spacing-22)' }],
        lg: ['var(--font-size-lg)', { lineHeight: 'var(--line-height-28)', letterSpacing: 'var(--letter-spacing-28)' }],
      },
      lineHeight: {
        prose: 'var(--line-height-prose)',
      },
      letterSpacing: {
        caption: 'var(--letter-spacing-11)',
        eyebrow: 'var(--letter-spacing-11)',
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
        'conversation-header': 'var(--conversation-header-height)',
        'rail-separator': 'var(--rail-separator-height)',
      },
      width: {
        'member-list': 'var(--member-list-width)',
        'settings-drawer': 'var(--settings-drawer-width)',
        'context-action': 'var(--context-action-width)',
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
      },
      minWidth: {
        'privacy-table': 'var(--privacy-table-width)',
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
        instant: 'var(--motion-dur-micro)',
        fast: 'var(--motion-dur-fast)',
        normal: 'var(--motion-dur-base)',
        slow: 'var(--motion-dur-slow)',
      },
      transitionTimingFunction: {
        DEFAULT: 'var(--motion-ease-hover)',
        enter: 'var(--motion-ease-enter)',
        exit: 'var(--motion-ease-exit)',
        move: 'var(--motion-ease-move)',
      },
      boxShadow: {
        overlay: 'var(--elev-overlay)',
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
