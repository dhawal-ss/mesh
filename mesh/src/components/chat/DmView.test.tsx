import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const composerHarness = vi.hoisted(() => ({
  onSend: null as null | ((content: string) => Promise<void>),
  onEditLastMessage: null as null | (() => void),
  disabled: false,
  placeholder: null as string | null,
}))

const interfaceSoundHarness = vi.hoisted(() => ({
  play: vi.fn(async () => true),
}))

vi.mock('../../lib/interface-sounds', () => ({
  playInterfaceSound: interfaceSoundHarness.play,
}))

vi.mock('./MessageInput', () => ({
  MessageInput: ({
    onSend,
    onEditLastMessage,
    disabled,
    placeholder,
  }: {
    onSend: (content: string) => Promise<void>
    onEditLastMessage?: () => void
    disabled?: boolean
    placeholder?: string
  }) => {
    composerHarness.onSend = onSend
    composerHarness.onEditLastMessage = onEditLastMessage ?? null
    composerHarness.disabled = Boolean(disabled)
    composerHarness.placeholder = placeholder ?? null
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
import { useMeshNavigationStore } from '../../store/navigation'
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
          peers: [{ userId: '@peer:example.org', displayName: 'Peer', avatarColor: '#52b5f4' }],
          lastMessageAt: null,
          unreadCount: 0,
          createdAt: '2026-07-25T12:00:00.000Z',
        },
      },
      conversationOrder: ['conversation-1'],
      conversations: [{
        id: 'conversation-1',
        peers: [{ userId: '@peer:example.org', displayName: 'Peer', avatarColor: '#52b5f4' }],
        lastMessageAt: null,
        unreadCount: 0,
        createdAt: '2026-07-25T12:00:00.000Z',
      }],
      messageEntities: {},
      messageOrder: {},
      activeConversationId: 'conversation-1',
      messages: {},
      isDmMode: true,
      conversationLoad: { status: 'idle', error: null, generation: 0 },
      messageLoads: {},
      loadingOlder: {},
      hasMoreOlder: {},
      browsingOlder: {},
      newerGapCount: {},
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
    localStorage.clear()
    useMeshNavigationStore.getState().clearAccount()
    useMeshNavigationStore.getState().initialize('@me:example.org')
    useMeshNavigationStore.getState().navigate({
      kind: 'direct',
      conversationId: 'conversation-1',
    })
    composerHarness.onSend = null
    composerHarness.onEditLastMessage = null
    composerHarness.disabled = false
    composerHarness.placeholder = null
    interfaceSoundHarness.play.mockClear()
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

  it('marks only the newest message the other person has read', async () => {
    const own = (id: string, content: string, seen: boolean): DirectMessage => ({
      ...directMessage(id, content),
      authorPublicKey: '@me:example.org',
      seenBy: seen ? [{ userId: '@peer:example.org', displayName: 'Peer' }] : null,
    })
    vi.spyOn(bridge, 'getDmMessages').mockResolvedValue([
      own('read-first', 'Read a while ago', true),
      own('read-latest', 'Read just now', true),
      own('unread', 'Not read yet', false),
    ])

    await act(async () => {
      root.render(<DmView />)
      await Promise.resolve()
      await Promise.resolve()
    })

    // In a conversation you both keep up with, every message carries a receipt.
    // One marker per read message is noise, and the only question being asked
    // is whether they have seen what you just said, so exactly one is shown and
    // it sits on the newest read message.
    const markers = [...container.querySelectorAll('p')]
      .filter((paragraph) => paragraph.textContent === 'Seen')
    expect(markers).toHaveLength(1)
    expect(container.textContent).toContain('Read just now')
  })

  it('says nothing about receipts the account service did not report', async () => {
    // The backend applies reciprocity: it reports another person's receipt only
    // while this account shares its own. When it reports none, the absence must
    // read as silence, never as "not seen yet", which would be a claim Mesh
    // cannot support.
    vi.spyOn(bridge, 'getDmMessages').mockResolvedValue([
      { ...directMessage('mine', 'No receipt reported'), authorPublicKey: '@me:example.org' },
    ])

    await act(async () => {
      root.render(<DmView />)
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(container.textContent).toContain('No receipt reported')
    expect(container.textContent).not.toContain('Seen')
  })

  it('names the peer and offers a first action once an empty conversation has loaded cleanly', async () => {
    vi.spyOn(bridge, 'getDmMessages').mockResolvedValue([])

    await act(async () => {
      root.render(<DmView />)
      await Promise.resolve()
      await Promise.resolve()
    })

    const emptyState = container.querySelector('section[aria-labelledby]')
    const title = emptyState?.querySelector('h3')
    const paragraphs = [...(emptyState?.querySelectorAll('p') ?? [])]
    const description = paragraphs.find(
      (paragraph) => paragraph.id === emptyState?.getAttribute('aria-describedby'),
    )
    // Imperative, and identical to the channel surface: the two views used to
    // speak in different voices ("Start of conversation" against "Start the
    // conversation") at the same moment in the same product.
    expect(title?.textContent).toBe('Nothing here yet')
    expect(emptyState?.getAttribute('aria-labelledby')).toBe(title?.id)
    expect(description?.textContent).toBe('Be the first to say something to Peer.')
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
    expect(composerHarness.placeholder).toBe('Message Peer')
  })

  it('publishes the DM timeline as a feed and the composer as its own region', async () => {
    vi.spyOn(bridge, 'getDmMessages').mockResolvedValue([
      directMessage('$only-event:example.org', 'Only message'),
    ])

    await act(async () => {
      root.render(<DmView />)
      await Promise.resolve()
      await Promise.resolve()
    })

    /*
     * `feed`, not `log`: aria-posinset and aria-setsize are only honoured on
     * an article inside a feed, and a feed is not a live region, which is what
     * aria-live="off" was reaching for on a role that implies one.
     */
    const feed = container.querySelector('[role="feed"]')
    expect(feed).not.toBeNull()
    expect(container.querySelector('[role="log"]')).toBeNull()
    expect(feed?.getAttribute('aria-label')).toBe('Messages with Peer')
    expect(feed?.hasAttribute('aria-live')).toBe(false)
    expect(feed?.hasAttribute('aria-busy')).toBe(false)

    const article = feed?.querySelector('[role="article"]')
    expect(article?.getAttribute('aria-posinset')).toBe('1')
    expect(article?.getAttribute('aria-setsize')).toBe('1')
    expect(article?.getAttribute('aria-labelledby')).toBe(
      'mesh-timeline-author-$only-event:example.org',
    )
    const authorName = document.getElementById(
      'mesh-timeline-author-$only-event:example.org',
    )
    expect(authorName?.textContent).toBe('$only-event:example.org')
    expect(article?.contains(authorName)).toBe(true)

    const composer = container.querySelector('#mesh-composer')
    expect(composer?.hasAttribute('data-mesh-region')).toBe(true)
    expect(composer?.getAttribute('tabindex')).toBe('-1')
    expect(composer?.getAttribute('aria-label')).toBe('Message composer')
    expect(composer?.textContent).toContain('Message composer remains available')
  })

  it('loads older messages near the top without losing the bounded timeline', async () => {
    const latest = Array.from({ length: 50 }, (_, index) => ({
      ...directMessage(`latest-${index.toString().padStart(2, '0')}`, `Latest ${index}`),
      timestamp: `2026-07-25T12:${index.toString().padStart(2, '0')}:00.000Z`,
    }))
    const older = Array.from({ length: 50 }, (_, index) => ({
      ...directMessage(`older-${index.toString().padStart(2, '0')}`, `Older ${index}`),
      timestamp: `2026-07-24T12:${index.toString().padStart(2, '0')}:00.000Z`,
    }))
    const load = vi.spyOn(bridge, 'getDmMessages')
      .mockResolvedValueOnce(latest)
      .mockResolvedValueOnce(older)

    await act(async () => {
      root.render(<DmView />)
      await Promise.resolve()
      await Promise.resolve()
    })

    const log = container.querySelector<HTMLDivElement>('[role="feed"]')
    expect(log).not.toBeNull()
    Object.defineProperties(log!, {
      clientHeight: { configurable: true, value: 600 },
      scrollHeight: { configurable: true, value: 4_000 },
      scrollTop: { configurable: true, writable: true, value: 0 },
    })

    await act(async () => {
      log?.dispatchEvent(new Event('scroll', { bubbles: true }))
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(load).toHaveBeenNthCalledWith(2, 'conversation-1', 50, {
      timestamp: latest[0].timestamp,
      id: latest[0].id,
    })
    expect(useDmStore.getState().messages['conversation-1']).toHaveLength(100)
    expect(useDmStore.getState().messages['conversation-1'][0].content).toBe('Older 0')
  })

  it('pages DM history from an activatable control, not only from the scroll threshold', async () => {
    const latest = Array.from({ length: 50 }, (_, index) => ({
      ...directMessage(`latest-${index.toString().padStart(2, '0')}`, `Latest ${index}`),
      timestamp: `2026-07-25T12:${index.toString().padStart(2, '0')}:00.000Z`,
    }))
    const older = [{
      ...directMessage('older-01', 'Older message'),
      timestamp: '2026-07-24T12:00:00.000Z',
    }]
    const load = vi.spyOn(bridge, 'getDmMessages')
      .mockResolvedValueOnce(latest)
      .mockResolvedValueOnce(older)

    await act(async () => {
      root.render(<DmView />)
      await Promise.resolve()
      await Promise.resolve()
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
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(load).toHaveBeenNthCalledWith(2, 'conversation-1', 50, {
      timestamp: latest[0].timestamp,
      id: latest[0].id,
    })
    expect(useDmStore.getState().messages['conversation-1'][0].content).toBe('Older message')
  })

  it('does not show or mark an empty conversation after a failed hydration and retries', async () => {
    const load = vi.spyOn(bridge, 'getDmMessages')
      .mockRejectedValueOnce(new Error('timeout'))
      .mockResolvedValueOnce([])
    const markRead = vi.mocked(bridge.markDmRead)

    await act(async () => {
      root.render(<DmView />)
      await Promise.resolve()
      await Promise.resolve()
    })

    /*
     * An empty timeline whose history failed to load is not evidence that the
     * conversation is new, so this state stays generic: no first-message call
     * to action and no welcome.
     */
    expect(container.textContent).toContain('Messages could not be loaded')
    expect(container.textContent).not.toContain('Nothing here yet')
    expect(container.textContent).not.toContain('Write the first message')
    expect(container.textContent).not.toContain('Welcome to')
    expect(markRead).not.toHaveBeenCalled()

    const retry = [...container.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent === 'Retry messages')
    await act(async () => {
      retry?.click()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(load).toHaveBeenCalledTimes(2)
    expect(markRead).toHaveBeenCalledWith('conversation-1')
    expect(container.textContent).toContain('Nothing here yet')
    expect(container.textContent).not.toContain('Welcome to')
  })

  it('keeps the Matrix DM composer disabled when native protection reports unencrypted', async () => {
    vi.mocked(bridge.isMatrixBackend).mockReturnValue(true)
    vi.spyOn(bridge, 'getMatrixUserId').mockReturnValue('@me:example.org')
    vi.spyOn(bridge, 'getDmMessages').mockResolvedValue([])
    vi.spyOn(bridge, 'matrixDmBlocked').mockResolvedValue(false)
    vi.spyOn(bridge, 'matrixRoomIsEncrypted').mockResolvedValue(false)
    vi.spyOn(bridge, 'matrixWaitForRoomUpdate').mockReturnValue(new Promise(() => {}))

    await act(async () => {
      root.render(<DmView />)
      await Promise.resolve()
      await Promise.resolve()
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    expect(composerHarness.disabled).toBe(true)
    expect(container.textContent).toContain(
      'Sending is paused until this conversation is protected.',
    )
  })

  it('fails closed and retries when the blocked-account setting cannot be checked', async () => {
    vi.mocked(bridge.isMatrixBackend).mockReturnValue(true)
    vi.spyOn(bridge, 'getMatrixUserId').mockReturnValue('@me:example.org')
    vi.spyOn(bridge, 'getDmMessages').mockResolvedValue([])
    const blockedLookup = vi.spyOn(bridge, 'matrixDmBlocked')
      .mockRejectedValueOnce(new Error('account data unavailable'))
      .mockResolvedValueOnce(false)
    vi.spyOn(bridge, 'matrixRoomIsEncrypted').mockResolvedValue(true)
    vi.spyOn(bridge, 'matrixWaitForRoomUpdate').mockReturnValue(new Promise(() => {}))
    const sendMessage = vi.spyOn(bridge, 'sendMessage')

    await act(async () => {
      root.render(<DmView />)
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(composerHarness.disabled).toBe(true)
    expect(container.textContent).toContain(
      'Sending is off until Mesh can check whether this account is blocked.',
    )
    await act(async () => {
      await composerHarness.onSend?.('Do not send while safety state is unknown')
    })
    expect(sendMessage).not.toHaveBeenCalled()

    const retry = [...container.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent === 'Retry safety check')
    await act(async () => {
      retry?.click()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(blockedLookup).toHaveBeenCalledTimes(2)
    expect(composerHarness.disabled).toBe(false)
    expect(container.textContent).not.toContain('Retry safety check')
  })

  it('surfaces and retries a DM mark-read failure after hydration', async () => {
    vi.spyOn(bridge, 'getDmMessages').mockResolvedValue([])
    const markRead = vi.mocked(bridge.markDmRead)
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(undefined)

    await act(async () => {
      root.render(<DmView />)
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(container.textContent).toContain('This conversation could not be marked as read')
    expect(container.textContent).toContain('Nothing here yet')

    await act(async () => {
      [...container.querySelectorAll<HTMLButtonElement>('button')]
        .find((button) => button.textContent === 'Retry read status')
        ?.click()
      await Promise.resolve()
    })
    expect(markRead).toHaveBeenCalledTimes(2)
    expect(container.textContent).not.toContain('This conversation could not be marked as read')
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

    // The row itself carries no role: the surrounding timeline article names
    // the message, and a labelled group inside it announced every message twice.
    const row = container.querySelector<HTMLElement>('.mesh-message-row')
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

  it('keeps the account address and moderation controls inside the typed Safety pane', async () => {
    vi.mocked(bridge.isMatrixBackend).mockReturnValue(true)
    vi.spyOn(bridge, 'getMatrixUserId').mockReturnValue('@me:example.org')
    vi.spyOn(bridge, 'getDmMessages').mockResolvedValue([
      {
        ...directMessage('$peer-safety-event:example.org', 'Latest reportable message'),
        authorPublicKey: '@peer:example.org',
      },
    ])
    vi.spyOn(bridge, 'matrixDmBlocked').mockResolvedValue(false)
    vi.spyOn(bridge, 'matrixSetDmBlocked').mockResolvedValue(true)
    vi.spyOn(bridge, 'matrixRoomIsEncrypted').mockResolvedValue(true)
    vi.spyOn(bridge, 'matrixWaitForRoomUpdate').mockReturnValue(new Promise(() => {}))

    await act(async () => {
      root.render(<DmView />)
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(container.textContent).not.toContain('@peer:example.org')
    expect(container.textContent).not.toContain('Block Peer')

    const safetyButton = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Open Safety with Peer"]',
    )
    await act(async () => safetyButton?.click())

    const safetyPanel = container.querySelector<HTMLElement>('#mesh-dm-safety-panel')
    expect(safetyPanel?.getAttribute('aria-label')).toBe('Safety with Peer')
    expect(safetyPanel?.textContent).toContain('Report latest message')
    expect(safetyPanel?.textContent).toContain('Block Peer')
    expect(safetyPanel?.textContent).not.toContain('@peer:example.org')

    const revealAddress = [...safetyPanel!.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent === 'Show account address')
    await act(async () => revealAddress?.click())
    expect(safetyPanel?.textContent).toContain('@peer:example.org')
    expect(safetyPanel?.querySelector('button[aria-label="Copy account address for Peer"]')).not.toBeNull()

    const block = [...safetyPanel!.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent === 'Block Peer')
    await act(async () => {
      block?.click()
      await Promise.resolve()
    })
    expect(bridge.matrixSetDmBlocked).toHaveBeenCalledWith('@peer:example.org', true)
    expect(container.querySelector('#mesh-dm-safety-panel')).toBeNull()
    expect(useDmStore.getState().conversationEntities['conversation-1']).toBeUndefined()
    expect(useDmStore.getState().activeConversationId).toBeNull()
    expect(container.querySelector('h1')?.textContent).toBe('Direct messages')
    expect(container.textContent).toContain('New conversation')
    expect(container.textContent).not.toContain('@peer:example.org')
  })

  it('turns the direct-message landing surface into a working continuation path', async () => {
    useDmStore.setState({ activeConversationId: null })
    useMeshNavigationStore.getState().navigate({ kind: 'direct-list' })
    vi.spyOn(bridge, 'getDmMessages').mockResolvedValue([])

    await act(async () => {
      root.render(<DmView />)
      await Promise.resolve()
    })

    expect(container.querySelector('h1')?.textContent).toBe('Direct messages')
    expect(container.textContent).not.toContain('Pick up where you left off')
    const continueButton = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Continue with Peer"]',
    )
    expect(continueButton).not.toBeNull()

    await act(async () => {
      continueButton?.click()
      await Promise.resolve()
    })

    expect(useDmStore.getState().activeConversationId).toBe('conversation-1')
    const navigation = useMeshNavigationStore.getState()
    expect(navigation.entries[navigation.index]).toMatchObject({
      kind: 'direct',
      conversationId: 'conversation-1',
    })
  })

  /*
    The landing surface set its subtitle in reading type under a name in display
    type, and when no message was loaded it filled that slot with "Open your
    private conversation." -- an instruction to do the thing the card already
    is. The recent rows below did the same with "Private conversation". Both
    slots now carry a message or nothing.
  */
  it('leaves the summary slot empty rather than filling it with the name of the surface', async () => {
    useDmStore.setState((state) => ({
      conversationEntities: {
        ...state.conversationEntities,
        'conversation-2': {
          id: 'conversation-2',
          peers: [{ userId: '@other:example.org', displayName: 'Other', avatarColor: '#f4a152' }],
          lastMessageAt: null,
          unreadCount: 0,
          createdAt: '2026-07-24T12:00:00.000Z',
        },
      },
      conversationOrder: ['conversation-1', 'conversation-2'],
      conversations: [...state.conversations, {
        id: 'conversation-2',
        peers: [{ userId: '@other:example.org', displayName: 'Other', avatarColor: '#f4a152' }],
        lastMessageAt: null,
        unreadCount: 0,
        createdAt: '2026-07-24T12:00:00.000Z',
      }],
      activeConversationId: null,
    }))
    useMeshNavigationStore.getState().navigate({ kind: 'direct-list' })
    vi.spyOn(bridge, 'getDmMessages').mockResolvedValue([])

    await act(async () => {
      root.render(<DmView />)
      await Promise.resolve()
    })

    expect(container.querySelector('h1')?.textContent).toBe('Direct messages')
    expect(container.textContent).toContain('Peer')
    expect(container.textContent).toContain('Other')
    expect(container.textContent).not.toContain('Open your private conversation')
    expect(container.textContent).not.toContain('Private conversation')
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

    expect(container.textContent).toContain('Could not send.')
    const retry = [...container.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent === 'Try again')
    expect(retry).toBeDefined()

    await act(async () => {
      retry?.click()
      await Promise.resolve()
    })
    expect(sendMessage).toHaveBeenCalledTimes(2)
    expect(container.textContent).toContain('Saved for later')
    expect(interfaceSoundHarness.play).toHaveBeenCalledWith('message-failed')
  })

  it('keeps a ten-thousand-message conversation DOM bounded', async () => {
    const messages = Array.from({ length: 10_000 }, (_, index) => ({
      ...directMessage(`event-${index}`, `Message ${index}`),
      authorPublicKey: index % 2 === 0 ? '@peer:example.org' : '@me:example.org',
    }))
    vi.spyOn(bridge, 'getDmMessages').mockResolvedValue(messages)

    await act(async () => {
      root.render(<DmView />)
      await Promise.resolve()
      await Promise.resolve()
    })

    const renderedMessages = container.querySelectorAll('[role="feed"] [role="article"]')
    expect(renderedMessages.length).toBeGreaterThan(0)
    expect(renderedMessages.length).toBeLessThan(100)
    expect(container.textContent).toContain('Message 0')
    expect(container.textContent).not.toContain('Message 9999')
  })

  it('opens thread replies in the typed secondary pane instead of expanding the timeline', async () => {
    vi.spyOn(bridge, 'getDmMessages').mockResolvedValue([
      directMessage('$thread-root', 'Main timeline question'),
      {
        ...directMessage('$thread-reply', 'Focused thread answer'),
        threadRootId: '$thread-root',
        replyToId: '$thread-root',
      },
    ])

    await act(async () => {
      root.render(<DmView />)
      await Promise.resolve()
      await Promise.resolve()
    })

    const threadButton = [...container.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent === '1 reply')
    await act(async () => {
      threadButton?.click()
      await import('./ThreadPanel')
      await Promise.resolve()
    })

    const navigation = useMeshNavigationStore.getState()
    expect(navigation.entries[navigation.index]).toEqual({
      kind: 'direct',
      conversationId: 'conversation-1',
      pane: { kind: 'thread', rootEventId: '$thread-root' },
    })
    expect(container.querySelector('[role="feed"] [aria-label="Thread replies"]')).toBeNull()
    expect(container.querySelector('#mesh-thread-panel')?.textContent).toContain('Focused thread answer')

    const replyInThread = [...container.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent === 'Reply in thread')
    await act(async () => replyInThread?.click())
    expect(container.textContent).toContain('In thread ·')
    expect(container.textContent).toContain('Replying to $thread-root')

    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => (
      window.setTimeout(() => callback(0), 0)
    ))
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      await new Promise((resolve) => window.setTimeout(resolve, 25))
    })
    expect(container.querySelector('#mesh-thread-panel')).toBeNull()
    expect(document.activeElement?.getAttribute('aria-label')).toBe(
      'Open thread for message from $thread-root, 1 reply',
    )
  })

  it('hydrates an older Matrix thread that is outside the bounded DM timeline', async () => {
    vi.mocked(bridge.isMatrixBackend).mockReturnValue(true)
    vi.spyOn(bridge, 'getMatrixUserId').mockReturnValue('@me:example.org')
    vi.spyOn(bridge, 'getDmMessages').mockResolvedValue([])
    vi.spyOn(bridge, 'matrixDmBlocked').mockResolvedValue(false)
    vi.spyOn(bridge, 'matrixRoomIsEncrypted').mockResolvedValue(true)
    vi.spyOn(bridge, 'matrixWaitForRoomUpdate').mockReturnValue(new Promise(() => {}))
    vi.spyOn(bridge, 'markThreadRead').mockResolvedValue()
    vi.spyOn(bridge, 'matrixThreadContext').mockResolvedValue({
      root: {
        id: '$old-root',
        channelId: 'conversation-1',
        authorPublicKey: '@peer:example.org',
        authorDisplayName: 'Peer',
        authorAvatarColor: '#52b5f4',
        content: 'Older hydrated root',
        attachments: [],
        reactions: {},
        timestamp: '2026-07-01T12:00:00.000Z',
        signature: '',
      },
      replies: [{
        id: '$old-reply',
        channelId: 'conversation-1',
        authorPublicKey: '@peer:example.org',
        authorDisplayName: 'Peer',
        authorAvatarColor: '#52b5f4',
        content: 'Older hydrated reply',
        attachments: [],
        reactions: {},
        timestamp: '2026-07-01T12:01:00.000Z',
        signature: '',
        threadRootId: '$old-root',
      }],
      unreadCount: 1,
      unreadMentions: 0,
      unreadStateAvailable: true,
      hasMore: false,
    })
    useMeshNavigationStore.getState().navigate({
      kind: 'direct',
      conversationId: 'conversation-1',
      pane: { kind: 'thread', rootEventId: '$old-root' },
    })

    await act(async () => {
      root.render(<DmView />)
      await import('./ThreadPanel')
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(bridge.matrixThreadContext).toHaveBeenCalledWith('conversation-1', '$old-root')
    expect(container.querySelector('#mesh-thread-panel')?.textContent).toContain('Older hydrated root')
    expect(container.querySelector('#mesh-thread-panel')?.textContent).toContain('Older hydrated reply')
    expect(bridge.markThreadRead).toHaveBeenCalledWith(
      'conversation-1',
      '$old-root',
      '$old-reply',
    )
  })
})
