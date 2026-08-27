import { forwardRef } from 'react'
import clsx from 'clsx'
import { Icon } from './Icon'
import { controlHeightClasses, type UiSize as ControlSize } from './controlGeometry'

/*
  Four tones, and no more. Colour is spent on two jobs in this contract, so
  there is no success tone and no warning tone: green left the product, and a
  warning that earns its own control is an exception, which is what `danger`
  is. `marker` is amber, and it means pinned or live.
*/
export type UiTone = 'neutral' | 'accent' | 'danger' | 'marker'
export type UiSize = ControlSize

/**
 * The five Material 3 buttons, in the order they compete for attention.
 *
 * `primary`, `secondary`, `solid`, `soft` and `ghost` are the previous
 * system's names and are kept as aliases so the renderer's call sites keep
 * compiling while they are migrated; each resolves to whichever of the five it
 * always meant.
 */
export type ButtonVariant =
  | 'filled'
  | 'tonal'
  | 'outlined'
  | 'text'
  | 'elevated'
  | 'solid'
  | 'soft'
  | 'outline'
  | 'ghost'
  | 'primary'
  | 'secondary'

type ResolvedVariant = 'filled' | 'tonal' | 'outlined' | 'text' | 'elevated'

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  tone?: UiTone
  size?: UiSize
  /**
   * Shows an inline spinner, marks the control `aria-busy`, and suppresses
   * activation while the work is in flight. Preserves the button geometry and
   * label so the process is named rather than hidden (design state contract).
   */
  loading?: boolean
}

const VARIANT_ALIASES: Record<ButtonVariant, ResolvedVariant> = {
  filled: 'filled',
  tonal: 'tonal',
  outlined: 'outlined',
  text: 'text',
  elevated: 'elevated',
  solid: 'filled',
  primary: 'filled',
  soft: 'tonal',
  secondary: 'tonal',
  outline: 'outlined',
  ghost: 'text',
}

const toneClasses: Record<UiTone, Record<ResolvedVariant, string>> = {
  neutral: {
    filled: 'bg-on-surface text-surface hover:bg-on-surface-variant',
    tonal: 'bg-surface-container-high text-on-surface hover:bg-surface-container-highest',
    outlined: 'border border-outline text-on-surface hover:bg-state-hover',
    text: 'text-on-surface-variant hover:bg-state-hover hover:text-on-surface',
    elevated: 'bg-surface-container-low text-on-surface shadow-elev-1 hover:bg-surface-container',
  },
  accent: {
    filled: 'bg-primary text-on-primary hover:bg-primary-container-hover',
    tonal: 'bg-primary-container text-on-primary-container hover:bg-primary-container-hover',
    outlined: 'border border-outline text-primary hover:bg-state-hover',
    text: 'text-primary hover:bg-state-hover',
    elevated: 'bg-surface-container-low text-primary shadow-elev-1 hover:bg-surface-container',
  },
  danger: {
    filled: 'bg-error text-on-error hover:bg-error-container-hover',
    tonal: 'bg-error-container text-on-error-container hover:bg-error-container-hover',
    outlined: 'border border-error-container-line text-error hover:bg-state-hover',
    text: 'text-error hover:bg-state-hover',
    elevated: 'bg-surface-container-low text-error shadow-elev-1 hover:bg-surface-container',
  },
  marker: {
    filled: 'bg-marker text-on-marker hover:bg-marker-container-hover',
    tonal: 'bg-marker-container text-on-marker-container hover:bg-marker-container-hover',
    outlined: 'border border-marker-container-line text-marker hover:bg-state-hover',
    text: 'text-marker hover:bg-state-hover',
    elevated: 'bg-surface-container-low text-marker shadow-elev-1 hover:bg-surface-container',
  },
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ variant = 'filled', tone, size = 'md', className, children, type = 'button', loading = false, disabled, ...props }, ref) => {
    const resolvedVariant = VARIANT_ALIASES[variant] ?? 'filled'
    const resolvedTone = tone ?? (resolvedVariant === 'filled' && variant !== 'solid' ? 'accent' : 'neutral')

    return (
      <button
        ref={ref}
        type={type}
        data-variant={resolvedVariant}
        data-tone={resolvedTone}
        data-size={size}
        disabled={disabled || loading}
        aria-busy={loading || undefined}
        className={clsx(
          'mesh-button no-select inline-flex items-center justify-center rounded-full border border-transparent',
          'transition-colors duration-fast focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus',
          // A button changes its face on press, it does not move. Elevation is
          // spent on things that are genuinely above the page, and a button in
          // normal flow is not one of them -- only the `elevated` variant lifts.
          'disabled:cursor-not-allowed disabled:opacity-40',
          toneClasses[resolvedTone][resolvedVariant],
          controlHeightClasses[size],
          {
            'gap-2 px-4 text-label-lg': size === 'sm',
            'gap-2 px-6 text-label-lg': size === 'md',
            'gap-2.5 px-6 text-title-md': size === 'lg',
          },
          className,
        )}
        {...props}
      >
        {loading && <Icon name="loader" size="sm" className="animate-spin" />}
        {children}
      </button>
    )
  }
)

Button.displayName = 'Button'
