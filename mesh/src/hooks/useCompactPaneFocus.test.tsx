import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useCompactPaneFocus } from './useCompactPaneFocus'

function Harness({ onClose }: { onClose: () => void }) {
  useCompactPaneFocus({
    active: true,
    compact: true,
    panelId: 'test-pane',
    onClose,
  })
  return (
    <aside id="test-pane" tabIndex={-1}>
      <button type="button">First</button>
      <button type="button">Last</button>
    </aside>
  )
}

describe('useCompactPaneFocus', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0)
      return 1
    })
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
    vi.spyOn(HTMLElement.prototype, 'getClientRects')
      .mockReturnValue([{} as DOMRect] as unknown as DOMRectList)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('focuses the pane, contains Tab, and closes on Escape', async () => {
    const onClose = vi.fn()
    await act(async () => root.render(<Harness onClose={onClose} />))

    const buttons = container.querySelectorAll<HTMLButtonElement>('button')
    expect(document.activeElement).toBe(buttons[0])

    await act(async () => {
      buttons[0].dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Tab',
        shiftKey: true,
        bubbles: true,
        cancelable: true,
      }))
    })
    expect(document.activeElement).toBe(buttons[1])

    await act(async () => {
      buttons[1].dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Tab',
        bubbles: true,
        cancelable: true,
      }))
    })
    expect(document.activeElement).toBe(buttons[0])

    await act(async () => {
      buttons[0].dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Escape',
        bubbles: true,
        cancelable: true,
      }))
    })
    expect(onClose).toHaveBeenCalledOnce()
  })
})
