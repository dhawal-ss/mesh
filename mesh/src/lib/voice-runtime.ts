import type { BackendStatus } from './bridge'
import type { VoiceConnectionState } from '../types/ipc'
import type { VoiceLifecycleState } from './voice-lifecycle'

/**
 * The only condition under which Mesh may load the legacy SimplePeer engine.
 *
 * All four assertions are intentional. A partially upgraded or malformed
 * backend response must fail closed, especially when the selected backend is
 * Matrix.
 */
export function canStartLegacyVoice(status: BackendStatus | null): boolean {
  return Boolean(
    status &&
      status.kind === 'legacy-p2p' &&
      status.capabilities.voice &&
      status.voiceService.provider === 'legacy-simple-peer' &&
      status.voiceService.availability === 'ready',
  )
}

export function canStartMatrixVoice(status: BackendStatus | null): boolean {
  return Boolean(
    status &&
      status.kind === 'matrix' &&
      status.capabilities.voice &&
      status.voiceService.provider === 'matrix-rtc' &&
      status.voiceService.availability === 'ready' &&
      status.voiceService.mediaE2eeReady,
  )
}

export function isMatrixVoiceFrontendEnabled(): boolean {
  return typeof __MESH_MATRIX_VOICE_FRONTEND__ === 'undefined'
    ? import.meta.env.MODE === 'test'
    : __MESH_MATRIX_VOICE_FRONTEND__
}

/**
 * Voice destinations are part of the product only when the selected backend
 * can actually open them. The explicit argument keeps this boundary directly
 * testable while production callers use the compile-time frontend gate.
 */
export function shouldExposeVoiceRoutes(
  matrixMode: boolean,
  status: BackendStatus | null,
  matrixFrontendEnabled = isMatrixVoiceFrontendEnabled(),
): boolean {
  return !matrixMode || (matrixFrontendEnabled && canStartMatrixVoice(status))
}

/**
 * Distinguish "the user (or policy) blocked the microphone" from every other
 * device failure. `getUserMedia` reports this as NotAllowedError, and Chromium
 * additionally uses SecurityError when a permissions policy blocks it.
 */
export function isPermissionDeniedError(error: unknown): boolean {
  if (typeof DOMException !== 'undefined' && error instanceof DOMException) {
    return (
      error.name === 'NotAllowedError' ||
      error.name === 'PermissionDeniedError' ||
      error.name === 'SecurityError'
    )
  }
  if (error && typeof error === 'object' && 'name' in error) {
    const name = (error as { name?: unknown }).name
    return (
      name === 'NotAllowedError' ||
      name === 'PermissionDeniedError' ||
      name === 'SecurityError'
    )
  }
  return false
}

export function voiceMediaErrorMessage(
  error: unknown,
  kind: 'camera' | 'screen-share',
): string {
  if (isPermissionDeniedError(error)) {
    return kind === 'camera'
      ? 'Mesh cannot use your camera. Allow camera access in system settings.'
      : 'Screen sharing did not start. Allow screen access in system settings.'
  }
  return kind === 'camera'
    ? 'Mesh could not change your camera. Check it is connected and free.'
    : 'Mesh could not change screen sharing. Choose the window again.'
}

export const PRIVATE_VOICE_FAILURE_MESSAGE =
  'Private voice was stopped to keep this call secure. Try again.'

export function voiceConnectionUserMessage(reason: string | null | undefined): string | null {
  if (!reason) return null
  return /(?:matrixrtc|private media|media encryption|media key|activation metadata|publication lease|key distribution)/i.test(reason)
    ? PRIVATE_VOICE_FAILURE_MESSAGE
    : reason
}

export function voiceServiceUserMessage(
  availability: BackendStatus['voiceService']['availability'],
): string {
  switch (availability) {
    case 'not-configured':
      return 'Calling is not available for this account yet. You can keep using messages.'
    case 'invalid-configuration':
      return 'Calling needs attention from the account service. You can keep using messages.'
    case 'client-unavailable':
      return 'Calling is unavailable in this version of Mesh. You can keep using messages.'
    case 'ready':
      return 'Calling is unavailable right now. Try again.'
  }
}

const PUSH_TO_TALK_INTERACTIVE_SELECTOR = [
  'button',
  'a[href]',
  'input',
  'textarea',
  'select',
  'summary',
  'audio[controls]',
  'video[controls]',
  '[contenteditable]:not([contenteditable="false"])',
  '[role="button"]',
  '[role="checkbox"]',
  '[role="combobox"]',
  '[role="link"]',
  '[role="menuitem"]',
  '[role="option"]',
  '[role="radio"]',
  '[role="switch"]',
  '[role="slider"]',
  '[role="tab"]',
  '[role="textbox"]',
  '[tabindex]:not([tabindex="-1"])',
].join(',')

export function isPushToTalkInteractiveTarget(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(PUSH_TO_TALK_INTERACTIVE_SELECTOR) !== null
}

export function shouldReleasePushToTalk(code: string, keyboardActive: boolean): boolean {
  return code === 'Space' && keyboardActive
}

export function shouldActivateVoiceSession(
  matrixMode: boolean,
  matrixVoiceReady: boolean,
): boolean {
  return !matrixMode || matrixVoiceReady
}

export function shouldPublishInitialMicrophone(
  isMuted: boolean,
  inputMode: 'voice-activity' | 'push-to-talk',
): boolean {
  return !isMuted && inputMode === 'voice-activity'
}

export interface VoiceStatusIndicator {
  label: string
  tone: 'success' | 'warning' | 'danger' | 'neutral'
  icon: 'mic' | 'micOff' | 'headphones' | 'headphoneOff' | 'refresh' | 'triangleAlert' | 'phoneOff'
}

/**
 * The single persistent call-status readout in VoiceView's header. It has to
 * stand in for every state a person can be in during a call, not just
 * "connected with some quality tier": a permission denial or a mute
 * outranks a quality reading, and reconnecting/failed need their own words
 * rather than silently disappearing (as the old connected-only pill did).
 */
export function resolveVoiceStatusIndicator({
  lifecycle,
  microphonePermission,
  isMuted,
  isDeafened,
  quality,
}: {
  lifecycle: VoiceLifecycleState
  microphonePermission: 'unknown' | 'granted' | 'denied'
  isMuted: boolean
  isDeafened: boolean
  quality: 'excellent' | 'good' | 'poor' | 'unknown'
}): VoiceStatusIndicator {
  if (microphonePermission === 'denied') {
    return { label: 'Microphone blocked', tone: 'danger', icon: 'micOff' }
  }
  switch (lifecycle) {
    case 'requesting':
      return { label: 'Joining…', tone: 'neutral', icon: 'mic' }
    case 'reconnect-grace':
    case 'reconnecting':
      return { label: 'Reconnecting…', tone: 'warning', icon: 'refresh' }
    case 'failed':
      return { label: 'Voice could not connect', tone: 'danger', icon: 'phoneOff' }
    case 'leaving':
      return { label: 'Leaving…', tone: 'neutral', icon: 'phoneOff' }
    case 'connected':
      if (isMuted && isDeafened) return { label: 'Muted and deafened', tone: 'warning', icon: 'headphoneOff' }
      if (isDeafened) return { label: 'Deafened', tone: 'warning', icon: 'headphoneOff' }
      if (isMuted) return { label: 'Muted', tone: 'neutral', icon: 'micOff' }
      if (quality === 'excellent') return { label: 'Excellent connection', tone: 'success', icon: 'mic' }
      if (quality === 'good') return { label: 'Good connection', tone: 'success', icon: 'mic' }
      if (quality === 'poor') return { label: 'Poor connection', tone: 'warning', icon: 'triangleAlert' }
      return { label: 'Voice connected', tone: 'neutral', icon: 'mic' }
    default:
      return { label: 'Voice connected', tone: 'neutral', icon: 'mic' }
  }
}

export function voiceConnectionLabel(state: VoiceConnectionState): string {
  switch (state) {
    case 'connecting':
      return 'Voice connecting'
    case 'connected':
      return 'Voice connected'
    case 'reconnecting':
      return 'Voice reconnecting'
    case 'degraded':
      return 'Voice degraded'
    case 'disconnected':
      return 'Voice disconnected'
    case 'idle':
      return 'Voice idle'
  }
}
