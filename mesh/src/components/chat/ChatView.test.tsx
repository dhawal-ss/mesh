import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const searchBarHarness = vi.hoisted(() => ({
  onNavigateToMessage: null as null | ((message: import('../../types/ipc').Message) => void),
}))

const messageHarness = vi.hoisted(() => ({
  renderCounts: {} as Record<string, number>,
  onRetry: {} as Record<string, ((message: import('../../types/ipc').Message) => void) | undefined>,
  onCancel: {} as Record<string, ((message: import('../../types/ipc').Message) => void) | undefined>,
}))

const composerHarness = vi.hoisted(() => ({
  onSend: null as null | ((content: string) => Promise<void>),
  disabled: false,
}))

const interfaceSoundHarness = vi.hoisted(() => ({
  play: vi.fn(async () => true),
}))

vi.mock('../../lib/interface-sounds', () => ({
  playInterfaceSound: interfaceSoundHarness.play,
}))

vi.mock('./Message', () => ({
  MessageComponent: ({
    message,
    onRetry,
    onCancel,
  }: {
    message: import('../../types/ipc').Message
    onRetry?: (message: import('../../types/ipc').Message) => void
    onCancel?: (message: import('../../types/ipc').Message) => void
  }) => {
    messageHarness.renderCounts[message.id] =
      (messageHarness.renderCounts[message.id] ?? 0) + 1
    messageHarness.onRetry[message.id] = onRetry
    messageHarness.onCancel[message.id] = onCancel
    if (message.content === 'THROW') {
      throw new Error('Malformed federated event')
    }
    if (message.undecryptable) {
      return <div data-undecryptable-message="true">Message waiting for secure keys</div>
    }
    return <div>{message.content}</div>
  },
}))

vi.mock('./MessageInput', () => ({
  MessageInput: ({
    onSend,
    disabled,
  }: {
    onSend: (content: string) => Promise<void>
    disabled?: boolean
  }) => {
    composerHarness.onSend = onSend
    composerHarness.disabled = Boolean(disabled)
    return <div data-message-composer>Message composer</div>
  },
}))

vi.mock('./SearchBar', () => ({
  SearchBar: ({
    onNavigateToMessage,
  }: {
    onNavigateToMessage: (message: import('../../types/ipc').Message) => void
  }) => {
    searchBarHarness.onNavigateToMessage = onNavigateToMessage
    return null
  },
}))

vi.mock('./TypingIndicator', () => ({
  TypingIndicator: () => null,
}))

vi.mock('./ConversationProtection', () => ({
  ConversationProtection: () => null,
}))

vi.mock('../ui/Skeleton', () => ({
  MessageSkeleton: () => <div>Loading messages</div>,
}))

import * as bridge from '../../lib/bridge'
import { useChannelStore } from '../../store/channels'
import { useMessageNavigationStore } from '../../store/message-navigation'
import { useMessageStore } from '../../store/messages'
import type { Channel, MatrixRoomUpgrade, Message } from '../../types/ipc'
import { ChatView } from './ChatView'

interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (reason?: unknown) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve
    reject = nextReject
  })
  return { promise, resolve, reject }
}

function channel(id: string, name: string): Channel {
  return {
    id,
    communityId: 'community-1',
    name,
    channelType: 'text',
    unreadCount: 0,
  }
}

function message(id: string, channelId: string, content: string): Message {
  return {
    id,
    channelId,
    authorPublicKey: 'sender-1',
    authorDisplayName: 'Sender',
    authorAvatarColor: '#52b5f4',
    content,
    attachments: [],
    reactions: {},
    timestamp: '2026-07-25T12:00:00.000Z',
    signature: '',
  }
}

async function flushAsyncWork() {
  await Promise.resolve()
  await Promise.resolve()
}

describe('ChatView channel switching', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)

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
    useChannelStore.setState({
      channels: [],
      activeChannelId: null,
    })
    useMessageNavigationStore.setState({ pending: null })
    searchBarHarness.onNavigateToMessage = null
    messageHarness.renderCounts = {}
    messageHarness.onRetry = {}
    messageHarness.onCancel = {}
    composerHarness.onSend = null
    composerHarness.disabled = false
    interfaceSoundHarness.play.mockClear()

    vi.stubGlobal('ResizeObserver', class {
      observe() {}
      disconnect() {}
    })
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0)
      return 1
    })
    vi.stubGlobal('cancelAnimationFrame', () => {})
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('keeps the active load pending and preserves a live message when the previous channel resolves late', async () => {
    const channelA = channel('channel-a', 'alpha')
    const channelB = channel('channel-b', 'beta')
    const channelALoad = deferred<Message[]>()
    const channelBLoad = deferred<Message[]>()
    let activeMessageHandler: ((incoming: Message) => void) | undefined

    vi.spyOn(bridge, 'isMatrixBackend').mockReturnValue(false)
    vi.spyOn(bridge, 'getMessages').mockImplementation((channelId) => {
      if (channelId === channelA.id) return channelALoad.promise
      if (channelId === channelB.id) return channelBLoad.promise
      throw new Error(`Unexpected channel: ${channelId}`)
    })
    vi.spyOn(bridge, 'requestMessageHistory').mockResolvedValue(undefined)
    vi.spyOn(bridge, 'markChannelRead').mockResolvedValue(undefined)
    vi.spyOn(bridge, 'onMessageReceived').mockImplementation(async (handler) => {
      activeMessageHandler = handler
      return () => {
        if (activeMessageHandler === handler) activeMessageHandler = undefined
      }
    })

    await act(async () => {
      root.render(<ChatView channel={channelA} />)
      await flushAsyncWork()
    })

    await act(async () => {
      root.render(<ChatView channel={channelB} />)
      await flushAsyncWork()
    })

    await act(async () => {
      channelALoad.resolve([message('history-a', channelA.id, 'Alpha history')])
      await flushAsyncWork()
    })

    expect.soft(container.textContent).toContain('Loading messages')
    expect(activeMessageHandler).toBeDefined()

    await act(async () => {
      activeMessageHandler?.(message('live-b', channelB.id, 'Live beta message'))
      await flushAsyncWork()
    })

    await act(async () => {
      channelBLoad.resolve([message('history-b', channelB.id, 'Beta history')])
      await flushAsyncWork()
    })

    const channelBMessages = useMessageStore.getState().messages[channelB.id] ?? []
    expect(channelBMessages.map((entry) => entry.id)).toEqual(['history-b', 'live-b'])
    expect(container.textContent).toContain('Beta history')
    expect(container.textContent).toContain('Live beta message')
  })

  it('switches channels, loads an evicted search target, centers it, and highlights it for two seconds', async () => {
    vi.useFakeTimers()
    const channelA = channel('channel-a', 'alpha')
    const channelB = channel('channel-b', 'beta')
    const latestB = message('latest-b', channelB.id, 'Latest beta message')
    const olderB = {
      ...message('older-b', channelB.id, 'Older beta context'),
      timestamp: '2026-07-25T11:00:00.000Z',
    }
    const targetB = {
      ...message('target-b', channelB.id, 'Search target'),
      timestamp: '2026-07-25T11:30:00.000Z',
    }

    vi.spyOn(bridge, 'isMatrixBackend').mockReturnValue(false)
    const getMessages = vi.spyOn(bridge, 'getMessages').mockImplementation(
      async (channelId, _limit, before) => {
        if (channelId === channelA.id) return []
        if (channelId === channelB.id && before?.id === targetB.id) return [olderB]
        if (channelId === channelB.id) return [latestB]
        throw new Error(`Unexpected channel: ${channelId}`)
      },
    )
    vi.spyOn(bridge, 'requestMessageHistory').mockResolvedValue(undefined)
    vi.spyOn(bridge, 'markChannelRead').mockResolvedValue(undefined)
    vi.spyOn(bridge, 'onMessageReceived').mockResolvedValue(() => {})

    await act(async () => {
      root.render(<ChatView channel={channelA} />)
      await flushAsyncWork()
    })

    expect(searchBarHarness.onNavigateToMessage).toBeTypeOf('function')
    await act(async () => {
      searchBarHarness.onNavigateToMessage?.(targetB)
    })
    expect(useChannelStore.getState().activeChannelId).toBe(channelB.id)

    await act(async () => {
      root.render(<ChatView channel={channelB} />)
      await flushAsyncWork()
      await flushAsyncWork()
    })

    expect(getMessages).toHaveBeenCalledWith(
      channelB.id,
      49,
      { timestamp: targetB.timestamp, id: targetB.id },
    )
    expect(
      useMessageStore.getState().messages[channelB.id]?.map((entry) => entry.id),
    ).toEqual([olderB.id, targetB.id, latestB.id])

    const highlighted = container.querySelector<HTMLElement>(
      `[data-message-id="${targetB.id}"]`,
    )
    expect(highlighted?.dataset.jumpHighlighted).toBe('true')
    expect(highlighted?.getAttribute('aria-current')).toBe('true')
    expect(document.activeElement).toBe(highlighted)
    expect(container.textContent).toContain('Jumped to message from Sender')
    expect(useMessageNavigationStore.getState().pending).toBeNull()

    await act(async () => {
      vi.advanceTimersByTime(2_000)
    })
    expect(
      container.querySelector(`[data-message-id="${targetB.id}"]`)
        ?.hasAttribute('data-jump-highlighted'),
    ).toBe(false)
    expect(container.textContent).not.toContain('Jumped to message from Sender')
    vi.useRealTimers()
  })

  it('contains a malformed message without removing healthy rows or the composer', async () => {
    const activeChannel = channel('channel-a', 'alpha')
    const healthyBefore = message('healthy-a', activeChannel.id, 'Healthy before')
    const malformed = message('malformed', activeChannel.id, 'THROW')
    const healthyAfter = message('healthy-b', activeChannel.id, 'Healthy after')

    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(bridge, 'isMatrixBackend').mockReturnValue(false)
    vi.spyOn(bridge, 'getMessages').mockResolvedValue([
      healthyBefore,
      malformed,
      healthyAfter,
    ])
    vi.spyOn(bridge, 'requestMessageHistory').mockResolvedValue(undefined)
    vi.spyOn(bridge, 'markChannelRead').mockResolvedValue(undefined)
    vi.spyOn(bridge, 'onMessageReceived').mockResolvedValue(() => {})

    await act(async () => {
      root.render(<ChatView channel={activeChannel} />)
      await flushAsyncWork()
    })

    expect(container.textContent).toContain('Healthy before')
    expect(container.textContent).toContain('Healthy after')
    expect(container.textContent).toContain("This message couldn't be displayed.")
    expect(container.querySelectorAll('[role="alert"]')).toHaveLength(1)
    expect(container.querySelector('[data-message-composer]')?.textContent).toBe(
      'Message composer',
    )
  })

  it('keeps an undecryptable event visible between healthy virtualized rows', async () => {
    const activeChannel = channel('channel-a', 'alpha')
    const healthyBefore = {
      ...message('healthy-a', activeChannel.id, 'Healthy before'),
      timestamp: '2026-07-29T12:00:00.000Z',
    }
    const undecryptable = {
      ...message('encrypted-a', activeChannel.id, ''),
      timestamp: '2026-07-29T12:01:00.000Z',
      undecryptable: {
        eventId: '$encrypted-a:example.org',
        sender: '@bob:example.org',
        originServerTs: 1_725_000_000_000,
        reason: 'waiting-for-keys' as const,
      },
    }
    const healthyAfter = {
      ...message('healthy-b', activeChannel.id, 'Healthy after'),
      timestamp: '2026-07-29T12:02:00.000Z',
    }

    vi.spyOn(bridge, 'isMatrixBackend').mockReturnValue(true)
    vi.spyOn(bridge, 'getMessages').mockResolvedValue([
      healthyBefore,
      undecryptable,
      healthyAfter,
    ])
    vi.spyOn(bridge, 'markChannelRead').mockResolvedValue(undefined)
    vi.spyOn(bridge, 'onMessageReceived').mockResolvedValue(() => {})

    await act(async () => {
      root.render(<ChatView channel={activeChannel} />)
      await flushAsyncWork()
    })

    expect(container.textContent).toContain('Healthy before')
    expect(container.textContent).toContain('Message waiting for secure keys')
    expect(container.textContent).toContain('Healthy after')
    expect(container.querySelector('[data-undecryptable-message="true"]')).not.toBeNull()
    expect(useMessageStore.getState().messages[activeChannel.id]?.map((entry) => entry.id))
      .toEqual([healthyBefore.id, undecryptable.id, healthyAfter.id])
    expect(container.querySelector('[data-message-composer]')?.textContent).toBe(
      'Message composer',
    )
  })

  it('keeps healthy message rows stable during unrelated history-loading updates', async () => {
    const activeChannel = channel('channel-a', 'alpha')
    const first = message('message-a', activeChannel.id, 'First')
    const second = message('message-b', activeChannel.id, 'Second')

    vi.spyOn(bridge, 'isMatrixBackend').mockReturnValue(false)
    vi.spyOn(bridge, 'getMessages').mockResolvedValue([first, second])
    vi.spyOn(bridge, 'requestMessageHistory').mockResolvedValue(undefined)
    vi.spyOn(bridge, 'markChannelRead').mockResolvedValue(undefined)
    vi.spyOn(bridge, 'onMessageReceived').mockResolvedValue(() => {})

    await act(async () => {
      root.render(<ChatView channel={activeChannel} />)
      await flushAsyncWork()
    })
    expect(messageHarness.renderCounts).toEqual({
      [first.id]: 1,
      [second.id]: 1,
    })

    await act(async () => {
      useMessageStore.setState((state) => ({
        loadingOlder: {
          ...state.loadingOlder,
          [activeChannel.id]: true,
        },
      }))
    })

    expect(messageHarness.renderCounts).toEqual({
      [first.id]: 1,
      [second.id]: 1,
    })
    expect(container.textContent).toContain('First')
    expect(container.textContent).toContain('Second')
  })

  it('guards history re-entry and marks the true beginning of the conversation', async () => {
    const activeChannel = channel('channel-a', 'alpha')
    const initial = Array.from({ length: 50 }, (_, index) => ({
      ...message(`message-${index}`, activeChannel.id, `Message ${index}`),
      timestamp: `2026-07-25T12:${String(index).padStart(2, '0')}:00.000Z`,
    }))
    const older = deferred<Message[]>()

    vi.spyOn(bridge, 'isMatrixBackend').mockReturnValue(false)
    const getMessages = vi.spyOn(bridge, 'getMessages').mockImplementation(
      async (_channelId, _limit, before) => before ? older.promise : initial,
    )
    getMessages.mockClear()
    vi.spyOn(bridge, 'requestMessageHistory').mockResolvedValue(undefined)
    vi.spyOn(bridge, 'markChannelRead').mockResolvedValue(undefined)
    vi.spyOn(bridge, 'onMessageReceived').mockResolvedValue(() => {})

    await act(async () => {
      root.render(<ChatView channel={activeChannel} />)
      await flushAsyncWork()
    })

    const log = container.querySelector<HTMLDivElement>('[role="log"]')!
    Object.defineProperty(log, 'clientHeight', { configurable: true, value: 400 })
    Object.defineProperty(log, 'scrollTop', { configurable: true, writable: true, value: 0 })
    log.getBoundingClientRect = () => ({
      x: 0,
      y: 0,
      top: 0,
      right: 800,
      bottom: 400,
      left: 0,
      width: 800,
      height: 400,
      toJSON: () => ({}),
    })
    container.querySelectorAll<HTMLElement>('[data-message-id]').forEach((row, index) => {
      row.getBoundingClientRect = () => ({
        x: 0,
        y: index * 50,
        top: index * 50,
        right: 800,
        bottom: index * 50 + 50,
        left: 0,
        width: 800,
        height: 50,
        toJSON: () => ({}),
      })
    })

    await act(async () => {
      log.dispatchEvent(new Event('scroll', { bubbles: true }))
      log.dispatchEvent(new Event('scroll', { bubbles: true }))
      await flushAsyncWork()
    })
    const olderCalls = getMessages.mock.calls.filter(
      ([, , before]) => before !== undefined,
    )
    expect(olderCalls).toHaveLength(1)
    expect(container.querySelector('[aria-label="Loading earlier messages"]')).not.toBeNull()

    await act(async () => {
      older.resolve([])
      await flushAsyncWork()
      await flushAsyncWork()
    })

    expect(container.textContent).toContain('Beginning of this conversation')
    expect(container.querySelector('[aria-label="Loading earlier messages"]')).toBeNull()
  })

  it('keeps one unread boundary anchored before the messages that were unread on entry', async () => {
    const activeChannel = {
      ...channel('channel-a', 'alpha'),
      unreadCount: 2,
    }
    const first = {
      ...message('message-a', activeChannel.id, 'Already read'),
      timestamp: '2026-07-29T12:00:00.000Z',
    }
    const firstUnread = {
      ...message('message-b', activeChannel.id, 'First unread'),
      timestamp: '2026-07-29T12:01:00.000Z',
    }
    const secondUnread = {
      ...message('message-c', activeChannel.id, 'Second unread'),
      timestamp: '2026-07-29T12:02:00.000Z',
    }

    vi.spyOn(bridge, 'isMatrixBackend').mockReturnValue(false)
    vi.spyOn(bridge, 'getMessages').mockImplementation(async (channelId) =>
      channelId === activeChannel.id ? [first, firstUnread, secondUnread] : [],
    )
    vi.spyOn(bridge, 'requestMessageHistory').mockResolvedValue(undefined)
    vi.spyOn(bridge, 'markChannelRead').mockResolvedValue(undefined)
    vi.spyOn(bridge, 'onMessageReceived').mockResolvedValue(() => {})

    await act(async () => {
      root.render(<ChatView channel={activeChannel} />)
      await flushAsyncWork()
    })

    const divider = container.querySelector('[data-unread-divider="true"]')
    const firstUnreadRow = container.querySelector(
      `[data-message-id="${firstUnread.id}"]`,
    )
    expect(divider?.textContent).toContain('New messages')
    expect(
      divider?.compareDocumentPosition(firstUnreadRow as Node)
        ?? Node.DOCUMENT_POSITION_PRECEDING,
    ).toBe(Node.DOCUMENT_POSITION_FOLLOWING)

    const receivedAfterEntry = {
      ...message('message-d', activeChannel.id, 'Arrived after entry'),
      timestamp: '2026-07-29T12:03:00.000Z',
    }
    await act(async () => {
      useMessageStore.getState().addMessage(activeChannel.id, receivedAfterEntry)
    })

    expect(container.querySelectorAll('[data-unread-divider="true"]')).toHaveLength(1)
    expect(
      container
        .querySelector('[data-unread-divider="true"]')
        ?.compareDocumentPosition(
          container.querySelector(`[data-message-id="${firstUnread.id}"]`) as Node,
        ) ?? Node.DOCUMENT_POSITION_PRECEDING,
    ).toBe(Node.DOCUMENT_POSITION_FOLLOWING)

    const caughtUpChannel = channel('channel-b', 'beta')
    await act(async () => {
      root.render(<ChatView channel={caughtUpChannel} />)
      await flushAsyncWork()
    })

    expect(container.querySelector('[data-unread-divider="true"]')).toBeNull()
  })

  it('uses the shared accessible empty state for a new room', async () => {
    const activeChannel = channel('channel-a', 'alpha')
    vi.spyOn(bridge, 'isMatrixBackend').mockReturnValue(false)
    vi.spyOn(bridge, 'getMessages').mockResolvedValue([])
    vi.spyOn(bridge, 'requestMessageHistory').mockResolvedValue(undefined)
    vi.spyOn(bridge, 'markChannelRead').mockResolvedValue(undefined)
    vi.spyOn(bridge, 'onMessageReceived').mockResolvedValue(() => {})

    await act(async () => {
      root.render(<ChatView channel={activeChannel} />)
      await flushAsyncWork()
    })

    const emptyState = container.querySelector('section')
    const title = emptyState?.querySelector('h3')
    const description = emptyState?.querySelector('p')
    expect(title?.textContent).toBe('No messages yet')
    expect(description?.textContent).toBe('Start with a build, clip, question, or thought.')
    expect(emptyState?.getAttribute('aria-labelledby')).toBe(title?.id)
    expect(emptyState?.getAttribute('aria-describedby')).toBe(description?.id)
    expect(emptyState?.querySelector('.border-dashed')).toBeNull()
  })

  it('renders a Matrix optimistic echo immediately, then reconciles and retries it in place', async () => {
    const activeChannel = channel('!channel:example.org', 'private')
    const send = deferred<Message>()
    const queued = {
      ...message('txn-1', activeChannel.id, 'Saved while offline'),
      authorPublicKey: '@alice:example.org',
      transactionId: 'txn-1',
      deliveryStatus: 'pending' as const,
    }

    vi.spyOn(bridge, 'isMatrixBackend').mockReturnValue(true)
    vi.spyOn(bridge, 'getMatrixUserId').mockReturnValue('@alice:example.org')
    vi.spyOn(bridge, 'getBackendCapabilities').mockReturnValue({
      encryptedText: true,
      encryptedAttachments: true,
      directMessages: true,
      voice: false,
      durableTimeouts: false,
      deviceManagement: true,
      recovery: true,
      legacyMigration: false,
    })
    vi.spyOn(bridge, 'getMessages').mockResolvedValue([])
    vi.spyOn(bridge, 'markChannelRead').mockResolvedValue(undefined)
    vi.spyOn(bridge, 'matrixTypingUsers').mockResolvedValue([])
    vi.spyOn(bridge, 'createMatrixTransactionId').mockReturnValue('request-1')
    const sendMessage = vi.spyOn(bridge, 'sendMessage').mockReturnValue(send.promise)
    const retry = vi.spyOn(bridge, 'matrixRetryQueuedMessage').mockResolvedValue(undefined)
    const cancel = vi.spyOn(bridge, 'matrixCancelQueuedMessage').mockResolvedValue(undefined)

    await act(async () => {
      root.render(<ChatView channel={activeChannel} />)
      await flushAsyncWork()
    })

    let submission!: Promise<void>
    await act(async () => {
      submission = composerHarness.onSend?.('Saved while offline') ?? Promise.resolve()
      await flushAsyncWork()
    })
    expect(useMessageStore.getState().messages[activeChannel.id]).toEqual([
      expect.objectContaining({
        id: 'request-1',
        clientRequestId: 'request-1',
        content: 'Saved while offline',
        deliveryStatus: 'pending',
      }),
    ])

    await act(async () => {
      send.resolve(queued)
      await submission
    })
    expect(sendMessage).toHaveBeenCalledWith(
      activeChannel.id,
      'Saved while offline',
      [],
      undefined,
      'request-1',
    )
    // Native and mocked responses may omit the renderer request id. The
    // caller still knows it and must preserve it to collapse the optimistic
    // echo into the queued/server record instead of rendering a duplicate.
    expect(useMessageStore.getState().messages[activeChannel.id]).toEqual([
      {
        ...queued,
        clientRequestId: 'request-1',
      },
    ])

    await act(async () => {
      useMessageStore.getState().applyQueuedMessageUpdate({
        roomId: activeChannel.id,
        transactionId: 'txn-1',
        state: 'failed',
      })
    })
    await act(async () => {
      messageHarness.onRetry['txn-1']?.(
        useMessageStore.getState().messages[activeChannel.id][0],
      )
      await flushAsyncWork()
    })
    expect(retry).toHaveBeenCalledWith(activeChannel.id, 'txn-1')
    expect(sendMessage).toHaveBeenCalledOnce()
    expect(
      useMessageStore.getState().messages[activeChannel.id][0].deliveryStatus,
    ).toBe('pending')

    await act(async () => {
      useMessageStore.getState().applyQueuedMessageUpdate({
        roomId: activeChannel.id,
        transactionId: 'txn-1',
        state: 'failed',
      })
    })
    await act(async () => {
      messageHarness.onCancel['txn-1']?.(
        useMessageStore.getState().messages[activeChannel.id][0],
      )
      await flushAsyncWork()
    })
    expect(cancel).toHaveBeenCalledWith(activeChannel.id, 'txn-1')
    expect(useMessageStore.getState().messages[activeChannel.id]).toEqual([])
  })

  it('keeps a rejected Matrix send as a retryable failed timeline row', async () => {
    const activeChannel = channel('!channel:example.org', 'private')
    vi.spyOn(bridge, 'isMatrixBackend').mockReturnValue(true)
    vi.spyOn(bridge, 'getMatrixUserId').mockReturnValue('@alice:example.org')
    vi.spyOn(bridge, 'getBackendCapabilities').mockReturnValue({
      encryptedText: true,
      encryptedAttachments: true,
      directMessages: true,
      voice: false,
      durableTimeouts: false,
      deviceManagement: true,
      recovery: true,
      legacyMigration: false,
    })
    vi.spyOn(bridge, 'getMessages').mockResolvedValue([])
    vi.spyOn(bridge, 'markChannelRead').mockResolvedValue(undefined)
    vi.spyOn(bridge, 'matrixTypingUsers').mockResolvedValue([])
    vi.spyOn(bridge, 'createMatrixTransactionId').mockReturnValue('request-failed')
    vi.spyOn(bridge, 'sendMessage').mockRejectedValue(new Error('service unavailable'))

    await act(async () => {
      root.render(<ChatView channel={activeChannel} />)
      await flushAsyncWork()
    })
    await act(async () => {
      await composerHarness.onSend?.('Keep this message')
      await flushAsyncWork()
    })

    const failed = useMessageStore.getState().messages[activeChannel.id][0]
    expect(failed).toMatchObject({
      id: 'request-failed',
      clientRequestId: 'request-failed',
      content: 'Keep this message',
      deliveryStatus: 'failed',
    })
    expect(messageHarness.onRetry['request-failed']).toBeTypeOf('function')
  })

  it('does not show or mark a welcome state after history hydration fails and retries', async () => {
    const activeChannel = channel('channel-offline', 'offline-room')
    vi.spyOn(bridge, 'isMatrixBackend').mockReturnValue(false)
    const load = vi.spyOn(bridge, 'getMessages')
      .mockRejectedValueOnce(new Error('timeout'))
      .mockResolvedValueOnce([])
    vi.spyOn(bridge, 'requestMessageHistory').mockResolvedValue(undefined)
    const markRead = vi.spyOn(bridge, 'markChannelRead').mockResolvedValue(undefined)

    await act(async () => {
      root.render(<ChatView channel={activeChannel} />)
      await flushAsyncWork()
    })

    expect(container.textContent).toContain('Messages could not be loaded')
    expect(container.textContent).not.toContain('Welcome to #offline-room')
    expect(markRead).not.toHaveBeenCalled()

    const retry = [...container.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent === 'Retry messages')
    await act(async () => {
      retry?.click()
      await flushAsyncWork()
    })

    expect(load.mock.calls.length).toBeGreaterThanOrEqual(2)
    expect(markRead).toHaveBeenCalledWith(activeChannel.id)
    expect(container.textContent).toContain('No messages yet')
  })

  it('surfaces an event-refresh failure with last-good messages and recovers on retry', async () => {
    const activeChannel = channel('!matrix-room:example.org', 'matrix-room')
    const lastGood = message('$last-good:example.org', activeChannel.id, 'Last good message')
    const recovered = message('$recovered:example.org', activeChannel.id, 'Recovered message')
    const firstUpdate = deferred<boolean>()
    const laterUpdate = deferred<boolean>()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(bridge, 'isMatrixBackend').mockReturnValue(true)
    vi.spyOn(bridge, 'getMatrixUserId').mockReturnValue('@alice:example.org')
    vi.spyOn(bridge, 'getBackendCapabilities').mockReturnValue({
      encryptedText: true,
      encryptedAttachments: true,
      directMessages: true,
      voice: false,
      durableTimeouts: false,
      deviceManagement: true,
      recovery: true,
      legacyMigration: false,
    })
    const load = vi.spyOn(bridge, 'getMessages')
      .mockResolvedValueOnce([lastGood])
      .mockRejectedValueOnce(new Error('timeline refresh timed out'))
      .mockResolvedValueOnce([recovered])
    vi.spyOn(bridge, 'markChannelRead').mockResolvedValue(undefined)
    vi.spyOn(bridge, 'matrixRoomUpgrade').mockResolvedValue(null)
    vi.spyOn(bridge, 'matrixTypingUsers').mockResolvedValue([])
    vi.spyOn(bridge, 'matrixWaitForRoomUpdate')
      .mockReturnValueOnce(firstUpdate.promise)
      .mockReturnValue(laterUpdate.promise)

    await act(async () => {
      root.render(<ChatView channel={activeChannel} />)
      await flushAsyncWork()
      await flushAsyncWork()
    })
    expect(container.textContent).toContain('Last good message')

    await act(async () => {
      firstUpdate.resolve(true)
      await flushAsyncWork()
      await flushAsyncWork()
    })
    expect(container.textContent).toContain('Last good message')
    expect(container.textContent).toContain('Could not refresh messages. Showing the last update.')

    const retry = [...container.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent === 'Retry')
    await act(async () => {
      retry?.click()
      await flushAsyncWork()
      await flushAsyncWork()
    })

    expect(load.mock.calls.length).toBeGreaterThanOrEqual(3)
    expect(container.textContent).toContain('Recovered message')
    expect(container.textContent).not.toContain('Could not refresh messages. Showing the last update.')
  })

  it.each([
    ['protected', false],
    ['checking', true],
    ['unencrypted', true],
    ['unavailable', true],
  ] as const)('aligns the composer with %s native room protection', async (protection, disabled) => {
    const activeChannel = channel('!protected:example.org', 'protected-room')
    vi.spyOn(bridge, 'isMatrixBackend').mockReturnValue(true)
    vi.spyOn(bridge, 'getMatrixUserId').mockReturnValue('@alice:example.org')
    vi.spyOn(bridge, 'getBackendCapabilities').mockReturnValue({
      encryptedText: true,
      encryptedAttachments: true,
      directMessages: true,
      voice: false,
      durableTimeouts: false,
      deviceManagement: true,
      recovery: true,
      legacyMigration: false,
    })
    vi.spyOn(bridge, 'getMessages').mockResolvedValue([])
    vi.spyOn(bridge, 'markChannelRead').mockResolvedValue(undefined)
    vi.spyOn(bridge, 'matrixRoomUpgrade').mockResolvedValue(null)
    vi.spyOn(bridge, 'matrixTypingUsers').mockResolvedValue([])

    await act(async () => {
      root.render(
        <ChatView
          channel={activeChannel}
          trust={{
            matrixMode: true,
            protection,
            communityMemberCount: 1,
            services: [],
            devices: [],
            devicesNeedReview: 0,
            verifiedDevices: 1,
            backup: null,
            accountId: '@alice:example.org',
            homeService: 'example.org',
            syncRunning: true,
            loadingAccountTrust: protection === 'checking',
          }}
        />,
      )
      await flushAsyncWork()
    })

    expect(composerHarness.disabled).toBe(disabled)
    if (disabled) {
      expect(container.textContent).toMatch(/Checking this room|Sending is unavailable/)
    }
  })

  it('surfaces and retries a mark-read failure without hiding hydrated history', async () => {
    const activeChannel = channel('channel-read-error', 'read-error')
    vi.spyOn(bridge, 'isMatrixBackend').mockReturnValue(false)
    vi.spyOn(bridge, 'getMessages').mockResolvedValue([])
    vi.spyOn(bridge, 'requestMessageHistory').mockResolvedValue(undefined)
    const markRead = vi.spyOn(bridge, 'markChannelRead')
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(undefined)

    await act(async () => {
      root.render(<ChatView channel={activeChannel} />)
      await flushAsyncWork()
    })
    expect(container.textContent).toContain('No messages yet')
    expect(container.textContent).toContain('This room could not be marked as read')

    await act(async () => {
      [...container.querySelectorAll<HTMLButtonElement>('button')]
        .find((button) => button.textContent === 'Retry read status')
        ?.click()
      await flushAsyncWork()
    })
    expect(markRead.mock.calls.length).toBeGreaterThanOrEqual(2)
    expect(container.textContent).not.toContain('This room could not be marked as read')
  })

  it('keeps a late mark-read failure scoped to the room that produced it', async () => {
    const channelA = channel('channel-read-a', 'read-a')
    const channelB = channel('channel-read-b', 'read-b')
    const markA = deferred<void>()
    vi.spyOn(bridge, 'isMatrixBackend').mockReturnValue(false)
    vi.spyOn(bridge, 'getMessages').mockResolvedValue([])
    vi.spyOn(bridge, 'requestMessageHistory').mockResolvedValue(undefined)
    const markRead = vi.spyOn(bridge, 'markChannelRead').mockImplementation(
      (channelId) => channelId === channelA.id ? markA.promise : Promise.resolve(),
    )

    await act(async () => {
      root.render(<ChatView channel={channelA} />)
      await flushAsyncWork()
    })
    expect(markRead).toHaveBeenCalledWith(channelA.id)

    await act(async () => {
      root.render(<ChatView channel={channelB} />)
      await flushAsyncWork()
    })
    expect(container.textContent).toContain('No messages yet')

    await act(async () => {
      markA.reject(new Error('late offline failure'))
      await flushAsyncWork()
    })
    expect(container.textContent).not.toContain('This room could not be marked as read')
  })

  it('does not carry a room-upgrade error into a newly selected room', async () => {
    const channelA = channel('!upgrade-a:example.org', 'upgrade-a')
    const channelB = channel('!upgrade-b:example.org', 'upgrade-b')
    const pendingBUpgrade = deferred<MatrixRoomUpgrade | null>()
    vi.spyOn(bridge, 'isMatrixBackend').mockReturnValue(true)
    vi.spyOn(bridge, 'getMatrixUserId').mockReturnValue('@alice:example.org')
    vi.spyOn(bridge, 'getBackendCapabilities').mockReturnValue({
      encryptedText: true,
      encryptedAttachments: true,
      directMessages: true,
      voice: false,
      durableTimeouts: false,
      deviceManagement: true,
      recovery: true,
      legacyMigration: false,
    })
    vi.spyOn(bridge, 'getMessages').mockResolvedValue([])
    vi.spyOn(bridge, 'markChannelRead').mockResolvedValue(undefined)
    vi.spyOn(bridge, 'matrixTypingUsers').mockResolvedValue([])
    vi.spyOn(bridge, 'matrixWaitForRoomUpdate').mockReturnValue(new Promise(() => {}))
    vi.spyOn(bridge, 'matrixRoomUpgrade')
      .mockRejectedValueOnce(new Error('upgrade lookup offline'))
      .mockRejectedValueOnce(new Error('community lookup offline'))
      .mockReturnValue(pendingBUpgrade.promise)

    await act(async () => {
      root.render(<ChatView channel={channelA} />)
      await flushAsyncWork()
      await flushAsyncWork()
    })
    expect(container.textContent).toContain('Room upgrade information could not be refreshed')

    await act(async () => {
      root.render(<ChatView channel={channelB} />)
      await flushAsyncWork()
    })
    expect(container.textContent).not.toContain('Room upgrade information could not be refreshed')
  })
})
