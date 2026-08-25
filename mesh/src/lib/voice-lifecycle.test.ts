import { describe, expect, it } from 'vitest'
import {
  resolveVoiceLifecycle,
  VOICE_FAILURE_THRESHOLD_MS,
  VOICE_RECONNECT_GRACE_MS,
} from './voice-lifecycle'

const base = {
  hasOwnedSession: true,
  capabilityAvailable: true,
  connectionState: 'connecting' as const,
  stateElapsedMs: 0,
}

describe('voice lifecycle presentation', () => {
  it('fails closed before considering transport state', () => {
    expect(resolveVoiceLifecycle({ ...base, capabilityAvailable: false })).toBe('unavailable')
    expect(resolveVoiceLifecycle({ ...base, hasOwnedSession: false })).toBe('idle')
  })

  it('bounds join and reconnect states without repeated automatic retries', () => {
    expect(resolveVoiceLifecycle(base)).toBe('requesting')
    expect(resolveVoiceLifecycle({ ...base, stateElapsedMs: VOICE_FAILURE_THRESHOLD_MS })).toBe('failed')
    expect(resolveVoiceLifecycle({
      ...base,
      connectionState: 'reconnecting',
      stateElapsedMs: VOICE_RECONNECT_GRACE_MS - 1,
    })).toBe('reconnect-grace')
    expect(resolveVoiceLifecycle({
      ...base,
      connectionState: 'reconnecting',
      stateElapsedMs: VOICE_RECONNECT_GRACE_MS,
    })).toBe('reconnecting')
    expect(resolveVoiceLifecycle({
      ...base,
      connectionState: 'reconnecting',
      stateElapsedMs: VOICE_FAILURE_THRESHOLD_MS,
    })).toBe('failed')
  })

  it('keeps local teardown explicit and treats degraded media as connected', () => {
    expect(resolveVoiceLifecycle({ ...base, leaving: true })).toBe('leaving')
    expect(resolveVoiceLifecycle({ ...base, connectionState: 'degraded' })).toBe('connected')
  })
})
