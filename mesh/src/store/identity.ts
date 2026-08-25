import { create } from 'zustand'
import type { Identity } from '../types/ipc'
import { registerAccountReset } from '../lib/account-reset-registry'

interface IdentityStore {
  identity: Identity | null
  isLoading: boolean
  setIdentity: (identity: Identity) => void
  setLoading: (loading: boolean) => void
  clear: () => void
}

export const useIdentityStore = create<IdentityStore>((set) => ({
  identity: null,
  isLoading: true,
  setIdentity: (identity) => set({ identity, isLoading: false }),
  setLoading: (isLoading) => set({ isLoading }),
  clear: () => set({ identity: null, isLoading: false }),
}))

registerAccountReset('identity', () => {
  // Was a caller-side clear in App.tsx, one of the four different mechanisms
  // that made "which stores get reset?" a question you had to answer by
  // reading four places. The sweep owns it now; the sign-out path no longer
  // has to remember.
  useIdentityStore.getState().clear()
})
