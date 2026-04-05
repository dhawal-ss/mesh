import { forwardRef } from 'react'
import clsx from 'clsx'

interface InputProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'onChange'> {
  label?: string
  onChange?: ((value: string) => void) | React.ChangeEventHandler<HTMLInputElement>
}

export const Input = forwardRef<HTMLInputElement, InputProps>(
  ({ label, className, onChange, ...props }, ref) => {
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
          <label className="text-xs font-bold uppercase text-muted">
            {label}
          </label>
        )}
        <input
          ref={ref}
          onChange={handleChange}
          className={clsx(
            'w-full rounded-md bg-bg-tertiary px-3 py-2.5',
            'text-sm text-primary placeholder:text-muted',
            'transition-colors duration-100',
            'focus:outline-none',
            className
          )}
          {...props}
        />
      </div>
    )
  }
)

Input.displayName = 'Input'
