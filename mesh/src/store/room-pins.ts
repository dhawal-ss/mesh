import { create } from 'zustand'
import type { MatrixRoomPins, Message } from '../types/ipc'
import * as bridge from '../lib/bridge'

interface RoomPinSnapshot {
  roomId: string | null
  eventIds: string[]
  messages: Message[]
  unavailableEventIds: string[]
  canManage: boolean
  loading: boolean
  loadFailed: boolean
}

interface RoomPinStore extends RoomPinSnapshot {
  load: (roomId: string) => Promise<void>
  toggle: (roomId: string, message: Message) => Promise<boolean>
  clear: () => void
}

const EMPTY_SNAPSHOT: RoomPinSnapshot = {
  roomId: null,
  eventIds: [],
  messages: [],
  unavailableEventIds: [],
  canManage: false,
  loading: false,
  loadFailed: false,
}

const MAX_PINNED_MESSAGES = 100
let requestGeneration = 0

function fromWire(snapshot: MatrixRoomPins): RoomPinSnapshot {
  const eventIds = [...new Set(snapshot.eventIds)].slice(0, MAX_PINNED_MESSAGES)
  const eventIdSet = new Set(eventIds)
  const seenMessages = new Set<string>()
  return {
    roomId: snapshot.roomId,
    eventIds,
    messages: snapshot.messages.filter((message) => {
      if (!eventIdSet.has(message.id) || seenMessages.has(message.id)) return false
      seenMessages.add(message.id)
      return true
    }),
    unavailableEventIds: [
      ...new Set(snapshot.unavailableEventIds.filter((eventId) => eventIdSet.has(eventId))),
    ],
    canManage: snapshot.canManage,
    loading: false,
    loadFailed: false,
  }
}

export const useRoomPinStore = create<RoomPinStore>((set, get) => ({
  ...EMPTY_SNAPSHOT,

  load: async (roomId) => {
    const generation = ++requestGeneration
    set((state) => ({
      ...(state.roomId === roomId ? state : EMPTY_SNAPSHOT),
      roomId,
      loading: true,
      loadFailed: false,
    }))

    try {
      const snapshot = await bridge.matrixRoomPins(roomId)
      if (generation !== requestGeneration || get().roomId !== roomId) return
      set(fromWire(snapshot))
    } catch {
      if (generation !== requestGeneration || get().roomId !== roomId) return
      set({ loading: false, loadFailed: true })
    }
  },

  toggle: async (roomId, message) => {
    const current = get()
    if (current.roomId !== roomId || !current.canManage) return false

    const generation = ++requestGeneration
    const wasPinned = current.eventIds.includes(message.id)
    const optimistic: RoomPinSnapshot = wasPinned
      ? {
          ...current,
          eventIds: current.eventIds.filter((eventId) => eventId !== message.id),
          messages: current.messages.filter((pinnedMessage) => pinnedMessage.id !== message.id),
          unavailableEventIds: current.unavailableEventIds.filter(
            (eventId) => eventId !== message.id,
          ),
          loading: false,
          loadFailed: false,
        }
      : {
          ...current,
          eventIds: [...current.eventIds, message.id],
          messages: [...current.messages, message],
          loading: false,
          loadFailed: false,
        }
    set(optimistic)

    try {
      const snapshot = await bridge.matrixToggleRoomPin(roomId, message.id)
      if (generation !== requestGeneration || get().roomId !== roomId) return true
      set(fromWire(snapshot))
      return true
    } catch {
      if (generation === requestGeneration && get().roomId === roomId) {
        set(current)
      }
      return false
    }
  },

  clear: () => {
    requestGeneration += 1
    set(EMPTY_SNAPSHOT)
  },
}))
