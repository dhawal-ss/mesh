import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import * as bridge from '../../lib/bridge'
import { useChannelStore } from '../../store/channels'
import { useCommunityStore } from '../../store/communities'
import type { Message } from '../../types/ipc'
import { SearchBar } from './SearchBar'

const targetMessage: Message = {
  id: 'target-message',
  channelId: 'channel-b',
  authorPublicKey: 'sender-1',
  authorDisplayName: 'Sender',
  authorAvatarColor: '#52b5f4',
  content: 'The searched message',
  attachments: [],
  reactions: {},
  timestamp: '2026-07-25T11:30:00.000Z',
  signature: '',
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve
  })
  return { promise, resolve }
}

describe('SearchBar', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    vi.useFakeTimers()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    useCommunityStore.setState({
      communities: [],
      activeCommunityId: 'community-1',
    })
    useChannelStore.setState({
      channels: [
        {
          id: 'channel-b',
          communityId: 'community-1',
          name: 'beta',
          channelType: 'text',
          unreadCount: 0,
        },
      ],
      activeChannelId: 'channel-a',
    })
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    vi.useRealTimers()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('passes the complete result to the navigation owner', async () => {
    const navigate = vi.fn()
    const searchMessages = vi.spyOn(bridge, 'searchMessages').mockResolvedValue([targetMessage])

    await act(async () => {
      root.render(<SearchBar onNavigateToMessage={navigate} />)
    })

    const openButton = container.querySelector<HTMLButtonElement>(
      'button[title="Search messages"]',
    )
    await act(async () => {
      openButton?.click()
    })

    const input = container.querySelector<HTMLInputElement>('input[type="text"]')
    const setValue = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    )?.set
    await act(async () => {
      setValue?.call(input, 'searched')
      input?.dispatchEvent(new Event('input', { bubbles: true }))
      vi.advanceTimersByTime(300)
      await Promise.resolve()
    })

    expect(searchMessages).toHaveBeenCalledWith('searched', 'community-1', 20)
    const resultButton = [...container.querySelectorAll('button')].find(
      (button) => button.textContent?.includes(targetMessage.content),
    )
    await act(async () => {
      resultButton?.click()
    })

    expect(navigate).toHaveBeenCalledWith(targetMessage)
    expect(useChannelStore.getState().activeChannelId).toBe('channel-a')
  })

  it('labels thread replies in search results', async () => {
    vi.spyOn(bridge, 'searchMessages').mockResolvedValue([
      { ...targetMessage, threadRootId: '$root' },
    ])

    await act(async () => {
      root.render(<SearchBar onNavigateToMessage={vi.fn()} />)
    })
    await act(async () => {
      container.querySelector<HTMLButtonElement>('button[title="Search messages"]')?.click()
    })
    const input = container.querySelector<HTMLInputElement>('input[type="text"]')
    const setValue = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    )?.set
    await act(async () => {
      setValue?.call(input, 'searched')
      input?.dispatchEvent(new Event('input', { bubbles: true }))
      vi.advanceTimersByTime(300)
      await Promise.resolve()
    })

    expect(container.textContent).toContain('Thread reply')
  })

  it('ignores a slower result from an older query', async () => {
    const first = deferred<Message[]>()
    const second = deferred<Message[]>()
    const firstMessage = { ...targetMessage, id: 'first-result', content: 'first result' }
    const secondMessage = { ...targetMessage, id: 'second-result', content: 'second result' }
    const searchMessages = vi.spyOn(bridge, 'searchMessages').mockImplementation((query) => (
      query === 'first' ? first.promise : second.promise
    ))

    await act(async () => {
      root.render(<SearchBar onNavigateToMessage={vi.fn()} />)
    })
    await act(async () => {
      container.querySelector<HTMLButtonElement>('button[title="Search messages"]')?.click()
    })
    const input = container.querySelector<HTMLInputElement>('input[type="text"]')
    const setValue = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    )?.set

    await act(async () => {
      setValue?.call(input, 'first')
      input?.dispatchEvent(new Event('input', { bubbles: true }))
      vi.advanceTimersByTime(300)
      await Promise.resolve()
    })
    expect(searchMessages).toHaveBeenCalledWith('first', 'community-1', 20)

    await act(async () => {
      setValue?.call(input, 'second')
      input?.dispatchEvent(new Event('input', { bubbles: true }))
      vi.advanceTimersByTime(300)
      await Promise.resolve()
    })
    expect(searchMessages).toHaveBeenCalledWith('second', 'community-1', 20)

    await act(async () => {
      first.resolve([firstMessage])
      await Promise.resolve()
    })
    expect(container.textContent).not.toContain('first result')

    await act(async () => {
      second.resolve([secondMessage])
      await Promise.resolve()
    })
    expect(container.textContent).toContain('second result')
  })

  it('supports ArrowDown and Enter result selection', async () => {
    const navigate = vi.fn()
    const secondMessage = { ...targetMessage, id: 'second-result', content: 'second result' }
    vi.spyOn(bridge, 'searchMessages').mockResolvedValue([targetMessage, secondMessage])

    await act(async () => {
      root.render(<SearchBar onNavigateToMessage={navigate} />)
    })
    await act(async () => {
      container.querySelector<HTMLButtonElement>('button[title="Search messages"]')?.click()
    })
    const input = container.querySelector<HTMLInputElement>('input[type="text"]')
    const setValue = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    )?.set
    await act(async () => {
      setValue?.call(input, 'searched')
      input?.dispatchEvent(new Event('input', { bubbles: true }))
      vi.advanceTimersByTime(300)
      await Promise.resolve()
    })

    await act(async () => {
      input?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
      await Promise.resolve()
    })
    expect(input?.getAttribute('aria-activedescendant')).toBe('search-result-second-result')

    await act(async () => {
      input?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      await Promise.resolve()
    })
    expect(navigate).toHaveBeenCalledWith(secondMessage)
  })

  it('explains a failed search and retries the same query', async () => {
    const searchMessages = vi.spyOn(bridge, 'searchMessages')
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce([targetMessage])

    await act(async () => {
      root.render(<SearchBar onNavigateToMessage={vi.fn()} />)
    })
    await act(async () => {
      container.querySelector<HTMLButtonElement>('button[title="Search messages"]')?.click()
    })
    const input = container.querySelector<HTMLInputElement>('input[type="text"]')
    const setValue = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    )?.set
    await act(async () => {
      setValue?.call(input, 'searched')
      input?.dispatchEvent(new Event('input', { bubbles: true }))
      vi.advanceTimersByTime(300)
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(container.textContent).toContain('Search is temporarily unavailable')
    const retryButton = [...container.querySelectorAll('button')].find(
      (button) => button.textContent === 'Try again',
    )
    await act(async () => {
      retryButton?.click()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(searchMessages).toHaveBeenNthCalledWith(2, 'searched', 'community-1', 20)
    expect(container.textContent).toContain(targetMessage.content)
  })

  it('uses the compact empty state when a search has no results', async () => {
    vi.spyOn(bridge, 'searchMessages').mockResolvedValue([])

    await act(async () => {
      root.render(<SearchBar onNavigateToMessage={vi.fn()} />)
    })
    await act(async () => {
      container.querySelector<HTMLButtonElement>('button[title="Search messages"]')?.click()
    })
    const input = container.querySelector<HTMLInputElement>('input[type="text"]')
    const setValue = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    )?.set
    await act(async () => {
      setValue?.call(input, 'missing')
      input?.dispatchEvent(new Event('input', { bubbles: true }))
      vi.advanceTimersByTime(300)
      await Promise.resolve()
    })

    expect(container.textContent).toContain('No messages found')
    expect(container.textContent).toContain('Try another word or phrase.')
    expect(container.querySelector('section')?.className).toContain('py-5')
  })

  it('returns focus to the search trigger when Escape closes the popover', async () => {
    await act(async () => {
      root.render(<SearchBar onNavigateToMessage={vi.fn()} />)
    })
    const trigger = container.querySelector<HTMLButtonElement>('button[title="Search messages"]')
    await act(async () => {
      trigger?.click()
    })
    const input = container.querySelector<HTMLInputElement>('input[type="text"]')
    expect(document.activeElement).toBe(input)

    await act(async () => {
      input?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      await Promise.resolve()
    })

    expect(trigger?.getAttribute('aria-expanded')).toBe('false')
    expect(document.activeElement).toBe(trigger)
  })
})
