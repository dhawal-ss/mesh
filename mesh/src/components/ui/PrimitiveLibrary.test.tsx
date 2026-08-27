import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Avatar } from './Avatar'
import { Button } from './Button'
import { ErrorState } from './ErrorState'
import { IconButton } from './IconButton'
import { Input } from './Input'
import {
  Combobox,
  Command,
  ContextMenu,
  DropdownMenu,
  Popover,
  Select,
  Sheet,
  Switch,
  Tabs,
} from './InteractivePrimitives'
import { Dialog, Modal } from './Modal'
import { ModalLoadingFallback } from './ModalLoadingFallback'
import {
  Badge,
  Card,
  Checkbox,
  EmptyState,
  Field,
  Kbd,
  Notice,
  Progress,
  Radio,
  ScrollArea,
  SectionHeader,
  Separator,
  Slider,
  Textarea,
} from './Primitives'
import { Skeleton } from './Skeleton'
import { Spinner } from './Spinner'
import { ToastContainer } from './Toast'
import { Tooltip } from './Tooltip'

describe('W2.3 primitive library', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    vi.unstubAllGlobals()
  })

  it('provides every primitive in the production-plan inventory', () => {
    const inventory = {
      Button,
      IconButton,
      Input,
      Textarea,
      Field,
      Select,
      Combobox,
      Switch,
      Checkbox,
      Radio,
      Slider,
      DropdownMenu,
      ContextMenu,
      Popover,
      Tooltip,
      Dialog,
      Modal,
      Sheet,
      Tabs,
      Command,
      Toast: ToastContainer,
      Badge,
      Progress,
      Separator,
      ScrollArea,
      Avatar,
      Skeleton,
      EmptyState,
      ErrorState,
      Kbd,
      Card,
      Notice,
      SectionHeader,
      Spinner,
    }

    expect(Object.keys(inventory)).toHaveLength(34)
    Object.values(inventory).forEach((primitive) => expect(primitive).toBeTruthy())
  })

  it('connects Field validation and help text to its control', () => {
    act(() => {
      root.render(
        <Field label="About" htmlFor="about" error="About is required" required>
          <Textarea id="about" aria-describedby="existing-help" />
        </Field>,
      )
    })

    const textarea = container.querySelector('textarea')
    const alert = container.querySelector('[role="alert"]')
    expect(textarea?.getAttribute('aria-invalid')).toBe('true')
    expect(textarea?.getAttribute('aria-required')).toBe('true')
    expect(textarea?.getAttribute('aria-describedby')).toContain('existing-help')
    expect(textarea?.getAttribute('aria-describedby')).toContain(alert?.id)
  })

  it('associates choice and slider descriptions with their native controls', () => {
    act(() => {
      root.render(
        <>
          <p id="shared-choice-help">Applies across this device.</p>
          <Checkbox
            id="compact"
            label="Compact mode"
            description="Reduce message spacing."
            aria-describedby="shared-choice-help"
            disabled
          />
          <Slider id="scale" label="Message size" valueLabel="15 pixels" defaultValue={50} />
        </>,
      )
    })

    const checkbox = container.querySelector<HTMLInputElement>('#compact')
    const slider = container.querySelector<HTMLInputElement>('#scale')
    expect(checkbox?.getAttribute('aria-describedby')).toBe('shared-choice-help compact-description')
    expect(document.getElementById('compact-description')?.textContent).toBe('Reduce message spacing.')
    expect(checkbox?.disabled).toBe(true)
    expect(slider?.getAttribute('aria-valuetext')).toBe('15 pixels')
  })

  it('preserves external input help when it also renders local supporting text', () => {
    act(() => {
      root.render(
        <>
          <p id="account-policy">Account names are public.</p>
          <Input id="account-name" label="Account name" hint="Use 3–32 characters." aria-describedby="account-policy" />
        </>,
      )
    })

    const input = container.querySelector<HTMLInputElement>('#account-name')
    expect(input?.getAttribute('aria-describedby')).toBe('account-policy account-name-supporting')
  })

  it('keeps shared controls on the same density-aware height contract', () => {
    act(() => {
      root.render(
        <>
          <Button size="sm">Small</Button>
          <Button size="md">Medium</Button>
          <Button size="lg">Large</Button>
          <Input id="symmetric-input" label="Name" size="md" />
          <IconButton aria-label="Open" size="md"><span aria-hidden>+</span></IconButton>
        </>,
      )
    })

    const [small, medium, large, icon] = container.querySelectorAll('button')
    const input = container.querySelector<HTMLInputElement>('#symmetric-input')
    expect(small.className).toContain('h-control-sm')
    expect(medium.className).toContain('h-control-md')
    expect(large.className).toContain('h-control-lg')
    expect(input?.className).toContain('h-control-md')
    expect(icon.className).toContain('h-control-md')
    expect(icon.className).toContain('w-control-md')
  })

  it('matches lazy modal fallbacks to the resolved modal width contract', () => {
    act(() => {
      root.render(
        <ModalLoadingFallback title="User settings" label="Loading settings" size="xl" />,
      )
    })

    const fallback = container.querySelector('[role="status"]')
    expect(fallback?.className).toContain('max-w-3xl')
    expect(fallback?.querySelector('.mesh-loading-title')).not.toBeNull()
    expect(fallback?.querySelector('.mesh-loading-lines')).not.toBeNull()
  })

  it('clamps progress values and applies its size and tone contracts', () => {
    act(() => {
      root.render(<Progress label="Upload" value={140} size="lg" tone="accent" showValue />)
    })

    const progress = container.querySelector('[role="progressbar"]')
    expect(progress?.getAttribute('aria-valuenow')).toBe('100')
    expect(progress?.className).toContain('h-2')
    expect(progress?.firstElementChild?.className).toContain('bg-primary')
    expect(container.textContent).toContain('100%')
  })

  it('renders a compact empty state with an optional centered icon', () => {
    act(() => {
      root.render(
        <EmptyState
          variant="compact"
          icon={<span data-testid="empty-icon">icon</span>}
          title="Nothing here"
          description="New items will appear here."
        />,
      )
    })

    const section = container.querySelector('section')
    const title = container.querySelector('h3')
    const description = container.querySelector('p')
    const icon = container.querySelector('[data-testid="empty-icon"]')

    expect(section?.className).toContain('py-5')
    expect(section?.className).not.toContain('py-10')
    expect(title?.className).toContain('text-sm')
    expect(description?.className).toContain('text-xs')
    expect(icon?.parentElement?.className).toContain('h-6')
    expect(section?.getAttribute('aria-labelledby')).toBe(title?.id)
    expect(section?.getAttribute('aria-describedby')).toBe(description?.id)
  })

  it('renders a tooltip trigger without mounting a provider for every tooltip', () => {
    // The delay and skip-delay settings only apply per provider group, so the
    // provider now lives once at the application root. This asserts the leaf
    // still mounts on its own.
    act(() => {
      root.render(
        <Tooltip content="Home">
          <button type="button">Home</button>
        </Tooltip>,
      )
    })

    expect(container.querySelector('button')?.textContent).toBe('Home')
  })

  it('renders one section header contract with a trailing mono count', () => {
    act(() => {
      root.render(<SectionHeader id="rooms-heading" title="Rooms" count={12} />)
    })

    const header = container.firstElementChild
    const count = container.querySelector('span + span')
    expect(header?.className).toContain('min-h-8')
    // Quiet Structure's eyebrow: mono at 9.5px, not the 11px caption step.
    // tracking-eyebrow rides on the type role now rather than being applied
    // beside it, so the class is gone and the 0.16em is not.
    expect(header?.className).toContain('font-mono')
    expect(header?.className).toContain('text-eyebrow')
    expect(header?.className).toContain('text-content-secondary')
    expect(count?.className).toContain('font-mono')
    expect(count?.textContent).toBe('12')
    expect(container.querySelector('#rooms-heading')?.textContent).toBe('Rooms')
  })

  it('gives a notice one of the two authored intensities and a tone attribute', () => {
    act(() => {
      root.render(
        <Notice intensity="band" tone="marker" title="Sync paused">
          Mesh will retry when the connection returns.
        </Notice>,
      )
    })

    const notice = container.firstElementChild
    expect(notice?.className).toContain('mesh-notice-band')
    expect(notice?.className).not.toContain('mesh-notice-advisory')
    expect(notice?.getAttribute('data-notice-tone')).toBe('marker')
    expect(notice?.textContent).toContain('Sync paused')
  })

  it('names the loading process even when reduced motion stops the spin', () => {
    act(() => {
      root.render(<Spinner size={16} label="Loading rooms" />)
    })

    const status = container.querySelector('[role="status"]')
    expect(status).not.toBeNull()
    expect(status?.textContent).toBe('Loading rooms')
    // The stepped indicator is the reduced-motion route and ships alongside
    // the glyph, so stopping the animation cannot leave an empty status.
    expect(status?.querySelector('.mesh-spinner-glyph')).not.toBeNull()
    expect(status?.querySelectorAll('.mesh-spinner-steps > span')).toHaveLength(3)
  })

  it('keeps context-menu navigation collision-safe and keyboard complete', async () => {
    const onSelect = vi.fn()
    await act(async () => {
      root.render(
        <ContextMenu
          label="Message actions"
          items={[
            { id: 'edit', label: 'Edit Message' },
            { id: 'disabled', label: 'Unavailable', disabled: true },
            { id: 'delete', label: 'Delete Message', tone: 'danger', onSelect },
          ]}
        >
          <button type="button">Open actions</button>
        </ContextMenu>,
      )
    })

    const trigger = container.querySelector('button')!
    trigger.focus()
    await act(async () => {
      trigger.dispatchEvent(
        new MouseEvent('contextmenu', {
          bubbles: true,
          cancelable: true,
          clientX: window.innerWidth - 1,
          clientY: window.innerHeight - 1,
        }),
      )
      await Promise.resolve()
    })

    const menu = document.querySelector<HTMLElement>('[role="menu"][aria-label="Message actions"]')
    const items = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
    expect(menu).not.toBeNull()
    expect(items.map((item) => item.textContent)).toEqual(['Edit Message', 'Unavailable', 'Delete Message'])

    await act(async () => {
      menu?.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }))
      await Promise.resolve()
    })
    expect(document.activeElement).toBe(items[2])

    await act(async () => {
      menu?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }))
      await Promise.resolve()
    })
    expect(document.activeElement).toBe(items[0])

    await act(async () => {
      menu?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      await Promise.resolve()
    })
    await vi.waitFor(() => {
      expect(document.querySelector('[role="menu"][aria-label="Message actions"]')).toBeNull()
      expect(document.activeElement).toBe(trigger)
    })
  })

  it('opens the combobox on ArrowDown and activates the first enabled option', () => {
    const onValueChange = vi.fn()
    act(() => {
      root.render(
        <Combobox
          label="Channel"
          options={[
            { value: 'disabled', label: 'Unavailable', disabled: true },
            { value: 'general', label: 'General' },
            { value: 'random', label: 'Random' },
          ]}
          onValueChange={onValueChange}
        />,
      )
    })

    const input = container.querySelector<HTMLInputElement>('[role="combobox"]')!
    act(() => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })))

    const activeId = input.getAttribute('aria-activedescendant')
    expect(activeId).toBeTruthy()
    // A combobox row carries its position in the list as a visible mono
    // numeral now, so identity comes from the label the row contains.
    expect(document.getElementById(activeId!)?.textContent).toContain('General')

    act(() => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })))
    expect(onValueChange).toHaveBeenCalledWith('general')
    expect(input.value).toBe('General')
    expect(input.getAttribute('aria-expanded')).toBe('false')
  })

  it('supports Home, End, Escape, and controlled-value synchronization', () => {
    const options = [
      { value: 'general', label: 'General' },
      { value: 'random', label: 'Random' },
    ]
    const render = (value?: string) => (
      <Combobox label="Channel" options={options} value={value} onValueChange={() => undefined} />
    )
    act(() => root.render(render()))

    const input = container.querySelector<HTMLInputElement>('[role="combobox"]')!
    act(() => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })))
    act(() => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true })))
    expect(document.getElementById(input.getAttribute('aria-activedescendant')!)?.textContent).toContain('Random')

    act(() => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true })))
    expect(document.getElementById(input.getAttribute('aria-activedescendant')!)?.textContent).toContain('General')

    act(() => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
    expect(input.getAttribute('aria-expanded')).toBe('false')
    expect(input.hasAttribute('aria-activedescendant')).toBe(false)

    act(() => root.render(render('random')))
    expect(input.value).toBe('Random')
  })
})
