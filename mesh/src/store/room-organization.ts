import { create } from 'zustand'
import {
  emptyRoomOrganization,
  moveWithinBand,
  reconcileOrder,
  restoreRoomOrganization,
  roomOrganizationStorageKey,
  serializeRoomOrganization,
  type RoomOrganizationSnapshot,
} from '../lib/room-organization'
import {
  safeLocalStorageGet,
  safeLocalStorageRemove,
  safeLocalStorageSet,
} from '../lib/safe-storage'
import { registerAccountReset } from '../lib/account-reset-registry'

interface RoomOrganizationStore extends RoomOrganizationSnapshot {
  hydrated: boolean
  initialize: (accountId: string) => void
  pin: (scopeKey: string, id: string) => void
  unpin: (scopeKey: string, id: string) => void
  move: (scopeKey: string, id: string, direction: -1 | 1, currentIds: string[]) => void
  hide: (id: string) => void
  unhide: (id: string) => void
  toggleGroupCollapsed: (groupKey: string) => void
  restoreDefaults: () => void
  resetForAccountTransition: (removedAccountId?: string | null) => void
}

const initial = emptyRoomOrganization('local-device')

function write(state: RoomOrganizationSnapshot): void {
  safeLocalStorageSet(roomOrganizationStorageKey(state.accountId), serializeRoomOrganization(state))
}

export const useRoomOrganizationStore = create<RoomOrganizationStore>()((set, get) => ({
  ...initial,
  hydrated: false,

  initialize: (accountId) => {
    if (get().hydrated && get().accountId === accountId) return
    const restored = restoreRoomOrganization(
      safeLocalStorageGet(roomOrganizationStorageKey(accountId)),
      accountId,
    )
    set({ ...restored, hydrated: true })
  },

  pin: (scopeKey, id) => {
    const state = get()
    const current = state.pinned[scopeKey] ?? []
    if (current.includes(id)) return
    const pinned = { ...state.pinned, [scopeKey]: [...current, id] }
    write({ ...state, pinned })
    set({ pinned })
  },

  unpin: (scopeKey, id) => {
    const state = get()
    const current = state.pinned[scopeKey] ?? []
    if (!current.includes(id)) return
    const pinned = { ...state.pinned, [scopeKey]: current.filter((existing) => existing !== id) }
    write({ ...state, pinned })
    set({ pinned })
  },

  move: (scopeKey, id, direction, currentIds) => {
    const state = get()
    const savedOrder = state.order[scopeKey] ?? []
    const hiddenSet = new Set(state.hidden)
    // `currentIds` comes from the rendered list, which excludes hidden rooms.
    // Hidden is not "left the community": keep any id already in the saved
    // order that's merely hidden, or reconciling would drop it, and it would
    // reappend at the end (forgetting its position) the next time it's unhidden.
    const preservedIds = [...currentIds, ...savedOrder.filter((existingId) => hiddenSet.has(existingId))]
    const reconciled = reconcileOrder(savedOrder, preservedIds)
    const pinnedSet = new Set(state.pinned[scopeKey] ?? [])
    const next = moveWithinBand(reconciled, id, direction, (entryId) => pinnedSet.has(entryId))
    const order = { ...state.order, [scopeKey]: next }
    write({ ...state, order })
    set({ order })
  },

  hide: (id) => {
    const state = get()
    if (state.hidden.includes(id)) return
    const hidden = [...state.hidden, id]
    write({ ...state, hidden })
    set({ hidden })
  },

  unhide: (id) => {
    const state = get()
    if (!state.hidden.includes(id)) return
    const hidden = state.hidden.filter((existing) => existing !== id)
    write({ ...state, hidden })
    set({ hidden })
  },

  toggleGroupCollapsed: (groupKey) => {
    const state = get()
    const collapsedGroups = state.collapsedGroups.includes(groupKey)
      ? state.collapsedGroups.filter((existing) => existing !== groupKey)
      : [...state.collapsedGroups, groupKey]
    write({ ...state, collapsedGroups })
    set({ collapsedGroups })
  },

  /** Returns every scope to server order: no pins, no manual order, nothing hidden, nothing collapsed. */
  restoreDefaults: () => {
    const state = get()
    const next = emptyRoomOrganization(state.accountId)
    write(next)
    set(next)
  },

  resetForAccountTransition: (removedAccountId) => {
    if (removedAccountId) {
      safeLocalStorageRemove(roomOrganizationStorageKey(removedAccountId))
    }
    set({ ...emptyRoomOrganization('local-device'), hydrated: false })
  },
}))

registerAccountReset('room-organization', (removedAccountId) => {
  useRoomOrganizationStore.getState().resetForAccountTransition(removedAccountId)
})
