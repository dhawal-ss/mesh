import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { OfflineQueueSummary } from './OfflineQueueSummary'

describe('OfflineQueueSummary', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    vi.useFakeTimers()
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('shows a review action and coalesces the polite queue count', async () => {
    const onReview = vi.fn()
    await act(async () => root.render(<OfflineQueueSummary count={2} onReview={onReview} />))

    expect(container.textContent).toContain('2 messages saved for later')
    expect(container.querySelector('[role="status"]')?.textContent).toBe('')

    await act(async () => vi.advanceTimersByTime(400))
    expect(container.querySelector('[role="status"]')?.textContent).toBe(
      '2 messages are saved for later.',
    )

    await act(async () => container.querySelector<HTMLButtonElement>('button')?.click())
    expect(onReview).toHaveBeenCalledOnce()
  })

  it('does not reserve composer space when the queue is empty', async () => {
    await act(async () => root.render(<OfflineQueueSummary count={0} onReview={vi.fn()} />))
    expect(container.innerHTML).toBe('')
  })
})
