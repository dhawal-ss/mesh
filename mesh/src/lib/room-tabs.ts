export const MAX_OPEN_ROOM_TABS = 12
export const MAX_RECENTLY_CLOSED_ROOM_TABS = 5

export type RoomTabKind = 'room' | 'dm'

export interface RoomTab {
  key: string
  kind: RoomTabKind
  roomId: string
  communityId: string | null
  title: string
  pinned: boolean
  unreadCount: number
  mentionCount: number
  lastOpenedAt: number
}

export interface RoomTabState {
  schemaVersion: 1
  accountId: string
  tabs: RoomTab[]
  activeKey: string | null
  recentlyClosed: RoomTab[]
}

export function roomTabKey(kind: RoomTabKind, roomId: string): string {
  return `${kind}:${roomId}`
}

export function emptyRoomTabState(accountId: string): RoomTabState {
  return {
    schemaVersion: 1,
    accountId,
    tabs: [],
    activeKey: null,
    recentlyClosed: [],
  }
}

function normalizeCount(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.min(9999, Math.trunc(value)))
}

function normalizeTab(tab: RoomTab): RoomTab {
  return {
    ...tab,
    key: roomTabKey(tab.kind, tab.roomId),
    title: tab.title.trim().slice(0, 100) || (tab.kind === 'dm' ? 'Direct message' : 'Room'),
    unreadCount: normalizeCount(tab.unreadCount),
    mentionCount: normalizeCount(tab.mentionCount),
    lastOpenedAt: Number.isFinite(tab.lastOpenedAt) ? tab.lastOpenedAt : 0,
  }
}

export function openRoomTab(
  state: RoomTabState,
  incoming: RoomTab,
): RoomTabState {
  const tab = normalizeTab(incoming)
  const existingIndex = state.tabs.findIndex((candidate) => candidate.key === tab.key)
  if (existingIndex >= 0) {
    const tabs = [...state.tabs]
    tabs[existingIndex] = {
      ...tab,
      pinned: tabs[existingIndex].pinned || tab.pinned,
    }
    return { ...state, tabs, activeKey: tab.key }
  }

  let tabs = [...state.tabs]
  if (tabs.length >= MAX_OPEN_ROOM_TABS) {
    const removable = tabs
      .map((candidate, index) => ({ candidate, index }))
      .filter(({ candidate }) => !candidate.pinned && candidate.key !== state.activeKey)
      .sort((left, right) => (
        left.candidate.lastOpenedAt - right.candidate.lastOpenedAt
        || left.index - right.index
      ))[0]
    if (!removable) return state
    tabs.splice(removable.index, 1)
  }
  tabs.push(tab)
  return { ...state, tabs, activeKey: tab.key }
}

export function activateRoomTab(state: RoomTabState, key: string, now = Date.now()): RoomTabState {
  if (!state.tabs.some((tab) => tab.key === key)) return state
  return {
    ...state,
    activeKey: key,
    tabs: state.tabs.map((tab) => (
      tab.key === key ? { ...tab, lastOpenedAt: now } : tab
    )),
  }
}

export function setRoomTabPinned(
  state: RoomTabState,
  key: string,
  pinned: boolean,
): RoomTabState {
  if (!state.tabs.some((tab) => tab.key === key)) return state
  return {
    ...state,
    tabs: state.tabs.map((tab) => (tab.key === key ? { ...tab, pinned } : tab)),
  }
}

export function reorderRoomTab(
  state: RoomTabState,
  key: string,
  offset: -1 | 1,
): RoomTabState {
  const index = state.tabs.findIndex((tab) => tab.key === key)
  const nextIndex = index + offset
  if (index < 0 || nextIndex < 0 || nextIndex >= state.tabs.length) return state
  const tabs = [...state.tabs]
  ;[tabs[index], tabs[nextIndex]] = [tabs[nextIndex], tabs[index]]
  return { ...state, tabs }
}

export function closeRoomTab(state: RoomTabState, key: string): RoomTabState {
  const index = state.tabs.findIndex((tab) => tab.key === key)
  if (index < 0) return state
  const closed = state.tabs[index]
  const tabs = state.tabs.filter((tab) => tab.key !== key)
  const activeKey = state.activeKey === key
    ? tabs[Math.min(index, tabs.length - 1)]?.key ?? null
    : state.activeKey
  return {
    ...state,
    tabs,
    activeKey,
    recentlyClosed: [
      closed,
      ...state.recentlyClosed.filter((tab) => tab.key !== key),
    ].slice(0, MAX_RECENTLY_CLOSED_ROOM_TABS),
  }
}

export function reopenRoomTab(state: RoomTabState, now = Date.now()): RoomTabState {
  const [closed, ...recentlyClosed] = state.recentlyClosed
  if (!closed) return state
  const reopened = openRoomTab(
    { ...state, recentlyClosed },
    { ...closed, lastOpenedAt: now },
  )
  return reopened === state ? state : { ...reopened, recentlyClosed }
}

export function activateRelativeRoomTab(
  state: RoomTabState,
  offset: -1 | 1,
  now = Date.now(),
): RoomTabState {
  if (state.tabs.length === 0) return state
  const index = state.tabs.findIndex((tab) => tab.key === state.activeKey)
  const start = index < 0 ? (offset === 1 ? -1 : 0) : index
  const nextIndex = (start + offset + state.tabs.length) % state.tabs.length
  return activateRoomTab(state, state.tabs[nextIndex].key, now)
}

export function roomTabStorageKey(accountId: string): string {
  return `mesh-room-tabs-v1:${encodeURIComponent(accountId)}`
}

export function findRestorableActiveRoomTab(
  state: RoomTabState,
  roomAvailable: (roomId: string) => boolean,
  dmAvailable: (conversationId: string) => boolean,
): RoomTab | null {
  const active = state.tabs.find((tab) => tab.key === state.activeKey)
  if (!active) return null
  return active.kind === 'dm'
    ? dmAvailable(active.roomId) ? active : null
    : roomAvailable(active.roomId) ? active : null
}

export function serializeRoomTabState(state: RoomTabState): string {
  return JSON.stringify(state)
}

export function restoreRoomTabState(serialized: string | null, accountId: string): RoomTabState {
  if (!serialized) return emptyRoomTabState(accountId)
  try {
    const value = JSON.parse(serialized) as Partial<RoomTabState>
    if (
      value.schemaVersion !== 1
      || value.accountId !== accountId
      || !Array.isArray(value.tabs)
      || !Array.isArray(value.recentlyClosed)
    ) {
      return emptyRoomTabState(accountId)
    }
    const tabs = value.tabs
      .filter(validRoomTab)
      .slice(0, MAX_OPEN_ROOM_TABS)
      .map(normalizeTab)
    const uniqueTabs = [...new Map(tabs.map((tab) => [tab.key, tab])).values()]
    const recentlyClosed = value.recentlyClosed
      .filter(validRoomTab)
      .slice(0, MAX_RECENTLY_CLOSED_ROOM_TABS)
      .map(normalizeTab)
    return {
      schemaVersion: 1,
      accountId,
      tabs: uniqueTabs,
      activeKey:
        typeof value.activeKey === 'string'
        && uniqueTabs.some((tab) => tab.key === value.activeKey)
          ? value.activeKey
          : uniqueTabs[0]?.key ?? null,
      recentlyClosed,
    }
  } catch {
    return emptyRoomTabState(accountId)
  }
}

function validRoomTab(value: unknown): value is RoomTab {
  if (!value || typeof value !== 'object') return false
  const tab = value as Partial<RoomTab>
  return (tab.kind === 'room' || tab.kind === 'dm')
    && typeof tab.roomId === 'string'
    && tab.roomId.length > 0
    && tab.roomId.length <= 255
    && (tab.communityId == null || typeof tab.communityId === 'string')
    && typeof tab.title === 'string'
    && typeof tab.pinned === 'boolean'
    && typeof tab.unreadCount === 'number'
    && typeof tab.mentionCount === 'number'
    && typeof tab.lastOpenedAt === 'number'
}
