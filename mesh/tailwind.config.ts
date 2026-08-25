import type { Config } from 'tailwindcss'

const withAlpha = (variable: string) => `rgb(var(${variable}) / <alpha-value>)`

export default {
  content: ['./src/**/*.{tsx,ts}', './index.html'],
  theme: {
    extend: {
      colors: {
        surface: {
          DEFAULT: withAlpha('--surface-sidebar-rgb'),
          // `bg-surface-canvas` was already in use in six places and compiled
          // to nothing, so the route canvas fell back to the inherited body
          // color. The token existed; only the export was missing.
          canvas: 'var(--surface-canvas)',
          sunken: withAlpha('--surface-sunken-rgb'),
          sidebar: withAlpha('--surface-sidebar-rgb'),
          base: withAlpha('--surface-base-rgb'),
          raised: withAlpha('--surface-raised-rgb'),
          overlay: withAlpha('--surface-overlay-rgb'),
          hover: withAlpha('--surface-hover-rgb'),
          active: withAlpha('--surface-active-rgb'),
          selected: withAlpha('--surface-selected-rgb'),
          scrim: 'var(--surface-scrim)',
          rail: 'var(--surface-rail)',
          qr: withAlpha('--surface-qr-rgb'),
          // The alpha-white wash an avatar tile, an input ground and a hovered
          // row all share. It composites onto whatever is behind it, so it is
          // a colour rather than a surface with a value of its own.
          fill: 'var(--surface-fill)',
          'fill-hover': 'var(--surface-fill-hover)',
        },
        content: {
          DEFAULT: withAlpha('--content-primary-rgb'),
          // `text-content-primary` reads as the obvious name for the strongest
          // ink and was used as if it existed. Only `text-content` and the
          // legacy `text-primary` did.
          primary: withAlpha('--content-primary-rgb'),
          normal: withAlpha('--content-normal-rgb'),
          secondary: withAlpha('--content-secondary-rgb'),
          // Message prose, one step below primary.
          body: withAlpha('--content-body-rgb'),
          // Supporting metadata. Below the body-text floor, so it is legal at
          // 18px and above and illegal on a 9.5px eyebrow.
          tertiary: withAlpha('--content-tertiary-rgb'),
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
          // Hover faces for solid status fills. Without these, every solid
          // status control invented its own opacity modifier.
          'success-hover': 'var(--status-success-hover)',
          'danger-hover': 'var(--status-danger-hover)',
          'warning-hover': 'var(--status-warning-hover)',
          'info-hover': 'var(--status-info-hover)',
        },
        container: {
          surface: 'var(--surface-container)',
          'surface-hover': 'var(--surface-container-hover)',
          'surface-active': 'var(--surface-container-active)',
          'surface-line': 'var(--surface-container-line)',
          accent: 'var(--accent-container)',
          'accent-hover': 'var(--accent-container-hover)',
          'accent-active': 'var(--accent-container-active)',
          'accent-line': 'var(--accent-container-line)',
          success: 'var(--success-container)',
          'success-hover': 'var(--success-container-hover)',
          'success-active': 'var(--success-container-active)',
          'success-line': 'var(--success-container-line)',
          warning: 'var(--warning-container)',
          'warning-hover': 'var(--warning-container-hover)',
          'warning-active': 'var(--warning-container-active)',
          'warning-line': 'var(--warning-container-line)',
          danger: 'var(--danger-container)',
          'danger-hover': 'var(--danger-container-hover)',
          'danger-active': 'var(--danger-container-active)',
          'danger-line': 'var(--danger-container-line)',
          info: 'var(--info-container)',
          'info-hover': 'var(--info-container-hover)',
          'info-active': 'var(--info-container-active)',
          'info-line': 'var(--info-container-line)',
        },
        'on-container': {
          surface: 'var(--surface-on-container)',
          accent: 'var(--accent-on-container)',
          success: 'var(--success-on-container)',
          warning: 'var(--warning-on-container)',
          danger: 'var(--danger-on-container)',
          info: 'var(--info-on-container)',
        },
        scrim: 'var(--surface-scrim)',
        'pane-tint': 'var(--surface-pane-tint)',
        'border-subtle': 'var(--border-subtle)',
        'border-strong': 'var(--border-strong)',
        // The two structural hairlines. Decorative under WCAG 1.4.11: neither
        // may carry the shape of a control.
        'border-structural': 'var(--border-structural)',
        'border-row': 'var(--border-row)',
        // `border-border-emphasis` was used in nine places, including the
        // community rail hover edge, and resolved to nothing. `border-light`
        // was the only name for it.
        'border-emphasis': withAlpha('--border-emphasis-rgb'),
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
        display: 'var(--font-weight-display)',
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
        // Quiet Structure roles. Mono is only ever eyebrow, count, chip or a
        // machine value; Inter is never uppercased.
        eyebrow: ['var(--font-size-eyebrow)', { lineHeight: 'var(--line-height-eyebrow)', letterSpacing: 'var(--letter-spacing-eyebrow)' }],
        count: ['var(--font-size-count)', { lineHeight: 'var(--line-height-solid)', letterSpacing: 'var(--letter-spacing-count)' }],
        chip: ['var(--font-size-count)', { lineHeight: 'var(--line-height-solid)', letterSpacing: 'var(--letter-spacing-chip)' }],
        support: ['var(--font-size-support)', { lineHeight: 'var(--line-height-support)', letterSpacing: 'var(--letter-spacing-12)' }],
        row: ['var(--font-size-row)', { lineHeight: 'var(--line-height-row)', letterSpacing: 'var(--letter-spacing-row)' }],
        panel: ['var(--font-size-panel)', { lineHeight: 'var(--line-height-15)', letterSpacing: 'var(--letter-spacing-panel)' }],
        body: ['var(--font-size-sm)', { lineHeight: 'var(--line-height-body)', letterSpacing: 'var(--letter-spacing-14)' }],
        section: ['var(--font-size-section)', { lineHeight: 'var(--line-height-solid)', letterSpacing: 'var(--letter-spacing-section)' }],
        numeral: ['var(--font-size-numeral)', { lineHeight: 'var(--line-height-solid)', letterSpacing: 'var(--letter-spacing-screen)' }],
        'screen-sm': ['var(--font-size-screen-sm)', { lineHeight: 'var(--line-height-solid)', letterSpacing: 'var(--letter-spacing-screen)' }],
        screen: ['var(--font-size-screen)', { lineHeight: 'var(--line-height-screen)', letterSpacing: 'var(--letter-spacing-screen)' }],
        display: ['var(--font-size-display)', { lineHeight: 'var(--line-height-solid)', letterSpacing: 'var(--letter-spacing-display)' }],
      },
      lineHeight: {
        prose: 'var(--line-height-prose)',
      },
      letterSpacing: {
        // The exception line opens up so it reads as machine output beside the
        // prose it interrupts.
        chip: 'var(--letter-spacing-chip)',
        // `eyebrow` is the one name. The rest are compatibility aliases for
        // existing call sites and should be codemodded to `tracking-eyebrow`.
        eyebrow: 'var(--letter-spacing-eyebrow)',
        caption: 'var(--letter-spacing-eyebrow)',
        section: 'var(--letter-spacing-eyebrow)',
        signal: 'var(--letter-spacing-eyebrow)',
        control: 'var(--letter-spacing-eyebrow)',
        status: 'var(--letter-spacing-eyebrow)',
      },
      borderRadius: {
        DEFAULT: 'var(--radius-default)',
        // Things you touch get a radius; things that structure do not.
        plane: 'var(--radius-plane)',
        tile: 'var(--radius-tile)',
        segment: 'var(--radius-segment)',
        sm: 'var(--radius-sm)',
        md: 'var(--radius-md)',
        lg: 'var(--radius-lg)',
        control: 'var(--radius-control)',
        panel: 'var(--radius-panel)',
        community: 'var(--radius-community-rest)',
        'community-active': 'var(--radius-community-active)',
        // The circle. Reserved for identity and live points.
        round: 'var(--radius-round)',
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
        'shell-gutter': 'var(--shell-conversation-padding)',
        'shell-message-y': 'var(--shell-message-padding-block)',
        'row-index': 'var(--row-index-width)',
        ledger: 'var(--ledger-row-padding)',
        'message-time': 'var(--message-time-width)',
        'message-rail-gap': 'var(--message-rail-gap)',
      },
      width: {
        'member-list': 'var(--member-list-width)',
        'settings-drawer': 'var(--settings-drawer-width)',
        'context-action': 'var(--context-action-width)',
        'content-error': 'var(--content-error-width)',
        'onboarding-shell': 'var(--onboarding-shell-width)',
        'voice-label': 'var(--voice-controls-label-width)',
        'shell-rail': 'var(--shell-rail-width)',
        'shell-channels': 'var(--shell-channel-width)',
        'shell-roster': 'var(--shell-roster-width)',
        'row-index': 'var(--row-index-width)',
        'message-time': 'var(--message-time-width)',
        'trust-rail': 'var(--trust-rail-width)',
        rule: 'var(--rule-width)',
      },
      maxWidth: {
        'attachment-name': 'var(--attachment-name-width)',
        'onboarding-shell': 'var(--onboarding-shell-width)',
        measure: 'var(--shell-message-measure)',
      },
      maxHeight: {
        modal: 'var(--modal-content-height)',
        settings: 'var(--settings-content-height)',
        composer: 'var(--composer-content-height)',
        'shell-media': 'var(--shell-media-max-height)',
      },
      height: {
        'trust-rail': 'var(--trust-rail-width)',
        rule: 'var(--rule-width)',
        'shell-header': 'var(--shell-header-height)',

        'shell-pin': 'var(--shell-pin-height)',
        'shell-composer': 'var(--shell-composer-height)',
        'shell-strip': 'var(--shell-strip-height)',
        'shell-channel-row': 'var(--shell-channel-row-height)',
        'shell-occupant': 'var(--shell-occupant-row-height)',
      },
      minWidth: {
        'privacy-table': 'var(--privacy-table-width)',
      },
      minHeight: {
        'onboarding-shell': 'var(--onboarding-shell-height)',
        'voice-tile': 'var(--voice-tile-min-height)',
        // Tailwind's minHeight does not inherit the spacing scale, so every
        // control floor a component needs has to be named here or it compiles
        // to nothing and the 32px hit-target contract quietly stops holding.
        'control-sm': 'var(--density-control-sm)',
        'control-md': 'var(--density-control-md)',
        'control-lg': 'var(--density-control-lg)',
        'shell-channel-row': 'var(--shell-channel-row-height)',
      },
      gridAutoRows: {
        voice: 'minmax(var(--voice-tile-min-height), 1fr)',
      },
      gridTemplateColumns: {
        route: 'var(--route-surface-columns)',
        settings: 'var(--settings-layout-columns)',
        'device-code': 'var(--device-code-columns)',
        'device-check': 'var(--device-check-columns)',
        'invitation-confirmation': 'var(--invitation-confirmation-columns)',
      },
      screens: {
        'voice-message': '380px',
        'voice-wide': '1100px',
      },
      borderWidth: {
        status: 'var(--border-width-status)',
        rule: 'var(--rule-width)',
        // The one 2px rule in the system.
        trust: 'var(--trust-rail-width)',
        // Werkstatt's active-marker weight, kept for the components not yet
        // carried into Quiet Structure (EventView, UnreadDivider, Toast,
        // SearchBar, CreateCommunityModal).
        bar: 'var(--border-width-bar)',
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
        slow: 'var(--motion-dur-deliberate)',
      },
      transitionTimingFunction: {
        DEFAULT: 'var(--ref-ease-hover)',
        enter: 'var(--motion-ease-arrive)',
        exit: 'var(--motion-ease-arrive)',
        move: 'var(--motion-ease-reposition)',
      },
      animation: {
        spin: 'spin var(--motion-dur-activity) linear infinite',
        pulse: 'pulse var(--motion-dur-highlight) var(--ref-ease-hover) infinite',
        bounce: 'bounce var(--motion-dur-activity) infinite',
        highlight: 'pulse var(--motion-dur-highlight) var(--ref-ease-hover) 1',
      },
      boxShadow: {
        overlay: 'var(--elev-overlay)',
      },
    },
  },
  plugins: [],
} satisfies Config
