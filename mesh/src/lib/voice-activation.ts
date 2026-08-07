export const VOICE_ACTIVATION_EVENT = 'mesh:voice-activation-timing'

export interface VoiceActivationMeasurement {
  segment: 'click-to-audible'
  durationMs: number
}

interface VoiceActivationTimeline {
  sessionKey: string
  requestedAt: number
  audibleAt: number | null
}

const MAX_SESSION_KEY_LENGTH = 256
let activeTimeline: VoiceActivationTimeline | null = null

function validSessionKey(value: string): boolean {
  return value.length > 0
    && value.length <= MAX_SESSION_KEY_LENGTH
    && !/[\u0000-\u001f\u007f]/.test(value)
}

function validTimestamp(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0
}

export function beginVoiceActivation(
  sessionKey: string,
  requestedAt = Date.now(),
): void {
  if (!validSessionKey(sessionKey) || !validTimestamp(requestedAt)) return
  activeTimeline = {
    sessionKey,
    requestedAt,
    audibleAt: null,
  }
}

export function recordVoiceAudible(
  sessionKey: string,
  audibleAt = Date.now(),
): VoiceActivationMeasurement | null {
  const timeline = activeTimeline
  if (
    !timeline
    || timeline.sessionKey !== sessionKey
    || timeline.audibleAt !== null
    || !validTimestamp(audibleAt)
    || audibleAt < timeline.requestedAt
  ) return null

  timeline.audibleAt = audibleAt
  const measurement: VoiceActivationMeasurement = {
    segment: 'click-to-audible',
    durationMs: audibleAt - timeline.requestedAt,
  }
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(VOICE_ACTIVATION_EVENT, {
      detail: measurement,
    }))
  }
  return measurement
}

export function clearVoiceActivation(sessionKey?: string): void {
  if (!activeTimeline) return
  if (sessionKey && activeTimeline.sessionKey !== sessionKey) return
  activeTimeline = null
}

export function resetVoiceActivationForTest(): void {
  activeTimeline = null
}
