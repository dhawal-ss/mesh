import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useMessageStore } from './messages'
import type { Message } from '../types/ipc'

// Helper: build a minimal Message object with sensible defaults
function msg(overrides: Partial<Message> & Pick<Message, 'id'>): Message {
  return {
    channelId: 'ch-1',
    authorPublicKey: 'author-abc',
    authorDisplayName: 'Alice',
    authorAvatarColor: '#ff0000',
    content: `Message ${overrides.id}`,
    attachments: [],
    reactions: {},
    timestamp: new Date().toISOString(),
    signature: 'sig',
    ...overrides,
  }
}

// Reset the store to its pristine state between tests
beforeEach(() => {
  useMessageStore.setState({
    messages: {},
    loadingOlder: {},
    hasMoreOlder: {},
    browsingOlder: {},
    newerGapCount: {},
  })
})

// ─── mergeMessages (tested indirectly through setMessages) ───

describe('mergeMessages via setMessages', () => {
  it('deduplicates messages with the same id', () => {
    const store = useMessageStore.getState()
    const m1 = msg({ id: 'a', timestamp: '2025-01-01T00:00:00Z' })

    store.setMessages('ch-1', [m1])
    store.setMessages('ch-1', [m1, m1])

    const result = useMessageStore.getState().messages['ch-1']
    expect(result).toHaveLength(1)
    expect(result[0].id).toBe('a')
  })

  it('sorts messages by timestamp then by id', () => {
    const store = useMessageStore.getState()
    const m1 = msg({ id: 'b', timestamp: '2025-01-01T00:00:02Z' })
    const m2 = msg({ id: 'a', timestamp: '2025-01-01T00:00:01Z' })
    const m3 = msg({ id: 'c', timestamp: '2025-01-01T00:00:01Z' })

    store.setMessages('ch-1', [m1, m2, m3])

    const ids = useMessageStore.getState().messages['ch-1'].map((m) => m.id)
    // m2 (01, id=a) < m3 (01, id=c) < m1 (02, id=b)
    expect(ids).toEqual(['a', 'c', 'b'])
  })

  it('merges incoming messages with existing ones', () => {
    const store = useMessageStore.getState()
    const m1 = msg({ id: 'a', timestamp: '2025-01-01T00:00:01Z' })
    const m2 = msg({ id: 'b', timestamp: '2025-01-01T00:00:02Z' })
    const m3 = msg({ id: 'c', timestamp: '2025-01-01T00:00:03Z' })

    store.setMessages('ch-1', [m1, m2])
    store.setMessages('ch-1', [m2, m3])

    const ids = useMessageStore.getState().messages['ch-1'].map((m) => m.id)
    expect(ids).toEqual(['a', 'b', 'c'])
  })
})

// ─── boundLatestWindow (tested indirectly through setMessages) ───

describe('boundLatestWindow via setMessages', () => {
  it('trims messages to the HOT_WINDOW_SIZE of 200, keeping the newest', () => {
    const store = useMessageStore.getState()
    const messages: Message[] = []
    for (let i = 0; i < 250; i++) {
      messages.push(
        msg({
          id: `msg-${String(i).padStart(4, '0')}`,
          timestamp: new Date(Date.UTC(2025, 0, 1, 0, 0, i)).toISOString(),
        }),
      )
    }

    store.setMessages('ch-1', messages)

    const result = useMessageStore.getState().messages['ch-1']
    expect(result).toHaveLength(200)
    // Should keep the newest 200, i.e. msg-0050 through msg-0249
    expect(result[0].id).toBe('msg-0050')
    expect(result[result.length - 1].id).toBe('msg-0249')
  })
})

// ─── addMessage ───

describe('addMessage', () => {
  it('adds a new message to an empty channel', () => {
    const store = useMessageStore.getState()
    const m1 = msg({ id: 'a', timestamp: '2025-01-01T00:00:01Z' })

    store.addMessage('ch-1', m1)

    const result = useMessageStore.getState().messages['ch-1']
    expect(result).toHaveLength(1)
    expect(result[0].id).toBe('a')
  })

  it('ignores a duplicate message', () => {
    const store = useMessageStore.getState()
    const m1 = msg({ id: 'a', timestamp: '2025-01-01T00:00:01Z' })

    store.addMessage('ch-1', m1)
    store.addMessage('ch-1', m1)

    expect(useMessageStore.getState().messages['ch-1']).toHaveLength(1)
  })

  it('increments newerGapCount instead of appending when browsingOlder is true', () => {
    useMessageStore.setState({
      messages: { 'ch-1': [msg({ id: 'a', timestamp: '2025-01-01T00:00:01Z' })] },
      browsingOlder: { 'ch-1': true },
      newerGapCount: { 'ch-1': 0 },
    })

    const store = useMessageStore.getState()
    store.addMessage('ch-1', msg({ id: 'b', timestamp: '2025-01-01T00:00:02Z' }))

    const state = useMessageStore.getState()
    expect(state.messages['ch-1']).toHaveLength(1) // unchanged
    expect(state.newerGapCount['ch-1']).toBe(1)
  })
})

// ─── loadOlderMessages ───

describe('loadOlderMessages', () => {
  it('sets and clears loadingOlder flag during load', async () => {
    const bridge = await import('../lib/bridge')
    const getMessagesMock = vi.mocked(bridge.getMessages)
    getMessagesMock.mockResolvedValueOnce([])

    useMessageStore.setState({
      messages: { 'ch-1': [msg({ id: 'a', timestamp: '2025-01-01T00:00:01Z' })] },
      hasMoreOlder: { 'ch-1': true },
    })

    const promise = useMessageStore.getState().loadOlderMessages('ch-1')

    // loadingOlder should be set immediately
    expect(useMessageStore.getState().loadingOlder['ch-1']).toBe(true)

    await promise

    expect(useMessageStore.getState().loadingOlder['ch-1']).toBe(false)
  })

  it('skips loading when already loading', async () => {
    const bridge = await import('../lib/bridge')
    const getMessagesMock = vi.mocked(bridge.getMessages)
    getMessagesMock.mockClear()

    useMessageStore.setState({
      loadingOlder: { 'ch-1': true },
    })

    await useMessageStore.getState().loadOlderMessages('ch-1')

    expect(getMessagesMock).not.toHaveBeenCalled()
  })

  it('skips loading when hasMoreOlder is false', async () => {
    const bridge = await import('../lib/bridge')
    const getMessagesMock = vi.mocked(bridge.getMessages)
    getMessagesMock.mockClear()

    useMessageStore.setState({
      hasMoreOlder: { 'ch-1': false },
    })

    await useMessageStore.getState().loadOlderMessages('ch-1')

    expect(getMessagesMock).not.toHaveBeenCalled()
  })
})

// ─── applyReaction (tested through updateReaction) ───

describe('updateReaction', () => {
  it('adds a reaction to a message', () => {
    const m1 = msg({ id: 'a', timestamp: '2025-01-01T00:00:01Z', reactions: {} })

    useMessageStore.setState({ messages: { 'ch-1': [m1] } })
    useMessageStore.getState().updateReaction('ch-1', 'a', 'thumbsup', 'user-1', 'add')

    const reactions = useMessageStore.getState().messages['ch-1'][0].reactions
    expect(reactions['thumbsup']).toEqual(['user-1'])
  })

  it('does not add duplicate reaction from same author', () => {
    const m1 = msg({
      id: 'a',
      timestamp: '2025-01-01T00:00:01Z',
      reactions: { thumbsup: ['user-1'] },
    })

    useMessageStore.setState({ messages: { 'ch-1': [m1] } })
    useMessageStore.getState().updateReaction('ch-1', 'a', 'thumbsup', 'user-1', 'add')

    const reactions = useMessageStore.getState().messages['ch-1'][0].reactions
    expect(reactions['thumbsup']).toEqual(['user-1'])
  })

  it('removes a reaction from a message', () => {
    const m1 = msg({
      id: 'a',
      timestamp: '2025-01-01T00:00:01Z',
      reactions: { thumbsup: ['user-1', 'user-2'] },
    })

    useMessageStore.setState({ messages: { 'ch-1': [m1] } })
    useMessageStore.getState().updateReaction('ch-1', 'a', 'thumbsup', 'user-1', 'remove')

    const reactions = useMessageStore.getState().messages['ch-1'][0].reactions
    expect(reactions['thumbsup']).toEqual(['user-2'])
  })

  it('removes the emoji key entirely when last author is removed', () => {
    const m1 = msg({
      id: 'a',
      timestamp: '2025-01-01T00:00:01Z',
      reactions: { thumbsup: ['user-1'] },
    })

    useMessageStore.setState({ messages: { 'ch-1': [m1] } })
    useMessageStore.getState().updateReaction('ch-1', 'a', 'thumbsup', 'user-1', 'remove')

    const reactions = useMessageStore.getState().messages['ch-1'][0].reactions
    expect(reactions['thumbsup']).toBeUndefined()
  })
})

// ─── editMessage ───

describe('editMessage', () => {
  it('updates content and editedAt for the target message', () => {
    const m1 = msg({ id: 'a', content: 'original', timestamp: '2025-01-01T00:00:01Z' })

    useMessageStore.setState({ messages: { 'ch-1': [m1] } })
    useMessageStore.getState().editMessage('ch-1', 'a', 'updated', '2025-01-01T00:01:00Z')

    const result = useMessageStore.getState().messages['ch-1'][0]
    expect(result.content).toBe('updated')
    expect(result.editedAt).toBe('2025-01-01T00:01:00Z')
  })

  it('leaves other messages in the channel unchanged', () => {
    const m1 = msg({ id: 'a', content: 'keep me', timestamp: '2025-01-01T00:00:01Z' })
    const m2 = msg({ id: 'b', content: 'edit me', timestamp: '2025-01-01T00:00:02Z' })

    useMessageStore.setState({ messages: { 'ch-1': [m1, m2] } })
    useMessageStore.getState().editMessage('ch-1', 'b', 'edited', '2025-01-01T00:01:00Z')

    const [r1, r2] = useMessageStore.getState().messages['ch-1']
    expect(r1.content).toBe('keep me')
    expect(r2.content).toBe('edited')
  })
})

// ─── deleteMessage ───

describe('deleteMessage', () => {
  it('clears content and sets deletedAt', () => {
    const m1 = msg({ id: 'a', content: 'to be deleted', timestamp: '2025-01-01T00:00:01Z' })

    useMessageStore.setState({ messages: { 'ch-1': [m1] } })
    useMessageStore.getState().deleteMessage('ch-1', 'a')

    const result = useMessageStore.getState().messages['ch-1'][0]
    expect(result.content).toBe('')
    expect(result.deletedAt).toBeTruthy()
  })
})
