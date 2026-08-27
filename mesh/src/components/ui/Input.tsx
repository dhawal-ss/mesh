import { forwardRef, useId } from 'react'
import clsx from 'clsx'
import { controlHeightClasses, type UiSize } from './controlGeometry'

export interface InputProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'onChange' | 'size'> {
  label?: string
  hint?: string
  error?: string
  size?: UiSize
  /**
   * `filled` is the Material 3 default: a container ground, cut at the top
   * corners only, with a 2px active indicator along the bottom edge. `outlined`
   * is the pill-shaped search field the composer and the sidebars use.
   */
  variant?: 'filled' | 'outlined'
  onChange?: ((value: string) => void) | React.ChangeEventHandler<HTMLInputElement>
}

export const Input = forwardRef<HTMLInputElement, InputProps>(
  ({ label, hint, error, size = 'md', variant = 'filled', className, onChange, id, 'aria-describedby': describedBy, ...props }, ref) => {
    const generatedId = useId()
    const inputId = id ?? generatedId
    const supportingTextId = `${inputId}-supporting`
    const descriptionIds = [describedBy, error || hint ? supportingTextId : undefined]
      .filter(Boolean)
      .join(' ') || undefined
    const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
      if (!onChange) return
      if (onChange.length <= 1) {
        try {
          (onChange as (value: string) => void)(e.target.value)
        } catch {
          (onChange as React.ChangeEventHandler<HTMLInputElement>)(e)
        }
      } else {
        (onChange as React.ChangeEventHandler<HTMLInputElement>)(e)
      }
    }

    return (
      <div className="flex flex-col gap-1">
        {label && (
          <label htmlFor={inputId} className="text-body-sm text-on-surface-variant">
            {label}
          </label>
        )}
        <input
          ref={ref}
          id={inputId}
          data-size={size}
          data-variant={variant}
          onChange={handleChange}
          aria-invalid={error ? true : undefined}
          aria-describedby={descriptionIds}
          className={clsx(
            'mesh-input w-full bg-surface-container-high text-on-surface placeholder:text-on-surface-variant',
            'transition-[border-color,background-color] duration-fast focus:outline-none',
            'disabled:cursor-not-allowed disabled:opacity-60',
            /*
              The filled field's whole boundary is the active indicator along
              its bottom edge, so it is drawn at full strength rather than as a
              hairline: it conveys the shape of a control and owes 3:1.
            */
            variant === 'filled'
              ? clsx(
                'rounded-t-xs border-b-2 border-outline enabled:hover:bg-surface-container-highest focus:border-primary',
                error && 'border-error focus:border-error',
              )
              : clsx(
                'rounded-full border border-outline enabled:hover:bg-surface-container-highest focus:border-2 focus:border-primary',
                error && 'border-error focus:border-error',
              ),
            controlHeightClasses[size],
            size === 'sm' && 'px-3 text-body-md',
            size === 'md' && 'px-4 text-body-lg',
            size === 'lg' && 'px-4 text-body-lg',
            className,
          )}
          {...props}
        />
        {(error || hint) && (
          <p
            id={supportingTextId}
            role={error ? 'alert' : undefined}
            className={clsx('px-4 text-body-sm', error ? 'text-error' : 'text-on-surface-variant')}
          >
            {error ?? hint}
          </p>
        )}
      </div>
    )
  }
)

Input.displayName = 'Input'
