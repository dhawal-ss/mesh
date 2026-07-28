import {
  useId,
  useMemo,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react'
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
import type { UiSize, UiTone } from './Button'
import { Icon } from './Icon'
import { IconButton } from './IconButton'

export interface SwitchProps
  extends Omit<React.ComponentPropsWithoutRef<typeof SwitchPrimitive.Root>, 'asChild'> {
  label: string
  description?: string
  size?: UiSize
  tone?: UiTone
}

const switchTone: Record<UiTone, string> = {
  neutral: 'data-[state=checked]:bg-content-secondary',
  accent: 'data-[state=checked]:bg-accent',
  success: 'data-[state=checked]:bg-status-success',
  danger: 'data-[state=checked]:bg-status-danger',
  warning: 'data-[state=checked]:bg-status-warning',
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
        <span className="block text-sm font-medium text-content">{label}</span>
        {description && <span id={descriptionId} className="block text-xs text-content-muted">{description}</span>}
      </label>
      <SwitchPrimitive.Root
        id={switchId}
        disabled={disabled}
        aria-describedby={description ? descriptionId : describedBy}
        className={clsx(
          'relative shrink-0 rounded-full bg-surface-active transition-colors duration-fast focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent disabled:cursor-not-allowed',
          size === 'sm' && 'h-4 w-7',
          size === 'md' && 'h-5 w-9',
          size === 'lg' && 'h-6 w-11',
          switchTone[tone],
        )}
        {...props}
      >
        <SwitchPrimitive.Thumb
          className={clsx(
            'block translate-x-0.5 rounded-full bg-content transition-transform duration-fast',
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
      {label && <div id={labelId} className="text-xs font-medium text-content-secondary">{label}</div>}
      <SelectPrimitive.Root
        value={value}
        defaultValue={defaultValue}
        onValueChange={onValueChange}
        disabled={disabled}
      >
        <SelectPrimitive.Trigger
          aria-labelledby={label ? labelId : undefined}
          aria-label={!label ? (ariaLabel ?? placeholder) : undefined}
          className={clsx(
            'flex w-full items-center justify-between gap-3 rounded-md border border-border bg-surface-sunken text-content focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-50',
            size === 'sm' && 'px-2.5 py-1.5 text-xs',
            size === 'md' && 'px-3 py-2 text-sm',
            size === 'lg' && 'px-3.5 py-2.5 text-base',
          )}
        >
          <SelectPrimitive.Value placeholder={placeholder} />
          <SelectPrimitive.Icon><Icon name="chevronDown" size="xs" /></SelectPrimitive.Icon>
        </SelectPrimitive.Trigger>
        <SelectPrimitive.Portal>
          <SelectPrimitive.Content
            position="popper"
            sideOffset={6}
            className="z-popover min-w-40 overflow-hidden rounded-md border border-border bg-surface-overlay p-1 text-content shadow-overlay"
          >
            <SelectPrimitive.Viewport>
              {options.map((option) => (
                <SelectPrimitive.Item
                  key={option.value}
                  value={option.value}
                  disabled={option.disabled}
                  className="relative cursor-default select-none rounded px-7 py-1.5 text-sm outline-none data-[highlighted]:bg-surface-hover data-[disabled]:opacity-40"
                >
                  <SelectPrimitive.ItemIndicator className="absolute left-2">✓</SelectPrimitive.ItemIndicator>
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
  onSelect?: () => void
  disabled?: boolean
  tone?: 'neutral' | 'danger'
}

function menuItemClass(tone: MenuItem['tone']) {
  return clsx(
    'cursor-default select-none rounded px-2 py-1.5 text-sm outline-none data-[highlighted]:bg-surface-hover data-[disabled]:opacity-40',
    tone === 'danger' ? 'text-status-danger' : 'text-content',
  )
}

export function DropdownMenu({
  trigger,
  label,
  items,
}: {
  trigger: ReactNode
  label: string
  items: MenuItem[]
}) {
  return (
    <DropdownMenuPrimitive.Root>
      <DropdownMenuPrimitive.Trigger asChild>{trigger}</DropdownMenuPrimitive.Trigger>
      <DropdownMenuPrimitive.Portal>
        <DropdownMenuPrimitive.Content
          aria-label={label}
          sideOffset={6}
          collisionPadding={8}
          className="z-dropdown min-w-40 rounded-md border border-border bg-surface-overlay p-1 shadow-overlay"
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
}: {
  children: ReactNode
  label: string
  items: MenuItem[]
}) {
  return (
    <ContextMenuPrimitive.Root>
      <ContextMenuPrimitive.Trigger asChild>{children}</ContextMenuPrimitive.Trigger>
      <ContextMenuPrimitive.Portal>
        <ContextMenuPrimitive.Content
          aria-label={label}
          collisionPadding={8}
          className="z-dropdown min-w-40 rounded-md border border-border bg-surface-overlay p-1 shadow-overlay"
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
  className?: string
}) {
  const generatedId = useId()
  const titleId = `${generatedId}-title`
  const descriptionId = `${generatedId}-description`
  return (
    <PopoverPrimitive.Root open={open} defaultOpen={defaultOpen} onOpenChange={onOpenChange}>
      <PopoverPrimitive.Trigger asChild>{trigger}</PopoverPrimitive.Trigger>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          align={align}
          side={side}
          sideOffset={8}
          collisionPadding={8}
          aria-labelledby={label ? titleId : undefined}
          aria-describedby={description ? descriptionId : undefined}
          className={clsx('z-popover w-72 rounded-lg border border-border bg-surface-overlay p-4 text-content shadow-overlay', className)}
        >
          {label && <div id={titleId} className="mb-1 text-sm font-semibold">{label}</div>}
          {description && <div id={descriptionId} className="mb-3 text-xs text-content-secondary">{description}</div>}
          {children}
          <PopoverPrimitive.Arrow className="fill-surface-overlay" />
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
          orientation === 'horizontal' ? 'border-b border-border-subtle' : 'flex-col border-r border-border-subtle',
        )}
      >
        {items.map((item) => (
          <TabsPrimitive.Trigger
            key={item.value}
            value={item.value}
            disabled={item.disabled}
            className="border-b-2 border-transparent px-3 py-2 text-sm text-content-secondary outline-none data-[state=active]:border-accent data-[state=active]:text-content focus-visible:bg-surface-hover disabled:opacity-40"
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
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description?: string
  children: ReactNode
  side?: 'left' | 'right'
}) {
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-overlay bg-surface-scrim" />
        <DialogPrimitive.Content
          className={clsx(
            'fixed inset-y-0 z-modal w-80 overflow-auto bg-surface-raised p-5 text-content shadow-overlay outline-none',
            side === 'right' ? 'right-0' : 'left-0',
          )}
        >
          <DialogPrimitive.Title className="pr-10 text-base font-semibold">{title}</DialogPrimitive.Title>
          {description && (
            <DialogPrimitive.Description className="mt-1 text-sm text-content-secondary">
              {description}
            </DialogPrimitive.Description>
          )}
          <DialogPrimitive.Close asChild>
            <IconButton aria-label="Close sheet" className="absolute right-3 top-3">
              <Icon name="x" size="sm" />
            </IconButton>
          </DialogPrimitive.Close>
          <div className="mt-4">{children}</div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}

export interface ComboboxOption {
  value: string
  label: string
  keywords?: string[]
  disabled?: boolean
}

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
  className?: string
}) {
  const listboxId = useId()
  const inputId = `${listboxId}-input`
  const supportingTextId = `${listboxId}-supporting`
  const selectedLabel = useMemo(
    () => options.find((option) => option.value === value)?.label ?? '',
    [options, value],
  )
  const [query, setQuery] = useState(selectedLabel)
  const [uncontrolledLabel, setUncontrolledLabel] = useState(selectedLabel)
  const [open, setOpen] = useState(false)
  const [activeIndex, setActiveIndex] = useState(-1)
  const filtered = useMemo(() => {
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
  }, [options, query])

  const currentLabel = value === undefined ? uncontrolledLabel : selectedLabel
  const resolvedActiveIndex = (
    activeIndex >= 0
    && activeIndex < filtered.length
    && !filtered[activeIndex]?.disabled
  ) ? activeIndex : -1
  const enabledIndices = filtered.reduce<number[]>((indices, option, index) => {
    if (!option.disabled) indices.push(index)
    return indices
  }, [])
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
    } else if (event.key === 'Enter' && open && filtered[resolvedActiveIndex]) {
      event.preventDefault()
      choose(filtered[resolvedActiveIndex])
    } else if (event.key === 'Escape') {
      event.preventDefault()
      setOpen(false)
      setActiveIndex(-1)
    } else if (event.key === 'Tab') {
      setOpen(false)
      setActiveIndex(-1)
    }
  }

  return (
    <div className={clsx('relative space-y-1.5', className)}>
      <label htmlFor={inputId} className="text-xs font-medium text-content-secondary">
        {label}
        {required && <span className="ml-1 text-status-danger" aria-hidden="true">*</span>}
      </label>
      <input
        id={inputId}
        role="combobox"
        aria-expanded={open}
        aria-controls={listboxId}
        aria-haspopup="listbox"
        aria-autocomplete="list"
        aria-activedescendant={open && filtered[resolvedActiveIndex] ? `${listboxId}-${resolvedActiveIndex}` : undefined}
        aria-describedby={error || description ? supportingTextId : undefined}
        aria-invalid={error ? true : undefined}
        aria-required={required || undefined}
        autoComplete="off"
        disabled={disabled}
        value={open ? query : currentLabel}
        placeholder={placeholder}
        onFocus={() => {
          setQuery(currentLabel)
          setOpen(true)
          setActiveIndex(-1)
        }}
        onBlur={() => {
          setOpen(false)
          setActiveIndex(-1)
        }}
        onChange={(event) => {
          setQuery(event.target.value)
          setActiveIndex(-1)
          setOpen(true)
        }}
        onKeyDown={onKeyDown}
        className={clsx(
          'w-full rounded-md border border-border bg-surface-sunken text-content placeholder:text-content-muted focus:border-accent focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:cursor-not-allowed disabled:opacity-50',
          error && 'border-status-danger focus:border-status-danger focus-visible:ring-status-danger/30',
          size === 'sm' && 'px-2.5 py-1.5 text-xs',
          size === 'md' && 'px-3 py-2 text-sm',
          size === 'lg' && 'px-3.5 py-2.5 text-base',
        )}
      />
      {(error || description) && (
        <p
          id={supportingTextId}
          role={error ? 'alert' : undefined}
          className={clsx('text-xs', error ? 'text-status-danger' : 'text-content-muted')}
        >
          {error ?? description}
        </p>
      )}
      {open && (
        <div
          id={listboxId}
          role="listbox"
          className="absolute top-full z-popover mt-1 max-h-56 w-full overflow-auto rounded-md border border-border bg-surface-overlay p-1 shadow-overlay"
        >
          {filtered.length === 0 ? (
            <p className="px-2 py-3 text-sm text-content-muted">No results</p>
          ) : filtered.map((option, index) => (
            <button
              key={option.value}
              id={`${listboxId}-${index}`}
              type="button"
              role="option"
              aria-selected={option.value === value}
              aria-disabled={option.disabled || undefined}
              disabled={option.disabled}
              onMouseDown={(event) => event.preventDefault()}
              onMouseMove={() => {
                if (!option.disabled) setActiveIndex(index)
              }}
              onClick={() => choose(option)}
              className={clsx(
                'block w-full rounded px-2 py-1.5 text-left text-sm text-content disabled:opacity-40',
                index === resolvedActiveIndex && 'bg-surface-hover',
              )}
            >
              {option.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

export function Command({
  open,
  onOpenChange,
  title = 'Command palette',
  options,
  onSelect,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title?: string
  options: ComboboxOption[]
  onSelect: (value: string) => void
}) {
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-overlay bg-surface-scrim" />
        <DialogPrimitive.Content className="fixed left-1/2 top-1/4 z-modal w-11/12 max-w-lg -translate-x-1/2 rounded-lg bg-surface-raised p-4 shadow-overlay outline-none">
          <DialogPrimitive.Title className="sr-only">{title}</DialogPrimitive.Title>
          <Combobox
            label={title}
            options={options}
            onValueChange={(value) => {
              onSelect(value)
              onOpenChange(false)
            }}
          />
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}
