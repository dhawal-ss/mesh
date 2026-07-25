import { forwardRef } from 'react'
import clsx from 'clsx'
import type { ButtonProps, UiSize } from './Button'

const sizeClasses: Record<UiSize, string> = {
  sm: 'h-7 w-7',
  md: 'h-8 w-8',
  lg: 'h-10 w-10',
}

export interface IconButtonProps extends Omit<ButtonProps, 'children'> {
  'aria-label': string
  children: React.ReactNode
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(
  ({ size = 'md', tone = 'neutral', className, children, type = 'button', ...props }, ref) => (
    <button
      ref={ref}
      type={type}
      className={clsx(
        'no-select inline-flex shrink-0 items-center justify-center rounded-md transition-colors duration-fast',
        'focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-40',
        tone === 'neutral' && 'text-content-secondary hover:bg-surface-hover hover:text-content',
        tone === 'accent' && 'text-accent hover:bg-accent/10',
        tone === 'success' && 'text-status-success hover:bg-status-success/10',
        tone === 'danger' && 'text-status-danger hover:bg-status-danger/10',
        tone === 'warning' && 'text-status-warning hover:bg-status-warning/10',
        sizeClasses[size],
        className,
      )}
      {...props}
    >
      {children}
    </button>
  ),
)
IconButton.displayName = 'IconButton'
