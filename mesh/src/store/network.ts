import { create } from 'zustand'
import type { NetworkState, ConnectionState } from '../types/ipc'

interface NetworkStore {
  status: NetworkState
  setStatus: (status: Partial<NetworkState>) => void
}

export const useNetworkStore = create<NetworkStore>((set) => ({
  status: {
    state: 'connecting' as ConnectionState,
    peerCount: 0,
    averageLatency: 0,
  },
  setStatus: (update) =>
    set((store) => ({
      status: { ...store.status, ...update },
    })),
}))
