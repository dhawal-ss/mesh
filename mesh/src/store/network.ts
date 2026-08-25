import { create } from 'zustand'
import type { NetworkState, ConnectionState } from '../types/ipc'
import { registerAccountReset } from '../lib/account-reset-registry'

/**
 * How this device stands with the Matrix account service.
 *
 * `ConnectionState` alone cannot carry this. It has one `disconnected` value,
 * and the three ways a Matrix session stops delivering messages need three
 * different sentences and three different recovery paths:
 *
 * - `reconnecting`: the session is signed in and the client's own sync loop is
 *   retrying on a backoff. Nothing is required of the person.
 * - `unreachable`: Mesh could not even read its own connection state, so the
 *   automatic retry may be sitting far out on the poll backoff. A manual check
 *   is worth something here.
 * - `signed-out`: the session is gone. No amount of waiting brings it back.
 */
export type MatrixLinkPhase = 'online' | 'reconnecting' | 'unreachable' | 'signed-out'

export interface MatrixLinkStatus {
  phase: MatrixLinkPhase
  /**
   * When this phase was first observed. Not read by the shell band, which does
   * its own damping against its own clock, but it is the only record of how
   * long a connection has been in this state and belongs with the phase.
   */
  since: number
}

interface NetworkStore {
  status: NetworkState
  /**
   * `null` while the Matrix backend has published nothing: at first paint, on
   * the legacy local backend, and after an account transition. Surfaces that
   * warn about the connection must stay silent rather than guess.
   */
  matrixLink: MatrixLinkStatus | null
  recoveredConnection: { durationMs: number; recoveredAt: number } | null
  setStatus: (status: Partial<NetworkState>) => void
  setMatrixLink: (phase: MatrixLinkPhase) => void
}

/**
 * The single mapping from a Matrix backend status to a link phase.
 *
 * It lives in the store rather than in `App.tsx` because both the status poll
 * that publishes it and the shell band that offers a manual reconnect have to
 * read the same status the same way. A second copy of this in the shell would
 * drift and flap the band.
 */
export function matrixLinkPhaseFor(
  status: { authenticated: boolean; syncRunning: boolean },
): MatrixLinkPhase {
  if (!status.authenticated) return 'signed-out'
  return status.syncRunning ? 'online' : 'reconnecting'
}

let disconnectedAt: number | null = null
let recoveredStatusTimer: ReturnType<typeof setTimeout> | null = null

const CONNECTING_STATUS: NetworkState = {
  state: 'connecting' as ConnectionState,
  peerCount: 0,
  averageLatency: 0,
}

export const useNetworkStore = create<NetworkStore>((set, get) => ({
  status: CONNECTING_STATUS,
  matrixLink: null,
  recoveredConnection: null,
  /*
   * Deliberately a no-op when the phase has not moved. The backend status poll
   * runs twelve times a minute; writing an equal-but-new object every tick
   * would re-render every subscriber and would keep resetting `since` for a
   * phase that never actually moved.
   */
  setMatrixLink: (phase) => {
    if (get().matrixLink?.phase === phase) return
    set({ matrixLink: { phase, since: Date.now() } })
  },
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

/**
 * Reset both observable and module-scoped recovery state at an account boundary.
 * A direct Zustand reset is insufficient because a prior account may still own
 * the disconnect timestamp or the timer that clears the recovered banner.
 */
export function resetNetworkStateForAccountTransition(): void {
  disconnectedAt = null
  if (recoveredStatusTimer) clearTimeout(recoveredStatusTimer)
  recoveredStatusTimer = null
  useNetworkStore.setState({
    status: CONNECTING_STATUS,
    matrixLink: null,
    recoveredConnection: null,
  })
}

export function resetNetworkRecoveryForTest(): void {
  resetNetworkStateForAccountTransition()
}

registerAccountReset('network', () => {
  resetNetworkStateForAccountTransition()
})
