import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useTypingStore } from '../../store/typing'
import { TypingIndicator } from './TypingIndicator'

describe('TypingIndicator', () => {
  let container: HTMLDivElement
  let root: Root
  let hidden = false

  beforeEach(() => {
    vi.useFakeTimers()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    hidden = false
    Object.defineProperty(document, 'hidden', {
      configurable: true,
      get: () => hidden,
    })
    useTypingStore.setState({ typingByChannel: {} })
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    vi.useRealTimers()
  })

  it('announces typing changes and pauses expiration work while the page is hidden', async () => {
    useTypingStore.getState().setTyping('room-1', '@alice:example.org', 'Alice')
    await act(async () => root.render(<TypingIndicator channelId="room-1" />))

    const status = container.querySelector('[role="status"][aria-live="polite"]')
    expect(status?.textContent).toContain('Alice is typing')

    hidden = true
    document.dispatchEvent(new Event('visibilitychange'))
    await act(async () => vi.advanceTimersByTimeAsync(8_000))
    expect(useTypingStore.getState().typingByChannel['room-1']).toHaveLength(1)

    hidden = false
    await act(async () => document.dispatchEvent(new Event('visibilitychange')))
    expect(useTypingStore.getState().typingByChannel['room-1']).toHaveLength(0)
    expect(status?.textContent).toBe('')
  })
})
