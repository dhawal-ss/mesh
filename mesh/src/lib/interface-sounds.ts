import connectionRecoveredUrl from '../assets/sounds/connection-recovered.wav'
import messageDirectUrl from '../assets/sounds/message-direct.wav'
import messageFailedUrl from '../assets/sounds/message-failed.wav'
import messageMentionUrl from '../assets/sounds/message-mention.wav'
import voicePeerJoinUrl from '../assets/sounds/voice-peer-join.wav'
import voicePeerLeaveUrl from '../assets/sounds/voice-peer-leave.wav'
import voiceSelfJoinUrl from '../assets/sounds/voice-self-join.wav'
import voiceSelfLeaveUrl from '../assets/sounds/voice-self-leave.wav'
import { isQuietHoursActive, useSettingsStore } from '../store/settings'
import type { InterfaceSoundId } from './interface-sound-contract'

export type { InterfaceSoundId } from './interface-sound-contract'

const SOUND_URLS: Record<InterfaceSoundId, string> = {
  'voice-self-join': voiceSelfJoinUrl,
  'voice-self-leave': voiceSelfLeaveUrl,
  'voice-peer-join': voicePeerJoinUrl,
  'voice-peer-leave': voicePeerLeaveUrl,
  'message-mention': messageMentionUrl,
  'message-direct': messageDirectUrl,
  'message-failed': messageFailedUrl,
  'connection-recovered': connectionRecoveredUrl,
}

const RELATIVE_VOLUME: Record<InterfaceSoundId, number> = {
  'voice-self-join': 0.71,
  'voice-self-leave': 0.63,
  'voice-peer-join': 0.5,
  'voice-peer-leave': 0.45,
  'message-mention': 0.79,
  'message-direct': 1,
  'message-failed': 0.89,
  'connection-recovered': 0.5,
}

export interface InterfaceSoundPlaybackOptions {
  /** User-requested previews bypass the event and master switches, not volume. */
  preview?: boolean
  /** Room or conversation identity used to coalesce high-frequency alerts. */
  contextKey?: string
  /** A visible focused destination suppresses mention and direct-message sounds. */
  focused?: boolean
  /** Recovery cues require a visible interruption of at least three seconds. */
  disruptionDurationMs?: number
  /** A stable batch identity prevents the same confirmed failure replaying. */
  failureKey?: string
  now?: number
  /** Test seam; product callers use the stored master volume. */
  masterVolume?: number
}

let lastPeerCueAt = Number.NEGATIVE_INFINITY
let recentPeerCueTimes: number[] = []
let lastRecoveryCueAt = Number.NEGATIVE_INFINITY
let lastMessageFailureCueAt = Number.NEGATIVE_INFINITY
let recentMessageCues = new Map<string, number>()
let playedFailureKeys = new Set<string>()

function allowedByRepetitionPolicy(
  sound: InterfaceSoundId,
  now: number,
  options: InterfaceSoundPlaybackOptions,
): boolean {
  if (sound === 'voice-peer-join' || sound === 'voice-peer-leave') {
    recentPeerCueTimes = recentPeerCueTimes.filter((timestamp) => now - timestamp < 2_000)
    if (now - lastPeerCueAt < 750 || recentPeerCueTimes.length >= 2) return false
    lastPeerCueAt = now
    recentPeerCueTimes.push(now)
  }
  if (sound === 'message-mention' || sound === 'message-direct') {
    const context = `${sound}:${options.contextKey ?? 'unknown'}`
    const lastPlayed = recentMessageCues.get(context) ?? Number.NEGATIVE_INFINITY
    if (now - lastPlayed < 2_000) return false
    recentMessageCues.set(context, now)
  }
  if (sound === 'connection-recovered') {
    if ((options.disruptionDurationMs ?? 0) < 3_000) return false
    if (now - lastRecoveryCueAt < 30_000) return false
    lastRecoveryCueAt = now
  }
  if (sound === 'message-failed') {
    if (options.failureKey && playedFailureKeys.has(options.failureKey)) return false
    if (now - lastMessageFailureCueAt < 750) return false
    lastMessageFailureCueAt = now
    if (options.failureKey) playedFailureKeys.add(options.failureKey)
  }
  return true
}

function allowedByPreferences(
  sound: InterfaceSoundId,
  options: InterfaceSoundPlaybackOptions,
): boolean {
  if (options.preview) return true
  const notifications = useSettingsStore.getState().notifications
  if (!notifications.sound || !notifications.soundEvents[sound]) return false
  if (sound === 'message-mention' || sound === 'message-direct') {
    if (
      !notifications.enabled
      || notifications.doNotDisturb
      || isQuietHoursActive(notifications.quietHours)
      || options.focused
    ) {
      return false
    }
  }
  return true
}

export async function playInterfaceSound(
  sound: InterfaceSoundId,
  optionsOrVolume: InterfaceSoundPlaybackOptions | number = {},
): Promise<boolean> {
  if (typeof Audio === 'undefined') return false
  const options = typeof optionsOrVolume === 'number'
    ? { masterVolume: optionsOrVolume }
    : optionsOrVolume
  if (!allowedByPreferences(sound, options)) return false
  const now = options.now ?? Date.now()
  if (!options.preview && !allowedByRepetitionPolicy(sound, now, options)) return false

  try {
    const audio = new Audio(SOUND_URLS[sound])
    audio.preload = 'auto'
    const storedVolume = useSettingsStore.getState().notifications.soundVolume
    const masterVolume = options.masterVolume ?? storedVolume
    audio.volume = Math.max(0, Math.min(1, masterVolume)) * RELATIVE_VOLUME[sound]
    await audio.play()
    return true
  } catch {
    // Visible state remains authoritative when media playback is blocked.
    return false
  }
}

export function resetInterfaceSoundPolicyForTest(): void {
  lastPeerCueAt = Number.NEGATIVE_INFINITY
  recentPeerCueTimes = []
  lastRecoveryCueAt = Number.NEGATIVE_INFINITY
  lastMessageFailureCueAt = Number.NEGATIVE_INFINITY
  recentMessageCues = new Map()
  playedFailureKeys = new Set()
}
