import { forwardRef } from 'react'
import clsx from 'clsx'

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'ghost'
  size?: 'sm' | 'md' | 'lg'
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ variant = 'primary', size = 'md', className, children, ...props }, ref) => {
    return (
      <button
        ref={ref}
        className={clsx(
          'inline-flex items-center justify-center rounded-md no-select font-medium',
          'transition-colors duration-100',
          'focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue',
          'disabled:opacity-40 disabled:cursor-not-allowed',
          {
            'bg-blue text-white hover:bg-blue/80 active:bg-blue/70': variant === 'primary',
            'bg-bg-modifier-hover text-secondary hover:bg-bg-modifier-active hover:text-primary': variant === 'secondary',
            'bg-transparent text-secondary hover:bg-bg-modifier-hover hover:text-primary': variant === 'ghost',
          },
          {
            'text-xs px-2.5 py-1 gap-1.5': size === 'sm',
            'text-sm px-4 py-2 gap-2': size === 'md',
            'text-base px-5 py-2.5 gap-2.5': size === 'lg',
          },
          className
        )}
        {...props}
      >
        {children}
      </button>
    )
  }
)

Button.displayName = 'Button'
