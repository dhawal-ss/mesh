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

function persistNavigation(state: MeshNavigationSnapshot): void {
  safeLocalStorageSet(
    meshNavigationStorageKey(state.accountId),
    serializeMeshNavigation(state),
  )
}

export const useMeshNavigationStore = create<MeshNavigationStore>()((set, get) => ({
  ...initial,
  hydrated: false,
  drawer: 'none',
  focusRequest: 0,
  initialize: (accountId) => {
    if (get().hydrated && get().accountId === accountId) return
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
