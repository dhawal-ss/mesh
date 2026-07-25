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
import {
  Badge,
  Card,
  Checkbox,
  EmptyState,
  Field,
  Kbd,
  Progress,
  Radio,
  ScrollArea,
  Separator,
  Slider,
  Textarea,
} from './Primitives'
import { Skeleton } from './Skeleton'
import { ToastContainer } from './Toast'
import { Tooltip } from './Tooltip'

describe('W2.3 primitive library', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
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
    }

    expect(Object.keys(inventory)).toHaveLength(31)
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
          <Checkbox id="compact" label="Compact mode" description="Reduce message spacing." disabled />
          <Slider id="scale" label="Message size" valueLabel="15 pixels" defaultValue={50} />
        </>,
      )
    })

    const checkbox = container.querySelector<HTMLInputElement>('#compact')
    const slider = container.querySelector<HTMLInputElement>('#scale')
    expect(checkbox?.getAttribute('aria-describedby')).toBe('compact-description')
    expect(document.getElementById('compact-description')?.textContent).toBe('Reduce message spacing.')
    expect(checkbox?.disabled).toBe(true)
    expect(slider?.getAttribute('aria-valuetext')).toBe('15 pixels')
  })

  it('clamps progress values and applies its size and tone contracts', () => {
    act(() => {
      root.render(<Progress label="Upload" value={140} size="lg" tone="success" showValue />)
    })

    const progress = container.querySelector('[role="progressbar"]')
    expect(progress?.getAttribute('aria-valuenow')).toBe('100')
    expect(progress?.className).toContain('h-2')
    expect(progress?.firstElementChild?.className).toContain('bg-status-success')
    expect(container.textContent).toContain('100%')
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
    expect(document.getElementById(activeId!)?.textContent).toBe('General')

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
    expect(document.getElementById(input.getAttribute('aria-activedescendant')!)?.textContent).toBe('Random')

    act(() => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true })))
    expect(document.getElementById(input.getAttribute('aria-activedescendant')!)?.textContent).toBe('General')

    act(() => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
    expect(input.getAttribute('aria-expanded')).toBe('false')
    expect(input.hasAttribute('aria-activedescendant')).toBe(false)

    act(() => root.render(render('random')))
    expect(input.value).toBe('Random')
  })
})
