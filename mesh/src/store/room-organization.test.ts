import { beforeEach, describe, expect, it } from 'vitest'
import { roomOrganizationStorageKey } from '../lib/room-organization'
import { useRoomOrganizationStore } from './room-organization'

describe('room organization store', () => {
  beforeEach(() => {
    localStorage.clear()
    useRoomOrganizationStore.getState().resetForAccountTransition()
  })

  it('isolates state by account and persists synchronously', () => {
    useRoomOrganizationStore.getState().initialize('@taylor:example.org')
    useRoomOrganizationStore.getState().hide('room-noisy')
    expect(useRoomOrganizationStore.getState().hidden).toEqual(['room-noisy'])
    const stored = localStorage.getItem(roomOrganizationStorageKey('@taylor:example.org'))
    expect(stored).not.toBeNull()
    expect(JSON.parse(stored!).hidden).toEqual(['room-noisy'])

    useRoomOrganizationStore.getState().initialize('@maya:example.org')
    expect(useRoomOrganizationStore.getState().hidden).toEqual([])
  })

  it('restores an account previously initialized in this session', () => {
    useRoomOrganizationStore.getState().initialize('@taylor:example.org')
    useRoomOrganizationStore.getState().hide('room-noisy')
    useRoomOrganizationStore.getState().initialize('@maya:example.org')

    useRoomOrganizationStore.getState().initialize('@taylor:example.org')
    expect(useRoomOrganizationStore.getState().hidden).toEqual(['room-noisy'])
  })

  it('pins and unpins without duplicating', () => {
    useRoomOrganizationStore.getState().initialize('@taylor:example.org')
    useRoomOrganizationStore.getState().pin('scope', 'room-a')
    useRoomOrganizationStore.getState().pin('scope', 'room-a')
    expect(useRoomOrganizationStore.getState().pinned.scope).toEqual(['room-a'])
    useRoomOrganizationStore.getState().unpin('scope', 'room-a')
    expect(useRoomOrganizationStore.getState().pinned.scope).toEqual([])
  })

  it('hides and unhides without duplicating', () => {
    useRoomOrganizationStore.getState().initialize('@taylor:example.org')
    useRoomOrganizationStore.getState().hide('room-a')
    useRoomOrganizationStore.getState().hide('room-a')
    expect(useRoomOrganizationStore.getState().hidden).toEqual(['room-a'])
    useRoomOrganizationStore.getState().unhide('room-a')
    expect(useRoomOrganizationStore.getState().hidden).toEqual([])
  })

  it('moves a room within its pinned band, not past an interleaved unpinned neighbor', () => {
    useRoomOrganizationStore.getState().initialize('@taylor:example.org')
    useRoomOrganizationStore.getState().pin('scope', 'room-a')
    useRoomOrganizationStore.getState().pin('scope', 'room-c')
    // Display order today: pinned [a, c], unpinned [b, d].
    useRoomOrganizationStore.getState().move('scope', 'room-c', -1, ['room-a', 'room-b', 'room-c', 'room-d'])
    expect(useRoomOrganizationStore.getState().order.scope).toEqual(['room-c', 'room-b', 'room-a', 'room-d'])
  })

  it('reconciles a room list that changed since the order was saved', () => {
    useRoomOrganizationStore.getState().initialize('@taylor:example.org')
    useRoomOrganizationStore.getState().move('scope', 'room-b', -1, ['room-a', 'room-b'])
    expect(useRoomOrganizationStore.getState().order.scope).toEqual(['room-b', 'room-a'])
    // room-a no longer exists; room-c is new.
    useRoomOrganizationStore.getState().move('scope', 'room-c', -1, ['room-b', 'room-c'])
    expect(useRoomOrganizationStore.getState().order.scope).toEqual(['room-c', 'room-b'])
  })

  it('preserves a hidden room\'s saved position across a move, instead of dropping it', () => {
    useRoomOrganizationStore.getState().initialize('@taylor:example.org')
    // Save an order: room-a is already first, so this move is a no-op, but
    // it establishes order.scope = [a, b, c, d].
    useRoomOrganizationStore.getState().move('scope', 'room-a', -1, ['room-a', 'room-b', 'room-c', 'room-d'])
    expect(useRoomOrganizationStore.getState().order.scope).toEqual(['room-a', 'room-b', 'room-c', 'room-d'])

    useRoomOrganizationStore.getState().hide('room-b')
    // room-b is hidden, so it is absent from the rendered `currentIds`. A
    // move of an unrelated room (room-d, not adjacent to room-b) must not
    // let reconciliation drop room-b from the saved order.
    useRoomOrganizationStore.getState().move('scope', 'room-d', -1, ['room-a', 'room-c', 'room-d'])
    expect(useRoomOrganizationStore.getState().order.scope).toEqual(['room-a', 'room-b', 'room-d', 'room-c'])

    useRoomOrganizationStore.getState().unhide('room-b')
    // room-b reappears exactly where it was, not reappended at the end.
    expect(useRoomOrganizationStore.getState().order.scope).toEqual(['room-a', 'room-b', 'room-d', 'room-c'])
  })

  it('toggles group collapse state', () => {
    useRoomOrganizationStore.getState().initialize('@taylor:example.org')
    expect(useRoomOrganizationStore.getState().collapsedGroups).toEqual([])
    useRoomOrganizationStore.getState().toggleGroupCollapsed('voice')
    expect(useRoomOrganizationStore.getState().collapsedGroups).toEqual(['voice'])
    useRoomOrganizationStore.getState().toggleGroupCollapsed('voice')
    expect(useRoomOrganizationStore.getState().collapsedGroups).toEqual([])
  })

  it('restore defaults clears every scope back to server order', () => {
    useRoomOrganizationStore.getState().initialize('@taylor:example.org')
    useRoomOrganizationStore.getState().pin('scope', 'room-a')
    useRoomOrganizationStore.getState().hide('room-b')
    useRoomOrganizationStore.getState().toggleGroupCollapsed('voice')
    useRoomOrganizationStore.getState().move('scope', 'room-c', -1, ['room-c', 'room-d'])

    useRoomOrganizationStore.getState().restoreDefaults()

    const state = useRoomOrganizationStore.getState()
    expect(state.pinned).toEqual({})
    expect(state.hidden).toEqual([])
    expect(state.collapsedGroups).toEqual([])
    expect(state.order).toEqual({})
    const stored = localStorage.getItem(roomOrganizationStorageKey('@taylor:example.org'))
    expect(JSON.parse(stored!).hidden).toEqual([])
  })

  it('removes the departed account key on account transition', () => {
    useRoomOrganizationStore.getState().initialize('@taylor:example.org')
    useRoomOrganizationStore.getState().hide('room-a')
    expect(localStorage.getItem(roomOrganizationStorageKey('@taylor:example.org'))).not.toBeNull()

    useRoomOrganizationStore.getState().resetForAccountTransition('@taylor:example.org')

    expect(localStorage.getItem(roomOrganizationStorageKey('@taylor:example.org'))).toBeNull()
    expect(useRoomOrganizationStore.getState().hidden).toEqual([])
  })
})
