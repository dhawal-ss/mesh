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
    return <div>{message.content}</div>
  },
}))

vi.mock('./MessageInput', () => ({
  MessageInput: ({
    onSend,
  }: {
    onSend: (content: string) => Promise<void>
  }) => {
    composerHarness.onSend = onSend
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
import type { Channel, Message } from '../../types/ipc'
import { ChatView } from './ChatView'

interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve
  })
  return { promise, resolve }
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
    authorAvatarColor: '#5865f2',
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

  it('accepts one durable Matrix echo and retries or cancels it in place', async () => {
    const activeChannel = channel('!channel:example.org', 'private')
    const send = deferred<Message>()
    const queued = {
      ...message('txn-1', activeChannel.id, 'Saved while offline'),
      authorPublicKey: '@alice:example.org',
      transactionId: 'txn-1',
      clientRequestId: 'request-1',
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
    expect(useMessageStore.getState().messages[activeChannel.id] ?? []).toEqual([])

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
    expect(useMessageStore.getState().messages[activeChannel.id]).toEqual([queued])

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
})
