import { describe, expect, it } from 'vitest'
import {
  MAX_OPEN_ROOM_TABS,
  activateRelativeRoomTab,
  closeRoomTab,
  emptyRoomTabState,
  findRestorableActiveRoomTab,
  openRoomTab,
  reorderRoomTab,
  reopenRoomTab,
  restoreRoomTabState,
  roomTabKey,
  serializeRoomTabState,
  setRoomTabPinned,
  type RoomTab,
} from './room-tabs'

function tab(id: string, pinned = false, lastOpenedAt = 0): RoomTab {
  return {
    key: roomTabKey('room', id),
    kind: 'room',
    roomId: id,
    communityId: '!space:example.org',
    title: id,
    pinned,
    unreadCount: 0,
    mentionCount: 0,
    lastOpenedAt,
  }
}

describe('account-scoped room tabs', () => {
  it('opens, pins, reorders, closes, and reopens rooms and DMs', () => {
    let state = emptyRoomTabState('@alice:example.org')
    state = openRoomTab(state, tab('one', false, 1))
    state = openRoomTab(state, { ...tab('dm', false, 2), kind: 'dm', key: 'forged' })
    expect(state.tabs.map((item) => item.key)).toEqual(['room:one', 'dm:dm'])

    state = setRoomTabPinned(state, 'room:one', true)
    state = reorderRoomTab(state, 'dm:dm', -1)
    expect(state.tabs.map((item) => [item.key, item.pinned])).toEqual([
      ['dm:dm', false],
      ['room:one', true],
    ])

    state = closeRoomTab(state, 'dm:dm')
    expect(state.activeKey).toBe('room:one')
    state = reopenRoomTab(state, 3)
    expect(state.activeKey).toBe('dm:dm')
    expect(state.tabs).toHaveLength(2)
  })

  it('cycles next and previous with wraparound', () => {
    let state = openRoomTab(emptyRoomTabState('account'), tab('one'))
    state = openRoomTab(state, tab('two'))
    state = activateRelativeRoomTab(state, 1, 4)
    expect(state.activeKey).toBe('room:one')
    state = activateRelativeRoomTab(state, -1, 5)
    expect(state.activeKey).toBe('room:two')
  })

  it('bounds open tabs and evicts the oldest unpinned inactive tab', () => {
    let state = emptyRoomTabState('account')
    for (let index = 0; index < MAX_OPEN_ROOM_TABS; index += 1) {
      state = openRoomTab(state, tab(`room-${index}`, index === 0, index))
    }
    state = openRoomTab(state, tab('new', false, 100))
    expect(state.tabs).toHaveLength(MAX_OPEN_ROOM_TABS)
    expect(state.tabs.some((item) => item.roomId === 'room-0')).toBe(true)
    expect(state.tabs.some((item) => item.roomId === 'room-1')).toBe(false)
    expect(state.tabs.some((item) => item.roomId === 'new')).toBe(true)
  })

  it('never restores another account room IDs and handles corrupt storage', () => {
    let alice = openRoomTab(emptyRoomTabState('@alice:example.org'), tab('private'))
    alice = openRoomTab(alice, { ...tab('friend'), kind: 'dm' })
    alice = setRoomTabPinned(alice, 'room:private', true)
    const serialized = serializeRoomTabState(alice)
    expect(restoreRoomTabState(serialized, '@alice:example.org')).toMatchObject({
      activeKey: 'dm:friend',
      tabs: [
        expect.objectContaining({ key: 'room:private', pinned: true }),
        expect.objectContaining({ key: 'dm:friend' }),
      ],
    })
    expect(restoreRoomTabState(serialized, '@bob:elsewhere.org')).toEqual(
      emptyRoomTabState('@bob:elsewhere.org'),
    )
    expect(restoreRoomTabState('{broken', '@alice:example.org')).toEqual(
      emptyRoomTabState('@alice:example.org'),
    )
  })

  it('normalizes badges and rejects unbounded restored state', () => {
    let state = emptyRoomTabState('account')
    for (let index = 0; index < MAX_OPEN_ROOM_TABS + 10; index += 1) {
      state.tabs.push({
        ...tab(`room-${index}`),
        unreadCount: 100_000,
        mentionCount: -4,
      })
    }
    const restored = restoreRoomTabState(JSON.stringify(state), 'account')
    expect(restored.tabs).toHaveLength(MAX_OPEN_ROOM_TABS)
    expect(restored.tabs[0]).toMatchObject({ unreadCount: 9999, mentionCount: 0 })
  })

  it('restores the saved active conversation rather than the first available tab', () => {
    let state = openRoomTab(emptyRoomTabState('account'), tab('general'))
    state = openRoomTab(state, {
      ...tab('friend'),
      key: roomTabKey('dm', 'friend'),
      kind: 'dm',
      communityId: null,
    })

    const restored = findRestorableActiveRoomTab(
      state,
      (roomId) => roomId === 'general',
      (conversationId) => conversationId === 'friend',
    )
    expect(restored).toMatchObject({ kind: 'dm', roomId: 'friend' })
  })
})
