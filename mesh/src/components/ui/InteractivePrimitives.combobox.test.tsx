import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Combobox, Command, type ComboboxOption } from './InteractivePrimitives'

describe('Combobox keyboard behavior', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
  })

  it('keeps its list open while focus moves to an option and closes after focus leaves', async () => {
    await renderCombobox()
    const input = findInput()
    await act(async () => input.focus())
    const firstOption = container.querySelector<HTMLButtonElement>('[role="option"]')
    expect(firstOption).not.toBeNull()

    await act(async () => firstOption?.focus())
    expect(document.activeElement).toBe(firstOption)
    expect(input.getAttribute('aria-expanded')).toBe('true')

    const outside = document.createElement('button')
    document.body.appendChild(outside)
    await act(async () => outside.focus())
    expect(input.getAttribute('aria-expanded')).toBe('false')
    outside.remove()
  })

  it('auto-highlights the first query result so typing then Enter selects it', async () => {
    const onValueChange = vi.fn()
    await renderCombobox(onValueChange)
    const input = findInput()
    await act(async () => {
      input.focus()
      setInputValue(input, 'be')
    })

    const firstOption = container.querySelector<HTMLElement>('[role="option"]')
    expect(input.getAttribute('aria-activedescendant')).toBe(firstOption?.id)
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Enter',
        bubbles: true,
        cancelable: true,
      }))
    })
    expect(onValueChange).toHaveBeenCalledWith('beta')
  })

  it('caps the empty-query list but searches the complete option set', async () => {
    const options = Array.from({ length: 80 }, (_, index) => ({
      value: `option-${index}`,
      label: `Choice ${index}`,
    }))
    await act(async () => {
      root.render(
        <Combobox
          label="Choices"
          options={options}
          maxEmptyOptions={10}
          onValueChange={() => {}}
        />,
      )
    })
    const input = findInput()
    await act(async () => input.focus())
    expect(container.querySelectorAll('[role="option"]')).toHaveLength(10)
    expect(container.textContent).toContain('Showing the first 10 results')

    await act(async () => setInputValue(input, 'Choice 79'))
    expect(container.querySelectorAll('[role="option"]')).toHaveLength(1)
    expect(container.textContent).toContain('Choice 79')
  })

  it('keeps an asynchronous person command open with a busy status', async () => {
    let finish: (() => void) | undefined
    const pending = new Promise<void>((resolve) => {
      finish = resolve
    })
    const options: ComboboxOption[] = [{
      value: 'person:@ada:example.org',
      label: 'Ada',
      group: 'People',
      title: 'Ada',
      subtitle: 'Start a conversation',
    }]

    function Harness() {
      const [open, setOpen] = useState(true)
      return (
        <Command
          open={open}
          onOpenChange={setOpen}
          options={options}
          onSelect={() => pending}
        />
      )
    }

    await act(async () => root.render(<Harness />))
    const input = document.body.querySelector<HTMLInputElement>('[role="combobox"]')!
    await act(async () => {
      input.focus()
      setInputValue(input, 'Ada')
      input.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Enter',
        bubbles: true,
        cancelable: true,
      }))
      await Promise.resolve()
    })
    expect(document.body.textContent).toContain('Opening a conversation with Ada')
    expect(document.body.querySelector('[role="dialog"]')).not.toBeNull()

    await act(async () => {
      finish?.()
      await pending
    })
    expect(document.body.querySelector('[role="dialog"]')).toBeNull()
  })

  async function renderCombobox(onValueChange: (value: string) => void = () => {}) {
    await act(async () => {
      root.render(
        <Combobox
          label="Greek letter"
          options={[
            { value: 'alpha', label: 'Alpha' },
            { value: 'beta', label: 'Beta' },
          ]}
          onValueChange={onValueChange}
        />,
      )
    })
  }

  function findInput() {
    const input = container.querySelector<HTMLInputElement>('[role="combobox"]')
    if (!input) throw new Error('Combobox input not found')
    return input
  }
})

function setInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  setter?.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}
