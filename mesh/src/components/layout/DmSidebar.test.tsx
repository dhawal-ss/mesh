import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./UserPanel', () => ({
  UserPanel: () => <div>User controls</div>,
}))

import * as bridge from '../../lib/bridge'
import { useDmStore } from '../../store/dms'
import { useIdentityStore } from '../../store/identity'
import { useNetworkStore } from '../../store/network'
import type { DmConversation } from '../../types/ipc'
import { DmSidebar } from './DmSidebar'

function conversation(index: number): DmConversation {
  return {
    id: `conversation-${index}`,
    peerPublicKey: `@person-${index}:example.org`,
    peerDisplayName: `Person ${index}`,
    peerAvatarColor: '#52b5f4',
    lastMessageAt: '2026-07-29T12:00:00.000Z',
    unreadCount: index % 3,
    createdAt: '2026-07-29T12:00:00.000Z',
  }
}

describe('DmSidebar conversation containment', () => {
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
    vi.stubGlobal('ResizeObserver', class {
      observe() {}
      unobserve() {}
      disconnect() {}
    })
    useIdentityStore.setState({
      identity: {
        publicKey: '@me:example.org',
        displayName: 'Me',
        avatarColor: '#3ba55d',
      },
      isLoading: false,
    })
    useNetworkStore.setState({
      status: {
        state: 'connected',
        peerCount: 1,
        averageLatency: 1,
      },
    })
    vi.spyOn(bridge, 'isMatrixBackend').mockReturnValue(false)
    vi.spyOn(bridge, 'onDmReceived').mockResolvedValue(() => {})
    vi.spyOn(bridge, 'markDmRead').mockResolvedValue(undefined)
    useDmStore.setState({
      conversationEntities: {},
      conversationOrder: [],
      conversations: [],
      messageEntities: {},
      messageOrder: {},
      messages: {},
      activeConversationId: null,
      isDmMode: true,
      conversationLoad: { status: 'idle', error: null, generation: 0 },
      messageLoads: {},
    })
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('keeps a 5,000-conversation account within a bounded DOM', async () => {
    const conversations = Array.from({ length: 5_000 }, (_, index) => conversation(index))
    useDmStore.getState().setConversations(conversations)
    vi.spyOn(bridge, 'getDmConversations').mockResolvedValue(conversations)

    await act(async () => {
      root.render(<DmSidebar />)
      await Promise.resolve()
      await Promise.resolve()
    })

    const list = container.querySelector('[role="list"][aria-label="Direct message conversations"]')
    expect(list).not.toBeNull()
    expect(list?.querySelectorAll('[role="listitem"]').length).toBeGreaterThan(0)
    expect(list?.querySelectorAll('[role="listitem"]').length).toBeLessThan(100)
    expect(list?.querySelector('button[aria-label="Direct message with Person 0"]')).not.toBeNull()
    expect(list?.querySelector('button[role="listitem"]')).toBeNull()

    await act(async () => {
      if (list instanceof HTMLElement) list.scrollTop = 260_000
      list?.dispatchEvent(new Event('scroll', { bubbles: true }))
      await Promise.resolve()
    })
    const finalConversation = list?.querySelector<HTMLButtonElement>(
      'button[aria-label="Direct message with Person 4999"]',
    )
    expect(finalConversation).not.toBeNull()
    finalConversation?.focus()
    expect(document.activeElement).toBe(finalConversation)
  })

  it('shows a retry instead of an empty state when loading fails', async () => {
    vi.spyOn(bridge, 'getDmConversations')
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce([])

    await act(async () => {
      root.render(<DmSidebar />)
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(container.textContent).toContain('Conversations could not be loaded')
    expect(container.textContent).not.toContain('No conversations yet')

    const retry = [...container.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent === 'Retry conversations')
    await act(async () => {
      retry?.click()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(container.textContent).toContain('No conversations yet')
  })
})
