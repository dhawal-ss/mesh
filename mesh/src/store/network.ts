import { create } from 'zustand'
import type { NetworkState, ConnectionState } from '../types/ipc'
import { playInterfaceSound } from '../lib/interface-sounds'

interface NetworkStore {
  status: NetworkState
  recoveredConnection: { durationMs: number; recoveredAt: number } | null
  setStatus: (status: Partial<NetworkState>) => void
}

let disconnectedAt: number | null = null
let recoveredStatusTimer: ReturnType<typeof setTimeout> | null = null

export const useNetworkStore = create<NetworkStore>((set, get) => ({
  status: {
    state: 'connecting' as ConnectionState,
    peerCount: 0,
    averageLatency: 0,
  },
  recoveredConnection: null,
  setStatus: (update) => {
    const previous = get().status
    const next = { ...previous, ...update }
    if (next.state === 'disconnected' && previous.state !== 'disconnected') {
      disconnectedAt = Date.now()
    }

    let recoveredConnection = get().recoveredConnection
    if (next.state === 'connected' && previous.state === 'disconnected' && disconnectedAt != null) {
      const durationMs = Date.now() - disconnectedAt
      disconnectedAt = null
      if (durationMs >= 3_000) {
        recoveredConnection = { durationMs, recoveredAt: Date.now() }
        void playInterfaceSound('connection-recovered', { disruptionDurationMs: durationMs })
        if (recoveredStatusTimer) clearTimeout(recoveredStatusTimer)
        recoveredStatusTimer = setTimeout(() => {
          recoveredStatusTimer = null
          set({ recoveredConnection: null })
        }, 4_000)
      }
    }

    set({ status: next, recoveredConnection })
  },
}))

export function resetNetworkRecoveryForTest(): void {
  disconnectedAt = null
  if (recoveredStatusTimer) clearTimeout(recoveredStatusTimer)
  recoveredStatusTimer = null
  useNetworkStore.setState({ recoveredConnection: null })
}
