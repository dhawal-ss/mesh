import { act, type ReactNode, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DialogErrorBoundary, ScopedErrorBoundary } from './ScopedErrorBoundary'

describe('scoped error containment', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('keeps sibling UI available and retries a throwing feature locally', async () => {
    let shouldThrow = true

    function MalformedFeature() {
      if (shouldThrow) throw new Error('malformed child data')
      return <p>Feature recovered</p>
    }

    await act(async () => {
      root.render(
        <div>
          <p>Conversation remains available</p>
          <ScopedErrorBoundary name="Member list">
            <MalformedFeature />
          </ScopedErrorBoundary>
        </div>,
      )
    })

    expect(container.textContent).toContain('Conversation remains available')
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      'Member list is unavailable',
    )

    shouldThrow = false
    const retry = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Try again',
    )
    expect(retry).toBeTruthy()

    await act(async () => retry?.click())

    expect(container.textContent).toContain('Feature recovered')
    expect(container.querySelector('[role="alert"]')).toBeNull()
  })

  it('keeps a failed settings surface modal and closeable with Escape', async () => {
    const onClose = vi.fn()
    const opener = document.createElement('button')
    opener.textContent = 'Open settings'
    document.body.appendChild(opener)
    opener.focus()

    function ThrowingSettings(): ReactNode {
      throw new Error('settings render failed')
    }

    function SettingsHarness() {
      const [open, setOpen] = useState(true)
      return (
        <DialogErrorBoundary
          open={open}
          onClose={() => {
            onClose()
            setOpen(false)
          }}
          title="User Settings"
        >
          <ThrowingSettings />
        </DialogErrorBoundary>
      )
    }

    await act(async () => {
      root.render(<SettingsHarness />)
    })

    const dialog = document.body.querySelector<HTMLElement>('[role="dialog"]')
    expect(dialog).toBeTruthy()
    expect(dialog?.getAttribute('aria-modal')).toBe('true')
    expect(dialog?.textContent).toContain('This settings panel could not be displayed.')

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    expect(onClose).toHaveBeenCalledTimes(1)
    expect(document.body.querySelector('[role="dialog"]')).toBeNull()
    expect(document.activeElement).toBe(opener)
    opener.remove()
  })
})
