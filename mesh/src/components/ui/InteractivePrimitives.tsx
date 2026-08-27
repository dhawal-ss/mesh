import { Fragment, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import {
  ContextMenu as ContextMenuPrimitive,
  Dialog as DialogPrimitive,
  DropdownMenu as DropdownMenuPrimitive,
  Popover as PopoverPrimitive,
  Select as SelectPrimitive,
  Switch as SwitchPrimitive,
  Tabs as TabsPrimitive,
} from 'radix-ui'
import clsx from 'clsx'
import { motion } from '../../lib/lazy-motion'
import { transitions, variants } from '../../lib/motion'
import type { UiSize, UiTone } from './Button'
import { Icon } from './Icon'
import { IconButton } from './IconButton'

const overlaySurfaceClass = 'mesh-overlay-surface rounded-xl border border-outline-variant bg-surface-container-high shadow-elev-3'

export interface SwitchProps extends Omit<React.ComponentPropsWithoutRef<typeof SwitchPrimitive.Root>, 'asChild'> {
  label: string
  description?: string
  size?: UiSize
  tone?: UiTone
}

const switchTone: Record<UiTone, string> = {
  neutral: 'data-[state=checked]:bg-on-surface-variant',
  accent: 'data-[state=checked]:bg-primary',
  danger: 'data-[state=checked]:bg-error',
  marker: 'data-[state=checked]:bg-marker',
}

export function Switch({
  label,
  description,
  id,
  className,
  size = 'md',
  tone = 'accent',
  disabled,
  'aria-describedby': describedBy,
  ...props
}: SwitchProps) {
  const generatedId = useId()
  const switchId = id ?? generatedId
  const descriptionId = `${switchId}-description`
  return (
    <div className={clsx('flex items-start justify-between gap-4', disabled && 'opacity-50', className)}>
      <label htmlFor={switchId} className={clsx('cursor-pointer', disabled && 'cursor-not-allowed')}>
        <span className="block text-body-md font-medium text-on-surface">{label}</span>
        {description && (
          <span id={descriptionId} className="block text-body-sm text-on-surface-variant">
            {description}
          </span>
        )}
      </label>
      <SwitchPrimitive.Root
        id={switchId}
        disabled={disabled}
        aria-describedby={description ? descriptionId : describedBy}
        className={clsx(
          'relative shrink-0 rounded-full bg-surface-container-highest transition-colors duration-fast focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus disabled:cursor-not-allowed',
          size === 'sm' && 'h-4 w-7',
          size === 'md' && 'h-5 w-9',
          size === 'lg' && 'h-6 w-11',
          switchTone[tone],
        )}
        {...props}
      >
        <SwitchPrimitive.Thumb
          className={clsx(
            'block translate-x-0.5 rounded-full bg-on-surface transition-transform duration-fast',
            size === 'sm' && 'h-3 w-3 data-[state=checked]:translate-x-3.5',
            size === 'md' && 'h-4 w-4 data-[state=checked]:translate-x-4',
            size === 'lg' && 'h-5 w-5 data-[state=checked]:translate-x-5',
          )}
        />
      </SwitchPrimitive.Root>
    </div>
  )
}

export interface SelectOption {
  value: string
  label: string
  disabled?: boolean
}

export interface SelectProps {
  value?: string
  defaultValue?: string
  onValueChange?: (value: string) => void
  options: SelectOption[]
  placeholder?: string
  label?: string
  ariaLabel?: string
  disabled?: boolean
  size?: UiSize
  className?: string
}

export function Select({
  value,
  defaultValue,
  onValueChange,
  options,
  placeholder = 'Choose an option',
  label,
  ariaLabel,
  disabled,
  size = 'md',
  className,
}: SelectProps) {
  const labelId = useId()
  return (
    <div className={clsx('space-y-1.5', className)}>
      {label && (
        <div id={labelId} className="text-body-sm font-medium text-on-surface-variant">
          {label}
        </div>
      )}
      <SelectPrimitive.Root value={value} defaultValue={defaultValue} onValueChange={onValueChange} disabled={disabled}>
        <SelectPrimitive.Trigger
          aria-labelledby={label ? labelId : undefined}
          aria-label={!label ? (ariaLabel ?? placeholder) : undefined}
          className={clsx(
            'flex w-full items-center justify-between gap-3 rounded-md border border-outline bg-surface-container-lowest text-on-surface focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus disabled:cursor-not-allowed disabled:opacity-50',
            size === 'sm' && 'px-2.5 py-1.5 text-body-sm',
            size === 'md' && 'px-3 py-2 text-body-md',
            size === 'lg' && 'px-3.5 py-2.5 text-body-lg',
          )}
        >
          <SelectPrimitive.Value placeholder={placeholder} />
          <SelectPrimitive.Icon>
            <Icon name="chevronDown" size="xs" />
          </SelectPrimitive.Icon>
        </SelectPrimitive.Trigger>
        <SelectPrimitive.Portal>
          <SelectPrimitive.Content
            position="popper"
            sideOffset={6}
            className={clsx('z-popover min-w-40 overflow-hidden p-1 text-on-surface', overlaySurfaceClass)}
          >
            <SelectPrimitive.Viewport>
              {options.map((option) => (
                <SelectPrimitive.Item
                  key={option.value}
                  value={option.value}
                  disabled={option.disabled}
                  className="relative cursor-default select-none rounded px-7 py-1.5 text-body-md outline-none data-[highlighted]:bg-surface-container-high data-[disabled]:opacity-40"
                >
                  <SelectPrimitive.ItemIndicator className="absolute left-2 inline-flex">
                    <Icon name="check" size="xs" />
                  </SelectPrimitive.ItemIndicator>
                  <SelectPrimitive.ItemText>{option.label}</SelectPrimitive.ItemText>
                </SelectPrimitive.Item>
              ))}
            </SelectPrimitive.Viewport>
          </SelectPrimitive.Content>
        </SelectPrimitive.Portal>
      </SelectPrimitive.Root>
    </div>
  )
}

export interface MenuItem {
  id: string
  label: string
  onSelect?: (event: Event) => void
  disabled?: boolean
  tone?: 'neutral' | 'danger'
}

function menuItemClass(tone: MenuItem['tone']) {
  return clsx(
    'cursor-default select-none rounded px-2 py-1.5 text-body-md outline-none data-[highlighted]:bg-surface-container-high data-[disabled]:opacity-40',
    tone === 'danger' ? 'text-error' : 'text-on-surface',
  )
}

export function DropdownMenu({ trigger, label, items }: { trigger: ReactNode; label: string; items: MenuItem[] }) {
  return (
    <DropdownMenuPrimitive.Root>
      <DropdownMenuPrimitive.Trigger asChild>{trigger}</DropdownMenuPrimitive.Trigger>
      <DropdownMenuPrimitive.Portal>
        <DropdownMenuPrimitive.Content
          aria-label={label}
          sideOffset={6}
          collisionPadding={8}
          className={clsx('z-dropdown min-w-40 p-1', overlaySurfaceClass)}
        >
          {items.map((item) => (
            <DropdownMenuPrimitive.Item
              key={item.id}
              disabled={item.disabled}
              onSelect={item.onSelect}
              className={menuItemClass(item.tone)}
            >
              {item.label}
            </DropdownMenuPrimitive.Item>
          ))}
        </DropdownMenuPrimitive.Content>
      </DropdownMenuPrimitive.Portal>
    </DropdownMenuPrimitive.Root>
  )
}

export function ContextMenu({
  children,
  label,
  items,
  disabled = false,
  open,
  onOpenChange,
}: {
  children: ReactNode
  label: string
  items: MenuItem[]
  disabled?: boolean
  open?: boolean
  onOpenChange?: (open: boolean) => void
}) {
  const triggerRef = useRef<HTMLSpanElement>(null)
  const focusTargetRef = useRef<HTMLElement | null>(null)
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false)
  const resolvedOpen = open ?? uncontrolledOpen
  const previousOpen = useRef(resolvedOpen)
  useLayoutEffect(() => {
    if (previousOpen.current && !resolvedOpen) {
      (focusTargetRef.current ?? triggerRef.current)?.focus()
    }
    previousOpen.current = resolvedOpen
  }, [resolvedOpen])

  return (
    <ContextMenuPrimitive.Root
      open={resolvedOpen}
      onOpenChange={(nextOpen) => {
        if (open === undefined) setUncontrolledOpen(nextOpen)
        onOpenChange?.(nextOpen)
      }}
    >
      <ContextMenuPrimitive.Trigger
        ref={triggerRef}
        asChild
        disabled={disabled}
        onContextMenuCapture={(event) => {
          focusTargetRef.current = event.currentTarget
        }}
      >
        {children}
      </ContextMenuPrimitive.Trigger>
      <ContextMenuPrimitive.Portal>
        <ContextMenuPrimitive.Content
          aria-label={label}
          collisionPadding={8}
          onCloseAutoFocus={(event) => {
            event.preventDefault()
            window.setTimeout(
              () => (focusTargetRef.current ?? triggerRef.current)?.focus(),
              0,
            )
          }}
          className={clsx('z-dropdown min-w-40 p-1', overlaySurfaceClass)}
        >
          {items.map((item) => (
            <ContextMenuPrimitive.Item
              key={item.id}
              disabled={item.disabled}
              onSelect={item.onSelect}
              className={menuItemClass(item.tone)}
            >
              {item.label}
            </ContextMenuPrimitive.Item>
          ))}
        </ContextMenuPrimitive.Content>
      </ContextMenuPrimitive.Portal>
    </ContextMenuPrimitive.Root>
  )
}

export function Popover({
  trigger,
  children,
  align = 'center',
  side = 'bottom',
  label,
  description,
  open,
  defaultOpen,
  onOpenChange,
  restoreFocusRef,
  className,
}: {
  trigger: ReactNode
  children: ReactNode
  align?: 'start' | 'center' | 'end'
  side?: 'top' | 'right' | 'bottom' | 'left'
  label?: string
  description?: string
  open?: boolean
  defaultOpen?: boolean
  onOpenChange?: (open: boolean) => void
  restoreFocusRef?: React.RefObject<HTMLElement | null>
  className?: string
}) {
  const generatedId = useId()
  const titleId = `${generatedId}-title`
  const descriptionId = `${generatedId}-description`
  const triggerRef = useRef<HTMLButtonElement>(null)
  const [uncontrolledOpen, setUncontrolledOpen] = useState(defaultOpen ?? false)
  const resolvedOpen = open ?? uncontrolledOpen
  const previousOpen = useRef(resolvedOpen)
  useLayoutEffect(() => {
    if (previousOpen.current && !resolvedOpen) {
      ;(restoreFocusRef?.current ?? triggerRef.current)?.focus()
    }
    previousOpen.current = resolvedOpen
  }, [resolvedOpen, restoreFocusRef])
  return (
    <PopoverPrimitive.Root
      open={resolvedOpen}
      onOpenChange={(nextOpen) => {
        if (open === undefined) setUncontrolledOpen(nextOpen)
        onOpenChange?.(nextOpen)
      }}
    >
      <PopoverPrimitive.Trigger ref={triggerRef} asChild>{trigger}</PopoverPrimitive.Trigger>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          align={align}
          side={side}
          sideOffset={8}
          collisionPadding={8}
          onCloseAutoFocus={(event) => {
            event.preventDefault()
            window.setTimeout(
              () => (restoreFocusRef?.current ?? triggerRef.current)?.focus(),
              0,
            )
          }}
          aria-labelledby={label ? titleId : undefined}
          aria-describedby={description ? descriptionId : undefined}
          className={clsx('z-popover w-72 p-4 text-on-surface', overlaySurfaceClass, className)}
        >
          {label && (
            <div id={titleId} className="mb-1 text-body-md font-semibold">
              {label}
            </div>
          )}
          {description && (
            <div id={descriptionId} className="mb-3 text-body-sm text-on-surface-variant">
              {description}
            </div>
          )}
          {children}
          <PopoverPrimitive.Arrow className="fill-surface-container-high" />
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  )
}

export interface TabItem {
  value: string
  label: string
  content: ReactNode
  disabled?: boolean
}

export function Tabs({
  items,
  defaultValue,
  value,
  onValueChange,
  label,
  orientation = 'horizontal',
}: {
  items: TabItem[]
  defaultValue?: string
  value?: string
  onValueChange?: (value: string) => void
  label: string
  orientation?: 'horizontal' | 'vertical'
}) {
  return (
    <TabsPrimitive.Root
      defaultValue={defaultValue ?? items[0]?.value}
      value={value}
      onValueChange={onValueChange}
      orientation={orientation}
    >
      <TabsPrimitive.List
        aria-label={label}
        className={clsx(
          'flex gap-1',
          orientation === 'horizontal' ? 'border-b border-outline-variant' : 'flex-col border-r border-outline-variant',
        )}
      >
        {items.map((item) => (
          <TabsPrimitive.Trigger
            key={item.value}
            value={item.value}
            disabled={item.disabled}
            className="border-b-2 border-transparent px-3 py-2 text-body-md text-on-surface-variant outline-none data-[state=active]:border-primary data-[state=active]:text-on-surface focus-visible:bg-surface-container-high disabled:opacity-40"
          >
            {item.label}
          </TabsPrimitive.Trigger>
        ))}
      </TabsPrimitive.List>
      {items.map((item) => (
        <TabsPrimitive.Content key={item.value} value={item.value} className="py-3 outline-none">
          {item.content}
        </TabsPrimitive.Content>
      ))}
    </TabsPrimitive.Root>
  )
}

export function Sheet({
  open,
  onOpenChange,
  title,
  description,
  children,
  side = 'right',
  size = 'sm',
  closeLabel = 'Close sheet',
  className,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description?: string
  children: ReactNode
  side?: 'left' | 'right'
  size?: 'sm' | 'md' | 'lg'
  closeLabel?: string
  className?: string
}) {
  const openerRef = useRef<HTMLElement | null>(null)
  const openingFocusTarget = useMemo(
    () =>
      open && typeof document !== 'undefined' && document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null,
    [open],
  )

  useLayoutEffect(() => {
    if (open && !openerRef.current && openingFocusTarget) {
      openerRef.current = openingFocusTarget
    }
  }, [open, openingFocusTarget])

  return (
    <DialogPrimitive.Root
      open={open}
      onOpenChange={(nextOpen) => {
        onOpenChange(nextOpen)
        if (nextOpen) return
        window.setTimeout(() => {
          openerRef.current?.focus()
          openerRef.current = null
        }, 0)
      }}
    >
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay asChild>
          <motion.div
            className="fixed inset-0 z-overlay bg-surface-scrim backdrop-blur-sm"
            variants={variants.overlay}
            initial="initial"
            animate="animate"
            exit="exit"
          />
        </DialogPrimitive.Overlay>
        <DialogPrimitive.Content
          asChild
          onCloseAutoFocus={(event) => {
            event.preventDefault()
            openerRef.current?.focus()
          }}
        >
          <motion.div
            className={clsx(
              'fixed inset-y-0 z-modal flex w-full flex-col overflow-hidden bg-surface-container text-on-surface shadow-elev-3 outline-none',
              side === 'right' ? 'right-0' : 'left-0',
              size === 'sm' && 'sm:w-80',
              size === 'md' && 'sm:w-96',
              size === 'lg' && 'sm:w-settings-drawer',
              className,
            )}
            initial={{ opacity: 0, x: side === 'right' ? '100%' : '-100%' }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: side === 'right' ? '100%' : '-100%' }}
            transition={transitions.enter}
          >
            <header className="flex min-h-14 flex-none items-start border-b border-outline-variant px-4 py-3">
              <div className="min-w-0 pr-10">
                {/* One size for one role: a drawer title is a dialog title. */}
                <DialogPrimitive.Title className="text-title-lg font-semibold">{title}</DialogPrimitive.Title>
                {description && (
                  <DialogPrimitive.Description className="mt-1 text-body-sm text-on-surface-variant">
                    {description}
                  </DialogPrimitive.Description>
                )}
              </div>
              <DialogPrimitive.Close asChild>
                <IconButton aria-label={closeLabel} className="absolute right-3 top-3">
                  <Icon name="x" size="sm" />
                </IconButton>
              </DialogPrimitive.Close>
            </header>
            <div className="flex-1 overflow-y-auto overscroll-contain px-4 py-4">{children}</div>
          </motion.div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}

export interface ComboboxOption {
  value: string
  label: string
  group?: string
  /**
   * Marks a group header as the accented "resumption" language Home uses for
   * its Continue section, so the palette and Home tell one story about picking
   * work back up. Reserved for that meaning, not for general emphasis.
   */
  groupTone?: 'accent'
  title?: string
  subtitle?: string
  icon?: ReactNode
  keywords?: string[]
  disabled?: boolean
}

export type ComboboxFilter = (
  options: ComboboxOption[],
  query: string,
) => ComboboxOption[]

export function fuzzySearchScore(candidate: string, query: string): number | null {
  const haystack = candidate.trim().toLocaleLowerCase()
  const needle = query.trim().toLocaleLowerCase()
  if (!needle) return 0

  const exactIndex = haystack.indexOf(needle)
  if (exactIndex >= 0) {
    return exactIndex * 2 + Math.max(0, haystack.length - needle.length) / 100
  }

  let queryIndex = 0
  let firstMatch = -1
  let previousMatch = -2
  let gaps = 0
  let runBonus = 0
  for (let candidateIndex = 0; candidateIndex < haystack.length; candidateIndex += 1) {
    if (haystack[candidateIndex] !== needle[queryIndex]) continue
    if (firstMatch === -1) firstMatch = candidateIndex
    if (candidateIndex === previousMatch + 1) runBonus += 1
    else if (previousMatch >= 0) gaps += candidateIndex - previousMatch - 1
    previousMatch = candidateIndex
    queryIndex += 1
    if (queryIndex === needle.length) {
      return 100 + firstMatch * 3 + gaps * 2 - runBonus
    }
  }

  return null
}

export function Combobox({
  label,
  options,
  value,
  onValueChange,
  placeholder = 'Search…',
  description,
  error,
  disabled = false,
  required = false,
  size = 'md',
  maxEmptyOptions,
  filterOptions,
  onQueryChange,
  leadingIcon,
  className,
}: {
  label: string
  options: ComboboxOption[]
  value?: string
  onValueChange: (value: string) => void
  placeholder?: string
  description?: string
  error?: string
  disabled?: boolean
  required?: boolean
  size?: UiSize
  maxEmptyOptions?: number
  filterOptions?: ComboboxFilter
  /**
   * Called with what has been typed, so an owner can offer an option the
   * static list cannot contain -- an address nobody has met yet, say.
   */
  onQueryChange?: (query: string) => void
  /** Decorative mark rendered inside the field, ahead of the input. */
  leadingIcon?: ReactNode
  className?: string
}) {
  const listboxId = useId()
  const inputId = `${listboxId}-input`
  const supportingTextId = `${listboxId}-supporting`
  const selectedLabel = useMemo(() => options.find((option) => option.value === value)?.label ?? '', [options, value])
  const [query, setQuery] = useState(selectedLabel)
  const [uncontrolledLabel, setUncontrolledLabel] = useState(selectedLabel)
  const [open, setOpen] = useState(false)
  const [activeIndex, setActiveIndex] = useState(-1)
  const rootRef = useRef<HTMLDivElement>(null)
  // The optional caller filter is stable in CommandPalette and can inspect a
  // large option set. Keep this runtime memo even though the React compiler
  // conservatively declines to transform function-prop memoization.
  // eslint-disable-next-line react-hooks/preserve-manual-memoization
  const filtered = useMemo(() => {
    if (filterOptions) return filterOptions(options, query)
    const normalized = query.trim().toLowerCase()
    if (!normalized) return options
    return options
      .map((option, optionIndex) => {
        const scores = [option.label, ...(option.keywords ?? [])]
          .map((candidate) => fuzzySearchScore(candidate, normalized))
          .filter((score): score is number => score !== null)
        return {
          option,
          optionIndex,
          score: scores.length > 0 ? Math.min(...scores) : null,
        }
      })
      .filter((entry): entry is typeof entry & { score: number } => entry.score !== null)
      .sort((left, right) => left.score - right.score || left.optionIndex - right.optionIndex)
      .map((entry) => entry.option)
  }, [filterOptions, options, query])

  const visibleFiltered = query.trim() || maxEmptyOptions === undefined
    ? filtered
    : filtered.slice(0, maxEmptyOptions)
  const resultsCapped = visibleFiltered.length < filtered.length
  const currentLabel = value === undefined ? uncontrolledLabel : selectedLabel
  const enabledIndices = visibleFiltered.reduce<number[]>((indices, option, index) => {
    if (!option.disabled) indices.push(index)
    return indices
  }, [])
  const indexedActive =
    activeIndex >= 0 && activeIndex < visibleFiltered.length && !visibleFiltered[activeIndex]?.disabled
      ? activeIndex
      : -1
  const resolvedActiveIndex =
    indexedActive >= 0
      ? indexedActive
      : open && query.trim()
        ? (enabledIndices[0] ?? -1)
        : -1
  const moveActive = (direction: 1 | -1) => {
    if (enabledIndices.length === 0) return -1
    const position = enabledIndices.indexOf(resolvedActiveIndex)
    if (position === -1) {
      return direction === 1 ? enabledIndices[0] : enabledIndices[enabledIndices.length - 1]
    }
    return enabledIndices[(position + direction + enabledIndices.length) % enabledIndices.length]
  }
  const choose = (option: ComboboxOption) => {
    if (option.disabled) return
    setQuery(option.label)
    setUncontrolledLabel(option.label)
    onValueChange(option.value)
    setOpen(false)
    setActiveIndex(-1)
  }
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setOpen(true)
      setActiveIndex(moveActive(1))
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      setOpen(true)
      setActiveIndex(moveActive(-1))
    } else if (event.key === 'Home' && open && enabledIndices.length > 0) {
      event.preventDefault()
      setActiveIndex(enabledIndices[0])
    } else if (event.key === 'End' && open && enabledIndices.length > 0) {
      event.preventDefault()
      setActiveIndex(enabledIndices[enabledIndices.length - 1])
    } else if (event.key === 'Enter' && open && visibleFiltered[resolvedActiveIndex]) {
      event.preventDefault()
      choose(visibleFiltered[resolvedActiveIndex])
    } else if (event.key === 'Escape') {
      event.preventDefault()
      setOpen(false)
      setActiveIndex(-1)
    }
  }

  return (
    <div
      ref={rootRef}
      className={clsx('relative space-y-1.5', className)}
      onBlur={(event) => {
        const nextTarget = event.relatedTarget
        if (nextTarget instanceof Node && rootRef.current?.contains(nextTarget)) return
        setOpen(false)
        setActiveIndex(-1)
      }}
    >
      <label htmlFor={inputId} className="text-body-sm font-medium text-on-surface-variant">
        {label}
        {required && (
          <span className="ml-1 text-error" aria-hidden="true">
            *
          </span>
        )}
      </label>
      {leadingIcon ? (
        <span className="mesh-field-leading-icon" aria-hidden="true">
          {leadingIcon}
        </span>
      ) : null}
      <input
        id={inputId}
        role="combobox"
        aria-expanded={open}
        aria-controls={listboxId}
        aria-haspopup="listbox"
        aria-autocomplete="list"
        aria-activedescendant={
          open && visibleFiltered[resolvedActiveIndex] ? `${listboxId}-${resolvedActiveIndex}` : undefined
        }
        aria-describedby={error || description ? supportingTextId : undefined}
        aria-invalid={error ? true : undefined}
        aria-required={required || undefined}
        autoComplete="off"
        disabled={disabled}
        value={open ? query : currentLabel}
        placeholder={placeholder}
        onFocus={() => {
          setQuery(currentLabel)
          onQueryChange?.(currentLabel)
          setOpen(true)
          setActiveIndex(currentLabel.trim()
            ? visibleFiltered.findIndex((option) => !option.disabled)
            : -1)
        }}
        onChange={(event) => {
          setQuery(event.target.value)
          onQueryChange?.(event.target.value)
          setActiveIndex(-1)
          setOpen(true)
        }}
        onKeyDown={onKeyDown}
        className={clsx(
          'w-full rounded-md border border-outline bg-surface-container-lowest text-on-surface placeholder:text-on-surface-variant focus:border-primary focus:outline-none disabled:cursor-not-allowed disabled:opacity-50',
          error && 'border-error focus:border-error',
          size === 'sm' && 'px-2.5 py-1.5 text-body-sm',
          size === 'md' && 'px-3 py-2 text-body-md',
          size === 'lg' && 'px-3.5 py-2.5 text-body-lg',
        )}
      />
      {(error || description) && (
        <p
          id={supportingTextId}
          role={error ? 'alert' : undefined}
          className={clsx('text-body-sm', error ? 'text-error' : 'text-on-surface-variant')}
        >
          {error ?? description}
        </p>
      )}
      {open && (
        <div
          id={listboxId}
          role="listbox"
          className={clsx('absolute top-full z-popover mt-1 max-h-56 w-full overflow-auto p-1', overlaySurfaceClass)}
        >
          {visibleFiltered.length === 0 ? (
            // An empty result that does not repeat what was typed makes the
            // person check whether the field even received it.
            <p className="px-2 py-3 text-body-md text-on-surface-variant">
              {query.trim() ? `No matches for “${query.trim()}”. Try another search.` : 'Try another search'}
            </p>
          ) : (
            <>
              {visibleFiltered.map((option, index) => (
                <Fragment key={option.value}>
                  {option.group && option.group !== visibleFiltered[index - 1]?.group ? (
                    <p
                      role="presentation"
                      className={clsx(
                        'px-2 pb-1 pt-3 text-label-sm font-medium first:pt-1',
                        option.groupTone === 'accent' ? 'text-primary' : 'text-on-surface-variant',
                      )}
                    >
                      {option.group}
                      {' \u00b7 '}
                      {visibleFiltered.filter((entry) => entry.group === option.group).length}
                    </p>
                  ) : null}
                  <button
                    id={`${listboxId}-${index}`}
                    type="button"
                    role="option"
                    aria-selected={option.value === value}
                    aria-disabled={option.disabled || undefined}
                    disabled={option.disabled}
                    onMouseMove={() => {
                      if (!option.disabled) setActiveIndex(index)
                    }}
                    onClick={() => choose(option)}
                    data-active={index === resolvedActiveIndex ? 'true' : undefined}
                    className={clsx(
                      'group flex w-full items-center gap-2 rounded-full px-2 py-1.5 text-left text-title-md text-on-surface disabled:opacity-40',
                      index === resolvedActiveIndex
                        ? 'mesh-combobox-option-active bg-primary text-on-primary'
                        : 'hover:bg-state-hover',
                    )}
                  >
                    {option.icon ? (
                      <span className="flex flex-none" aria-hidden="true">
                        {option.icon}
                      </span>
                    ) : null}
                    <span className="min-w-0 flex-1">
                      <span className="block truncate">{option.title ?? option.label}</span>
                      {option.subtitle ? (
                        <span
                          className={clsx(
                            'block truncate text-body-sm',
                            index === resolvedActiveIndex
                              ? 'text-on-primary'
                              : 'text-on-surface-variant',
                          )}
                        >
                          {option.subtitle}
                        </span>
                      ) : null}
                    </span>
                  </button>
                </Fragment>
              ))}
              {resultsCapped ? (
                <p role="status" className="px-2 py-2 text-body-sm text-on-surface-variant">
                  Showing the first {visibleFiltered.length} results. Type to narrow the list.
                </p>
              ) : null}
            </>
          )}
        </div>
      )}
    </div>
  )
}

export function Command({
  open,
  onOpenChange,
  title = 'Command palette',
  description = 'Rooms, people, settings, and actions',
  placeholder = 'Search Mesh…',
  options,
  onSelect,
  filterOptions,
  onQueryChange,
  note,
  maxEmptyOptions = 20,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title?: string
  description?: string
  placeholder?: string
  options: ComboboxOption[]
  onSelect: (value: string) => void | Promise<void>
  filterOptions?: ComboboxFilter
  onQueryChange?: (query: string) => void
  /**
   * A line beneath the list saying something the options cannot: where the
   * results came from, or why there are none. Announced, and replaced by the
   * busy line while a selection is in flight.
   */
  note?: string | null
  maxEmptyOptions?: number
}) {
  const [busyValue, setBusyValue] = useState<string | null>(null)
  const busyOption = options.find((option) => option.value === busyValue)

  return (
    <DialogPrimitive.Root
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen && busyValue) return
        onOpenChange(nextOpen)
      }}
    >
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-overlay bg-surface-scrim" />
        {/*
          A full-width band anchored to the top of the window, not a floating
          dialog. It spans the window and keeps its top edge flush with it, so
          only the two corners that meet the app are cut; it is genuinely above
          the page, so it takes a tonal step and the menu elevation.
        */}
        <DialogPrimitive.Content className="mesh-command-surface fixed inset-x-0 top-0 z-modal overflow-hidden rounded-b-xl bg-surface-container-high shadow-elev-3 outline-none">
          {/*
            * The palette is a field. A 36px chip, a title, a description and an
            * Esc key all restated the placeholder above the only control that
            * did anything, so the title and description are now the accessible
            * name and the search icon lives inside the field.
            */}
          <DialogPrimitive.Title className="sr-only">{title}</DialogPrimitive.Title>
          <DialogPrimitive.Description className="sr-only">{description}</DialogPrimitive.Description>
          <Combobox
            label={title}
            className="mesh-command-combobox"
            options={options}
            placeholder={placeholder}
            disabled={busyValue !== null}
            maxEmptyOptions={maxEmptyOptions}
            filterOptions={filterOptions}
            onQueryChange={onQueryChange}
            leadingIcon={<Icon name="search" size="sm" />}
            onValueChange={(value) => {
              setBusyValue(value)
              void Promise.resolve(onSelect(value))
                .then(() => onOpenChange(false))
                .catch(() => {
                  // The owner surfaces the actionable error and the palette stays open for retry.
                })
                .finally(() => setBusyValue(null))
            }}
          />
          {busyOption || note ? (
            <p role="status" className="border-t border border-outline-variant py-2 text-label-sm text-on-surface-variant">
              {busyOption
                ? busyValue?.startsWith('person:')
                  ? `Opening a conversation with ${busyOption.title ?? busyOption.label}…`
                  : `Opening ${busyOption.title ?? busyOption.label}…`
                : note}
            </p>
          ) : (
            /*
              The band's footer. Three keys and what they do, in the same mono
              the row numbers are in, so the band reads as one instrument rather
              than a dialog with a hint strip taped to the bottom.
            */
            <p className="flex items-center gap-3 border-t border border-outline-variant py-2 text-label-sm text-on-surface-variant">
              <span>{'\u2191\u2193'} Move</span>
              <span aria-hidden="true">·</span>
              <span>{'\u23ce'} Open</span>
              <span aria-hidden="true">·</span>
              <span>{'\u21e5'} Filter</span>
            </p>
          )}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}
