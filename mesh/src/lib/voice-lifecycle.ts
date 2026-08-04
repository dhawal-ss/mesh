import type { VoiceConnectionState } from '../types/ipc'

export const VOICE_RECONNECT_GRACE_MS = 750
export const VOICE_FAILURE_THRESHOLD_MS = 12_000

export type VoiceLifecycleState =
  | 'idle'
  | 'unavailable'
  | 'requesting'
  | 'connected'
  | 'reconnect-grace'
  | 'reconnecting'
  | 'failed'
  | 'leaving'

export interface VoiceLifecycleInput {
  hasOwnedSession: boolean
  capabilityAvailable: boolean
  connectionState: VoiceConnectionState
  stateElapsedMs: number
  leaving?: boolean
}

export function resolveVoiceLifecycle({
  hasOwnedSession,
  capabilityAvailable,
  connectionState,
  stateElapsedMs,
  leaving = false,
}: VoiceLifecycleInput): VoiceLifecycleState {
  if (leaving) return 'leaving'
  if (!hasOwnedSession) return 'idle'
  if (!capabilityAvailable) return 'unavailable'

  switch (connectionState) {
    case 'connected':
    case 'degraded':
      return 'connected'
    case 'reconnecting':
      if (stateElapsedMs < VOICE_RECONNECT_GRACE_MS) return 'reconnect-grace'
      return stateElapsedMs >= VOICE_FAILURE_THRESHOLD_MS ? 'failed' : 'reconnecting'
    case 'disconnected':
      return 'failed'
    case 'connecting':
    case 'idle':
      return stateElapsedMs >= VOICE_FAILURE_THRESHOLD_MS ? 'failed' : 'requesting'
  }
}
