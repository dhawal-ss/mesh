import { beforeEach, describe, expect, it } from 'vitest'
import type { DirectMessage } from '../types/ipc'
import { useDmStore } from './dms'

const CONVERSATION_ID = 'dm-1'

function dm(id: string, minute: number): DirectMessage {
  return {
    id,
    conversationId: CONVERSATION_ID,
    authorPublicKey: '@peer:example.org',
    authorDisplayName: 'Peer',
    authorAvatarColor: '#52b5f4',
    content: `Message at minute ${minute}`,
    timestamp: new Date(Date.UTC(2026, 7, 1, 0, minute)).toISOString(),
    signature: '',
    attachments: [],
    reactions: {},
  }
}

function resetStore() {
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
    loadingOlder: {},
    hasMoreOlder: {},
    browsingOlder: {},
    newerGapCount: {},
    conversationRecency: [],
    hasAuthoredMessage: false,
  })
}

describe('DM addMessage ordering', () => {
  beforeEach(resetStore)

  it('inserts a late, out-of-order arrival into its chronological slot', () => {
    const first = dm('$a', 0)
    const third = dm('$c', 2)
    // Arrives last (federation lag) but belongs between the first and third.
    const late = dm('$b', 1)

    useDmStore.getState().addMessage(first)
    useDmStore.getState().addMessage(third)
    useDmStore.getState().addMessage(late)

    const state = useDmStore.getState()
    expect(state.messageOrder[CONVERSATION_ID]).toEqual(['$a', '$b', '$c'])
    expect(state.messages[CONVERSATION_ID].map((entry) => entry.id)).toEqual(['$a', '$b', '$c'])
    // The entity map stays consistent with the ordered projection.
    expect(Object.keys(state.messageEntities[CONVERSATION_ID]).sort()).toEqual(['$a', '$b', '$c'])
  })

  it('ignores a duplicate echo without disturbing the timeline', () => {
    useDmStore.getState().addMessage(dm('$a', 0))
    useDmStore.getState().addMessage(dm('$b', 1))
    // Same id arriving again is a duplicate echo: the first-seen entry stays.
    useDmStore.getState().addMessage({ ...dm('$b', 1), content: 'edited echo' })

    const state = useDmStore.getState()
    expect(state.messageOrder[CONVERSATION_ID]).toEqual(['$a', '$b'])
    expect(state.messages[CONVERSATION_ID][1].content).toBe('Message at minute 1')
  })

  it('does not count a re-delivered event into the gap badge while browsing older', () => {
    const first = dm('$a', 0)
    useDmStore.getState().addMessage(first)
    // User scrolls into history: pin the timeline and start gap-counting.
    useDmStore.setState((state) => ({
      browsingOlder: { ...state.browsingOlder, [CONVERSATION_ID]: true },
    }))

    // A genuinely new message bumps the gap counter by one.
    useDmStore.getState().addMessage(dm('$b', 1))
    expect(useDmStore.getState().newerGapCount[CONVERSATION_ID]).toBe(1)

    // A re-delivery of an already-known event (sync resume / reconnect replay)
    // must be deduped, not counted again.
    useDmStore.getState().addMessage(first)
    expect(useDmStore.getState().newerGapCount[CONVERSATION_ID]).toBe(1)
  })
})
