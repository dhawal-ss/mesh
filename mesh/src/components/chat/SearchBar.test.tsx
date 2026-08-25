import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import * as bridge from '../../lib/bridge'
import { SEARCH_MESSAGES_PER_ROOM } from '../../lib/search-query'
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
      communityEntities: {},
      activeCommunityId: 'community-1',
    })
    useChannelStore.setState({
      channels: [
        {
          id: 'channel-b',
          communityId: 'community-1',
          name: 'beta',
          topic: '',
          channelType: 'text',
          unreadCount: 0,
          joined: true,
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

    expect(searchMessages).toHaveBeenCalledWith(['searched'], 'community-1', 20, {})
    const resultButton = [...container.querySelectorAll('button')].find(
      (button) => button.textContent?.includes(targetMessage.content),
    )
    await act(async () => {
      resultButton?.click()
    })

    expect(navigate).toHaveBeenCalledWith(targetMessage)
    expect(useChannelStore.getState().activeChannelId).toBe('channel-a')
  })

  it('parses operator syntax into structured filters and residual text', async () => {
    const searchMessages = vi.spyOn(bridge, 'searchMessages').mockResolvedValue([targetMessage])

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
      setValue?.call(input, 'from:alice has:image design review')
      input?.dispatchEvent(new Event('input', { bubbles: true }))
      vi.advanceTimersByTime(300)
      await Promise.resolve()
    })

    expect(searchMessages).toHaveBeenCalledWith(['design', 'review'], 'community-1', 20, {
      from: 'alice',
      has: ['image'],
    })
  })

  it('runs a filter-only search when the query has no free text', async () => {
    const searchMessages = vi.spyOn(bridge, 'searchMessages').mockResolvedValue([targetMessage])

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
      setValue?.call(input, 'has:link')
      input?.dispatchEvent(new Event('input', { bubbles: true }))
      vi.advanceTimersByTime(300)
      await Promise.resolve()
    })

    expect(searchMessages).toHaveBeenCalledWith([], 'community-1', 20, { has: ['link'] })
  })

  it('searches an explicit direct-message scope and labels its results without a room marker', async () => {
    const navigate = vi.fn()
    const directResult = { ...targetMessage, channelId: '!dm:example.org' }
    const searchMessages = vi.spyOn(bridge, 'searchMessages').mockResolvedValue([directResult])

    await act(async () => {
      root.render(
        <SearchBar
          scopeId="!dm:example.org"
          resultLocationLabel="Maya"
          onNavigateToMessage={navigate}
        />,
      )
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

    expect(searchMessages).toHaveBeenCalledWith(['searched'], '!dm:example.org', 20, {})
    expect(container.textContent).toContain('in Maya')
    expect(container.textContent).not.toContain('in #')
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
    const searchMessages = vi.spyOn(bridge, 'searchMessages').mockImplementation((terms) => (
      terms[0] === 'first' ? first.promise : second.promise
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
    expect(searchMessages).toHaveBeenCalledWith(['first'], 'community-1', 20, {})

    await act(async () => {
      setValue?.call(input, 'second')
      input?.dispatchEvent(new Event('input', { bubbles: true }))
      vi.advanceTimersByTime(300)
      await Promise.resolve()
    })
    expect(searchMessages).toHaveBeenCalledWith(['second'], 'community-1', 20, {})

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

    // A combobox, so the active descendant is actually announced. Without the
    // role, NVDA moves the visual highlight in silence.
    expect(input?.getAttribute('role')).toBe('combobox')
    expect(input?.getAttribute('aria-expanded')).toBe('true')
    expect(input?.getAttribute('aria-haspopup')).toBe('listbox')
    // Only the input controls the results list; the trigger is a disclosure.
    const trigger = container.querySelector<HTMLButtonElement>('button[title="Search messages"]')
    expect(trigger?.getAttribute('aria-controls')).toBeNull()

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

    expect(searchMessages).toHaveBeenNthCalledWith(2, ['searched'], 'community-1', 20, {})
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

    // A miss is not proof of absence: the empty state has to say what was not
    // searched, or the user concludes the message never existed.
    expect(container.textContent).toContain('No matches in recent messages')
    expect(container.textContent).toContain(
      'Older messages were not searched.',
    )
    expect(container.querySelector('section')?.className).toContain('py-5')
  })

  it('states how deep and how wide the completed search actually went', async () => {
    vi.spyOn(bridge, 'searchMessages').mockResolvedValue([targetMessage])

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

    // Nothing searched yet, so no claim about scope is made.
    expect(container.querySelector('#message-search-scope')).toBeNull()

    await act(async () => {
      setValue?.call(input, 'searched')
      input?.dispatchEvent(new Event('input', { bubbles: true }))
      vi.advanceTimersByTime(300)
      await Promise.resolve()
    })

    const scope = container.querySelector('#message-search-scope')
    expect(scope?.textContent).toBe(
      `Searched the most recent ${SEARCH_MESSAGES_PER_ROOM} messages in 1 room.`,
    )
    expect(input?.getAttribute('aria-describedby')).toBe('message-search-scope')
  })

  it('narrows results to an in: room and says the narrowing came after the fact', async () => {
    const otherRoomMessage = {
      ...targetMessage,
      id: 'other-room',
      channelId: 'channel-c',
      content: 'not in the filtered room',
    }
    useChannelStore.setState({
      channels: [
        {
          id: 'channel-b',
          communityId: 'community-1',
          name: 'beta',
          topic: '',
          channelType: 'text',
          unreadCount: 0,
          joined: true,
        },
        {
          id: 'channel-c',
          communityId: 'community-1',
          name: 'gamma',
          topic: '',
          channelType: 'text',
          unreadCount: 0,
          joined: true,
        },
      ],
      activeChannelId: 'channel-b',
    })
    const searchMessages = vi.spyOn(bridge, 'searchMessages')
      .mockResolvedValue([targetMessage, otherRoomMessage])

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
      setValue?.call(input, 'in:#beta searched')
      input?.dispatchEvent(new Event('input', { bubbles: true }))
      vi.advanceTimersByTime(300)
      await Promise.resolve()
    })

    // The room predicate never reaches the native engine, and the deeper slice
    // is what makes renderer-side narrowing usable at all.
    expect(searchMessages).toHaveBeenCalledWith(['searched'], 'community-1', 200, {})
    expect(container.textContent).toContain(targetMessage.content)
    expect(container.textContent).not.toContain('not in the filtered room')
    expect(container.querySelector('#message-search-scope')?.textContent).toBe(
      `Filtered to #beta after searching the most recent ${SEARCH_MESSAGES_PER_ROOM} messages in each of 2 rooms.`,
    )
  })

  it('names an unknown in: room instead of showing an empty result list', async () => {
    vi.spyOn(bridge, 'searchMessages').mockResolvedValue([targetMessage])

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
      setValue?.call(input, 'in:#archive searched')
      input?.dispatchEvent(new Event('input', { bubbles: true }))
      vi.advanceTimersByTime(300)
      await Promise.resolve()
    })

    expect(container.textContent).toContain('No room named #archive here')
    expect(container.textContent).toContain(
      'Check the room name.',
    )
  })

  it('does not run a search for a room filter on its own', async () => {
    const searchMessages = vi.spyOn(bridge, 'searchMessages').mockResolvedValue([targetMessage])

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
      setValue?.call(input, 'in:#beta')
      input?.dispatchEvent(new Event('input', { bubbles: true }))
      vi.advanceTimersByTime(300)
      await Promise.resolve()
    })

    expect(searchMessages).not.toHaveBeenCalled()
    expect(container.textContent).toContain('Add a word or another filter to search #beta.')
    expect(container.querySelector('#message-search-scope')).toBeNull()
  })

  it('writes an operator into the box when a filter chip is used', async () => {
    const searchMessages = vi.spyOn(bridge, 'searchMessages').mockResolvedValue([])

    await act(async () => {
      root.render(<SearchBar onNavigateToMessage={vi.fn()} />)
    })
    await act(async () => {
      container.querySelector<HTMLButtonElement>('button[title="Search messages"]')?.click()
    })

    const chip = [...container.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.getAttribute('aria-label') === 'Filter by author')
    expect(chip?.textContent).toBe('from:')
    await act(async () => {
      chip?.click()
      vi.advanceTimersByTime(300)
      await Promise.resolve()
    })

    const input = container.querySelector<HTMLInputElement>('input[type="text"]')
    expect(input?.value).toBe('from:')
    // A bare operator is not a query, so nothing is searched for it.
    expect(searchMessages).not.toHaveBeenCalled()
    expect(container.textContent).toContain('Keep typing to search.')
  })

  it('searches every joined community when the toggle is checked, and names the community per result', async () => {
    useCommunityStore.setState({
      communities: [
        { id: 'community-1', name: 'Alpha', description: '', avatarUrl: null, memberCount: 1, role: 'member', joinedAt: null },
        { id: 'community-2', name: 'Beta', description: '', avatarUrl: null, memberCount: 1, role: 'member', joinedAt: null },
      ],
      communityEntities: {
        'community-1': { id: 'community-1', name: 'Alpha', description: '', avatarUrl: null, memberCount: 1, role: 'member', joinedAt: null },
        'community-2': { id: 'community-2', name: 'Beta', description: '', avatarUrl: null, memberCount: 1, role: 'member', joinedAt: null },
      },
      activeCommunityId: 'community-1',
    })
    useChannelStore.setState({
      channels: [
        { id: 'channel-b', communityId: 'community-1', name: 'beta', topic: '', channelType: 'text', unreadCount: 0, joined: true },
        { id: 'channel-g', communityId: 'community-2', name: 'gamma', topic: '', channelType: 'text', unreadCount: 0, joined: true },
      ],
      activeChannelId: 'channel-a',
    })
    const foreignResult = { ...targetMessage, channelId: 'channel-g' }
    const searchMessagesEverywhere = vi.spyOn(bridge, 'searchMessagesEverywhere').mockResolvedValue({
      results: [foreignResult],
      scope: {
        communitiesSearched: 2,
        communitiesTotal: 2,
        roomsSearched: 2,
        roomsTotal: 2,
        truncated: false,
      },
    })
    const searchMessages = vi.spyOn(bridge, 'searchMessages')

    await act(async () => {
      root.render(<SearchBar onNavigateToMessage={vi.fn()} />)
    })
    await act(async () => {
      container.querySelector<HTMLButtonElement>('button[title="Search messages"]')?.click()
    })
    const toggle = container.querySelector<HTMLInputElement>('input[type="checkbox"]')
    await act(async () => {
      toggle?.click()
      await Promise.resolve()
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

    expect(searchMessagesEverywhere).toHaveBeenCalledWith(
      ['searched'],
      ['community-1', 'community-2'],
      20,
      {},
    )
    expect(searchMessages).not.toHaveBeenCalled()
    expect(container.textContent).toContain('Beta · #gamma')
    expect(container.querySelector('#message-search-scope')?.textContent).toBe(
      `Searched the most recent ${SEARCH_MESSAGES_PER_ROOM} messages in 2 rooms across all 2 communities.`,
    )
  })

  it('partitions results into type tabs over the same fetched set', async () => {
    const mediaMessage = {
      ...targetMessage,
      id: 'media-message',
      content: 'a screenshot',
      attachments: [{
        fileHash: 'hash-1',
        filename: 'shot.png',
        size: 10,
        chunks: 1,
        sourcePeerId: 'peer-1',
        contentType: 'image/png',
      }],
    }
    const linkMessage = {
      ...targetMessage,
      id: 'link-message',
      content: 'see https://example.org/doc',
    }
    vi.spyOn(bridge, 'searchMessages').mockResolvedValue([targetMessage, mediaMessage, linkMessage])

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

    const findTab = (label: string) => [...container.querySelectorAll('button')]
      .find((button) => button.textContent === label)
    expect(findTab('All (3)')).toBeTruthy()
    expect(findTab('Media (1)')).toBeTruthy()
    expect(findTab('Links (1)')).toBeTruthy()
    expect(findTab('Files (0)')).toBeTruthy()
    // "All" is selected by default, so every result shows, not just the
    // fraction that would fall into one narrowing tab.
    expect(container.textContent).toContain(targetMessage.content)
    expect(container.textContent).toContain(mediaMessage.content)
    expect(container.textContent).toContain(linkMessage.content)

    await act(async () => {
      findTab('Media (1)')?.click()
    })

    expect(container.textContent).toContain(mediaMessage.content)
    expect(container.textContent).not.toContain(targetMessage.content)
    expect(container.textContent).not.toContain(linkMessage.content)
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

  it('cancels an in-flight cross-community search when Escape closes the popover', async () => {
    const cancelEverywhere = vi.spyOn(bridge, 'cancelMessageSearchEverywhere').mockResolvedValue()

    await act(async () => {
      root.render(<SearchBar onNavigateToMessage={vi.fn()} />)
    })
    await act(async () => {
      container.querySelector<HTMLButtonElement>('button[title="Search messages"]')?.click()
    })
    const input = container.querySelector<HTMLInputElement>('input[type="text"]')

    await act(async () => {
      input?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      await Promise.resolve()
    })

    // The everywhere search shares one backend slot with every other message
    // search, so closing must cancel it too, not only the per-community one:
    // otherwise a cross-community walk keeps running server-side for up to
    // the full search deadline after the popover is gone.
    expect(cancelEverywhere).toHaveBeenCalled()
  })
})
