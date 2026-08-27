import {
  cloneElement,
  forwardRef,
  isValidElement,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type HTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type TextareaHTMLAttributes,
} from 'react'
import clsx from 'clsx'
import type { UiSize, UiTone } from './Button'
import { PixelMark, type PixelMarkVariant } from './PixelMark'

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
        'mesh-input w-full resize-y rounded-control border border-border-control bg-surface-sunken text-content placeholder:text-content-muted',
        'transition-[border-color,box-shadow,background-color] duration-fast hover:border-border-emphasis focus:border-accent focus:bg-surface-base focus:outline-none',
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

export function Field({ label, htmlFor, hint, error, required, children, className }: FieldProps) {
  const generatedId = useId()
  const supportingTextId = `${generatedId}-supporting`
  const control = isValidElement<FieldControlProps>(children)
    ? cloneElement(children, {
        'aria-describedby':
          error || hint
            ? [children.props['aria-describedby'], supportingTextId].filter(Boolean).join(' ')
            : children.props['aria-describedby'],
        'aria-invalid': error ? true : children.props['aria-invalid'],
        'aria-required': required ? true : children.props['aria-required'],
      })
    : children

  return (
    <div className={clsx('flex flex-col gap-2', className)}>
      <label htmlFor={htmlFor} className="text-caption font-semibold text-content-secondary">
        {label}
        {required && (
          <span className="ml-1 text-status-danger" aria-hidden="true">
            *
          </span>
        )}
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
          aria-describedby={
            [describedBy, description ? descriptionId : undefined].filter(Boolean).join(' ') || undefined
          }
          className="mt-0.5 h-4 w-4 rounded border-border accent-accent"
          {...props}
        />
        <span>
          <span className="block">{label}</span>
          {description && (
            <span id={descriptionId} className="block text-xs text-content-muted">
              {description}
            </span>
          )}
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
          aria-describedby={
            [describedBy, description ? descriptionId : undefined].filter(Boolean).join(' ') || undefined
          }
          className="mt-0.5 h-4 w-4 border-border accent-accent"
          {...props}
        />
        <span>
          <span className="block">{label}</span>
          {description && (
            <span id={descriptionId} className="block text-xs text-content-muted">
              {description}
            </span>
          )}
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
          <label htmlFor={inputId} className="font-medium text-content-secondary">
            {label}
          </label>
          {valueLabel && <span className="text-content-muted">{valueLabel}</span>}
        </div>
        <input
          ref={ref}
          id={inputId}
          type="range"
          aria-valuetext={valueText ?? valueLabel}
          data-size={size}
          className="h-6 w-full accent-accent"
          {...props}
        />
      </div>
    )
  },
)
Slider.displayName = 'Slider'

const badgeTone: Record<UiTone, string> = {
  neutral: 'bg-surface-container-high text-on-surface-variant',
  accent: 'bg-secondary-container text-on-secondary-container',
  danger: 'bg-error-container text-on-error-container',
  marker: 'bg-marker-container text-on-marker-container',
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
        // An M3 badge is a pill. Nothing in this system is uppercased, so it
        // carries a label role rather than an eyebrow.
        'inline-flex items-center rounded-full',
        size === 'sm' && 'px-2 py-0.5 text-label-sm',
        size === 'md' && 'px-2.5 py-0.5 text-label-md',
        size === 'lg' && 'px-3 py-1 text-label-lg',
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
  accent: 'bg-primary',
  danger: 'bg-error',
  marker: 'bg-marker',
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
          'overflow-hidden rounded-control bg-surface-hover',
          size === 'sm' && 'h-1',
          size === 'md' && 'h-1.5',
          size === 'lg' && 'h-2',
        )}
      >
        <div
          className={clsx('h-full rounded-control transition-[width] duration-normal', progressTone[tone])}
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

export function ScrollArea({ label, className, tabIndex, role, ...props }: ScrollAreaProps) {
  const areaRef = useRef<HTMLDivElement>(null)
  const [scrollable, setScrollable] = useState(false)

  useLayoutEffect(() => {
    const area = areaRef.current
    if (!area) return
    const update = () => {
      setScrollable(area.scrollHeight > area.clientHeight || area.scrollWidth > area.clientWidth)
    }
    update()
    const resizeObserver = typeof ResizeObserver === 'undefined'
      ? null
      : new ResizeObserver(update)
    const mutationObserver = new MutationObserver(update)
    resizeObserver?.observe(area)
    mutationObserver.observe(area, { childList: true, subtree: true, characterData: true })
    return () => {
      resizeObserver?.disconnect()
      mutationObserver.disconnect()
    }
  }, [])

  return (
    <div
      ref={areaRef}
      role={role ?? (label ? 'region' : undefined)}
      aria-label={label}
      tabIndex={tabIndex ?? (scrollable ? 0 : undefined)}
      className={clsx(
        'overflow-auto overscroll-contain focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent',
        className,
      )}
      {...props}
    />
  )
}

export interface SectionHeaderProps extends Omit<HTMLAttributes<HTMLDivElement>, 'title'> {
  title: string
  /** Optional tally, flush right in mono so columns of counts line up. */
  count?: number | string
  /** One control at most. A section header is a label, not a toolbar. */
  action?: ReactNode
  /**
   * Exposes the label as a heading at this level. Omit it where the section
   * already has its own heading element and this is only its visible label.
   */
  headingLevel?: 2 | 3 | 4
}

/**
 * The one section label in the product.
 *
 * Home, RouteSurface, ChannelSidebar and MemberList each grew their own, in
 * four sizes, three colors and four heights, two of them side by side on the
 * same screen. This is that role, once. Under Quiet Structure it is the mono
 * eyebrow -- 9.5px at 0.16em on the secondary ink -- with a 32px minimum row
 * so headers align across panes and the count in mono at the trailing edge.
 */
export function SectionHeader({
  title,
  count,
  action,
  headingLevel,
  className,
  id,
  ...props
}: SectionHeaderProps) {
  return (
    <div
      className={clsx(
        'flex min-h-8 items-center gap-2 font-mono text-eyebrow font-medium uppercase text-content-secondary',
        className,
      )}
      {...props}
    >
      <span
        id={id}
        role={headingLevel ? 'heading' : undefined}
        aria-level={headingLevel}
        className="min-w-0 truncate"
      >
        {title}
      </span>
      {count !== undefined && (
        <span className="ml-auto flex-none font-mono text-count font-semibold normal-case text-content-secondary">
          {count}
        </span>
      )}
      {action ? <span className={clsx('flex-none', count === undefined && 'ml-auto')}>{action}</span> : null}
    </div>
  )
}

/*
  A notice speaks for one of four reasons, and "everything is fine" is not one
  of them: the norm gets one chip per screen and no words per message. `info`
  and `success` are gone with the colours behind them.
*/
export type NoticeTone = 'neutral' | 'accent' | 'danger' | 'marker'

export interface NoticeProps extends Omit<HTMLAttributes<HTMLDivElement>, 'title'> {
  /**
   * `advisory` is a leading rule with no fill: the surface under it stays
   * usable. `band` rules the region above and below and fills it: the notice
   * governs everything beneath it. A failure with a retry is `ErrorState`.
   */
  intensity?: 'advisory' | 'band'
  tone?: NoticeTone
  title?: string
  action?: ReactNode
  children: ReactNode
}

const noticeTitleTone: Record<NoticeTone, string> = {
  neutral: 'text-on-surface',
  accent: 'text-primary',
  danger: 'text-error',
  marker: 'text-marker',
}

/**
 * A status surface at one of the two authored intensities.
 *
 * Every strength resolves through the container quintuples, so no caller has
 * to invent an opacity. See the "Notice intensities" block in globals.css.
 */
export function Notice({
  intensity = 'advisory',
  tone = 'neutral',
  title,
  action,
  children,
  className,
  ...props
}: NoticeProps) {
  return (
    <div
      data-notice-tone={tone === 'neutral' ? undefined : tone}
      className={clsx(
        intensity === 'advisory' ? 'mesh-notice-advisory' : 'mesh-notice-band',
        'flex flex-col items-start gap-1 text-sm text-content-secondary',
        className,
      )}
      {...props}
    >
      {title && (
        <p className={clsx('text-title-sm', noticeTitleTone[tone])}>
          {title}
        </p>
      )}
      <div className="max-w-measure">{children}</div>
      {action ? <div className="mt-1 flex flex-wrap items-center gap-2">{action}</div> : null}
    </div>
  )
}

export interface EmptyStateProps {
  title: string
  description: string
  /**
   * Uppercase amber label naming the section this emptiness belongs to, for
   * example `Rooms` or `This conversation`. Editorial, not decorative.
   */
  eyebrow?: string
  /**
   * Room, conversation, or community id. Renders the 56px pixel mark tinted
   * from that identity instead of a generic glyph, so the emptiest surface in
   * the app becomes the one most specific to where you are.
   */
  markSeed?: string
  markVariant?: PixelMarkVariant
  icon?: ReactNode
  iconClassName?: string
  action?: ReactNode
  variant?: 'default' | 'compact'
  className?: string
  style?: HTMLAttributes<HTMLElement>['style']
}

/*
 * Ruled, left-aligned, editorial. The previous centred card had to be undone
 * with inline overrides wherever it was used on a real surface, which is the
 * signal that the shared primitive, not the caller, was wrong.
 */
export function EmptyState({
  title,
  description,
  eyebrow,
  markSeed,
  markVariant = 'community',
  icon,
  iconClassName,
  action,
  variant = 'default',
  className,
  style,
}: EmptyStateProps) {
  const generatedId = useId()
  const titleId = `${generatedId}-title`
  const descriptionId = `${generatedId}-description`
  return (
    <section
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      className={clsx(
        'flex flex-col items-start justify-center text-left',
        variant === 'default' && 'gap-2 border-y border-rule border-border-structural px-shell-gutter py-6',
        variant === 'compact' && 'gap-1.5 px-shell-gutter py-5',
        className,
      )}
      style={style}
    >
      {markSeed ? (
        <span className="mesh-empty-mark mb-1 flex" aria-hidden="true">
          <PixelMark
            variant={markVariant}
            seed={markSeed}
            className="h-empty-icon w-empty-icon"
          />
        </span>
      ) : icon ? (
        <div
          aria-hidden="true"
          className={clsx(
            'mb-0.5 flex h-6 w-6 items-center justify-center text-content-muted',
            iconClassName,
          )}
        >
          {icon}
        </div>
      ) : null}
      {eyebrow && (
        <p className="text-caption font-semibold uppercase tracking-eyebrow text-content-secondary">
          {eyebrow}
        </p>
      )}
      <h3
        id={titleId}
        className={clsx(
          'text-content-primary',
          variant === 'default' && 'text-md font-semibold',
          variant === 'compact' && 'text-sm font-medium',
        )}
      >
        {title}
      </h3>
      <p
        id={descriptionId}
        className={clsx(
          'text-content-secondary',
          variant === 'default' && 'max-w-measure text-sm',
          variant === 'compact' && 'max-w-xs text-xs',
        )}
      >
        {description}
      </p>
      {action && (
        <div className={clsx('flex flex-wrap items-center gap-2', variant === 'compact' ? 'mt-1' : 'mt-2')}>
          {action}
        </div>
      )}
    </section>
  )
}

export function Kbd({ className, ...props }: HTMLAttributes<HTMLElement>) {
  return (
    <kbd
      className={clsx(
        'rounded border border-border bg-surface-sunken px-1.5 py-0.5 font-mono text-xs text-content-secondary',
        className,
      )}
      {...props}
    />
  )
}

export function Card({
  variant = 'raised',
  className,
  style,
  ...props
}: HTMLAttributes<HTMLDivElement> & {
  variant?: 'base' | 'raised' | 'outline'
}) {
  return (
    <div
      className={clsx(
        'mesh-card',
        variant === 'base' && 'bg-surface-base',
        variant === 'raised' && 'border border-border-subtle bg-surface-raised',
        variant === 'outline' && 'border border-border bg-surface-base',
        className,
      )}
      style={style}
      {...props}
    />
  )
}
