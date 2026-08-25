import { create } from 'zustand'
import {
  closeMeshPane,
  currentMeshRoute,
  emptyMeshNavigation,
  meshNavigationStorageKey,
  moveMeshHistory,
  navigateMesh,
  restoreMeshNavigation,
  serializeMeshNavigation,
  type MeshNavigationSnapshot,
  type MeshRoute,
} from '../lib/mesh-navigation'
import {
  safeLocalStorageGet,
  safeLocalStorageRemove,
  safeLocalStorageSet,
} from '../lib/safe-storage'
import { registerAccountReset } from '../lib/account-reset-registry'

export type MeshDrawer = 'none' | 'context' | 'secondary'

interface MeshNavigationStore extends MeshNavigationSnapshot {
  hydrated: boolean
  drawer: MeshDrawer
  focusRequest: number
  initialize: (accountId: string) => void
  navigate: (route: MeshRoute, options?: { replace?: boolean; focus?: boolean }) => void
  back: () => void
  forward: () => void
  closePane: () => void
  setDrawer: (drawer: MeshDrawer) => void
  resetForAccountTransition: (removedAccountId?: string | null) => void
  clearAccount: () => void
}

const initial = emptyMeshNavigation('local-device')

/**
 * Trailing window for the navigation write.
 *
 * Serializing history and writing localStorage inside `navigate` put a
 * blocking main-thread JSON serialize plus a storage write on the interaction
 * frame of every room switch and thread open. The write is coalesced into a
 * trailing timer instead; the timer is not restarted by later navigations, so
 * a burst still lands within one window rather than being starved.
 */
const NAVIGATION_PERSIST_DELAY_MS = 250

let pendingNavigation: MeshNavigationSnapshot | null = null
let navigationPersistTimer: ReturnType<typeof setTimeout> | null = null

function writeNavigation(snapshot: MeshNavigationSnapshot): void {
  safeLocalStorageSet(
    meshNavigationStorageKey(snapshot.accountId),
    serializeMeshNavigation(snapshot),
  )
}

/** Write any queued snapshot now. Safe to call when nothing is queued. */
function flushNavigationPersist(): void {
  if (navigationPersistTimer) {
    clearTimeout(navigationPersistTimer)
    navigationPersistTimer = null
  }
  const snapshot = pendingNavigation
  pendingNavigation = null
  if (snapshot) writeNavigation(snapshot)
}

/** Drop a queued snapshot so it cannot resurrect a key we are about to remove. */
function cancelNavigationPersist(): void {
  if (navigationPersistTimer) {
    clearTimeout(navigationPersistTimer)
    navigationPersistTimer = null
  }
  pendingNavigation = null
}

function persistNavigation(state: MeshNavigationSnapshot): void {
  pendingNavigation = state
  if (navigationPersistTimer) return
  navigationPersistTimer = setTimeout(() => {
    navigationPersistTimer = null
    const snapshot = pendingNavigation
    pendingNavigation = null
    if (snapshot) writeNavigation(snapshot)
  }, NAVIGATION_PERSIST_DELAY_MS)
}

// A quit or a hidden window must not lose the last hop of history.
if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', flushNavigationPersist)
}
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushNavigationPersist()
  })
}

export const useMeshNavigationStore = create<MeshNavigationStore>()((set, get) => ({
  ...initial,
  hydrated: false,
  drawer: 'none',
  focusRequest: 0,
  initialize: (accountId) => {
    if (get().hydrated && get().accountId === accountId) return
    // Land any queued write before reading storage back, so a fast account
    // switch never restores a snapshot older than the one still in the queue.
    flushNavigationPersist()
    const restored = restoreMeshNavigation(
      safeLocalStorageGet(meshNavigationStorageKey(accountId)),
      accountId,
    )
    set({ ...restored, hydrated: true, drawer: 'none' })
  },
  navigate: (route, options = {}) => {
    const current = get()
    const next = navigateMesh(current, route, { replace: options.replace })
    if (next === current) {
      if (current.drawer !== 'none') set({ drawer: 'none' })
      return
    }
    persistNavigation(next)
    set({
      ...next,
      drawer: 'none',
      focusRequest: options.focus === false ? current.focusRequest : current.focusRequest + 1,
    })
  },
  back: () => {
    const current = get()
    const next = moveMeshHistory(current, -1)
    if (next === current) return
    persistNavigation(next)
    set({ ...next, drawer: 'none', focusRequest: current.focusRequest + 1 })
  },
  forward: () => {
    const current = get()
    const next = moveMeshHistory(current, 1)
    if (next === current) return
    persistNavigation(next)
    set({ ...next, drawer: 'none', focusRequest: current.focusRequest + 1 })
  },
  closePane: () => {
    const current = get()
    const next = closeMeshPane(current)
    if (next === current) return
    persistNavigation(next)
    set({ ...next, drawer: 'none', focusRequest: current.focusRequest + 1 })
  },
  setDrawer: (drawer) => set({ drawer }),
  resetForAccountTransition: (removedAccountId) => {
    const current = get()
    cancelNavigationPersist()
    if (removedAccountId) {
      safeLocalStorageRemove(meshNavigationStorageKey(removedAccountId))
    }
    set({
      ...emptyMeshNavigation('local-device'),
      hydrated: false,
      drawer: 'none',
      focusRequest: current.focusRequest + 1,
    })
  },
  clearAccount: () => {
    get().resetForAccountTransition(get().accountId)
  },
}))

export function useCurrentMeshRoute(): MeshRoute {
  return useMeshNavigationStore(currentMeshRoute)
}

registerAccountReset('navigation', (removedAccountId) => {
  useMeshNavigationStore.getState().resetForAccountTransition(removedAccountId)
})
