import { forwardRef } from 'react'
import clsx from 'clsx'

export type UiTone = 'neutral' | 'accent' | 'success' | 'danger' | 'warning'
export type UiSize = 'sm' | 'md' | 'lg'
export type ButtonVariant = 'solid' | 'soft' | 'outline' | 'ghost' | 'primary' | 'secondary'

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  tone?: UiTone
  size?: UiSize
}

const toneClasses: Record<UiTone, Record<'solid' | 'soft' | 'outline' | 'ghost', string>> = {
  neutral: {
    solid: 'bg-content text-surface-sunken hover:bg-content-secondary',
    soft: 'bg-surface-hover text-content hover:bg-surface-active',
    outline: 'border border-border text-content hover:bg-surface-hover',
    ghost: 'text-content-secondary hover:bg-surface-hover hover:text-content',
  },
  accent: {
    solid: 'bg-accent text-accent-content hover:bg-accent-hover',
    soft: 'bg-accent/15 text-accent hover:bg-accent/25',
    outline: 'border border-accent/60 text-accent hover:bg-accent/10',
    ghost: 'text-accent hover:bg-accent/10',
  },
  success: {
    solid: 'bg-status-success text-content-on-status hover:bg-status-success/95',
    soft: 'bg-status-success/15 text-status-success hover:bg-status-success/25',
    outline: 'border border-status-success/60 text-status-success hover:bg-status-success/10',
    ghost: 'text-status-success hover:bg-status-success/10',
  },
  danger: {
    solid: 'bg-status-danger text-content-on-status hover:bg-status-danger/95',
    soft: 'bg-status-danger/15 text-status-danger hover:bg-status-danger/25',
    outline: 'border border-status-danger/60 text-status-danger hover:bg-status-danger/10',
    ghost: 'text-status-danger hover:bg-status-danger/10',
  },
  warning: {
    solid: 'bg-status-warning text-surface-sunken hover:bg-status-warning/80',
    soft: 'bg-status-warning/15 text-status-warning hover:bg-status-warning/25',
    outline: 'border border-status-warning/60 text-status-warning hover:bg-status-warning/10',
    ghost: 'text-status-warning hover:bg-status-warning/10',
  },
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ variant = 'solid', tone, size = 'md', className, children, type = 'button', ...props }, ref) => {
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
        className={clsx(
          'no-select inline-flex items-center justify-center rounded-md font-medium',
          'transition-colors duration-fast focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent',
          'disabled:cursor-not-allowed disabled:opacity-40',
          toneClasses[resolvedTone][resolvedVariant],
          {
            'gap-1.5 px-2.5 py-1 text-xs': size === 'sm',
            'gap-2 px-4 py-2 text-sm': size === 'md',
            'gap-2.5 px-5 py-2.5 text-base': size === 'lg',
          },
          className,
        )}
        {...props}
      >
        {children}
      </button>
    )
  }
)

Button.displayName = 'Button'
