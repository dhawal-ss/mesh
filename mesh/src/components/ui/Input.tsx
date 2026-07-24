import { forwardRef, useId } from 'react'
import clsx from 'clsx'

interface InputProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'onChange'> {
  label?: string
  onChange?: ((value: string) => void) | React.ChangeEventHandler<HTMLInputElement>
}

export const Input = forwardRef<HTMLInputElement, InputProps>(
  ({ label, className, onChange, id, ...props }, ref) => {
    const generatedId = useId()
    const inputId = id ?? generatedId
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
          <label htmlFor={inputId} className="text-xs font-bold uppercase text-muted">
            {label}
          </label>
        )}
        <input
          ref={ref}
          id={inputId}
          onChange={handleChange}
          className={clsx(
            'w-full rounded-md bg-bg-tertiary px-3 py-2.5',
            'text-sm text-primary placeholder:text-muted',
            'transition-colors duration-100',
            'focus:outline-none focus-visible:ring-2 focus-visible:ring-blue',
            className
          )}
          {...props}
        />
      </div>
    )
  }
)

Input.displayName = 'Input'
