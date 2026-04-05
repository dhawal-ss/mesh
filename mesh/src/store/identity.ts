import { create } from 'zustand'
import type { Identity } from '../types/ipc'

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
