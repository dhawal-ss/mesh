import { create } from 'zustand'
import type { MatrixThreadListDto, ThreadListItemDto } from '../types/ipc'
import * as bridge from '../lib/bridge'
import { calloutsFirst } from '../lib/attention-ranking'
import { registerAccountReset } from '../lib/account-reset-registry'

interface ThreadListSnapshot {
  roomId: string | null
  items: ThreadListItemDto[]
  hasMore: boolean
  loading: boolean
  loadFailed: boolean
}

interface ThreadListStore extends ThreadListSnapshot {
  load: (roomId: string) => Promise<void>
  clear: () => void
}

const EMPTY_SNAPSHOT: ThreadListSnapshot = {
  roomId: null,
  items: [],
  hasMore: false,
  loading: false,
  loadFailed: false,
}

let requestGeneration = 0

const NEVER_MUTED = () => false

/** Mentions float; every other thread keeps the server's own order. */
export function orderThreadList(
  items: readonly ThreadListItemDto[],
): ThreadListItemDto[] {
  return calloutsFirst(items, NEVER_MUTED)
}

function fromWire(roomId: string, snapshot: MatrixThreadListDto): ThreadListSnapshot {
  return {
    roomId,
    items: orderThreadList(snapshot.items),
    hasMore: snapshot.hasMore,
    loading: false,
    loadFailed: false,
  }
}

export const useThreadListStore = create<ThreadListStore>((set, get) => ({
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
      const snapshot = await bridge.matrixThreadList(roomId)
      if (generation !== requestGeneration || get().roomId !== roomId) return
      set(fromWire(roomId, snapshot))
    } catch {
      if (generation !== requestGeneration || get().roomId !== roomId) return
      set({ loading: false, loadFailed: true })
    }
  },

  clear: () => {
    requestGeneration += 1
    set(EMPTY_SNAPSHOT)
  },
}))

registerAccountReset('threads', () => {
  // The thread list keys itself by room, and `load` keeps the existing snapshot
  // when the room matches. Two accounts in the same room is ordinary in Matrix,
  // so without this the previous account's threads stay on screen until a
  // refetch lands. `clear` also bumps the request generation, which drops a
  // response already in flight for the account that just went away.
  useThreadListStore.getState().clear()
})
