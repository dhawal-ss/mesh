import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { MatrixThreadListDto, Message, ThreadListItemDto } from '../types/ipc'

const bridge = vi.hoisted(() => ({
  matrixThreadList: vi.fn(),
}))

vi.mock('../lib/bridge', () => bridge)

import { orderThreadList, useThreadListStore } from './threads'

const root: Message = {
  id: '$root:example.org',
  channelId: '!room:example.org',
  authorPublicKey: '@alice:example.org',
  authorDisplayName: 'Alice',
  authorAvatarColor: 'var(--mark-sky)',
  content: 'Should we ship Friday?',
  attachments: [],
  reactions: {},
  timestamp: '2026-07-28T12:00:00.000Z',
  signature: '',
}

function item(overrides: Partial<ThreadListItemDto> = {}): ThreadListItemDto {
  return {
    root,
    replyCount: 3,
    participantCount: 2,
    lastActivity: '2026-07-28T12:05:00.000Z',
    unreadCount: 0,
    unreadMentions: 0,
    ...overrides,
  }
}

function snapshot(overrides: Partial<MatrixThreadListDto> = {}): MatrixThreadListDto {
  return {
    items: [item()],
    hasMore: false,
    ...overrides,
  }
}

describe('orderThreadList', () => {
  it('floats threads with an unread mention above everything else, preserving order otherwise', () => {
    const quiet = item({ root: { ...root, id: '$quiet' } })
    const mentioned = item({ root: { ...root, id: '$mentioned' }, unreadMentions: 1 })
    const unreadOnly = item({ root: { ...root, id: '$unread' }, unreadCount: 5 })

    expect(orderThreadList([quiet, mentioned, unreadOnly]).map((row) => row.root.id)).toEqual([
      '$mentioned',
      '$quiet',
      '$unread',
    ])
  })
})

describe('thread list store', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useThreadListStore.getState().clear()
  })

  it('loads a room-scoped snapshot, ordered with mentions floating', async () => {
    const quiet = item({ root: { ...root, id: '$quiet' } })
    const mentioned = item({ root: { ...root, id: '$mentioned' }, unreadMentions: 2 })
    bridge.matrixThreadList.mockResolvedValue(snapshot({ items: [quiet, mentioned], hasMore: true }))

    await useThreadListStore.getState().load(root.channelId)

    expect(useThreadListStore.getState()).toMatchObject({
      roomId: root.channelId,
      hasMore: true,
      loading: false,
      loadFailed: false,
    })
    expect(useThreadListStore.getState().items.map((row) => row.root.id)).toEqual([
      '$mentioned',
      '$quiet',
    ])
  })

  it('discards a stale response when the room changes before it resolves', async () => {
    let resolveFirst: (value: MatrixThreadListDto) => void = () => {}
    bridge.matrixThreadList.mockReturnValueOnce(new Promise<MatrixThreadListDto>((resolve) => {
      resolveFirst = resolve
    }))

    const firstLoad = useThreadListStore.getState().load('!first:example.org')
    bridge.matrixThreadList.mockResolvedValueOnce(snapshot({ items: [] }))
    await useThreadListStore.getState().load('!second:example.org')

    resolveFirst(snapshot({ items: [item()] }))
    await firstLoad

    expect(useThreadListStore.getState().roomId).toBe('!second:example.org')
    expect(useThreadListStore.getState().items).toEqual([])
  })

  it('reports a load failure without clearing an unrelated room out from under a retry', async () => {
    bridge.matrixThreadList.mockRejectedValue(new Error('offline'))

    await useThreadListStore.getState().load(root.channelId)

    expect(useThreadListStore.getState()).toMatchObject({
      roomId: root.channelId,
      loading: false,
      loadFailed: true,
    })
  })

  it('clears back to the empty snapshot', async () => {
    bridge.matrixThreadList.mockResolvedValue(snapshot())
    await useThreadListStore.getState().load(root.channelId)

    useThreadListStore.getState().clear()

    expect(useThreadListStore.getState()).toMatchObject({
      roomId: null,
      items: [],
      hasMore: false,
      loading: false,
      loadFailed: false,
    })
  })
})
