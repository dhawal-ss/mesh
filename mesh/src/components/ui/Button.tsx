import { forwardRef } from 'react'
import clsx from 'clsx'
import { Icon } from './Icon'
import { controlHeightClasses, type UiSize as ControlSize } from './controlGeometry'

export type UiTone = 'neutral' | 'accent' | 'success' | 'danger' | 'warning'
export type UiSize = ControlSize
export type ButtonVariant = 'solid' | 'soft' | 'outline' | 'ghost' | 'primary' | 'secondary'

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

const toneClasses: Record<UiTone, Record<'solid' | 'soft' | 'outline' | 'ghost', string>> = {
  neutral: {
    solid: 'border-content/80 bg-content text-surface-sunken hover:bg-content-secondary',
    soft: 'bg-surface-hover text-content hover:bg-surface-active',
    outline: 'border border-border text-content hover:bg-surface-hover',
    ghost: 'text-content-secondary hover:bg-surface-hover hover:text-content',
  },
  accent: {
    solid: 'border-accent bg-accent text-accent-content hover:bg-accent-hover',
    soft: 'bg-container-accent text-on-container-accent hover:bg-container-accent-hover',
    outline: 'border border-container-accent-line text-on-container-accent hover:bg-container-accent',
    ghost: 'text-on-container-accent hover:bg-container-accent',
  },
  success: {
    solid: 'bg-status-success text-content-on-status hover:bg-status-success-hover',
    soft: 'bg-container-success text-on-container-success hover:bg-container-success-hover',
    outline: 'border border-container-success-line text-on-container-success hover:bg-container-success',
    ghost: 'text-on-container-success hover:bg-container-success',
  },
  danger: {
    solid: 'bg-status-danger text-content-on-status hover:bg-status-danger-hover',
    soft: 'bg-container-danger text-on-container-danger hover:bg-container-danger-hover',
    outline: 'border border-container-danger-line text-on-container-danger hover:bg-container-danger',
    ghost: 'text-on-container-danger hover:bg-container-danger',
  },
  warning: {
    solid: 'bg-status-warning text-content-on-status hover:bg-status-warning-hover',
    soft: 'bg-container-warning text-on-container-warning hover:bg-container-warning-hover',
    outline: 'border border-container-warning-line text-on-container-warning hover:bg-container-warning',
    ghost: 'text-on-container-warning hover:bg-container-warning',
  },
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ variant = 'solid', tone, size = 'md', className, children, type = 'button', loading = false, disabled, ...props }, ref) => {
    const resolvedVariant = variant === 'primary'
      ? 'solid'
      : variant === 'secondary'
        ? 'soft'
        : variant
    const resolvedTone = tone ?? (variant === 'primary' ? 'accent' : 'neutral')

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
          'mesh-button no-select inline-flex items-center justify-center rounded-control border border-transparent font-semibold',
          'transition-colors duration-fast focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus',
          // A button changes its face on press, it does not move. The dip and
          // the accent variant's offset shadow were the previous system's
          // physical-object signature; Quiet Structure has no elevation
          // language for that movement to belong to.
          'disabled:cursor-not-allowed disabled:opacity-40',
          toneClasses[resolvedTone][resolvedVariant],
          resolvedTone === 'accent' && resolvedVariant === 'solid' && 'mesh-button-accent',
          controlHeightClasses[size],
          {
            'gap-1.5 px-3 text-xs': size === 'sm',
            'gap-2 px-4 text-sm': size === 'md',
            'gap-2.5 px-5 text-base': size === 'lg',
          },
          className,
        )}
        {...props}
      >
        {loading && <Icon name="loader" size={size === 'lg' ? 'md' : 'sm'} className="animate-spin" />}
        {children}
      </button>
    )
  }
)

Button.displayName = 'Button'
