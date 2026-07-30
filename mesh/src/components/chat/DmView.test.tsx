import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const composerHarness = vi.hoisted(() => ({
  onSend: null as null | ((content: string) => Promise<void>),
  onEditLastMessage: null as null | (() => void),
}))

vi.mock('./MessageInput', () => ({
  MessageInput: ({
    onSend,
    onEditLastMessage,
  }: {
    onSend: (content: string) => Promise<void>
    onEditLastMessage?: () => void
  }) => {
    composerHarness.onSend = onSend
    composerHarness.onEditLastMessage = onEditLastMessage ?? null
    return <div>Message composer remains available</div>
  },
}))

vi.mock('./ReactionPicker', () => ({
  ReactionPicker: () => null,
}))

import * as bridge from '../../lib/bridge'
import { useDmStore } from '../../store/dms'
import { useIdentityStore } from '../../store/identity'
import { useMessageStore } from '../../store/messages'
import type { DirectMessage } from '../../types/ipc'
import { DmView } from './DmView'

function directMessage(id: string, content: string): DirectMessage {
  return {
    id,
    conversationId: 'conversation-1',
    authorPublicKey: `@${id}:example.org`,
    authorDisplayName: id,
    authorAvatarColor: '#52b5f4',
    content,
    timestamp: '2026-07-25T12:00:00.000Z',
    signature: '',
    attachments: [],
    reactions: {},
  }
}

describe('DmView message containment', () => {
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
    useDmStore.setState({
      conversationEntities: {
        'conversation-1': {
          id: 'conversation-1',
          peerPublicKey: '@peer:example.org',
          peerDisplayName: 'Peer',
          peerAvatarColor: '#52b5f4',
          lastMessageAt: null,
          unreadCount: 0,
          createdAt: '2026-07-25T12:00:00.000Z',
        },
      },
      conversationOrder: ['conversation-1'],
      conversations: [{
        id: 'conversation-1',
        peerPublicKey: '@peer:example.org',
        peerDisplayName: 'Peer',
        peerAvatarColor: '#52b5f4',
        lastMessageAt: null,
        unreadCount: 0,
        createdAt: '2026-07-25T12:00:00.000Z',
      }],
      messageEntities: {},
      messageOrder: {},
      activeConversationId: 'conversation-1',
      messages: {},
      isDmMode: true,
    })
    useMessageStore.setState({
      messageEntities: {},
      messageOrder: {},
      messages: {},
      loadingOlder: {},
      hasMoreOlder: {},
      browsingOlder: {},
      newerGapCount: {},
      channelRecency: [],
      matrixQueueStates: {},
    })
    composerHarness.onSend = null
    composerHarness.onEditLastMessage = null
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(bridge, 'isMatrixBackend').mockReturnValue(false)
    vi.spyOn(bridge, 'onDmReceived').mockResolvedValue(() => {})
    vi.spyOn(bridge, 'markDmRead').mockResolvedValue()
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('replaces only a malformed message while rendering the rest of the conversation', async () => {
    const malformed = {
      ...directMessage('malformed', 'Broken event'),
      content: { length: 12 } as unknown as string,
    }
    const valid = directMessage('valid', 'Healthy event remains visible')
    vi.spyOn(bridge, 'getDmMessages').mockResolvedValue([malformed, valid])

    await act(async () => {
      root.render(<DmView />)
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      'One message could not be displayed.',
    )
    expect(container.textContent).toContain('Healthy event remains visible')
    expect(container.textContent).toContain('Message composer remains available')
  })

  it('uses the shared accessible empty state at the start of a conversation', async () => {
    vi.spyOn(bridge, 'getDmMessages').mockResolvedValue([])

    await act(async () => {
      root.render(<DmView />)
      await Promise.resolve()
      await Promise.resolve()
    })

    const emptyState = container.querySelector('section')
    const title = emptyState?.querySelector('h3')
    const description = emptyState?.querySelector('p')
    expect(title?.textContent).toBe('Start of conversation')
    expect(description?.textContent).toBe('Send a message to Peer.')
    expect(emptyState?.getAttribute('aria-labelledby')).toBe(title?.id)
    expect(emptyState?.getAttribute('aria-describedby')).toBe(description?.id)
    expect(emptyState?.querySelector('.border-dashed')).toBeNull()
  })

  it('offers account-service reporting for a received Matrix DM', async () => {
    vi.mocked(bridge.isMatrixBackend).mockReturnValue(true)
    vi.spyOn(bridge, 'getMatrixUserId').mockReturnValue('@me:example.org')
    vi.spyOn(bridge, 'getDmMessages').mockResolvedValue([
      {
        ...directMessage('$peer-event:example.org', 'Reportable message'),
        authorPublicKey: '@peer:example.org',
      },
    ])
    vi.spyOn(bridge, 'matrixDmBlocked').mockResolvedValue(false)
    vi.spyOn(bridge, 'matrixRoomIsEncrypted').mockResolvedValue(true)
    vi.spyOn(bridge, 'matrixWaitForRoomUpdate').mockReturnValue(new Promise(() => {}))
    const report = vi.spyOn(bridge, 'reportMessage').mockResolvedValue()

    await act(async () => {
      root.render(<DmView />)
      await Promise.resolve()
      await Promise.resolve()
    })

    const row = container.querySelector<HTMLElement>('[role="group"]')
    await act(async () => {
      row?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }))
    })
    const reportButton = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
      .find((item) => item.textContent?.includes('Report message'))
    expect(reportButton).toBeDefined()
    await act(async () => reportButton?.click())
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')
    const send = [...dialog!.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent?.includes('Send report'))
    await act(async () => {
      send?.click()
      await Promise.resolve()
    })

    expect(report).toHaveBeenCalledWith(
      '$peer-event:example.org',
      'conversation-1',
      'Spam or abusive content',
    )
  })

  it('uses the same no-read-receipt presentation as channel rows', async () => {
    vi.mocked(bridge.isMatrixBackend).mockReturnValue(true)
    vi.spyOn(bridge, 'getMatrixUserId').mockReturnValue('@me:example.org')
    vi.spyOn(bridge, 'getDmMessages').mockResolvedValue([
      {
        ...directMessage('$me-event:example.org', 'Message the peer has read'),
        authorPublicKey: '@me:example.org',
        seenBy: [{ userId: '@peer:example.org', displayName: 'Peer' }],
      },
    ])
    vi.spyOn(bridge, 'matrixDmBlocked').mockResolvedValue(false)
    vi.spyOn(bridge, 'matrixRoomIsEncrypted').mockResolvedValue(true)
    vi.spyOn(bridge, 'matrixWaitForRoomUpdate').mockReturnValue(new Promise(() => {}))

    await act(async () => {
      root.render(<DmView />)
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(container.textContent).not.toContain('Seen by Peer')
    expect(container.querySelector('[aria-label="Seen by Peer"]')).toBeNull()
  })

  it('renders a failed Matrix DM as the shared retryable delivery bubble', async () => {
    vi.mocked(bridge.isMatrixBackend).mockReturnValue(true)
    vi.spyOn(bridge, 'getMatrixUserId').mockReturnValue('@me:example.org')
    vi.spyOn(bridge, 'getDmMessages').mockResolvedValue([])
    vi.spyOn(bridge, 'matrixDmBlocked').mockResolvedValue(false)
    vi.spyOn(bridge, 'matrixRoomIsEncrypted').mockResolvedValue(true)
    vi.spyOn(bridge, 'matrixWaitForRoomUpdate').mockReturnValue(new Promise(() => {}))
    vi.spyOn(bridge, 'createMatrixTransactionId').mockReturnValue('request-1')
    const sendMessage = vi.spyOn(bridge, 'sendMessage')
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce({
        id: 'request-1',
        channelId: 'conversation-1',
        authorPublicKey: '@me:example.org',
        authorDisplayName: 'Me',
        authorAvatarColor: '#3ba55d',
        content: 'Saved for delivery',
        attachments: [],
        reactions: {},
        timestamp: '2026-07-30T12:00:00.000Z',
        signature: '',
        clientRequestId: 'request-1',
        deliveryStatus: 'pending',
      })

    await act(async () => {
      root.render(<DmView />)
      await Promise.resolve()
      await Promise.resolve()
    })
    await act(async () => {
      await composerHarness.onSend?.('Saved for delivery')
    })

    expect(container.textContent).toContain('Delivery needs attention.')
    const retry = [...container.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent === 'Retry')
    expect(retry).toBeDefined()

    await act(async () => {
      retry?.click()
      await Promise.resolve()
    })
    expect(sendMessage).toHaveBeenCalledTimes(2)
    expect(container.textContent).toContain('Waiting to send')
  })

  it('keeps a five-thousand-message conversation DOM bounded', async () => {
    const messages = Array.from({ length: 5_000 }, (_, index) => ({
      ...directMessage(`event-${index}`, `Message ${index}`),
      authorPublicKey: index % 2 === 0 ? '@peer:example.org' : '@me:example.org',
    }))
    vi.spyOn(bridge, 'getDmMessages').mockResolvedValue(messages)

    await act(async () => {
      root.render(<DmView />)
      await Promise.resolve()
      await Promise.resolve()
    })

    const renderedMessages = container.querySelectorAll('[role="group"][aria-label^="Message from"]')
    expect(renderedMessages.length).toBeGreaterThan(0)
    expect(renderedMessages.length).toBeLessThan(100)
    expect(container.textContent).toContain('Message 0')
    expect(container.textContent).not.toContain('Message 4999')
  })
})
