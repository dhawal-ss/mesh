import type { Config } from 'tailwindcss'

const withAlpha = (variable: string) => `rgb(var(${variable}) / <alpha-value>)`

/*
  Every token added to globals.css has to be exported here or the utility that
  consumes it compiles to nothing: an undefined utility is not an error at
  build time, at type-check time, or at runtime, and `bg-surface-canvas` and
  `text-content-primary` both resolved to nothing for months on exactly that.
  check-design-tokens.mjs resolves every class in the renderer against this
  file, so a missing export fails loudly now.

  The blocks marked "migration scaffolding" are the Quiet Structure class names
  re-pointed at their Material 3 replacements. They exist so the renderer keeps
  compiling while its 86 files are codemodded surface by surface, and they are
  deleted in one commit at the end of that pass so anything missed breaks
  loudly rather than silently keeping the old look.
*/
export default {
  content: ['./src/**/*.{tsx,ts}', './index.html'],
  theme: {
    extend: {
      colors: {
        // ── Material 3 surface tones ──────────────────────────────────────
        surface: {
          DEFAULT: withAlpha('--surface-rgb'),
          'container-lowest': withAlpha('--surface-container-lowest-rgb'),
          'container-low': withAlpha('--surface-container-low-rgb'),
          container: withAlpha('--surface-container-rgb'),
          'container-high': withAlpha('--surface-container-high-rgb'),
          'container-highest': withAlpha('--surface-container-highest-rgb'),
          scrim: 'var(--surface-scrim)',
          'nav-scrim': 'var(--surface-nav-scrim)',
          qr: withAlpha('--surface-qr-rgb'),
          inverse: withAlpha('--inverse-surface-rgb'),

          // Migration scaffolding.
          canvas: withAlpha('--surface-rgb'),
          base: withAlpha('--surface-rgb'),
          sunken: withAlpha('--surface-container-lowest-rgb'),
          sidebar: withAlpha('--surface-container-low-rgb'),
          rail: withAlpha('--surface-container-lowest-rgb'),
          raised: withAlpha('--surface-container-rgb'),
          overlay: withAlpha('--surface-container-high-rgb'),
          hover: withAlpha('--surface-container-high-rgb'),
          active: withAlpha('--surface-container-highest-rgb'),
          selected: withAlpha('--secondary-container-rgb'),
          /*
            --surface-fill was translucent: the comment on it said it was what
            to reach for where the wash has to composite onto something other
            than the canvas. Twenty of its twenty-one call sites are `hover:`,
            so it lands on the state layer rather than on an opaque tone, which
            is both the M3 answer and the only one that still reads as a hover
            on a row that already sits on a container.
          */
          fill: 'var(--state-layer-hover)',
          'fill-hover': 'var(--state-layer-pressed)',
        },

        // ── Material 3 foreground roles ───────────────────────────────────
        'on-surface': {
          DEFAULT: withAlpha('--on-surface-rgb'),
          variant: withAlpha('--on-surface-variant-rgb'),
          inverse: withAlpha('--on-inverse-surface-rgb'),
        },
        outline: {
          DEFAULT: withAlpha('--outline-rgb'),
          variant: withAlpha('--outline-variant-rgb'),
        },

        // ── The three colour families ─────────────────────────────────────
        primary: {
          DEFAULT: withAlpha('--primary-rgb'),
          hover: 'var(--primary-hover)',
          container: withAlpha('--primary-container-rgb'),
          'container-hover': 'var(--primary-container-hover)',
          'container-active': 'var(--primary-container-active)',
          'container-line': 'var(--primary-container-line)',
        },
        'on-primary': {
          DEFAULT: withAlpha('--on-primary-rgb'),
          container: withAlpha('--on-primary-container-rgb'),
        },
        secondary: {
          // `text-secondary` is supporting text, not the secondary container.
          DEFAULT: withAlpha('--on-surface-variant-rgb'),
          container: withAlpha('--secondary-container-rgb'),
          'container-hover': 'var(--secondary-container-hover)',
          'container-active': 'var(--secondary-container-active)',
          'container-line': 'var(--secondary-container-line)',
        },
        'on-secondary': {
          container: withAlpha('--on-secondary-container-rgb'),
        },
        error: {
          DEFAULT: withAlpha('--error-rgb'),
          hover: 'var(--error-hover)',
          container: withAlpha('--error-container-rgb'),
          'container-hover': 'var(--error-container-hover)',
          'container-active': 'var(--error-container-active)',
          'container-line': 'var(--error-container-line)',
        },
        'on-error': {
          DEFAULT: withAlpha('--on-error-rgb'),
          container: withAlpha('--on-error-container-rgb'),
        },
        marker: {
          DEFAULT: withAlpha('--marker-rgb'),
          hover: 'var(--marker-hover)',
          container: withAlpha('--marker-container-rgb'),
          'container-hover': 'var(--marker-container-hover)',
          'container-active': 'var(--marker-container-active)',
          'container-line': 'var(--marker-container-line)',
        },
        'on-marker': {
          DEFAULT: withAlpha('--on-marker-rgb'),
          container: withAlpha('--on-marker-container-rgb'),
        },

        // ── State layers, focus, and the remaining component roles ────────
        state: {
          hover: 'var(--state-layer-hover)',
          focus: 'var(--state-layer-focus)',
          pressed: 'var(--state-layer-pressed)',
        },
        focus: withAlpha('--border-focus-rgb'),
        offline: withAlpha('--presence-offline-rgb'),
        'on-avatar': withAlpha('--on-avatar-rgb'),
        'on-media-overlay': withAlpha('--on-media-overlay-rgb'),
        scrim: 'var(--surface-scrim)',

        /*
          Migration scaffolding: the Quiet Structure colour names, re-pointed.

          Green is not in this list. --status-success resolved to a green that
          this contract removes from the product, so every call site that asked
          for it now gets --primary and reads as structure rather than as a
          second, quieter kind of success.
        */
        content: {
          DEFAULT: withAlpha('--on-surface-rgb'),
          primary: withAlpha('--on-surface-rgb'),
          normal: withAlpha('--on-surface-rgb'),
          body: withAlpha('--on-surface-rgb'),
          secondary: withAlpha('--on-surface-variant-rgb'),
          muted: withAlpha('--on-surface-variant-rgb'),
          tertiary: withAlpha('--outline-rgb'),
          link: withAlpha('--primary-rgb'),
          accent: withAlpha('--primary-rgb'),
          'on-accent': withAlpha('--on-primary-rgb'),
          'on-status': withAlpha('--on-error-rgb'),
          'on-avatar': withAlpha('--on-avatar-rgb'),
          'on-media-overlay': withAlpha('--on-media-overlay-rgb'),
        },
        accent: {
          DEFAULT: withAlpha('--primary-rgb'),
          hover: withAlpha('--primary-rgb'),
          muted: withAlpha('--primary-container-rgb'),
          content: withAlpha('--on-primary-rgb'),
        },
        status: {
          success: withAlpha('--primary-rgb'),
          danger: withAlpha('--error-rgb'),
          warning: withAlpha('--marker-rgb'),
          info: withAlpha('--primary-rgb'),
          offline: withAlpha('--presence-offline-rgb'),
          'success-hover': withAlpha('--primary-rgb'),
          'danger-hover': withAlpha('--error-rgb'),
          'warning-hover': withAlpha('--marker-rgb'),
          'info-hover': withAlpha('--primary-rgb'),
        },
        container: {
          surface: withAlpha('--surface-container-rgb'),
          'surface-hover': withAlpha('--surface-container-high-rgb'),
          'surface-active': withAlpha('--surface-container-highest-rgb'),
          'surface-line': withAlpha('--outline-variant-rgb'),
          accent: withAlpha('--primary-container-rgb'),
          'accent-hover': 'var(--primary-container-hover)',
          'accent-active': 'var(--primary-container-active)',
          'accent-line': 'var(--primary-container-line)',
          success: withAlpha('--primary-container-rgb'),
          'success-hover': 'var(--primary-container-hover)',
          'success-active': 'var(--primary-container-active)',
          'success-line': 'var(--primary-container-line)',
          warning: withAlpha('--marker-container-rgb'),
          'warning-hover': 'var(--marker-container-hover)',
          'warning-active': 'var(--marker-container-active)',
          'warning-line': 'var(--marker-container-line)',
          danger: withAlpha('--error-container-rgb'),
          'danger-hover': 'var(--error-container-hover)',
          'danger-active': 'var(--error-container-active)',
          'danger-line': 'var(--error-container-line)',
          info: withAlpha('--primary-container-rgb'),
          'info-hover': 'var(--primary-container-hover)',
          'info-active': 'var(--primary-container-active)',
          'info-line': 'var(--primary-container-line)',
        },
        'on-container': {
          surface: withAlpha('--on-surface-rgb'),
          accent: withAlpha('--on-primary-container-rgb'),
          success: withAlpha('--on-primary-container-rgb'),
          warning: withAlpha('--on-marker-container-rgb'),
          danger: withAlpha('--on-error-container-rgb'),
          info: withAlpha('--on-primary-container-rgb'),
        },
        'border-subtle': withAlpha('--outline-variant-rgb'),
        'border-strong': withAlpha('--outline-rgb'),
        'border-structural': withAlpha('--outline-variant-rgb'),
        'border-row': withAlpha('--outline-variant-rgb'),
        'border-emphasis': withAlpha('--outline-rgb'),
        'border-control': withAlpha('--outline-rgb'),
        border: withAlpha('--outline-rgb'),
        'border-light': withAlpha('--outline-rgb'),
        bg: withAlpha('--surface-rgb'),
        'surface-raised': withAlpha('--surface-container-rgb'),
        'surface-float': withAlpha('--surface-container-high-rgb'),
        'bg-tertiary': withAlpha('--surface-container-lowest-rgb'),
        'bg-secondary': withAlpha('--surface-container-low-rgb'),
        'bg-primary': withAlpha('--surface-rgb'),
        'bg-modifier-hover': withAlpha('--surface-container-high-rgb'),
        'bg-modifier-active': withAlpha('--surface-container-highest-rgb'),
        'bg-modifier-selected': withAlpha('--secondary-container-rgb'),
        'bg-floating': withAlpha('--surface-container-high-rgb'),
        muted: withAlpha('--on-surface-variant-rgb'),
        'text-link': withAlpha('--primary-rgb'),
        'accent-bright': withAlpha('--primary-rgb'),
        'accent-dim': withAlpha('--primary-container-rgb'),
        green: withAlpha('--primary-rgb'),
        red: withAlpha('--error-rgb'),
        yellow: withAlpha('--marker-rgb'),
        blue: withAlpha('--primary-rgb'),
        danger: withAlpha('--error-rgb'),
      },
      fontFamily: {
        sans: ['var(--font-sans)'],
        // A machine value a person copies. There is no vendored mono family.
        code: ['var(--font-code)'],
      },
      fontWeight: {
        normal: 'var(--font-weight-regular)',
        medium: 'var(--font-weight-medium)',
        semibold: 'var(--font-weight-semibold)',
      },
      fontSize: {
        // ── The thirteen Material 3 roles. The scale is closed. ───────────
        'display-lg': ['var(--type-display-lg)', { lineHeight: 'var(--type-line-display-lg)', letterSpacing: 'var(--type-track-display-lg)', fontWeight: 'var(--font-weight-regular)' }],
        'display-sm': ['var(--type-display-sm)', { lineHeight: 'var(--type-line-display-sm)', letterSpacing: '0', fontWeight: 'var(--font-weight-regular)' }],
        'headline-lg': ['var(--type-headline-lg)', { lineHeight: 'var(--type-line-headline-lg)', letterSpacing: '0', fontWeight: 'var(--font-weight-regular)' }],
        'headline-md': ['var(--type-headline-md)', { lineHeight: 'var(--type-line-headline-md)', letterSpacing: '0', fontWeight: 'var(--font-weight-regular)' }],
        'title-lg': ['var(--type-title-lg)', { lineHeight: 'var(--type-line-title-lg)', letterSpacing: '0', fontWeight: 'var(--font-weight-regular)' }],
        'title-md': ['var(--type-title-md)', { lineHeight: 'var(--type-line-title-md)', letterSpacing: 'var(--type-track-title-md)', fontWeight: 'var(--font-weight-medium)' }],
        'title-sm': ['var(--type-title-sm)', { lineHeight: 'var(--type-line-title-sm)', letterSpacing: 'var(--type-track-title-sm)', fontWeight: 'var(--font-weight-medium)' }],
        'body-lg': ['var(--type-body-lg)', { lineHeight: 'var(--type-line-body-lg)', letterSpacing: 'var(--type-track-body-lg)', fontWeight: 'var(--font-weight-regular)' }],
        'body-md': ['var(--type-body-md)', { lineHeight: 'var(--type-line-body-md)', letterSpacing: 'var(--type-track-body-md)', fontWeight: 'var(--font-weight-regular)' }],
        'body-sm': ['var(--type-body-sm)', { lineHeight: 'var(--type-line-body-sm)', letterSpacing: 'var(--type-track-body-sm)', fontWeight: 'var(--font-weight-regular)' }],
        'label-lg': ['var(--type-label-lg)', { lineHeight: 'var(--type-line-label-lg)', letterSpacing: 'var(--type-track-label-lg)', fontWeight: 'var(--font-weight-medium)' }],
        'label-md': ['var(--type-label-md)', { lineHeight: 'var(--type-line-label-md)', letterSpacing: 'var(--type-track-label-md)', fontWeight: 'var(--font-weight-medium)' }],
        'label-sm': ['var(--type-label-sm)', { lineHeight: 'var(--type-line-label-sm)', letterSpacing: 'var(--type-track-label-sm)', fontWeight: 'var(--font-weight-medium)' }],

        // Migration scaffolding: the old steps, folded onto the nearest role.
        micro: ['var(--type-label-sm)', { lineHeight: 'var(--type-line-label-sm)', letterSpacing: 'var(--type-track-label-sm)' }],
        caption: ['var(--type-label-sm)', { lineHeight: 'var(--type-line-label-sm)', letterSpacing: 'var(--type-track-label-sm)' }],
        eyebrow: ['var(--type-label-sm)', { lineHeight: 'var(--type-line-label-sm)', letterSpacing: 'var(--type-track-label-sm)' }],
        count: ['var(--type-label-sm)', { lineHeight: 'var(--type-line-label-sm)', letterSpacing: 'var(--type-track-label-sm)' }],
        chip: ['var(--type-label-md)', { lineHeight: 'var(--type-line-label-md)', letterSpacing: 'var(--type-track-label-md)' }],
        '2xs': ['var(--type-label-sm)', { lineHeight: 'var(--type-line-label-sm)', letterSpacing: 'var(--type-track-label-sm)' }],
        meta: ['var(--type-body-sm)', { lineHeight: 'var(--type-line-body-sm)', letterSpacing: 'var(--type-track-body-sm)' }],
        xs: ['var(--type-body-sm)', { lineHeight: 'var(--type-line-body-sm)', letterSpacing: 'var(--type-track-body-sm)' }],
        support: ['var(--type-body-sm)', { lineHeight: 'var(--type-line-body-sm)', letterSpacing: 'var(--type-track-body-sm)' }],
        code: ['var(--type-body-md)', { lineHeight: 'var(--type-line-body-md)', letterSpacing: 'var(--type-track-body-md)' }],
        dense: ['var(--type-body-md)', { lineHeight: 'var(--type-line-body-md)', letterSpacing: 'var(--type-track-body-md)' }],
        sm: ['var(--type-body-md)', { lineHeight: 'var(--type-line-body-md)', letterSpacing: 'var(--type-track-body-md)' }],
        body: ['var(--type-body-md)', { lineHeight: 'var(--type-line-body-md)', letterSpacing: 'var(--type-track-body-md)' }],
        base: ['var(--type-body-lg)', { lineHeight: 'var(--type-line-body-lg)', letterSpacing: 'var(--type-track-body-lg)' }],
        row: ['var(--type-title-md)', { lineHeight: 'var(--type-line-title-md)', letterSpacing: 'var(--type-track-title-md)' }],
        md: ['var(--type-title-lg)', { lineHeight: 'var(--type-line-title-lg)', letterSpacing: '0' }],
        title: ['var(--type-title-lg)', { lineHeight: 'var(--type-line-title-lg)', letterSpacing: '0' }],
        panel: ['var(--type-title-lg)', { lineHeight: 'var(--type-line-title-lg)', letterSpacing: '0' }],
        lg: ['var(--type-headline-md)', { lineHeight: 'var(--type-line-headline-md)', letterSpacing: '0' }],
        section: ['var(--type-headline-md)', { lineHeight: 'var(--type-line-headline-md)', letterSpacing: '0' }],
        screen: ['var(--type-headline-lg)', { lineHeight: 'var(--type-line-headline-lg)', letterSpacing: '0' }],
        numeral: ['var(--type-display-sm)', { lineHeight: 'var(--type-line-display-sm)', letterSpacing: '0' }],
        'screen-sm': ['var(--type-display-sm)', { lineHeight: 'var(--type-line-display-sm)', letterSpacing: '0' }],
        display: ['var(--type-display-lg)', { lineHeight: 'var(--type-line-display-lg)', letterSpacing: 'var(--type-track-display-lg)' }],
      },
      lineHeight: {
        prose: 'var(--line-height-prose)',
        solid: 'var(--line-height-solid)',
      },
      letterSpacing: {
        'display-lg': 'var(--type-track-display-lg)',
        'title-md': 'var(--type-track-title-md)',
        'title-sm': 'var(--type-track-title-sm)',
        'body-lg': 'var(--type-track-body-lg)',
        'body-md': 'var(--type-track-body-md)',
        'body-sm': 'var(--type-track-body-sm)',
        'label-lg': 'var(--type-track-label-lg)',
        'label-md': 'var(--type-track-label-md)',
        'label-sm': 'var(--type-track-label-sm)',

        // Migration scaffolding. Nothing is uppercased any more, so every one
        // of these resolves to a label tracking rather than the 0.16em the
        // mono eyebrow used to carry.
        chip: 'var(--type-track-label-md)',
        eyebrow: 'var(--type-track-label-md)',
        caption: 'var(--type-track-label-md)',
        section: 'var(--type-track-label-md)',
        signal: 'var(--type-track-label-md)',
        control: 'var(--type-track-label-md)',
        status: 'var(--type-track-label-md)',
      },
      borderRadius: {
        DEFAULT: 'var(--shape-sm)',
        none: 'var(--shape-none)',
        xs: 'var(--shape-xs)',
        sm: 'var(--shape-sm)',
        md: 'var(--shape-md)',
        lg: 'var(--shape-lg)',
        'lg-inc': 'var(--shape-lg-inc)',
        xl: 'var(--shape-xl)',
        'xl-inc': 'var(--shape-xl-inc)',
        full: 'var(--shape-full)',
        round: 'var(--shape-round)',
        pane: 'var(--shell-pane-radius)',

        // Migration scaffolding.
        plane: 'var(--shape-full)',
        tile: 'var(--shape-lg)',
        segment: 'var(--shape-full)',
        control: 'var(--shape-full)',
        panel: 'var(--shape-xl)',
        community: 'var(--shape-round)',
        'community-active': 'var(--shape-lg)',
      },
      boxShadow: {
        none: 'var(--elev-0)',
        'elev-0': 'var(--elev-0)',
        'elev-1': 'var(--elev-1)',
        'elev-2': 'var(--elev-2)',
        'elev-3': 'var(--elev-3)',
        'elev-4': 'var(--elev-4)',
        'elev-5': 'var(--elev-5)',

        // Migration scaffolding.
        overlay: 'var(--elev-3)',
      },
      spacing: {
        'density-row': 'var(--density-row-block)',
        'control-sm': 'var(--density-control-sm)',
        'control-md': 'var(--density-control-md)',
        'control-lg': 'var(--density-control-lg)',
        'panel-gap': 'var(--density-panel-gap)',
        'pane-gap': 'var(--shell-pane-gap)',
        'message-group': 'var(--message-group-gap)',
        'empty-icon': 'var(--empty-state-icon)',
        'user-panel': 'var(--user-panel-height)',
        'conversation-header': 'var(--conversation-header-height)',
        'shell-message-y': 'var(--shell-message-padding-block)',

        /*
          Migration scaffolding. These are lengths, not tokens: the custom
          properties behind them measured a hairline, a row-number gutter, a
          fixed timestamp column and a 28px conversation padding, and all four
          are things this contract no longer draws. They are written as
          literals here so the call sites keep compiling and so the next reader
          can see there is no token left to reach for.
        */
        'shell-gutter': '20px',
        ledger: '8px',
        'row-index': '34px',
        'message-time': '44px',
        'message-rail-gap': '20px',
        'community-marker': '3px',
        'rail-separator': '2px',
      },
      width: {
        'member-list': 'var(--member-list-width)',
        'settings-drawer': 'var(--settings-drawer-width)',
        'context-action': 'var(--context-action-width)',
        'content-error': 'var(--content-error-width)',
        'onboarding-shell': 'var(--onboarding-shell-width)',
        'voice-label': 'var(--voice-controls-label-width)',
        'shell-rail': 'var(--shell-rail-width)',
        'shell-list': 'var(--shell-list-width)',
        'shell-roster': 'var(--shell-roster-width)',

        // Migration scaffolding.
        'row-index': '34px',
        'message-time': '44px',
        'trust-rail': '2px',
        rule: '1px',
      },
      maxWidth: {
        'attachment-name': 'var(--attachment-name-width)',
        'onboarding-shell': 'var(--onboarding-shell-width)',
        measure: 'var(--shell-message-measure)',
        bubble: 'var(--shell-bubble-measure)',
      },
      maxHeight: {
        modal: 'var(--modal-content-height)',
        settings: 'var(--settings-content-height)',
        composer: 'var(--composer-content-height)',
        'shell-media': 'var(--shell-media-max-height)',
      },
      height: {
        'shell-header': 'var(--shell-header-height)',
        'shell-pin': 'var(--shell-pin-height)',
        'shell-composer': 'var(--shell-composer-height)',
        'shell-strip': 'var(--shell-strip-height)',
        'shell-channel-row': 'var(--shell-channel-row-height)',
        'shell-occupant': 'var(--shell-occupant-row-height)',

        // Migration scaffolding.
        'trust-rail': '2px',
        rule: '1px',
      },
      minWidth: {
        'privacy-table': 'var(--privacy-table-width)',
      },
      minHeight: {
        'onboarding-shell': 'var(--onboarding-shell-height)',
        'voice-tile': 'var(--voice-tile-min-height)',
        // Tailwind's minHeight does not inherit the spacing scale, so every
        // control floor a component needs has to be named here or it compiles
        // to nothing and the hit-target contract quietly stops holding.
        'control-sm': 'var(--density-control-sm)',
        'control-md': 'var(--density-control-md)',
        'control-lg': 'var(--density-control-lg)',
        'shell-channel-row': 'var(--shell-channel-row-height)',
        'shell-pin': 'var(--shell-pin-height)',
      },
      gridAutoRows: {
        voice: 'minmax(var(--voice-tile-min-height), 1fr)',
      },
      gridTemplateColumns: {
        route: 'var(--route-surface-columns)',
        settings: 'var(--settings-drawer-width) minmax(0, 1fr)',
        'device-code': 'var(--device-code-columns)',
        'invitation-confirmation': 'var(--invitation-confirmation-columns)',
      },
      screens: {
        'voice-message': '380px',
        'voice-wide': '1100px',
      },
      borderWidth: {
        status: 'var(--border-width-status)',
        bar: 'var(--border-width-bar)',

        // Migration scaffolding: the hairline and the trust rail.
        rule: '1px',
        trust: '2px',
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
    },
  },
  plugins: [],
} satisfies Config
