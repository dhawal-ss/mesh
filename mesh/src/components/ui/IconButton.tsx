import { forwardRef } from 'react'
import clsx from 'clsx'
import type { ButtonProps } from './Button'

/**
 * The Material 3 icon button: a 48px target around a 24px glyph, circular, with
 * a state layer on hover, focus and press.
 *
 * `size` names the target, not the glyph. The glyph is the caller's `Icon`, and
 * `md` is the one to reach for: it is the 48px primary touch target the density
 * contract asks of anything you tap.
 */
export interface IconButtonProps extends Omit<ButtonProps, 'children' | 'loading' | 'variant'> {
  'aria-label': string
  children: React.ReactNode
  /**
   * `standard` is a bare glyph over a state layer. The other three carry a
   * ground of their own and are for an icon button that is the primary action
   * on its surface.
   */
  variant?: 'standard' | 'filled' | 'tonal' | 'outlined'
}

const TARGET_SIZE = {
  sm: 'h-control-sm w-control-sm',
  md: 'h-control-md w-control-md',
  lg: 'h-control-lg w-control-lg',
} as const

const TONE_INK = {
  neutral: 'text-on-surface-variant hover:text-on-surface',
  accent: 'text-primary',
  danger: 'text-error',
  marker: 'text-marker',
} as const

const VARIANT_GROUND = {
  standard: 'hover:bg-state-hover',
  filled: {
    neutral: 'bg-surface-container-highest text-on-surface hover:bg-state-hover',
    accent: 'bg-primary text-on-primary hover:bg-primary-hover',
    danger: 'bg-error text-on-error hover:bg-error-hover',
    marker: 'bg-marker text-on-marker hover:bg-marker-hover',
  },
  tonal: {
    neutral: 'bg-surface-container-high text-on-surface hover:bg-surface-container-highest',
    accent: 'bg-primary-container text-on-primary-container hover:bg-primary-container-hover',
    danger: 'bg-error-container text-on-error-container hover:bg-error-container-hover',
    marker: 'bg-marker-container text-on-marker-container hover:bg-marker-container-hover',
  },
  outlined: 'border border-outline hover:bg-state-hover',
} as const

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(
  ({ size = 'md', tone = 'neutral', variant = 'standard', className, children, type = 'button', ...props }, ref) => (
    <button
      ref={ref}
      type={type}
      data-size={size}
      data-variant={variant}
      data-tone={tone}
      className={clsx(
        'mesh-icon-button no-select inline-flex shrink-0 items-center justify-center rounded-full',
        'transition-colors duration-fast',
        'focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus disabled:cursor-not-allowed disabled:opacity-40',
        variant === 'filled' || variant === 'tonal'
          ? VARIANT_GROUND[variant][tone]
          : clsx(TONE_INK[tone], VARIANT_GROUND[variant]),
        TARGET_SIZE[size],
        className,
      )}
      {...props}
    >
      {children}
    </button>
  ),
)
IconButton.displayName = 'IconButton'
