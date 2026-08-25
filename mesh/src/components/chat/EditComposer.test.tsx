import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EditComposer } from './EditComposer'

const LABEL = 'Edit message from Ada'

describe('EditComposer', () => {
  let container: HTMLDivElement
  let root: Root

  const allButtons = () => [...container.querySelectorAll<HTMLButtonElement>('button')]
  const buttonByText = (text: string) =>
    allButtons().find((button) => button.textContent === text)
  const buttonByLabel = (label: string) =>
    allButtons().find((button) => button.getAttribute('aria-label') === label)
  const textarea = () => {
    const node = container.querySelector<HTMLTextAreaElement>('textarea')
    if (!node) throw new Error('edit textarea was not rendered')
    return node
  }

  const noop = () => {}

  beforeEach(() => {
    window.localStorage.clear()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    window.localStorage.clear()
  })

  it('names the textarea, and exposes save, cancel, and emoji affordances', async () => {
    await act(async () => {
      root.render(
        <EditComposer label={LABEL} value="hello" onChange={noop} onSave={noop} onCancel={noop} />,
      )
    })

    expect(textarea().getAttribute('aria-label')).toBe(LABEL)
    expect(buttonByText('save')).toBeTruthy()
    expect(buttonByText('cancel')).toBeTruthy()
    expect(buttonByLabel('Open emoji picker')).toBeTruthy()
    for (const label of ['Bold', 'Italic', 'Strikethrough', 'Inline code']) {
      expect(buttonByLabel(label)).toBeFalsy()
    }
    expect(container.querySelector('[role="toolbar"]')).toBeNull()
  })

  it('saves on Enter, cancels on Escape, and leaves Shift+Enter for a newline', async () => {
    const onSave = vi.fn()
    const onCancel = vi.fn()
    await act(async () => {
      root.render(
        <EditComposer label={LABEL} value="hello" onChange={noop} onSave={onSave} onCancel={onCancel} />,
      )
    })

    await act(async () => {
      textarea().dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
      )
    })
    expect(onSave).toHaveBeenCalledTimes(1)

    await act(async () => {
      textarea().dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true, cancelable: true }),
      )
    })
    expect(onSave).toHaveBeenCalledTimes(1)

    await act(async () => {
      textarea().dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
      )
    })
    expect(onCancel).toHaveBeenCalledTimes(1)
  })

  it('routes the inline save and cancel affordances to their handlers', async () => {
    const onSave = vi.fn()
    const onCancel = vi.fn()
    await act(async () => {
      root.render(
        <EditComposer label={LABEL} value="hello" onChange={noop} onSave={onSave} onCancel={onCancel} />,
      )
    })

    await act(async () => buttonByText('save')?.click())
    expect(onSave).toHaveBeenCalledTimes(1)

    await act(async () => buttonByText('cancel')?.click())
    expect(onCancel).toHaveBeenCalledTimes(1)
  })

  it('freezes every control while a save is in flight', async () => {
    await act(async () => {
      root.render(
        <EditComposer
          label={LABEL}
          value="hello"
          onChange={noop}
          onSave={noop}
          onCancel={noop}
          disabled
        />,
      )
    })

    expect(textarea().disabled).toBe(true)
    expect(buttonByLabel('Open emoji picker')?.disabled).toBe(true)
    expect(buttonByText('save')?.disabled).toBe(true)
    expect(buttonByText('cancel')?.disabled).toBe(true)
  })
})
