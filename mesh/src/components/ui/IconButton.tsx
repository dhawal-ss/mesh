import { forwardRef } from 'react'
import clsx from 'clsx'
import type { ButtonProps } from './Button'
import {
  controlHeightClasses,
  controlWidthClasses,
} from './controlGeometry'

export interface IconButtonProps extends Omit<ButtonProps, 'children' | 'loading'> {
  'aria-label': string
  children: React.ReactNode
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(
  ({ size = 'md', tone = 'neutral', className, children, type = 'button', ...props }, ref) => (
    <button
      ref={ref}
      type={type}
      data-size={size}
      className={clsx(
        'mesh-icon-button no-select inline-flex shrink-0 items-center justify-center rounded-md',
        'transition-colors duration-fast',
        'focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus disabled:cursor-not-allowed disabled:opacity-40 disabled:active:translate-y-0',
        tone === 'neutral' && 'text-content-secondary hover:bg-surface-hover hover:text-content',
        tone === 'accent' && 'text-on-container-accent hover:bg-container-accent',
        tone === 'success' && 'text-on-container-success hover:bg-container-success',
        tone === 'danger' && 'text-on-container-danger hover:bg-container-danger',
        tone === 'warning' && 'text-on-container-warning hover:bg-container-warning',
        controlHeightClasses[size],
        controlWidthClasses[size],
        className,
      )}
      {...props}
    >
      {children}
    </button>
  ),
)
IconButton.displayName = 'IconButton'
