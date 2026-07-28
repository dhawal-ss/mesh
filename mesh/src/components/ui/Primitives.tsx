import {
  cloneElement,
  forwardRef,
  isValidElement,
  useId,
  type HTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type TextareaHTMLAttributes,
} from 'react'
import clsx from 'clsx'
import type { UiSize, UiTone } from './Button'

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  size?: UiSize
  error?: boolean
}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({ size = 'md', error = false, className, ...props }, ref) => (
    <textarea
      ref={ref}
      aria-invalid={error || undefined}
      className={clsx(
        'w-full resize-y rounded-md border border-border bg-surface-sunken text-content placeholder:text-content-muted',
        'transition-colors duration-fast focus:border-accent focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40',
        error && 'border-status-danger focus:border-status-danger',
        size === 'sm' && 'min-h-20 px-2.5 py-1.5 text-xs',
        size === 'md' && 'min-h-24 px-3 py-2 text-sm',
        size === 'lg' && 'min-h-28 px-3.5 py-2.5 text-base',
        className,
      )}
      {...props}
    />
  ),
)
Textarea.displayName = 'Textarea'

export interface FieldProps {
  label: string
  htmlFor: string
  hint?: string
  error?: string
  required?: boolean
  children: ReactNode
  className?: string
}

interface FieldControlProps {
  'aria-describedby'?: string
  'aria-invalid'?: boolean | 'true' | 'false'
  'aria-required'?: boolean | 'true' | 'false'
}

export function Field({
  label,
  htmlFor,
  hint,
  error,
  required,
  children,
  className,
}: FieldProps) {
  const generatedId = useId()
  const supportingTextId = `${generatedId}-supporting`
  const control = isValidElement<FieldControlProps>(children)
    ? cloneElement(
        children,
        {
          'aria-describedby': error || hint
            ? [children.props['aria-describedby'], supportingTextId].filter(Boolean).join(' ')
            : children.props['aria-describedby'],
          'aria-invalid': error ? true : children.props['aria-invalid'],
          'aria-required': required ? true : children.props['aria-required'],
        },
      )
    : children

  return (
    <div className={clsx('flex flex-col gap-1.5', className)}>
      <label htmlFor={htmlFor} className="text-xs font-medium text-content-secondary">
        {label}
        {required && <span className="ml-1 text-status-danger" aria-hidden="true">*</span>}
      </label>
      {control}
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

interface ChoiceProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'size'> {
  label: ReactNode
  description?: string
  size?: UiSize
}

export const Checkbox = forwardRef<HTMLInputElement, ChoiceProps>(
  ({ label, description, size = 'md', className, id, disabled, 'aria-describedby': describedBy, ...props }, ref) => {
    const generatedId = useId()
    const inputId = id ?? generatedId
    const descriptionId = `${inputId}-description`
    return (
      <label
        htmlFor={inputId}
        className={clsx(
          'flex cursor-pointer items-start gap-2 text-content',
          disabled && 'cursor-not-allowed opacity-50',
          size === 'sm' ? 'text-xs' : size === 'lg' ? 'text-base' : 'text-sm',
          className,
        )}
      >
        <input
          ref={ref}
          id={inputId}
          type="checkbox"
          disabled={disabled}
          aria-describedby={description ? descriptionId : describedBy}
          className="mt-0.5 h-4 w-4 rounded border-border accent-accent focus-visible:ring-2 focus-visible:ring-accent/40"
          {...props}
        />
        <span>
          <span className="block">{label}</span>
          {description && <span id={descriptionId} className="block text-xs text-content-muted">{description}</span>}
        </span>
      </label>
    )
  },
)
Checkbox.displayName = 'Checkbox'

export const Radio = forwardRef<HTMLInputElement, ChoiceProps>(
  ({ label, description, size = 'md', className, id, disabled, 'aria-describedby': describedBy, ...props }, ref) => {
    const generatedId = useId()
    const inputId = id ?? generatedId
    const descriptionId = `${inputId}-description`
    return (
      <label
        htmlFor={inputId}
        className={clsx(
          'flex cursor-pointer items-start gap-2 text-content',
          disabled && 'cursor-not-allowed opacity-50',
          size === 'sm' ? 'text-xs' : size === 'lg' ? 'text-base' : 'text-sm',
          className,
        )}
      >
        <input
          ref={ref}
          id={inputId}
          type="radio"
          disabled={disabled}
          aria-describedby={description ? descriptionId : describedBy}
          className="mt-0.5 h-4 w-4 border-border accent-accent focus-visible:ring-2 focus-visible:ring-accent/40"
          {...props}
        />
        <span>
          <span className="block">{label}</span>
          {description && <span id={descriptionId} className="block text-xs text-content-muted">{description}</span>}
        </span>
      </label>
    )
  },
)
Radio.displayName = 'Radio'

export interface SliderProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'size'> {
  label: string
  valueLabel?: string
  size?: UiSize
}

export const Slider = forwardRef<HTMLInputElement, SliderProps>(
  ({ label, valueLabel, size = 'md', id, className, 'aria-valuetext': valueText, ...props }, ref) => {
    const generatedId = useId()
    const inputId = id ?? generatedId
    return (
      <div className={clsx('space-y-1.5', className)}>
        <div className="flex items-center justify-between gap-3 text-xs">
          <label htmlFor={inputId} className="font-medium text-content-secondary">{label}</label>
          {valueLabel && <span className="text-content-muted">{valueLabel}</span>}
        </div>
        <input
          ref={ref}
          id={inputId}
          type="range"
          aria-valuetext={valueText ?? valueLabel}
          className={clsx('w-full accent-accent', size === 'sm' ? 'h-1' : size === 'lg' ? 'h-2' : 'h-1.5')}
          {...props}
        />
      </div>
    )
  },
)
Slider.displayName = 'Slider'

const badgeTone: Record<UiTone, string> = {
  neutral: 'bg-surface-hover text-content-secondary',
  accent: 'bg-accent/15 text-accent',
  success: 'bg-status-success/15 text-status-success',
  danger: 'bg-status-danger/15 text-status-danger',
  warning: 'bg-status-warning/15 text-status-warning',
}

export function Badge({
  tone = 'neutral',
  size = 'md',
  className,
  ...props
}: HTMLAttributes<HTMLSpanElement> & { tone?: UiTone; size?: UiSize }) {
  return (
    <span
      className={clsx(
        'inline-flex items-center rounded-full font-medium',
        size === 'sm' && 'px-1.5 py-0.5 text-caption',
        size === 'md' && 'px-2 py-0.5 text-xs',
        size === 'lg' && 'px-2.5 py-1 text-sm',
        badgeTone[tone],
        className,
      )}
      {...props}
    />
  )
}

export interface ProgressProps extends HTMLAttributes<HTMLDivElement> {
  value: number
  label: string
  showValue?: boolean
  size?: UiSize
  tone?: Exclude<UiTone, 'neutral'>
}

const progressTone: Record<Exclude<UiTone, 'neutral'>, string> = {
  accent: 'bg-accent',
  success: 'bg-status-success',
  danger: 'bg-status-danger',
  warning: 'bg-status-warning',
}

export function Progress({
  value,
  label,
  showValue = false,
  size = 'md',
  tone = 'accent',
  className,
  ...props
}: ProgressProps) {
  const boundedValue = Math.min(100, Math.max(0, value))
  return (
    <div className={clsx('space-y-1.5', className)} {...props}>
      <div className="flex items-center justify-between gap-3 text-xs">
        <span className="text-content-secondary">{label}</span>
        {showValue && <span className="text-content-muted">{Math.round(boundedValue)}%</span>}
      </div>
      <div
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={boundedValue}
        className={clsx(
          'overflow-hidden rounded-full bg-surface-hover',
          size === 'sm' && 'h-1',
          size === 'md' && 'h-1.5',
          size === 'lg' && 'h-2',
        )}
      >
        <div
          className={clsx('h-full rounded-full transition-[width] duration-normal', progressTone[tone])}
          style={{ width: `${boundedValue}%` }}
        />
      </div>
    </div>
  )
}

export function Separator({
  orientation = 'horizontal',
  className,
}: {
  orientation?: 'horizontal' | 'vertical'
  className?: string
}) {
  return (
    <div
      role="separator"
      aria-orientation={orientation}
      className={clsx(
        'shrink-0 bg-border-subtle',
        orientation === 'horizontal' ? 'h-px w-full' : 'h-full w-px',
        className,
      )}
    />
  )
}

export interface ScrollAreaProps extends HTMLAttributes<HTMLDivElement> {
  label?: string
}

export function ScrollArea({
  label,
  className,
  tabIndex = 0,
  role,
  ...props
}: ScrollAreaProps) {
  return (
    <div
      role={role ?? (label ? 'region' : undefined)}
      aria-label={label}
      tabIndex={tabIndex}
      className={clsx(
        'overflow-auto overscroll-contain focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent',
        className,
      )}
      {...props}
    />
  )
}

export function EmptyState({
  title,
  description,
  action,
  className,
}: {
  title: string
  description: string
  action?: ReactNode
  className?: string
}) {
  const generatedId = useId()
  const titleId = `${generatedId}-title`
  const descriptionId = `${generatedId}-description`
  return (
    <section
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      className={clsx('flex flex-col items-center justify-center gap-2 px-6 py-10 text-center', className)}
    >
      <h3 id={titleId} className="text-base font-semibold text-content">{title}</h3>
      <p id={descriptionId} className="max-w-md text-sm text-content-secondary">{description}</p>
      {action && <div className="mt-2">{action}</div>}
    </section>
  )
}

export function Kbd({ className, ...props }: HTMLAttributes<HTMLElement>) {
  return (
    <kbd
      className={clsx('rounded border border-border bg-surface-sunken px-1.5 py-0.5 font-mono text-xs text-content-secondary', className)}
      {...props}
    />
  )
}

export function Card({
  variant = 'raised',
  className,
  ...props
}: HTMLAttributes<HTMLDivElement> & { variant?: 'base' | 'raised' | 'outline' }) {
  return (
    <div
      className={clsx(
        'rounded-lg',
        variant === 'base' && 'bg-surface-base',
        variant === 'raised' && 'border border-border-subtle bg-surface-raised',
        variant === 'outline' && 'border border-border bg-surface-base',
        className,
      )}
      {...props}
    />
  )
}
