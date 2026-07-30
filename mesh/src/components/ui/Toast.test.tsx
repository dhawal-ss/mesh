import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { showToast, ToastContainer } from './Toast'

describe('ToastContainer accessibility', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(async () => {
    vi.useFakeTimers()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    await act(async () => root.render(<ToastContainer />))
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    vi.useRealTimers()
  })

  it('announces danger assertively and waits for an explicit keyboard-reachable dismissal', async () => {
    await act(async () => showToast('Could not remove Bob', 'danger'))
    const assertiveRegion = container.querySelector('[role="alert"][aria-live="assertive"]')
    expect(assertiveRegion?.textContent).toContain('Could not remove Bob')
    const dismiss = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Dismiss notification: Could not remove Bob"]',
    )
    expect(dismiss).not.toBeNull()

    await act(async () => vi.advanceTimersByTime(60_000))
    expect(assertiveRegion?.textContent).toContain('Could not remove Bob')
    await act(async () => {
      dismiss?.click()
      await vi.runAllTimersAsync()
    })
    expect(assertiveRegion?.textContent).not.toContain('Could not remove Bob')
  })
})
