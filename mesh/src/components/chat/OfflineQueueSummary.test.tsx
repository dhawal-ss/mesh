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

  it('reports a failed send persistently, and assertively', async () => {
    /*
      Believing a message was delivered when it was not is the highest-cost
      failure a chat product has. Before this the only surfaces were a chip on
      the row, an sr-only region, and a sound: a sighted person with sound off
      who had scrolled away got nothing at all.
    */
    const onReviewFailed = vi.fn()
    await act(async () => root.render(
      <OfflineQueueSummary count={0} failedCount={1} onReview={vi.fn()} onReviewFailed={onReviewFailed} />,
    ))

    expect(container.textContent).toContain('1 message could not be sent')
    // The warning is a persistent visible strip, not only an sr-only region.
    expect(container.querySelector('.bg-container-danger')?.textContent)
      .toContain('1 message could not be sent.')

    const alert = container.querySelector('[role="alert"]')
    expect(alert?.getAttribute('aria-live')).toBe('assertive')

    await act(async () => {
      vi.advanceTimersByTime(400)
    })
    expect(alert?.textContent).toContain('1 message could not be sent.')

    const review = container.querySelector('button')
    await act(async () => review?.click())
    expect(onReviewFailed).toHaveBeenCalledTimes(1)
  })

  it('lets a failure outrank a queued message, because only one needs a person', async () => {
    await act(async () => root.render(
      <OfflineQueueSummary count={3} failedCount={2} onReview={vi.fn()} onReviewFailed={vi.fn()} />,
    ))

    expect(container.textContent).toContain('2 messages could not be sent')
    expect(container.textContent).not.toContain('saved for later')
    expect(container.textContent).not.toContain('Mesh will retry automatically')
  })

  it('falls back to the queued review action when no failed handler is given', async () => {
    const onReview = vi.fn()
    await act(async () => root.render(
      <OfflineQueueSummary count={0} failedCount={1} onReview={onReview} />,
    ))
    await act(async () => container.querySelector('button')?.click())
    expect(onReview).toHaveBeenCalledTimes(1)
  })

  it('shows a review action and coalesces the polite queue count', async () => {
    const onReview = vi.fn()
    await act(async () => root.render(<OfflineQueueSummary count={2} onReview={onReview} />))

    expect(container.textContent).toContain('2 messages saved for later')
    expect(container.querySelector('button')?.textContent).toContain('Review')
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
