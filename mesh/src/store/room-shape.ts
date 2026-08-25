import { create } from 'zustand'
import {
  emptyRoomShapes,
  restoreRoomShapes,
  roomShapeStorageKey,
  serializeRoomShapes,
  type RoomShape,
  type RoomShapesSnapshot,
} from '../lib/room-shape'
import {
  safeLocalStorageGet,
  safeLocalStorageRemove,
  safeLocalStorageSet,
} from '../lib/safe-storage'
import { registerAccountReset } from '../lib/account-reset-registry'

/**
 * Which surface each room is read on.
 *
 * Deliberately its own store rather than a field on the channel entity:
 * `mergeChannel` replaces an entity wholesale whenever any wire field differs,
 * so a renderer-only shape parked there would be erased by the next unread
 * tick. Modelled on `room-organization`, which solved the same problem for pin
 * and hide.
 */
interface RoomShapeStore extends RoomShapesSnapshot {
  hydrated: boolean
  initialize: (accountId: string) => void
  shapeFor: (roomId: string) => RoomShape
  setShape: (roomId: string, shape: RoomShape) => void
  resetForAccountTransition: (removedAccountId?: string | null) => void
}

function write(state: RoomShapesSnapshot): void {
  safeLocalStorageSet(roomShapeStorageKey(state.accountId), serializeRoomShapes(state))
}

export const useRoomShapeStore = create<RoomShapeStore>()((set, get) => ({
  ...emptyRoomShapes('local-device'),
  hydrated: false,

  initialize: (accountId) => {
    if (get().hydrated && get().accountId === accountId) return
    const restored = restoreRoomShapes(
      safeLocalStorageGet(roomShapeStorageKey(accountId)),
      accountId,
    )
    set({ ...restored, hydrated: true })
  },

  shapeFor: (roomId) => get().shapes[roomId] ?? 'conversation',

  setShape: (roomId, shape) => {
    const { shapes, ...rest } = get()
    const next = { ...shapes }
    // Conversation is the default, so it is recorded by absence. A room put
    // back never leaves a row behind to be migrated later.
    if (shape === 'conversation') delete next[roomId]
    else next[roomId] = shape
    const snapshot: RoomShapesSnapshot = {
      schemaVersion: rest.schemaVersion,
      accountId: rest.accountId,
      shapes: next,
    }
    set({ shapes: next })
    write(snapshot)
  },

  resetForAccountTransition: (removedAccountId) => {
    const { accountId } = get()
    if (removedAccountId) safeLocalStorageRemove(roomShapeStorageKey(removedAccountId))
    if (!removedAccountId || removedAccountId === accountId) {
      set({ ...emptyRoomShapes('local-device'), hydrated: false })
    }
  },
}))

registerAccountReset('room-shape', (removedAccountId) => {
  useRoomShapeStore.getState().resetForAccountTransition(removedAccountId)
})
