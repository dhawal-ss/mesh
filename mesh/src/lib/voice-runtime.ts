import type { BackendStatus } from './bridge'
import type { VoiceConnectionState } from '../types/ipc'

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
      status.voiceService.mediaE2eeVerified,
  )
}

/**
 * Distinguish "the user (or policy) blocked the microphone" from every other
 * device failure. `getUserMedia` reports this as NotAllowedError, and Chromium
 * additionally uses SecurityError when a permissions policy blocks it.
 */
export function isPermissionDeniedError(error: unknown): boolean {
  if (typeof DOMException !== 'undefined' && error instanceof DOMException) {
    return error.name === 'NotAllowedError' || error.name === 'SecurityError'
  }
  if (error && typeof error === 'object' && 'name' in error) {
    const name = (error as { name?: unknown }).name
    return name === 'NotAllowedError' || name === 'SecurityError'
  }
  return false
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
