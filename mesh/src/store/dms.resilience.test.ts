import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as bridge from '../lib/bridge'
import type { DirectMessage, DmConversation } from '../types/ipc'
import { useDmStore } from './dms'

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
      messageEntities: {},
      messageOrder: {},
      messages: {},
      activeConversationId: null,
      isDmMode: false,
      conversationLoad: { status: 'idle', error: null, generation: 0 },
      messageLoads: {},
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
})
