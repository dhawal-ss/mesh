import { forwardRef, useId } from 'react'
import clsx from 'clsx'
import type { UiSize } from './Button'

export interface InputProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'onChange' | 'size'> {
  label?: string
  hint?: string
  error?: string
  size?: UiSize
  onChange?: ((value: string) => void) | React.ChangeEventHandler<HTMLInputElement>
}

export const Input = forwardRef<HTMLInputElement, InputProps>(
  ({ label, hint, error, size = 'md', className, onChange, id, 'aria-describedby': describedBy, ...props }, ref) => {
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
      <div className="flex flex-col gap-1.5">
        {label && (
          <label htmlFor={inputId} className="text-xs font-medium text-content-secondary">
            {label}
          </label>
        )}
        <input
          ref={ref}
          id={inputId}
          onChange={handleChange}
          aria-invalid={error ? true : undefined}
          aria-describedby={descriptionIds}
          className={clsx(
            'w-full rounded-md border border-border bg-surface-sunken text-content placeholder:text-content-muted',
            'transition-colors duration-fast focus:border-accent focus:outline-none',
            error && 'border-status-danger focus:border-status-danger',
            size === 'sm' && 'px-2.5 py-1.5 text-xs',
            size === 'md' && 'px-3 py-2 text-sm',
            size === 'lg' && 'px-3.5 py-2.5 text-base',
            className,
          )}
          {...props}
        />
        {(error || hint) && (
          <p
            id={supportingTextId}
            className={clsx('text-xs', error ? 'text-status-danger' : 'text-content-muted')}
          >
            {error ?? hint}
          </p>
        )}
      </div>
    )
  }
)

Input.displayName = 'Input'
