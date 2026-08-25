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

type ComposerSend = (
  content: string,
  files?: unknown[],
  onAttachmentSent?: unknown,
  mentionUserIds?: readonly string[],
  mentionsRoom?: boolean,
) => Promise<void>

const composerHarness = vi.hoisted(() => ({
  onSend: null as null | ComposerSend,
  disabled: false,
}))

const interfaceSoundHarness = vi.hoisted(() => ({
  play: vi.fn(async () => true),
}))

/**
 * Records what each timeline row asked motion to do.
 *
 * `initial: false` is a row that is merely being re-virtualized and must paint
 * at its resting values; the arrival variant belongs only to a message that
 * has genuinely just landed.
 */
const rowMotionHarness = vi.hoisted(() => ({
  initialByMessageId: {} as Record<string, unknown>,
}))

vi.mock('../../lib/lazy-motion', () => ({
  AnimatePresence: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  motion: {
    div: ({
      children,
      variants,
      initial,
      animate,
      exit,
      ...props
    }: React.HTMLAttributes<HTMLDivElement> & {
      variants?: unknown
      initial?: unknown
      animate?: unknown
      exit?: unknown
      'data-message-id'?: string
    }) => {
      const messageId = props['data-message-id']
      if (messageId) rowMotionHarness.initialByMessageId[messageId] = initial
      return <div {...props}>{children}</div>
    },
  },
}))

const toastMocks = vi.hoisted(() => ({ showToast: vi.fn() }))
vi.mock('../ui/Toast', () => ({ showToast: toastMocks.showToast }))

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
    onSend: ComposerSend
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
import type { Channel, MatrixRoomUpgrade, MatrixRoomUpdateKind, Message } from '../../types/ipc'
import { ChatView, ROOM_UPDATE_COALESCE_MS } from './ChatView'
import { useRoomShapeStore } from '../../store/room-shape'
import { useRoomPinStore } from '../../store/room-pins'
import { useIdentityStore } from '../../store/identity'

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
    topic: '',
    channelType: 'text',
    unreadCount: 0,
    joined: true,
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
    rowMotionHarness.initialByMessageId = {}
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

  /*
    The header slot beside the room name held a generated sentence, the same one
    for every room in a community, because `m.room.topic` was writable over IPC
    and no UI ever wrote one. A room that has a description now says what it is
    for; one that does not keeps the generated line rather than going blank.
  */
  it('shows the room description in the header, and nothing without one', async () => {
    vi.spyOn(bridge, 'isMatrixBackend').mockReturnValue(false)
    vi.spyOn(bridge, 'getMessages').mockResolvedValue([])
    vi.spyOn(bridge, 'requestMessageHistory').mockResolvedValue(undefined)
    vi.spyOn(bridge, 'markChannelRead').mockResolvedValue(undefined)
    vi.spyOn(bridge, 'onMessageReceived').mockImplementation(async () => () => {})

    const described = { ...channel('channel-a', 'concept-art'), topic: 'Reference and sketches.' }
    await act(async () => {
      root.render(<ChatView channel={described} />)
      await flushAsyncWork()
    })

    expect(container.textContent).toContain('Reference and sketches.')
    expect(container.textContent).not.toContain('Share messages, files, and links')

    await act(async () => {
      root.render(<ChatView channel={channel('channel-b', 'lobby')} />)
      await flushAsyncWork()
    })

    /*
      Changed deliberately: a room with no description now gets no line.
      The generated stand-in said what every room in Mesh is for, so it was the
      same sentence in every header that had not been written, sitting in the
      slot a reader checks to find out what this room in particular is about.
    */
    expect(container.textContent).not.toContain('Share messages, files, and links')
    expect(container.textContent).not.toContain('Messages and updates for')
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

    const log = container.querySelector<HTMLDivElement>('[role="feed"]')!
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
    /*
     * The in-lane chip is decorative: role="status" implies a live region on
     * the element itself, which the container cannot suppress, so every
     * virtualized pass re-announced it. The feed's aria-busy is what assistive
     * technology reads now.
     */
    const earlierChip = container.querySelector('[data-loading-older="true"]')
    expect(earlierChip).not.toBeNull()
    expect(earlierChip?.getAttribute('aria-hidden')).toBe('true')
    expect(earlierChip?.textContent).toContain('Loading earlier messages')
    expect(log.getAttribute('aria-busy')).toBe('true')

    await act(async () => {
      older.resolve([])
      await flushAsyncWork()
      await flushAsyncWork()
    })

    expect(container.textContent).toContain('Beginning of this conversation')
    expect(container.querySelector('[data-loading-older="true"]')).toBeNull()
    expect(log.hasAttribute('aria-busy')).toBe(false)
    // The end of history removes the affordance rather than leaving a control
    // that can only fail.
    expect(
      [...container.querySelectorAll<HTMLButtonElement>('button')]
        .some((button) => button.textContent === 'Load earlier messages'),
    ).toBe(false)
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

  it('marks the room read from the unread divider and retires the boundary', async () => {
    const activeChannel = {
      ...channel('channel-a', 'alpha'),
      unreadCount: 1,
    }
    const read = {
      ...message('message-a', activeChannel.id, 'Already read'),
      timestamp: '2026-07-29T12:00:00.000Z',
    }
    const unread = {
      ...message('message-b', activeChannel.id, 'First unread'),
      timestamp: '2026-07-29T12:01:00.000Z',
    }

    vi.spyOn(bridge, 'isMatrixBackend').mockReturnValue(false)
    vi.spyOn(bridge, 'getMessages').mockResolvedValue([read, unread])
    vi.spyOn(bridge, 'requestMessageHistory').mockResolvedValue(undefined)
    const markChannelRead = vi.spyOn(bridge, 'markChannelRead').mockResolvedValue(undefined)
    vi.spyOn(bridge, 'onMessageReceived').mockResolvedValue(() => {})

    await act(async () => {
      root.render(<ChatView channel={activeChannel} />)
      await flushAsyncWork()
    })

    const divider = container.querySelector('[data-unread-divider="true"]')
    const markRead = Array.from(divider?.querySelectorAll('button') ?? [])
      .find((button) => button.textContent === 'Mark as read')
    expect(markRead).toBeDefined()

    const callsBefore = markChannelRead.mock.calls.length
    await act(async () => {
      markRead?.click()
      await flushAsyncWork()
    })

    // The divider is the control, so using it has to retire it, and the read
    // marker goes through the room's one existing path.
    expect(markChannelRead.mock.calls.length).toBeGreaterThan(callsBefore)
    expect(markChannelRead).toHaveBeenLastCalledWith(activeChannel.id)
    expect(container.querySelector('[data-unread-divider="true"]')).toBeNull()
  })

  it('animates an arriving message and nothing that was already loaded', async () => {
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

    // Opening a room is not an arrival, and neither is scrolling one of these
    // rows back into the virtual window.
    expect(rowMotionHarness.initialByMessageId).toEqual({
      [first.id]: false,
      [second.id]: false,
    })

    const arrival = message('message-c', activeChannel.id, 'Arrived after entry')
    await act(async () => {
      useMessageStore.getState().addMessage(activeChannel.id, arrival)
      await flushAsyncWork()
    })

    expect(rowMotionHarness.initialByMessageId[arrival.id]).toBe('initial')
    expect(rowMotionHarness.initialByMessageId[first.id]).toBe(false)

    // The hooks the browser suite navigates by survive the motion wrapper.
    const arrivalRow = container.querySelector(`[data-message-id="${arrival.id}"]`)
    expect(arrivalRow?.getAttribute('role')).toBe('article')
    expect(arrivalRow?.getAttribute('aria-posinset')).toBe('3')
    expect(arrivalRow?.getAttribute('aria-setsize')).toBe('3')
  })

  it('does not replay the arrival when a sent message is acknowledged', async () => {
    const activeChannel = channel('channel-a', 'alpha')
    const optimistic = {
      ...message('request-1', activeChannel.id, 'Saved while offline'),
      clientRequestId: 'request-1',
      deliveryStatus: 'pending' as const,
    }

    vi.spyOn(bridge, 'isMatrixBackend').mockReturnValue(false)
    vi.spyOn(bridge, 'getMessages').mockResolvedValue([])
    vi.spyOn(bridge, 'requestMessageHistory').mockResolvedValue(undefined)
    vi.spyOn(bridge, 'markChannelRead').mockResolvedValue(undefined)
    vi.spyOn(bridge, 'onMessageReceived').mockResolvedValue(() => {})

    await act(async () => {
      root.render(<ChatView channel={activeChannel} />)
      await flushAsyncWork()
    })
    await act(async () => {
      useMessageStore.getState().addMessage(activeChannel.id, optimistic)
      await flushAsyncWork()
    })
    expect(rowMotionHarness.initialByMessageId['request-1']).toBe('initial')

    // The server event carries a different id for the same message. Treating
    // it as a second arrival would flash the row at the moment it settles.
    await act(async () => {
      useMessageStore.getState().replaceMessages(activeChannel.id, [{
        ...optimistic,
        id: 'event-1',
        deliveryStatus: 'sent',
      }])
      await flushAsyncWork()
    })
    expect(rowMotionHarness.initialByMessageId['event-1']).toBe(false)
  })

  it('names the room and offers a first action once an empty room has loaded cleanly', async () => {
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

    const emptyState = container.querySelector('section[aria-labelledby]')
    const title = emptyState?.querySelector('h3')
    const paragraphs = [...(emptyState?.querySelectorAll('p') ?? [])]
    const description = paragraphs.find(
      (paragraph) => paragraph.id === emptyState?.getAttribute('aria-describedby'),
    )
    // The title stays imperative and stays identical to the honest fallback
    // below: only the surrounding specificity changes with what is known.
    expect(title?.textContent).toBe('Nothing here yet')
    expect(emptyState?.getAttribute('aria-labelledby')).toBe(title?.id)
    expect(description?.textContent).toBe(
      'Say hello, drop a screenshot, or paste a link.',
    )
    expect(emptyState?.textContent).toContain('#alpha')
    /*
      Changed deliberately: the action is gone. Its only job was to focus the
      composer, which is visible directly below the empty state and is the next
      thing the Tab key reaches, so it was a control that duplicated an adjacent
      control. The eyebrow naming the room is what still separates this earned
      state from the honest generic one.
    */
    expect(
      [...(emptyState?.querySelectorAll<HTMLButtonElement>('button') ?? [])]
        .some((button) => button.textContent === 'Write the first message'),
    ).toBe(false)
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
      undefined,
      [],
      false,
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

  it('returns to the live window before sending from parked history, so the echo renders', async () => {
    // While browsingOlder is set, addMessage diverts arrivals into the gap
    // counter, and that used to include the sender's own optimistic echo: the
    // composer cleared and the message never appeared. The send path must
    // reset to the latest window first, exactly as DmView always has.
    const activeChannel = channel('!channel:example.org', 'private')
    const send = deferred<Message>()

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
    const getMessages = vi.spyOn(bridge, 'getMessages').mockResolvedValue([])
    vi.spyOn(bridge, 'markChannelRead').mockResolvedValue(undefined)
    vi.spyOn(bridge, 'matrixTypingUsers').mockResolvedValue([])
    vi.spyOn(bridge, 'createMatrixTransactionId').mockReturnValue('request-1')
    vi.spyOn(bridge, 'sendMessage').mockReturnValue(send.promise)

    await act(async () => {
      root.render(<ChatView channel={activeChannel} />)
      await flushAsyncWork()
    })

    // Park the reader in history: the room has an older window on screen and
    // newer messages counted behind the gap banner.
    await act(async () => {
      useMessageStore.setState((state) => ({
        browsingOlder: { ...state.browsingOlder, [activeChannel.id]: true },
        newerGapCount: { ...state.newerGapCount, [activeChannel.id]: 3 },
      }))
    })
    getMessages.mockClear()

    await act(async () => {
      void composerHarness.onSend?.('Sent from history')
      await flushAsyncWork()
    })

    // The window came back to the latest page and the echo is in it, not in
    // the gap counter.
    expect(getMessages).toHaveBeenCalledWith(activeChannel.id, 50)
    expect(useMessageStore.getState().browsingOlder[activeChannel.id] ?? false).toBe(false)
    expect(useMessageStore.getState().messages[activeChannel.id]).toEqual([
      expect.objectContaining({ id: 'request-1', content: 'Sent from history' }),
    ])
    expect(useMessageStore.getState().newerGapCount[activeChannel.id] ?? 0).toBe(0)
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
    toastMocks.showToast.mockClear()

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
    // Nothing was queued, so this failure will not fix itself. The row says
    // "failed" and offers a retry without saying why; the reason has to reach
    // the sender somewhere, or a refusal reads as a network blip forever.
    expect(toastMocks.showToast).toHaveBeenCalledOnce()
    const [announced, tone] = toastMocks.showToast.mock.calls[0]
    expect(tone).toBe('error')
    expect(String(announced).length).toBeGreaterThan(0)
  })

  it('names a refusal the sender cannot retry away, such as a denied room-wide mention', async () => {
    const activeChannel = channel('channel-refused', 'refused-room')
    vi.spyOn(bridge, 'isMatrixBackend').mockReturnValue(true)
    vi.spyOn(bridge, 'getMessages').mockResolvedValue([])
    vi.spyOn(bridge, 'markChannelRead').mockResolvedValue(undefined)
    vi.spyOn(bridge, 'matrixTypingUsers').mockResolvedValue([])
    vi.spyOn(bridge, 'createMatrixTransactionId').mockReturnValue('request-refused')
    vi.spyOn(bridge, 'sendMessage').mockRejectedValue(
      new Error('permission denied: your current role cannot notify everyone in this room'),
    )
    toastMocks.showToast.mockClear()

    await act(async () => {
      root.render(<ChatView channel={activeChannel} />)
      await flushAsyncWork()
    })
    await act(async () => {
      await composerHarness.onSend?.('@room ship it', undefined, undefined, [], true)
      await flushAsyncWork()
    })

    expect(bridge.sendMessage).toHaveBeenCalledWith(
      activeChannel.id,
      '@room ship it',
      [],
      undefined,
      'request-refused',
      undefined,
      [],
      true,
    )
    expect(toastMocks.showToast).toHaveBeenCalledOnce()
    expect(toastMocks.showToast.mock.calls[0][1]).toBe('error')
    expect(
      useMessageStore.getState().messages[activeChannel.id][0],
    ).toMatchObject({ deliveryStatus: 'failed' })
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

    /*
     * An empty timeline whose history failed to load is not evidence that the
     * room is new, so this state stays generic: no room name, no welcome, and
     * no first-message call to action. The room-specific state below is
     * allowed only because the retried load succeeded.
     */
    expect(container.textContent).toContain('Messages could not be loaded')
    expect(container.textContent).not.toContain('Welcome to #offline-room')
    expect(container.textContent).not.toContain('Welcome to')
    // History is unknown, so no empty state at all: not the generic one, and
    // certainly not the room-specific one with its eyebrow and first action.
    expect(container.querySelector('section[aria-labelledby]')).toBeNull()
    expect(container.textContent).not.toContain('Write the first message')
    expect(markRead).not.toHaveBeenCalled()

    const retry = [...container.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent === 'Retry messages')
    await act(async () => {
      retry?.click()
      await flushAsyncWork()
    })

    expect(load.mock.calls.length).toBeGreaterThanOrEqual(2)
    expect(markRead).toHaveBeenCalledWith(activeChannel.id)
    expect(container.textContent).toContain('Nothing here yet')
    // The retried load succeeded, so the room-specific state is earned: the
    // eyebrow names the room and the first action is offered.
    const recoveredEmptyState = container.querySelector('section[aria-labelledby]')
    // The eyebrow is the earned part; the first-message action is gone from
    // both branches because the composer below is the action.
    expect(recoveredEmptyState?.textContent).toContain('#offline-room')
    expect(recoveredEmptyState?.textContent).not.toContain('Write the first message')
    expect(container.textContent).not.toContain('Welcome to')
  })

  it('refetches the timeline for a timeline change and ignores a read receipt', async () => {
    const activeChannel = channel('!matrix-room:example.org', 'matrix-room')
    const existing = message('$existing:example.org', activeChannel.id, 'Existing message')
    const receipt = deferred<MatrixRoomUpdateKind>()
    const arrival = deferred<MatrixRoomUpdateKind>()
    vi.spyOn(bridge, 'isMatrixBackend').mockReturnValue(true)
    vi.spyOn(bridge, 'markChannelRead').mockResolvedValue(undefined)
    vi.spyOn(bridge, 'matrixRoomUpgrade').mockResolvedValue(null)
    vi.spyOn(bridge, 'matrixTypingUsers').mockResolvedValue([])
    const load = vi.spyOn(bridge, 'getMessages').mockResolvedValue([existing])
    vi.spyOn(bridge, 'matrixWaitForRoomUpdate')
      .mockReturnValueOnce(receipt.promise)
      .mockReturnValueOnce(arrival.promise)
      .mockReturnValue(new Promise<MatrixRoomUpdateKind>(() => {}))

    await act(async () => {
      root.render(<ChatView channel={activeChannel} />)
      await flushAsyncWork()
    })
    const afterFirstPaint = load.mock.calls.length

    // A read receipt is the most frequent update in an active room. Refetching
    // the whole timeline for one was the waste this type exists to remove.
    await act(async () => {
      receipt.resolve('ephemeral')
      await flushAsyncWork()
      await flushAsyncWork()
    })
    expect(load.mock.calls.length).toBe(afterFirstPaint)

    // A real timeline change still refetches, or the saving would be a bug.
    await act(async () => {
      arrival.resolve('timeline')
      await flushAsyncWork()
      await flushAsyncWork()
    })
    expect(load.mock.calls.length).toBeGreaterThan(afterFirstPaint)
  })

  it('surfaces an event-refresh failure with last-good messages and recovers on retry', async () => {
    const activeChannel = channel('!matrix-room:example.org', 'matrix-room')
    const lastGood = message('$last-good:example.org', activeChannel.id, 'Last good message')
    const recovered = message('$recovered:example.org', activeChannel.id, 'Recovered message')
    const firstUpdate = deferred<MatrixRoomUpdateKind>()
    const laterUpdate = deferred<MatrixRoomUpdateKind>()
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
      firstUpdate.resolve('timeline')
      await flushAsyncWork()
      await flushAsyncWork()
    })
    expect(container.textContent).toContain('Last good message')
    expect(container.textContent).toContain('Could not refresh messages.')

    const retry = [...container.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent === 'Retry')
    await act(async () => {
      retry?.click()
      await flushAsyncWork()
      await flushAsyncWork()
    })

    expect(load.mock.calls.length).toBeGreaterThanOrEqual(3)
    expect(container.textContent).toContain('Recovered message')
    expect(container.textContent).not.toContain('Could not refresh messages.')
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
  recheckProtection: () => {},
          }}
        />,
      )
      await flushAsyncWork()
    })

    expect(composerHarness.disabled).toBe(disabled)
    if (disabled) {
      expect(container.textContent).toMatch(/Checking this room|sending is paused/i)
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
    expect(container.textContent).toContain('Nothing here yet')
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
    expect(container.textContent).toContain('Nothing here yet')

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
    expect(container.textContent).toContain('Room move details could not be refreshed')

    await act(async () => {
      root.render(<ChatView channel={channelB} />)
      await flushAsyncWork()
    })
    expect(container.textContent).not.toContain('Room move details could not be refreshed')
  })

  it('publishes the timeline as a feed and the composer as its own region', async () => {
    const activeChannel = channel('channel-a', 'alpha')
    const only = message('message-a', activeChannel.id, 'Only message')
    vi.spyOn(bridge, 'isMatrixBackend').mockReturnValue(false)
    vi.spyOn(bridge, 'getMessages').mockResolvedValue([only])
    vi.spyOn(bridge, 'requestMessageHistory').mockResolvedValue(undefined)
    vi.spyOn(bridge, 'markChannelRead').mockResolvedValue(undefined)
    vi.spyOn(bridge, 'onMessageReceived').mockResolvedValue(() => {})

    await act(async () => {
      root.render(<ChatView channel={activeChannel} />)
      await flushAsyncWork()
    })

    /*
     * `feed`, not `log`: aria-posinset and aria-setsize are only honoured on
     * an article inside a feed, so under role="log" the position was computed
     * and never announced, and aria-live="off" was suppressing a live region
     * that a feed does not have in the first place.
     */
    const feed = container.querySelector('[role="feed"]')
    expect(feed).not.toBeNull()
    expect(container.querySelector('[role="log"]')).toBeNull()
    expect(feed?.getAttribute('aria-label')).toBe('Messages in #alpha')
    expect(feed?.hasAttribute('aria-live')).toBe(false)
    expect(feed?.hasAttribute('aria-busy')).toBe(false)
    // Preserved e2e and performance hooks.
    expect(feed?.classList.contains('mesh-message-log')).toBe(true)
    expect(feed?.querySelector('.mesh-message-lane')).not.toBeNull()

    const article = feed?.querySelector('[role="article"]')
    expect(article?.getAttribute('data-message-id')).toBe(only.id)
    expect(article?.getAttribute('aria-posinset')).toBe('1')
    expect(article?.getAttribute('aria-setsize')).toBe('1')
    expect(article?.getAttribute('aria-labelledby')).toBe(`mesh-timeline-author-${only.id}`)

    const composer = container.querySelector('#mesh-composer')
    expect(composer?.hasAttribute('data-mesh-region')).toBe(true)
    expect(composer?.getAttribute('tabindex')).toBe('-1')
    expect(composer?.getAttribute('aria-label')).toBe('Message composer')
    expect(composer?.querySelector('[data-message-composer]')).not.toBeNull()
  })

  it('pages history from an activatable control, not only from the scroll threshold', async () => {
    const activeChannel = channel('channel-a', 'alpha')
    const initial = Array.from({ length: 50 }, (_, index) => ({
      ...message(`message-${index}`, activeChannel.id, `Message ${index}`),
      timestamp: `2026-07-25T12:${String(index).padStart(2, '0')}:00.000Z`,
    }))
    const older = {
      ...message('older-1', activeChannel.id, 'Older message'),
      timestamp: '2026-07-25T11:00:00.000Z',
    }

    vi.spyOn(bridge, 'isMatrixBackend').mockReturnValue(false)
    const getMessages = vi.spyOn(bridge, 'getMessages').mockImplementation(
      async (_channelId, _limit, before) => (before ? [older] : initial),
    )
    vi.spyOn(bridge, 'requestMessageHistory').mockResolvedValue(undefined)
    vi.spyOn(bridge, 'markChannelRead').mockResolvedValue(undefined)
    vi.spyOn(bridge, 'onMessageReceived').mockResolvedValue(() => {})

    await act(async () => {
      root.render(<ChatView channel={activeChannel} />)
      await flushAsyncWork()
    })

    /*
     * Only the visible window exists in the DOM, so a browse-mode or
     * keyboard-only reader has no scroll threshold to trip and nothing to tell
     * them history continues above.
     */
    const loadEarlier = [...container.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent === 'Load earlier messages')
    expect(loadEarlier).toBeDefined()

    await act(async () => {
      loadEarlier?.click()
      await flushAsyncWork()
      await flushAsyncWork()
    })

    expect(getMessages).toHaveBeenCalledWith(
      activeChannel.id,
      50,
      { timestamp: initial[0].timestamp, id: initial[0].id },
    )
    expect(useMessageStore.getState().messages[activeChannel.id]?.[0]?.id).toBe(older.id)
  })

  it('keeps one message listener attached across a room switch', async () => {
    const channelA = channel('channel-a', 'alpha')
    const channelB = channel('channel-b', 'beta')
    const handlers: Array<(incoming: Message) => void> = []
    const dispose = vi.fn()

    vi.spyOn(bridge, 'isMatrixBackend').mockReturnValue(false)
    vi.spyOn(bridge, 'getMessages').mockResolvedValue([])
    vi.spyOn(bridge, 'requestMessageHistory').mockResolvedValue(undefined)
    vi.spyOn(bridge, 'markChannelRead').mockResolvedValue(undefined)
    const register = vi.spyOn(bridge, 'onMessageReceived').mockImplementation(async (handler) => {
      handlers.push(handler)
      return dispose
    })

    await act(async () => {
      root.render(<ChatView channel={channelA} />)
      await flushAsyncWork()
    })
    await act(async () => {
      root.render(<ChatView channel={channelB} />)
      await flushAsyncWork()
    })

    /*
     * Registration is asynchronous, so re-registering per room left a window
     * with no listener attached and dropped everything that arrived in it.
     */
    expect(register).toHaveBeenCalledOnce()
    expect(dispose).not.toHaveBeenCalled()
    expect(handlers).toHaveLength(1)

    await act(async () => {
      handlers[0]?.(message('live-b', channelB.id, 'Arrived during the switch'))
      await flushAsyncWork()
    })
    expect(
      useMessageStore.getState().messages[channelB.id]?.map((entry) => entry.id),
    ).toEqual(['live-b'])
    expect(useMessageStore.getState().messages[channelA.id] ?? []).toEqual([])
  })

  it('coalesces a storm of Matrix room updates into one timeline refetch', async () => {
    vi.useFakeTimers()
    const activeChannel = channel('!busy:example.org', 'busy')
    const updates = [
      deferred<MatrixRoomUpdateKind>(),
      deferred<MatrixRoomUpdateKind>(),
      deferred<MatrixRoomUpdateKind>(),
    ]
    let waitIndex = 0

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
    const load = vi.spyOn(bridge, 'getMessages').mockResolvedValue([])
    vi.spyOn(bridge, 'markChannelRead').mockResolvedValue(undefined)
    vi.spyOn(bridge, 'matrixRoomUpgrade').mockResolvedValue(null)
    vi.spyOn(bridge, 'matrixTypingUsers').mockResolvedValue([])
    vi.spyOn(bridge, 'matrixWaitForRoomUpdate').mockImplementation(() => {
      const pending = updates[waitIndex]
      waitIndex += 1
      return pending ? pending.promise : new Promise<MatrixRoomUpdateKind>(() => {})
    })

    await act(async () => {
      root.render(<ChatView channel={activeChannel} />)
      await flushAsyncWork()
      await flushAsyncWork()
    })
    const afterOpen = load.mock.calls.length
    expect(afterOpen).toBeGreaterThan(0)

    // The first update after a room opens is never delayed by the window.
    await act(async () => {
      updates[0].resolve('timeline')
      await flushAsyncWork()
      await flushAsyncWork()
    })
    expect(load.mock.calls.length).toBe(afterOpen + 1)

    // Read receipts and typing wake the same subscription, so a burst inside
    // the window must not turn into one 50-message refetch each.
    await act(async () => {
      updates[1].resolve('timeline')
      await flushAsyncWork()
      updates[2].resolve('timeline')
      await flushAsyncWork()
    })
    expect(load.mock.calls.length).toBe(afterOpen + 1)

    // The burst still lands, exactly once, on the trailing edge.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ROOM_UPDATE_COALESCE_MS + 20)
      await flushAsyncWork()
    })
    expect(load.mock.calls.length).toBe(afterOpen + 2)
    vi.useRealTimers()
  })
})

describe('ChatView room shape', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    useRoomShapeStore.setState({ shapes: {}, accountId: 'local-device', hydrated: true } as never)
    vi.spyOn(bridge, 'isMatrixBackend').mockReturnValue(false)
    vi.spyOn(bridge, 'getMessages').mockResolvedValue([])
    vi.spyOn(bridge, 'requestMessageHistory').mockResolvedValue(undefined)
    vi.spyOn(bridge, 'markChannelRead').mockResolvedValue(undefined)
    vi.spyOn(bridge, 'onMessageReceived').mockImplementation(async () => () => {})
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    vi.restoreAllMocks()
    useRoomShapeStore.setState({ shapes: {} } as never)
  })

  async function renderRoom(id = 'channel-a') {
    await act(async () => {
      root.render(<ChatView channel={channel(id, 'concept-art')} />)
      await flushAsyncWork()
    })
  }

  /*
    An event room's plan is the pinned message, but the pin store keeps its own
    copy of that message. Reading replies off the copy meant a reply landed in
    the timeline and the surface went on showing the count from whenever the
    pin was loaded.
  */
  it('counts replies from the live message, not from the pin store copy', async () => {
    const plan = {
      id: 'msg-plan',
      channelId: 'channel-a',
      authorPublicKey: '@maya:mesh.test',
      authorDisplayName: 'Maya Chen',
      content: 'Raid night Saturday, 8pm.',
      attachments: [],
      reactions: {},
      timestamp: '2026-08-01T18:00:00.000Z',
      signature: '',
    }
    vi.spyOn(bridge, 'getMessages').mockResolvedValue(
      [{ ...plan, reactions: { '\u2705': ['@rohan:mesh.test'] } }] as never,
    )
    // The pin store's copy is deliberately stale, which is the point.
    useRoomPinStore.setState({ roomId: 'channel-a', messages: [plan] } as never)
    useRoomShapeStore.setState({ shapes: { 'channel-a': 'event' } } as never)

    await renderRoom()

    const going = Array.from(container.querySelectorAll('button'))
      .find((button) => (button.textContent ?? '').includes('Going'))
    expect(going?.textContent).toContain('1')

    const roster = container.querySelector('[data-event-roster]')
    expect(roster?.textContent).toContain('Going')
  })

  it('sends a reply as a reaction on the plan, and shows it before the server agrees', async () => {
    const addReaction = vi.spyOn(bridge, 'addReaction').mockResolvedValue(undefined as never)
    useIdentityStore.setState({ identity: { publicKey: '@taylor:mesh.test' } } as never)
    const plan = {
      id: 'msg-plan',
      channelId: 'channel-a',
      authorPublicKey: '@maya:mesh.test',
      authorDisplayName: 'Maya Chen',
      content: 'Raid night Saturday, 8pm.',
      attachments: [],
      reactions: {},
      timestamp: '2026-08-01T18:00:00.000Z',
      signature: '',
    }
    vi.spyOn(bridge, 'getMessages').mockResolvedValue([plan] as never)
    useRoomPinStore.setState({ roomId: 'channel-a', messages: [plan] } as never)
    useRoomShapeStore.setState({ shapes: { 'channel-a': 'event' } } as never)

    await renderRoom()

    const going = () => Array.from(container.querySelectorAll('button'))
      .find((button) => (button.textContent ?? '').includes('Going'))
    expect(going()?.getAttribute('aria-pressed')).toBe('false')

    await act(async () => {
      going()?.click()
      await flushAsyncWork()
    })

    // The reply is a reaction on the plan, not a new kind of object.
    expect(addReaction).toHaveBeenCalledWith('msg-plan', '\u2705', 'channel-a')
    expect(going()?.getAttribute('aria-pressed')).toBe('true')
    expect(going()?.textContent).toContain('1')
  })

  it('says nothing about shape in a room read the ordinary way', async () => {
    await renderRoom()

    expect(container.querySelector('[data-room-shape-chip]')).toBeNull()
  })

  it('names the shape in the header once a room is read as clips', async () => {
    useRoomShapeStore.setState({ shapes: { 'channel-a': 'clips' } } as never)

    await renderRoom()

    expect(container.querySelector('[data-room-shape-chip]')?.textContent).toContain('Clips')
  })

  it('names an event room as an event, not as clips', async () => {
    useRoomShapeStore.setState({ shapes: { 'channel-a': 'event' } } as never)

    await renderRoom()

    const chip = container.querySelector('[data-room-shape-chip]')
    expect(chip?.textContent).toContain('Event')
    expect(chip?.textContent).not.toContain('Clips')
    expect(chip?.getAttribute('aria-label')).toContain('event')
  })

  it('offers the way back from the header, not only from a context menu', async () => {
    useRoomShapeStore.setState({ shapes: { 'channel-a': 'clips' } } as never)
    await renderRoom()

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-room-shape-chip]')?.click()
      await flushAsyncWork()
    })

    expect(useRoomShapeStore.getState().shapes['channel-a']).toBeUndefined()
  })

  it('explains what the chip does rather than showing a bare word', async () => {
    useRoomShapeStore.setState({ shapes: { 'channel-a': 'clips' } } as never)

    await renderRoom()

    expect(container.querySelector('[data-room-shape-chip]')?.getAttribute('aria-label'))
      .toContain('conversation')
  })
})

describe('ChatView feed keyboard contract', () => {
  let container: HTMLDivElement
  let root: Root

  const roomChannel: Channel = {
    id: 'channel-feed',
    communityId: 'community-1',
    name: 'feed',
    topic: '',
    channelType: 'text',
    unreadCount: 0,
    joined: true,
  }
  const rows = Array.from({ length: 30 }, (_, index) =>
    message(`message-${index}`, roomChannel.id, `Body ${index}`))

  beforeEach(async () => {
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
    useChannelStore.setState({ channels: [roomChannel], activeChannelId: roomChannel.id })
    useMessageNavigationStore.setState({ pending: null })
    messageHarness.renderCounts = {}

    vi.stubGlobal('ResizeObserver', class {
      observe() {}
      disconnect() {}
    })
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    vi.spyOn(bridge, 'isMatrixBackend').mockReturnValue(false)
    vi.spyOn(bridge, 'getMessages').mockResolvedValue(rows)
    vi.spyOn(bridge, 'requestMessageHistory').mockResolvedValue(undefined)
    vi.spyOn(bridge, 'markChannelRead').mockResolvedValue(undefined)
    vi.spyOn(bridge, 'onMessageReceived').mockResolvedValue(() => {})

    await act(async () => {
      root.render(<ChatView channel={roomChannel} />)
      await flushAsyncWork()
    })
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  const articles = () => Array.from(container.querySelectorAll<HTMLElement>('[role="article"]'))

  it('costs a keyboard user one tab stop, not one per message', () => {
    /*
      Before this, rows were never focusable, so leaving the timeline meant
      tabbing through one toolbar stop per message. A roving tab stop is what
      role="feed" is supposed to pair with.
    */
    const rendered = articles()
    expect(rendered.length).toBeGreaterThan(1)
    expect(rendered.filter((article) => article.tabIndex === 0)).toHaveLength(1)
    expect(rendered.every((article) => article.tabIndex === 0 || article.tabIndex === -1)).toBe(true)
  })

  it('moves the roving stop with the arrow and page keys', () => {
    // `role="feed"` documents this navigation but implements none of it: the
    // role carries no behaviour at all.
    const feed = container.querySelector<HTMLElement>('[role="feed"]')
    expect(feed).not.toBeNull()

    const initial = articles().find((article) => article.tabIndex === 0)
    expect(initial).toBeTruthy()

    act(() => {
      feed!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }))
    })
    const afterArrow = articles().find((article) => article.tabIndex === 0)
    expect(afterArrow?.dataset.messageId).not.toBe(initial?.dataset.messageId)

    act(() => {
      feed!.dispatchEvent(new KeyboardEvent('keydown', { key: 'PageUp', bubbles: true }))
    })
    const afterPage = articles().find((article) => article.tabIndex === 0)
    expect(afterPage?.dataset.messageId).not.toBe(afterArrow?.dataset.messageId)
  })

  it('leaves a keystroke inside a row control to that control', () => {
    // Arrow keys belong to a control the reader has focused, such as a
    // reaction picker or an edit box, not to feed navigation.
    const before = articles().find((article) => article.tabIndex === 0)?.dataset.messageId
    const row = articles()[0]
    const control = document.createElement('button')
    row.appendChild(control)

    act(() => {
      control.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }))
    })

    expect(articles().find((article) => article.tabIndex === 0)?.dataset.messageId).toBe(before)
  })
})
