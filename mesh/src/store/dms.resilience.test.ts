import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as bridge from '../lib/bridge'
import type { DirectMessage, DmConversation, Message } from '../types/ipc'
import { useDmStore } from './dms'
import { useMessageStore } from './messages'

const conversation: DmConversation = {
  id: 'dm-1',
  peerPublicKey: '@peer:example.org',
  peerDisplayName: 'Peer',
  peerAvatarColor: '#52b5f4',
  lastMessageAt: null,
  unreadCount: 2,
  createdAt: '2026-08-01T00:00:00.000Z',
}

const message: DirectMessage = {
  id: '$message',
  conversationId: conversation.id,
  authorPublicKey: conversation.peerPublicKey,
  authorDisplayName: 'Peer',
  authorAvatarColor: '#52b5f4',
  content: 'Last good message',
  timestamp: '2026-08-01T00:00:00.000Z',
  signature: '',
  attachments: [],
  reactions: {},
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

describe('DM load resilience', () => {
  beforeEach(() => {
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
      isDmMode: false,
      conversationLoad: { status: 'idle', error: null, generation: 0 },
      requestLoad: { status: 'idle', error: null, generation: 0 },
      blockedAccountLoad: { status: 'idle', error: null, generation: 0 },
      messageLoads: {},
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
    vi.restoreAllMocks()
  })

  it('preserves last-good conversations after an offline refresh and recovers on retry', async () => {
    useDmStore.getState().setConversations([conversation])
    vi.spyOn(bridge, 'getDmConversations')
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce([])

    await expect(useDmStore.getState().loadConversations()).rejects.toThrow('offline')
    expect(useDmStore.getState().conversations).toEqual([conversation])
    expect(useDmStore.getState().conversationLoad.status).toBe('failed')

    await expect(useDmStore.getState().loadConversations()).resolves.toBeUndefined()
    expect(useDmStore.getState().conversations).toEqual([])
    expect(useDmStore.getState().conversationLoad.status).toBe('loaded')
  })

  it('does not let an older conversation load overwrite a newer result', async () => {
    const first = deferred<DmConversation[]>()
    const second = deferred<DmConversation[]>()
    const newerConversation: DmConversation = {
      ...conversation,
      id: 'dm-2',
      peerPublicKey: '@newer:example.org',
      peerDisplayName: 'Newer peer',
    }
    vi.spyOn(bridge, 'getDmConversations')
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)

    const firstLoad = useDmStore.getState().loadConversations()
    const secondLoad = useDmStore.getState().loadConversations()
    expect(useDmStore.getState().conversationLoad.generation).toBe(2)

    second.resolve([newerConversation])
    await secondLoad
    expect(useDmStore.getState().conversations).toEqual([newerConversation])

    first.resolve([conversation])
    await firstLoad
    expect(useDmStore.getState().conversations).toEqual([newerConversation])
    expect(useDmStore.getState().conversationLoad).toEqual({
      status: 'loaded',
      error: null,
      generation: 2,
    })
  })

  it('preserves last-good messages across timeout and malformed responses', async () => {
    vi.spyOn(bridge, 'getDmMessages').mockResolvedValueOnce([message])
    await useDmStore.getState().loadMessages(conversation.id)

    vi.mocked(bridge.getDmMessages).mockRejectedValueOnce(new Error('timeout'))
    await expect(useDmStore.getState().loadMessages(conversation.id)).rejects.toThrow('timeout')
    expect(useDmStore.getState().messages[conversation.id]).toEqual([message])

    vi.mocked(bridge.getDmMessages).mockResolvedValueOnce(null as never)
    await expect(useDmStore.getState().loadMessages(conversation.id)).rejects.toBeTruthy()
    expect(useDmStore.getState().messages[conversation.id]).toEqual([message])
    expect(useDmStore.getState().messageLoads[conversation.id].status).toBe('failed')
  })

  it('appends bounded block-list pages and preserves them after a failed refresh', async () => {
    vi.spyOn(bridge, 'getBlockedAccounts')
      .mockResolvedValueOnce({
        accounts: [{ userId: '@bob:example.org' }],
        nextCursor: '@bob:example.org',
      })
      .mockResolvedValueOnce({
        accounts: [{ userId: '@carol:example.org' }],
        nextCursor: null,
      })
      .mockRejectedValueOnce(new Error('offline'))

    await useDmStore.getState().loadBlockedAccounts()
    await useDmStore.getState().loadBlockedAccounts(false)

    expect(bridge.getBlockedAccounts).toHaveBeenNthCalledWith(1, undefined)
    expect(bridge.getBlockedAccounts).toHaveBeenNthCalledWith(2, '@bob:example.org')
    expect(useDmStore.getState().blockedAccounts).toEqual([
      { userId: '@bob:example.org' },
      { userId: '@carol:example.org' },
    ])
    expect(useDmStore.getState().blockedAccountsNextCursor).toBeNull()

    await expect(useDmStore.getState().loadBlockedAccounts()).rejects.toThrow('offline')
    expect(useDmStore.getState().blockedAccounts).toEqual([
      { userId: '@bob:example.org' },
      { userId: '@carol:example.org' },
    ])
    expect(useDmStore.getState().blockedAccountLoad.status).toBe('failed')
  })

  it('purges an existing blocked conversation and prevents an older list load from restoring it', async () => {
    useDmStore.getState().setConversations([conversation])
    useDmStore.setState({
      activeConversationId: conversation.id,
      messageEntities: { [conversation.id]: { [message.id]: message } },
      messageOrder: { [conversation.id]: [message.id] },
      messages: { [conversation.id]: [message] },
      messageLoads: {
        [conversation.id]: { status: 'loaded', error: null, generation: 1 },
      },
    })
    const stale = deferred<DmConversation[]>()
    vi.spyOn(bridge, 'getDmConversations').mockReturnValueOnce(stale.promise)
    const staleLoad = useDmStore.getState().loadConversations()

    useDmStore.getState().upsertBlockedAccount({ userId: conversation.peerPublicKey })

    expect(useDmStore.getState().conversations).toEqual([])
    expect(useDmStore.getState().conversationEntities).toEqual({})
    expect(useDmStore.getState().messages[conversation.id]).toBeUndefined()
    expect(useDmStore.getState().messageEntities[conversation.id]).toBeUndefined()
    expect(useDmStore.getState().activeConversationId).toBeNull()
    expect(useDmStore.getState().blockedAccounts).toEqual([
      { userId: conversation.peerPublicKey },
    ])

    stale.resolve([conversation])
    await staleLoad
    expect(useDmStore.getState().conversations).toEqual([])
  })

  it('invalidates a pre-block conversation load even when the peer was not cached yet', async () => {
    const stale = deferred<DmConversation[]>()
    vi.spyOn(bridge, 'getDmConversations').mockReturnValueOnce(stale.promise)
    const staleLoad = useDmStore.getState().loadConversations()

    useDmStore.getState().upsertBlockedAccount({ userId: conversation.peerPublicKey })
    stale.resolve([conversation])
    await staleLoad

    expect(useDmStore.getState().conversations).toEqual([])
    expect(useDmStore.getState().conversationEntities).toEqual({})
  })

  it('does not let an in-flight message load restore a conversation purged by blocking', async () => {
    useDmStore.getState().setConversations([conversation])
    const stale = deferred<DirectMessage[]>()
    vi.spyOn(bridge, 'getDmMessages').mockReturnValueOnce(stale.promise)
    const staleLoad = useDmStore.getState().loadMessages(conversation.id)

    useDmStore.getState().upsertBlockedAccount({ userId: conversation.peerPublicKey })
    stale.resolve([message])
    await staleLoad

    expect(useDmStore.getState().messages[conversation.id]).toBeUndefined()
    expect(useDmStore.getState().messageEntities[conversation.id]).toBeUndefined()
    expect(useDmStore.getState().messageLoads[conversation.id]).toBeUndefined()
  })

  it('removes cached ignored content in shared rooms and clears the hidden DM delivery cache', () => {
    useDmStore.getState().setConversations([conversation])
    useDmStore.setState({
      requests: [{
        roomId: '!request:example.org',
        inviterUserId: conversation.peerPublicKey,
        inviterDisplayName: conversation.peerDisplayName,
        inviterAvatarColor: conversation.peerAvatarColor,
        canAccept: true,
      }],
    })
    const sharedBlocked: Message = {
      ...message,
      id: '$shared-blocked',
      channelId: '!shared:example.org',
      attachments: message.attachments ?? [],
      reactions: message.reactions ?? {},
    }
    const sharedAllowed: Message = {
      ...sharedBlocked,
      id: '$shared-allowed',
      authorPublicKey: '@allowed:example.org',
    }
    const queuedOwnDm: Message = {
      ...sharedBlocked,
      id: 'queued-own-dm',
      channelId: conversation.id,
      authorPublicKey: '@me:example.org',
      transactionId: 'queued-own-dm',
      deliveryStatus: 'pending',
    }
    useMessageStore.getState().setMessages('!shared:example.org', [
      sharedBlocked,
      sharedAllowed,
    ])
    useMessageStore.getState().setMessages(conversation.id, [queuedOwnDm])
    useMessageStore.setState({
      matrixQueueStates: {
        [conversation.id]: {
          'queued-own-dm': { state: 'pending' },
        },
      },
    })

    useDmStore.getState().upsertBlockedAccount({ userId: conversation.peerPublicKey })

    expect(useMessageStore.getState().messages['!shared:example.org']).toEqual([sharedAllowed])
    expect(useMessageStore.getState().messages[conversation.id]).toBeUndefined()
    expect(useMessageStore.getState().matrixQueueStates[conversation.id]).toBeUndefined()
    expect(useDmStore.getState().requests).toEqual([])
  })

  it('clears every bounded renderer projection when prior ignored-user state is unknown', () => {
    useDmStore.getState().setConversations([conversation])
    useDmStore.setState({
      activeConversationId: conversation.id,
      messages: { [conversation.id]: [message] },
    })
    const cached: Message = {
      ...message,
      channelId: '!shared:example.org',
      attachments: message.attachments ?? [],
      reactions: message.reactions ?? {},
    }
    useMessageStore.getState().setMessages(cached.channelId, [cached])

    useDmStore.getState().resetIgnoredUserProjection()

    expect(useDmStore.getState().conversations).toEqual([])
    expect(useDmStore.getState().messages).toEqual({})
    expect(useDmStore.getState().activeConversationId).toBeNull()
    expect(useMessageStore.getState().messages).toEqual({})
    expect(useMessageStore.getState().channelRecency).toEqual([])
  })
})
