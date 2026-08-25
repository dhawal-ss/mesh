/**
 * Local-only room and community organization: manual order, pins, hidden
 * rooms, and collapsed groups. None of this is Matrix room account data or
 * any other protocol state: it is a per-account, per-device rendering
 * preference layered over the server's own order, exactly like the original
 * product direction called for.
 *
 * Persisted per account (see `roomOrganizationStorageKey`); restored
 * field-by-field rather than all-or-nothing, so an additive future schema
 * change never silently wipes an account's existing pins, order, hides, or
 * collapsed groups the way a version-gated wipe would.
 */

export const ROOM_ORGANIZATION_SCHEMA_VERSION = 1

export interface RoomOrganizationSnapshot {
  schemaVersion: typeof ROOM_ORGANIZATION_SCHEMA_VERSION
  accountId: string
  /**
   * scopeKey -> the full manual order of ids for that scope. An id absent
   * from the current data set is dropped on reconciliation; an id present in
   * the data but absent from this list is appended after the listed ones, in
   * whatever order it arrived in.
   */
  order: Record<string, string[]>
  /**
   * scopeKey -> ids pinned to the top of that scope. Membership only: the
   * *relative* order of pinned ids among themselves comes from `order`, via
   * `applyPinned`'s stable partition, not from this list's own sequence.
   */
  pinned: Record<string, string[]>
  /** Hidden channel ids. Channel ids are globally unique, so this needs no scope key. */
  hidden: string[]
  /** Collapsed group keys. See `isGroupCollapsed` for how a key's default factors in. */
  collapsedGroups: string[]
}

export function roomOrganizationStorageKey(accountId: string): string {
  return `mesh-room-organization-v1:${encodeURIComponent(accountId)}`
}

export function emptyRoomOrganization(accountId: string): RoomOrganizationSnapshot {
  return {
    schemaVersion: ROOM_ORGANIZATION_SCHEMA_VERSION,
    accountId,
    order: {},
    pinned: {},
    hidden: [],
    collapsedGroups: [],
  }
}

export function serializeRoomOrganization(state: RoomOrganizationSnapshot): string {
  return JSON.stringify(state)
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string')
}

function isStringArrayRecord(value: unknown): value is Record<string, string[]> {
  return (
    typeof value === 'object' && value !== null && !Array.isArray(value)
    && Object.values(value).every(isStringArray)
  )
}

/**
 * Restores per-field: a field that fails to parse or has the wrong shape
 * falls back to its own empty default instead of discarding the whole
 * snapshot. `mesh-navigation.ts` wipes entirely on a schema mismatch, which
 * is fine for expendable navigation history; it is not fine here, where the
 * same behavior would mean a future additive field costs every account its
 * pins, order, hides, and collapsed groups on upgrade.
 */
export function restoreRoomOrganization(
  serialized: string | null,
  accountId: string,
): RoomOrganizationSnapshot {
  const empty = emptyRoomOrganization(accountId)
  if (!serialized) return empty
  try {
    const value = JSON.parse(serialized) as Partial<RoomOrganizationSnapshot> | null
    if (!value || typeof value !== 'object' || value.accountId !== accountId) return empty
    return {
      schemaVersion: ROOM_ORGANIZATION_SCHEMA_VERSION,
      accountId,
      order: isStringArrayRecord(value.order) ? value.order : empty.order,
      pinned: isStringArrayRecord(value.pinned) ? value.pinned : empty.pinned,
      hidden: isStringArray(value.hidden) ? value.hidden : empty.hidden,
      collapsedGroups: isStringArray(value.collapsedGroups)
        ? value.collapsedGroups
        : empty.collapsedGroups,
    }
  } catch {
    return empty
  }
}

function stablePartition<T>(items: readonly T[], inFirstBand: (item: T) => boolean): T[] {
  const first: T[] = []
  const rest: T[] = []
  for (const item of items) (inFirstBand(item) ? first : rest).push(item)
  return [...first, ...rest]
}

/**
 * Applies a saved manual order over the current data: listed ids first, in
 * saved order (dropping any that no longer exist), then every remaining id
 * appended in its incoming order. A no-op when there is no saved order.
 */
export function applyManualOrder<T>(
  items: readonly T[],
  getId: (item: T) => string,
  order: readonly string[] | undefined,
): T[] {
  if (!order || order.length === 0) return [...items]
  const byId = new Map(items.map((item) => [getId(item), item] as const))
  const seen = new Set<string>()
  const ordered: T[] = []
  for (const id of order) {
    const item = byId.get(id)
    if (item && !seen.has(id)) {
      ordered.push(item)
      seen.add(id)
    }
  }
  for (const item of items) {
    const id = getId(item)
    if (!seen.has(id)) {
      ordered.push(item)
      seen.add(id)
    }
  }
  return ordered
}

/**
 * Floats pinned items to the front. A stable partition, so the relative
 * order within each band (pinned, unpinned) is whatever the caller already
 * established, typically the result of `applyManualOrder`.
 */
export function applyPinned<T>(
  items: readonly T[],
  getId: (item: T) => string,
  pinnedIds: readonly string[] | undefined,
): T[] {
  if (!pinnedIds || pinnedIds.length === 0) return [...items]
  const pinnedSet = new Set(pinnedIds)
  return stablePartition(items, (item) => pinnedSet.has(getId(item)))
}

/**
 * Reconciles a saved order against the ids actually present: drops ids that
 * no longer exist, appends ids that are present but not yet in the saved
 * order (in their incoming order). Always returns every id in `currentIds`
 * exactly once, ready to hand to `moveWithinBand`.
 */
export function reconcileOrder(
  order: readonly string[] | undefined,
  currentIds: readonly string[],
): string[] {
  const currentSet = new Set(currentIds)
  const seen = new Set<string>()
  const reconciled: string[] = []
  for (const id of order ?? []) {
    if (currentSet.has(id) && !seen.has(id)) {
      reconciled.push(id)
      seen.add(id)
    }
  }
  for (const id of currentIds) {
    if (!seen.has(id)) {
      reconciled.push(id)
      seen.add(id)
    }
  }
  return reconciled
}

/**
 * Moves `id` one step within its own band (pinned ids and unpinned ids are
 * separate bands, per `bandOf`), leaving the other band's members at their
 * exact absolute positions. Swapping with the literal next array slot would
 * silently do nothing whenever that slot belongs to the other band, since
 * `applyPinned` always floats the pinned band to the front regardless of
 * where its members sit in `order`, only a same-band swap is ever visible.
 * Returns `order` unchanged (a new array, same contents) when `id` is
 * missing or already at the edge of its band in that direction.
 */
export function moveWithinBand(
  order: readonly string[],
  id: string,
  direction: -1 | 1,
  bandOf: (id: string) => boolean,
): string[] {
  const index = order.indexOf(id)
  if (index === -1) return [...order]
  const sameBand = bandOf(id)
  let neighbor = index + direction
  while (neighbor >= 0 && neighbor < order.length && bandOf(order[neighbor]) !== sameBand) {
    neighbor += direction
  }
  if (neighbor < 0 || neighbor >= order.length) return [...order]
  const next = [...order]
  const moved = next[index]
  next[index] = next[neighbor]
  next[neighbor] = moved
  return next
}

export interface BandPosition {
  isFirstInBand: boolean
  isLastInBand: boolean
}

/**
 * For each item in a pinned-first display order, says whether it is at the
 * start or end of its own band (pinned or unpinned). Used to disable a
 * "move up"/"move down" action exactly when it would be a no-op, rather than
 * a click that silently does nothing.
 */
export function bandPositions<T>(
  items: readonly T[],
  getId: (item: T) => string,
  pinnedIds: readonly string[] | undefined,
): Map<string, BandPosition> {
  const pinnedSet = new Set(pinnedIds ?? [])
  const pinnedCount = items.reduce((count, item) => count + (pinnedSet.has(getId(item)) ? 1 : 0), 0)
  const unpinnedCount = items.length - pinnedCount
  const positions = new Map<string, BandPosition>()
  let pinnedSeen = 0
  let unpinnedSeen = 0
  for (const item of items) {
    const id = getId(item)
    if (pinnedSet.has(id)) {
      positions.set(id, { isFirstInBand: pinnedSeen === 0, isLastInBand: pinnedSeen === pinnedCount - 1 })
      pinnedSeen += 1
    } else {
      positions.set(id, { isFirstInBand: unpinnedSeen === 0, isLastInBand: unpinnedSeen === unpinnedCount - 1 })
      unpinnedSeen += 1
    }
  }
  return positions
}

/**
 * A collapsed-group key's effective state is its stored membership XORed
 * with its default: most groups default expanded (so a first appearance in
 * `collapsedGroups` means collapsed), but a group whose whole purpose is to
 * stay out of the way by default (the hidden-rooms tray) needs the opposite
 * default without a separate storage shape.
 */
export function isGroupCollapsed(
  collapsedGroups: readonly string[],
  groupKey: string,
  defaultCollapsed = false,
): boolean {
  const toggled = collapsedGroups.includes(groupKey)
  return defaultCollapsed ? !toggled : toggled
}

export function voiceGroupKey(communityId: string): string {
  return `community:${communityId}:voice`
}

export function hiddenGroupKey(communityId: string): string {
  return `community:${communityId}:hidden`
}

export function textOrderScopeKey(communityId: string): string {
  return `community:${communityId}:text`
}

export function voiceOrderScopeKey(communityId: string): string {
  return `community:${communityId}:voice`
}

export const RAIL_ORDER_SCOPE_KEY = 'rail'
