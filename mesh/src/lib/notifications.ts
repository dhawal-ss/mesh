import type { Identity } from '../types/ipc'

export function identityLabel(
  identity: Pick<Identity, 'displayName'> | null | undefined,
  matrixMode: boolean,
): string {
  return identity?.displayName || (matrixMode ? 'Mesh account' : 'Local identity')
}

export interface QuietHours {
  enabled: boolean
  start: string
  end: string
}

export interface NotificationChannel {
  id: string
  communityId: string
}

function minutesSinceMidnight(value: string): number | null {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value)
  if (!match) return null
  return Number(match[1]) * 60 + Number(match[2])
}

export function isQuietHoursActive(
  quietHours: QuietHours,
  now = new Date(),
): boolean {
  if (!quietHours.enabled) return false

  const start = minutesSinceMidnight(quietHours.start)
  const end = minutesSinceMidnight(quietHours.end)
  if (start == null || end == null) return false

  const current = now.getHours() * 60 + now.getMinutes()
  if (start === end) return true
  if (start < end) return current >= start && current < end
  return current >= start || current < end
}

export function isMuteActive(
  muteUntil: string | null | undefined,
  now = Date.now(),
): boolean {
  if (muteUntil === null) return true
  if (muteUntil === undefined) return false
  const expiresAt = Date.parse(muteUntil)
  return Number.isFinite(expiresAt) && expiresAt > now
}

export function effectiveMutedRoomIds(
  channels: NotificationChannel[],
  channelMuteUntil: Record<string, string | null>,
  communityMuteUntil: Record<string, string | null>,
  notificationLevels: Record<string, 'all' | 'mentions' | 'nothing'>,
  now = Date.now(),
): string[] {
  const muted = new Set<string>()

  for (const [roomId, muteUntil] of Object.entries(channelMuteUntil)) {
    if (isMuteActive(muteUntil, now)) muted.add(roomId)
  }
  for (const [roomId, level] of Object.entries(notificationLevels)) {
    if (level === 'nothing') muted.add(roomId)
  }

  for (const channel of channels) {
    if (
      isMuteActive(communityMuteUntil[channel.communityId], now) ||
      notificationLevels[channel.id] === 'nothing'
    ) {
      muted.add(channel.id)
    }
  }

  return [...muted].sort()
}

export function matrixRoomPermalink(roomId: string): string {
  return `https://matrix.to/#/${encodeURIComponent(roomId)}`
}

export async function copyText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text)
    return
  }

  const textarea = document.createElement('textarea')
  textarea.value = text
  textarea.style.position = 'fixed'
  textarea.style.opacity = '0'
  document.body.appendChild(textarea)
  textarea.select()
  try {
    if (!document.execCommand('copy')) throw new Error('Copy was rejected')
  } finally {
    textarea.remove()
  }
}
