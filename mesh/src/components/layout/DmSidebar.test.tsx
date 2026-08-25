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
import type { BlockedAccountDto, DmConversation, DmRequestDto } from '../../types/ipc'
import { COMMAND_PALETTE_OPEN_EVENT } from '../../lib/command-palette'
import {
  DM_CONVERSATION_ROW_HEIGHT,
  DmSidebar,
  dmSidebarRenderMetrics,
} from './DmSidebar'

function conversation(index: number): DmConversation {
  return {
    id: `conversation-${index}`,
    peers: [{
      userId: `@person-${index}:example.org`,
      displayName: `Person ${index}`,
      avatarColor: '#52b5f4',
    }],
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
      requests: [],
      blockedAccounts: [],
      blockedAccountsNextCursor: null,
      messageEntities: {},
      messageOrder: {},
      messages: {},
      activeConversationId: null,
      isDmMode: true,
      conversationLoad: { status: 'idle', error: null, generation: 0 },
      requestLoad: { status: 'idle', error: null, generation: 0 },
      blockedAccountLoad: { status: 'idle', error: null, generation: 0 },
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
    expect(list?.querySelector(
      'button[aria-label="Direct message with Person 1, 1 unread message"]',
    )).not.toBeNull()
    expect(list?.querySelector('button[role="listitem"]')).toBeNull()

    await act(async () => {
      if (list instanceof HTMLElement) {
        list.scrollTop = DM_CONVERSATION_ROW_HEIGHT * conversations.length
      }
      list?.dispatchEvent(new Event('scroll', { bubbles: true }))
      await Promise.resolve()
    })
    const finalConversation = list?.querySelector<HTMLButtonElement>(
      'button[aria-label="Direct message with Person 4999, 1 unread message"]',
    )
    expect(finalConversation).not.toBeNull()
    finalConversation?.focus()
    expect(document.activeElement).toBe(finalConversation)
  })

  /*
    A line that reads the same on every row is a caption, not information.

    The sidebar printed "Private conversation" under every name, and the header
    printed "Private conversations for Taylor" above them; neither told anybody
    which conversation was which, and the header was narrow enough that it
    truncated mid-word. This asserts the stronger property rather than the
    absence of two particular strings: whatever a row prints, no other row may
    print the same thing.
  */
  it('prints nothing on a conversation row that every other row also prints', async () => {
    const conversations = [
      { ...conversation(0), lastMessageAt: '2026-07-27T09:00:00.000Z', unreadCount: 0 },
      { ...conversation(1), lastMessageAt: '2026-07-29T15:00:00.000Z', unreadCount: 0 },
    ]
    useDmStore.getState().setConversations(conversations)
    vi.spyOn(bridge, 'getDmConversations').mockResolvedValue(conversations)

    await act(async () => {
      root.render(<DmSidebar />)
      await Promise.resolve()
      await Promise.resolve()
    })

    const rows = [...container.querySelectorAll('[role="listitem"]')]
    expect(rows).toHaveLength(2)

    const linesOf = (row: Element) => new Set(
      [...row.querySelectorAll('span, time, p')]
        .filter((node) => node.querySelector('span, time, p') === null)
        .map((node) => (node.textContent ?? '').trim())
        .filter(Boolean),
    )

    const [first, second] = rows.map(linesOf)
    const shared = [...first].filter((line) => second.has(line))
    expect(shared).toEqual([])

    // And the header names the surface once, without defining the word above it.
    expect(container.textContent).not.toContain('Private conversations for')
  })

  /*
      A conversation row is where people recognise who they are talking to, and
      DmPeerDto carried no picture at all, so every row showed the generated
      mark. This asserts the address reaches the avatar: resolving it to bytes
      is the store's job and is covered there.
  */
  it('asks for the picture of the person a conversation is with', async () => {
    vi.spyOn(bridge, 'isMatrixBackend').mockReturnValue(true)
    const load = vi.spyOn(bridge, 'matrixLoadProfileAvatar').mockResolvedValue(new Uint8Array())
    const withPicture: DmConversation = {
      ...conversation(0),
      peers: [{
        userId: '@person-0:example.org',
        displayName: 'Person 0',
        avatarColor: '#52b5f4',
        avatarUrl: 'mxc://example.org/person-0',
      }],
    }
    useDmStore.getState().setConversations([withPicture])
    vi.spyOn(bridge, 'getDmConversations').mockResolvedValue([withPicture])

    await act(async () => {
      root.render(<DmSidebar />)
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(load).toHaveBeenCalledWith('mxc://example.org/person-0')
  })

  it('measures row work when a parent-only search state changes', async () => {
    const conversations = Array.from({ length: 40 }, (_, index) => conversation(index))
    useDmStore.getState().setConversations(conversations)
    vi.spyOn(bridge, 'getDmConversations').mockResolvedValue(conversations)
    await act(async () => {
      root.render(<DmSidebar />)
      await Promise.resolve()
      await Promise.resolve()
    })
    dmSidebarRenderMetrics.reset()

    await act(async () => {
      const input = container.querySelector<HTMLInputElement>('#dm-search')!
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
      setter?.call(input, 'Person')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })

    expect(dmSidebarRenderMetrics.rows).toBe(0)
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
    expect(container.textContent).not.toContain('Start a direct message')

    const retry = [...container.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent === 'Retry conversations')
    await act(async () => {
      retry?.click()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(container.textContent).toContain('Start a direct message')
  })

  it('opens the shared people search when starting a conversation', async () => {
    vi.spyOn(bridge, 'getDmConversations').mockResolvedValue([])
    const openPalette = vi.fn()
    window.addEventListener(COMMAND_PALETTE_OPEN_EVENT, openPalette)

    await act(async () => {
      root.render(<DmSidebar />)
      await Promise.resolve()
      await Promise.resolve()
    })

    const start = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Find someone to message"]',
    )
    await act(async () => start?.click())
    expect(openPalette).toHaveBeenCalledOnce()

    window.removeEventListener(COMMAND_PALETTE_OPEN_EVENT, openPalette)
  })

  it('quarantines incoming message requests until they are accepted or deleted', async () => {
    const safeRequest: DmRequestDto = {
      roomId: '!safe:example.org',
      inviterUserId: '@alice:example.org',
      inviterDisplayName: 'Alice',
      inviterAvatarColor: '#52b5f4',
      canAccept: true,
    }
    const unsafeRequest: DmRequestDto = {
      roomId: '!unsafe:example.org',
      inviterUserId: '@mallory:example.org',
      inviterDisplayName: 'Mallory',
      inviterAvatarColor: '#ed4245',
      canAccept: false,
    }
    vi.mocked(bridge.isMatrixBackend).mockReturnValue(true)
    vi.spyOn(bridge, 'getDmConversations').mockResolvedValue([])
    vi.spyOn(bridge, 'getDmRequests').mockResolvedValue([safeRequest, unsafeRequest])
    const acceptedConversation = conversation(20)
    vi.spyOn(bridge, 'acceptDmRequest').mockResolvedValue(acceptedConversation)
    vi.spyOn(bridge, 'declineDmRequest').mockResolvedValue(undefined)
    useDmStore.setState({
      requests: [safeRequest, unsafeRequest],
      requestLoad: { status: 'loaded', error: null, generation: 1 },
    })

    await act(async () => {
      root.render(<DmSidebar />)
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })

    const heading = [...container.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent?.includes('Message requests'))
    expect(heading?.textContent).toContain('2')
    await act(async () => heading?.click())

    const requestList = container.querySelector('[role="list"][aria-label="Message requests"]')
    expect(requestList?.querySelectorAll('[role="listitem"]')).toHaveLength(2)
    expect(requestList?.textContent).not.toContain('message preview')
    expect(requestList?.textContent).toContain('@alice:example.org')
    expect(requestList?.textContent).toContain('couldn\'t verify this private conversation yet')
    expect(requestList?.querySelectorAll('button')).toHaveLength(5)

    const accept = [...requestList!.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent === 'Accept')
    await act(async () => {
      accept?.click()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(bridge.acceptDmRequest).toHaveBeenCalledWith(safeRequest.roomId)
    expect(useDmStore.getState().requests).toEqual([unsafeRequest])
    expect(useDmStore.getState().conversationEntities[acceptedConversation.id])
      .toEqual(acceptedConversation)

    const deleteRequest = [...container.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent === 'Delete request')
    await act(async () => {
      deleteRequest?.click()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(bridge.declineDmRequest).toHaveBeenCalledWith(unsafeRequest.roomId)
    expect(useDmStore.getState().requests).toEqual([])
    expect(document.activeElement).toBe(heading)
  })

  it('blocks a verified requester and keeps an explicit global unblock path', async () => {
    const request: DmRequestDto = {
      roomId: '!request:example.org',
      inviterUserId: '@alice:example.org',
      inviterDisplayName: 'Alice',
      inviterAvatarColor: '#52b5f4',
      canAccept: true,
    }
    const existingBlocked: BlockedAccountDto = { userId: '@bob:example.org' }
    vi.mocked(bridge.isMatrixBackend).mockReturnValue(true)
    vi.spyOn(bridge, 'getDmConversations').mockResolvedValue([])
    vi.spyOn(bridge, 'getDmRequests').mockResolvedValue([request])
    vi.spyOn(bridge, 'getBlockedAccounts').mockResolvedValue({
      accounts: [existingBlocked],
      nextCursor: null,
    })
    vi.spyOn(bridge, 'blockDmRequest').mockResolvedValue({ userId: request.inviterUserId })
    vi.spyOn(bridge, 'matrixSetDmBlocked').mockResolvedValue(false)
    useDmStore.setState({
      requests: [request],
      blockedAccounts: [existingBlocked],
      requestLoad: { status: 'loaded', error: null, generation: 1 },
      blockedAccountLoad: { status: 'loaded', error: null, generation: 1 },
    })

    await act(async () => {
      root.render(<DmSidebar />)
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })

    const blockedHeading = [...container.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent?.includes('Blocked accounts'))
    await act(async () => {
      blockedHeading?.click()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(bridge.getBlockedAccounts).toHaveBeenCalledTimes(2)
    await act(async () => blockedHeading?.click())

    const requestsHeading = [...container.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent?.includes('Message requests'))
    await act(async () => requestsHeading?.click())
    const block = [...container.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent === 'Block account')
    await act(async () => {
      block?.click()
      await Promise.resolve()
    })
    const confirmation = document.body.querySelector<HTMLElement>('[role="dialog"]')
    expect(confirmation?.textContent).toContain('Block Alice?')
    expect(confirmation?.textContent).toContain(request.inviterUserId)
    const confirmBlock = [...confirmation!.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent === 'Block Alice')
    await act(async () => {
      confirmBlock?.click()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(bridge.blockDmRequest).toHaveBeenCalledWith(request.roomId)
    expect(useDmStore.getState().requests).toEqual([])
    expect(useDmStore.getState().blockedAccounts).toEqual([
      { userId: request.inviterUserId },
      existingBlocked,
    ])
    const blockedList = container.querySelector('[role="list"][aria-label="Blocked accounts"]')
    expect(blockedList?.textContent).toContain(request.inviterUserId)
    expect(blockedList?.textContent).toContain(existingBlocked.userId)
    expect(container.textContent).toContain('until you unblock it')

    const aliceRow = [...blockedList!.querySelectorAll<HTMLElement>('[role="listitem"]')]
      .find((row) => row.textContent?.includes(request.inviterUserId))
    const unblock = [...aliceRow!.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent === 'Unblock')
    await act(async () => {
      unblock?.click()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(bridge.matrixSetDmBlocked).toHaveBeenCalledWith(request.inviterUserId, false)
    expect(useDmStore.getState().blockedAccounts).toEqual([existingBlocked])
    expect(container.textContent).toContain('may appear again')
  })
})
