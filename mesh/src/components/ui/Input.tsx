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
      <div className="flex flex-col gap-2">
        {label && (
          <label htmlFor={inputId} className="text-caption font-semibold text-content-secondary">
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
            'mesh-input w-full rounded-control border border-border-control bg-surface-sunken text-content placeholder:text-content-muted',
            'transition-[border-color,box-shadow,background-color] duration-fast hover:border-border-emphasis focus:border-accent focus:bg-surface-base focus:outline-none',
            error && 'border-status-danger focus:border-status-danger',
            size === 'sm' && 'min-h-8 px-2.5 py-1.5 text-xs',
            size === 'md' && 'min-h-10 px-3 py-2 text-sm',
            size === 'lg' && 'min-h-11 px-3.5 py-2.5 text-base',
            className,
          )}
          {...props}
        />
        {(error || hint) && (
          <p
            id={supportingTextId}
            role={error ? 'alert' : undefined}
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
