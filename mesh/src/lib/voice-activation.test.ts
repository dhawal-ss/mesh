import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  beginVoiceActivation,
  clearVoiceActivation,
  recordVoiceAudible,
  resetVoiceActivationForTest,
  VOICE_ACTIVATION_EVENT,
} from './voice-activation'

describe('voice activation timing', () => {
  beforeEach(resetVoiceActivationForTest)
  afterEach(resetVoiceActivationForTest)

  it('measures actual audible playback without exposing the session key', () => {
    const listener = vi.fn()
    window.addEventListener(VOICE_ACTIVATION_EVENT, listener)
    beginVoiceActivation('!party:mesh.test', 1_000)

    expect(recordVoiceAudible('!party:mesh.test', 1_480)).toEqual({
      segment: 'click-to-audible',
      durationMs: 480,
    })
    const event = listener.mock.calls[0]?.[0] as CustomEvent
    expect(event.detail).toEqual({ segment: 'click-to-audible', durationMs: 480 })
    expect(JSON.stringify(event.detail)).not.toContain('!party:mesh.test')
    window.removeEventListener(VOICE_ACTIVATION_EVENT, listener)
  })

  it('emits only once for one requested session', () => {
    const listener = vi.fn()
    window.addEventListener(VOICE_ACTIVATION_EVENT, listener)
    beginVoiceActivation('party-one', 500)

    expect(recordVoiceAudible('party-one', 700)).not.toBeNull()
    expect(recordVoiceAudible('party-one', 900)).toBeNull()
    expect(listener).toHaveBeenCalledOnce()
    window.removeEventListener(VOICE_ACTIVATION_EVENT, listener)
  })

  it('ignores stale, invalid, and cleared timelines', () => {
    beginVoiceActivation('party-two', 2_000)
    expect(recordVoiceAudible('party-one', 2_200)).toBeNull()
    expect(recordVoiceAudible('party-two', 1_900)).toBeNull()
    clearVoiceActivation('party-one')
    expect(recordVoiceAudible('party-two', 2_200)).not.toBeNull()

    beginVoiceActivation('bad\nkey', 3_000)
    expect(recordVoiceAudible('bad\nkey', 3_200)).toBeNull()
  })
})
