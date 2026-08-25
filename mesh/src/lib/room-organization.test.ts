import { describe, expect, it } from 'vitest'
import {
  applyManualOrder,
  applyPinned,
  bandPositions,
  emptyRoomOrganization,
  isGroupCollapsed,
  moveWithinBand,
  reconcileOrder,
  restoreRoomOrganization,
  ROOM_ORGANIZATION_SCHEMA_VERSION,
  roomOrganizationStorageKey,
  serializeRoomOrganization,
  type RoomOrganizationSnapshot,
} from './room-organization'

describe('roomOrganizationStorageKey', () => {
  it('namespaces by account id', () => {
    expect(roomOrganizationStorageKey('@alice:example.org')).toBe(
      'mesh-room-organization-v1:%40alice%3Aexample.org',
    )
  })
})

describe('applyManualOrder', () => {
  const items = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]

  it('is a no-op with no saved order', () => {
    expect(applyManualOrder(items, (i) => i.id, undefined)).toEqual(items)
    expect(applyManualOrder(items, (i) => i.id, [])).toEqual(items)
  })

  it('applies the saved order and appends anything not listed', () => {
    const result = applyManualOrder(items, (i) => i.id, ['c', 'a'])
    expect(result.map((i) => i.id)).toEqual(['c', 'a', 'b'])
  })

  it('drops ids from the saved order that no longer exist', () => {
    const result = applyManualOrder(items, (i) => i.id, ['z', 'c', 'a'])
    expect(result.map((i) => i.id)).toEqual(['c', 'a', 'b'])
  })
})

describe('applyPinned', () => {
  const items = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }]

  it('is a no-op with no pins', () => {
    expect(applyPinned(items, (i) => i.id, undefined)).toEqual(items)
    expect(applyPinned(items, (i) => i.id, [])).toEqual(items)
  })

  it('floats pinned items to the front as a stable partition', () => {
    const result = applyPinned(items, (i) => i.id, ['c', 'a'])
    // Pinned band keeps its relative order from `items` (a before c), not
    // pin-array order (c before a): membership only, per the module doc.
    expect(result.map((i) => i.id)).toEqual(['a', 'c', 'b', 'd'])
  })
})

describe('reconcileOrder', () => {
  it('drops stale ids and appends new ones in their incoming order', () => {
    expect(reconcileOrder(['z', 'b', 'a'], ['a', 'b', 'c'])).toEqual(['b', 'a', 'c'])
  })

  it('returns the incoming order untouched with no saved order', () => {
    expect(reconcileOrder(undefined, ['a', 'b'])).toEqual(['a', 'b'])
  })
})

describe('moveWithinBand', () => {
  const noPinned = () => false

  it('swaps adjacent same-band neighbors', () => {
    expect(moveWithinBand(['a', 'b', 'c'], 'b', -1, noPinned)).toEqual(['b', 'a', 'c'])
    expect(moveWithinBand(['a', 'b', 'c'], 'b', 1, noPinned)).toEqual(['a', 'c', 'b'])
  })

  it('is unchanged at the edge of the whole list', () => {
    expect(moveWithinBand(['a', 'b', 'c'], 'a', -1, noPinned)).toEqual(['a', 'b', 'c'])
    expect(moveWithinBand(['a', 'b', 'c'], 'c', 1, noPinned)).toEqual(['a', 'b', 'c'])
  })

  it('is unchanged for a missing id', () => {
    expect(moveWithinBand(['a', 'b'], 'z', -1, noPinned)).toEqual(['a', 'b'])
  })

  it('skips over the other band instead of silently no-oping against it', () => {
    // order = [A(pin), B(unpin), C(pin), D(unpin)]. Moving C up must land it
    // ahead of A in the pinned band, not swap with the literal next slot (B),
    // which would leave the pinned band's visible order unchanged.
    const pinned = new Set(['a', 'c'])
    const isPinned = (id: string) => pinned.has(id)
    const moved = moveWithinBand(['a', 'b', 'c', 'd'], 'c', -1, isPinned)
    expect(moved).toEqual(['c', 'b', 'a', 'd'])
    // The unpinned band's own relative order (b before d) is untouched.
    expect(moved.filter((id) => !pinned.has(id))).toEqual(['b', 'd'])
  })

  it('does not cross into the other band at its own band edge', () => {
    // b is the only unpinned id and sits between two pinned ids; it has no
    // unpinned neighbor in either direction.
    const pinned = new Set(['a', 'c'])
    const isPinned = (id: string) => pinned.has(id)
    expect(moveWithinBand(['a', 'b', 'c'], 'b', -1, isPinned)).toEqual(['a', 'b', 'c'])
    expect(moveWithinBand(['a', 'b', 'c'], 'b', 1, isPinned)).toEqual(['a', 'b', 'c'])
  })
})

describe('bandPositions', () => {
  const items = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }]

  it('marks band edges independently for the pinned and unpinned bands', () => {
    const positions = bandPositions(items, (i) => i.id, ['a', 'c'])
    expect(positions.get('a')).toEqual({ isFirstInBand: true, isLastInBand: false })
    expect(positions.get('c')).toEqual({ isFirstInBand: false, isLastInBand: true })
    expect(positions.get('b')).toEqual({ isFirstInBand: true, isLastInBand: false })
    expect(positions.get('d')).toEqual({ isFirstInBand: false, isLastInBand: true })
  })

  it('treats every item as both first and last in a single-item band', () => {
    const positions = bandPositions([{ id: 'a' }], (i) => i.id, [])
    expect(positions.get('a')).toEqual({ isFirstInBand: true, isLastInBand: true })
  })
})

describe('isGroupCollapsed', () => {
  it('defaults expanded unless toggled', () => {
    expect(isGroupCollapsed([], 'voice')).toBe(false)
    expect(isGroupCollapsed(['voice'], 'voice')).toBe(true)
  })

  it('defaults collapsed when asked to, and toggling flips it', () => {
    expect(isGroupCollapsed([], 'hidden', true)).toBe(true)
    expect(isGroupCollapsed(['hidden'], 'hidden', true)).toBe(false)
  })
})

describe('restoreRoomOrganization', () => {
  const accountId = '@alice:example.org'

  it('returns empty state for nothing stored', () => {
    expect(restoreRoomOrganization(null, accountId)).toEqual(emptyRoomOrganization(accountId))
  })

  it('round-trips a full snapshot', () => {
    const snapshot: RoomOrganizationSnapshot = {
      schemaVersion: ROOM_ORGANIZATION_SCHEMA_VERSION,
      accountId,
      order: { 'community:c1:text': ['room-b', 'room-a'] },
      pinned: { 'community:c1:text': ['room-a'] },
      hidden: ['room-c'],
      collapsedGroups: ['community:c1:voice'],
    }
    expect(restoreRoomOrganization(serializeRoomOrganization(snapshot), accountId)).toEqual(snapshot)
  })

  it('discards a snapshot stored under a different account', () => {
    const snapshot = serializeRoomOrganization({
      ...emptyRoomOrganization('@bob:example.org'),
      hidden: ['room-a'],
    })
    expect(restoreRoomOrganization(snapshot, accountId)).toEqual(emptyRoomOrganization(accountId))
  })

  it('discards unparseable JSON', () => {
    expect(restoreRoomOrganization('not json', accountId)).toEqual(emptyRoomOrganization(accountId))
  })

  it('falls back per field instead of wiping the whole snapshot on one bad field', () => {
    const raw = JSON.stringify({
      schemaVersion: ROOM_ORGANIZATION_SCHEMA_VERSION,
      accountId,
      order: { 'community:c1:text': ['room-a'] },
      pinned: 'not an object',
      hidden: ['room-c'],
      collapsedGroups: [1, 2, 3],
    })
    expect(restoreRoomOrganization(raw, accountId)).toEqual({
      schemaVersion: ROOM_ORGANIZATION_SCHEMA_VERSION,
      accountId,
      order: { 'community:c1:text': ['room-a'] },
      pinned: {},
      hidden: ['room-c'],
      collapsedGroups: [],
    })
  })

  it('tolerates an unrecognized future field without discarding the rest', () => {
    const raw = JSON.stringify({
      schemaVersion: ROOM_ORGANIZATION_SCHEMA_VERSION,
      accountId,
      order: {},
      pinned: {},
      hidden: ['room-a'],
      collapsedGroups: [],
      categories: [{ id: 'later', name: 'Not built yet' }],
    })
    expect(restoreRoomOrganization(raw, accountId).hidden).toEqual(['room-a'])
  })
})
