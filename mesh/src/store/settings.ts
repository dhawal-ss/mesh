import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import {
  getMatrixUserPreferences,
  isMatrixBackend,
  setKv,
  updateMatrixUserPreferences,
} from '../lib/bridge'
import type { MatrixUserPreferences } from '../types/ipc'

const MINUTE_MS = 60 * 1_000

export const NOTIFICATION_MUTE_DURATIONS = [
  { id: 'mute-15m', label: 'Mute for 15 minutes', durationMs: 15 * MINUTE_MS },
  { id: 'mute-1h', label: 'Mute for 1 hour', durationMs: 60 * MINUTE_MS },
  { id: 'mute-8h', label: 'Mute for 8 hours', durationMs: 8 * 60 * MINUTE_MS },
  { id: 'mute-24h', label: 'Mute for 24 hours', durationMs: 24 * 60 * MINUTE_MS },
  { id: 'mute-until-enabled', label: 'Mute until turned back on', durationMs: null },
] as const

export interface NotificationPreferences {
  /** Whether desktop notifications are enabled */
  enabled: boolean
  /** Whether notification sounds are enabled */
  sound: boolean
  /** The built-in sound played for message notifications. */
  soundId: NotificationSoundId
  /** Suppress all notification surfaces until explicitly disabled. */
  doNotDisturb: boolean
  /** Daily local-time window in which notification surfaces are suppressed. */
  quietHours: QuietHoursPreferences
  /** List of channel IDs where notifications are muted */
  mutedChannels: string[]
  /** List of community IDs where notifications are muted */
  mutedCommunities: string[]
  /** ISO expiry for each muted channel; null means muted until turned back on. */
  channelMuteUntil: Record<string, string | null>
  /** ISO expiry for each muted community; null means muted until turned back on. */
  communityMuteUntil: Record<string, string | null>
  /** Optimistic mirror of authoritative Matrix room push-rule modes. */
  channelNotificationLevels: Record<string, NotificationLevel>
}

export type NotificationSoundId = 'mesh' | 'chime' | 'pulse' | 'soft'
export type NotificationLevel = 'all' | 'mentions' | 'nothing'

export interface QuietHoursPreferences {
  enabled: boolean
  /** Local wall-clock time in HH:mm format. */
  start: string
  /** Local wall-clock time in HH:mm format. */
  end: string
}

export type AppearanceTheme = 'dark' | 'light' | 'high-contrast'
export type AppearanceDensity = 'default' | 'compact' | 'comfortable'
export type AppearanceAccent = 'sand' | 'ocean' | 'violet' | 'forest' | 'ember' | 'rose'

export interface AppearancePreferences {
  theme: AppearanceTheme
  density: AppearanceDensity
  accent: AppearanceAccent
}

export interface BackupPreferences {
  configured: boolean
  reminderPending: boolean
  dismissedAt: string | null
}

export interface PrivacyPreferences {
  readReceiptMode: ReadReceiptMode
  sendTypingIndicators: boolean
  sharePresence: boolean
  invisibleMode: boolean
}

export type ReadReceiptMode = 'public' | 'private' | 'off'

export type MatrixPreferenceSyncStatus = 'idle' | 'saving' | 'saved' | 'failed'

export interface MatrixPreferenceSyncState {
  status: MatrixPreferenceSyncStatus
  error: unknown | null
}

const PREFERENCES_SCHEMA_VERSION = 3
const MATRIX_SAVE_DEBOUNCE_MS = 350
const BACKUP_REMINDER_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000
const DEFAULT_APPEARANCE: AppearancePreferences = {
  theme: 'dark',
  density: 'default',
  accent: 'sand',
}
const DEFAULT_NOTIFICATIONS: NotificationPreferences = {
  enabled: true,
  sound: true,
  soundId: 'mesh',
  doNotDisturb: false,
  quietHours: {
    enabled: false,
    start: '22:00',
    end: '08:00',
  },
  mutedChannels: [],
  mutedCommunities: [],
  channelMuteUntil: {},
  communityMuteUntil: {},
  channelNotificationLevels: {},
}
const DEFAULT_PRIVACY: PrivacyPreferences = {
  readReceiptMode: 'off',
  sendTypingIndicators: false,
  sharePresence: false,
  invisibleMode: false,
}
const DEFAULT_MATRIX_PREFERENCE_SYNC: MatrixPreferenceSyncState = {
  status: 'idle',
  error: null,
}

const APPEARANCE_THEMES = new Set<AppearanceTheme>(['dark', 'light', 'high-contrast'])
const APPEARANCE_DENSITIES = new Set<AppearanceDensity>([
  'default',
  'compact',
  'comfortable',
])
const APPEARANCE_ACCENTS = new Set<AppearanceAccent>([
  'sand',
  'ocean',
  'violet',
  'forest',
  'ember',
  'rose',
])
const NOTIFICATION_SOUNDS = new Set<NotificationSoundId>(['mesh', 'chime', 'pulse', 'soft'])
const NOTIFICATION_LEVELS = new Set<NotificationLevel>(['all', 'mentions', 'nothing'])
const READ_RECEIPT_MODES = new Set<ReadReceiptMode>(['public', 'private', 'off'])
const WALL_CLOCK_TIME = /^(?:[01]\d|2[0-3]):[0-5]\d$/

type ExtendedMatrixUserPreferences = MatrixUserPreferences & {
  notificationSoundId?: NotificationSoundId
  doNotDisturb?: boolean
  quietHoursEnabled?: boolean
  quietHoursStart?: string
  quietHoursEnd?: string
  mutedChannelUntil?: Record<string, string | null>
  mutedCommunityUntil?: Record<string, string | null>
  channelNotificationLevels?: Record<string, NotificationLevel>
}

function normalizeWallClockTime(value: unknown, fallback: string): string {
  return typeof value === 'string' && WALL_CLOCK_TIME.test(value) ? value : fallback
}

function normalizeMuteExpirations(
  mutedIds: unknown,
  expirations: unknown,
  now = Date.now(),
): { ids: string[]; until: Record<string, string | null> } {
  const legacyIds = Array.isArray(mutedIds)
    ? mutedIds.filter((id): id is string => typeof id === 'string' && id.length > 0)
    : []
  const rawExpirations =
    expirations && typeof expirations === 'object'
      ? (expirations as Record<string, unknown>)
      : {}
  const ids = new Set([...legacyIds, ...Object.keys(rawExpirations)])
  const activeIds: string[] = []
  const until: Record<string, string | null> = {}

  for (const id of ids) {
    const rawExpiry = rawExpirations[id]
    // A legacy muted id without an expiry remains muted until turned back on.
    if (rawExpiry == null) {
      if (legacyIds.includes(id) || Object.prototype.hasOwnProperty.call(rawExpirations, id)) {
        activeIds.push(id)
        until[id] = null
      }
      continue
    }
    if (typeof rawExpiry !== 'string') continue
    const expiry = Date.parse(rawExpiry)
    if (!Number.isFinite(expiry) || expiry <= now) continue
    activeIds.push(id)
    until[id] = new Date(expiry).toISOString()
  }

  return { ids: [...new Set(activeIds)], until }
}

function normalizeNotificationLevels(value: unknown): Record<string, NotificationLevel> {
  if (!value || typeof value !== 'object') return {}
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).filter(
      (entry): entry is [string, NotificationLevel] =>
        entry[0].length > 0 &&
        typeof entry[1] === 'string' &&
        NOTIFICATION_LEVELS.has(entry[1] as NotificationLevel),
    ),
  )
}

export function normalizeNotificationPreferences(
  preferences: Partial<NotificationPreferences> | undefined,
  now = Date.now(),
): NotificationPreferences {
  const channels = normalizeMuteExpirations(
    preferences?.mutedChannels,
    preferences?.channelMuteUntil,
    now,
  )
  const communities = normalizeMuteExpirations(
    preferences?.mutedCommunities,
    preferences?.communityMuteUntil,
    now,
  )

  return {
    enabled: preferences?.enabled ?? DEFAULT_NOTIFICATIONS.enabled,
    sound: preferences?.sound ?? DEFAULT_NOTIFICATIONS.sound,
    soundId:
      preferences?.soundId && NOTIFICATION_SOUNDS.has(preferences.soundId)
        ? preferences.soundId
        : DEFAULT_NOTIFICATIONS.soundId,
    doNotDisturb: preferences?.doNotDisturb ?? DEFAULT_NOTIFICATIONS.doNotDisturb,
    quietHours: {
      enabled: preferences?.quietHours?.enabled ?? DEFAULT_NOTIFICATIONS.quietHours.enabled,
      start: normalizeWallClockTime(
        preferences?.quietHours?.start,
        DEFAULT_NOTIFICATIONS.quietHours.start,
      ),
      end: normalizeWallClockTime(
        preferences?.quietHours?.end,
        DEFAULT_NOTIFICATIONS.quietHours.end,
      ),
    },
    mutedChannels: channels.ids,
    mutedCommunities: communities.ids,
    channelMuteUntil: channels.until,
    communityMuteUntil: communities.until,
    channelNotificationLevels: normalizeNotificationLevels(
      preferences?.channelNotificationLevels,
    ),
  }
}

function normalizeAppearancePreferences(
  preferences: Partial<AppearancePreferences> | undefined,
): AppearancePreferences {
  return {
    theme:
      preferences?.theme && APPEARANCE_THEMES.has(preferences.theme)
        ? preferences.theme
        : DEFAULT_APPEARANCE.theme,
    density:
      preferences?.density && APPEARANCE_DENSITIES.has(preferences.density)
        ? preferences.density
        : DEFAULT_APPEARANCE.density,
    accent:
      preferences?.accent && APPEARANCE_ACCENTS.has(preferences.accent)
        ? preferences.accent
        : DEFAULT_APPEARANCE.accent,
  }
}

export function normalizePrivacyPreferences(
  preferences:
    | (Partial<PrivacyPreferences> & { sendReadReceipts?: boolean })
    | undefined,
): PrivacyPreferences {
  const mode = preferences?.readReceiptMode
  return {
    readReceiptMode: READ_RECEIPT_MODES.has(mode as ReadReceiptMode)
      ? (mode as ReadReceiptMode)
      : preferences?.sendReadReceipts === true
        ? 'private'
        : DEFAULT_PRIVACY.readReceiptMode,
    sendTypingIndicators:
      preferences?.sendTypingIndicators ?? DEFAULT_PRIVACY.sendTypingIndicators,
    sharePresence: preferences?.sharePresence ?? DEFAULT_PRIVACY.sharePresence,
    invisibleMode: preferences?.invisibleMode ?? DEFAULT_PRIVACY.invisibleMode,
  }
}

export function applyAppearancePreferences(preferences: AppearancePreferences): void {
  if (typeof document === 'undefined') return
  const root = document.documentElement
  root.dataset.theme = preferences.theme
  root.dataset.density = preferences.density
  root.dataset.accent = preferences.accent
}

export function matrixPreferencesToNotifications(
  preferences: MatrixUserPreferences,
): NotificationPreferences {
  const extended = preferences as ExtendedMatrixUserPreferences
  return normalizeNotificationPreferences({
    enabled: preferences.notificationsEnabled,
    sound: preferences.notificationSound,
    soundId: extended.notificationSoundId,
    doNotDisturb: extended.doNotDisturb,
    quietHours: {
      enabled: extended.quietHoursEnabled ?? false,
      start: extended.quietHoursStart ?? DEFAULT_NOTIFICATIONS.quietHours.start,
      end: extended.quietHoursEnd ?? DEFAULT_NOTIFICATIONS.quietHours.end,
    },
    mutedChannels: preferences.mutedChannels,
    mutedCommunities: preferences.mutedCommunities,
    channelMuteUntil: extended.mutedChannelUntil,
    communityMuteUntil: extended.mutedCommunityUntil,
    channelNotificationLevels: extended.channelNotificationLevels,
  })
}

export function matrixPreferencesToPrivacy(
  preferences: MatrixUserPreferences,
): PrivacyPreferences {
  return normalizePrivacyPreferences({
    readReceiptMode:
      preferences.readReceiptMode === null ? undefined : preferences.readReceiptMode,
    sendReadReceipts: preferences.sendReadReceipts,
    sendTypingIndicators: preferences.sendTypingIndicators,
    sharePresence: preferences.sharePresence,
    invisibleMode: preferences.invisibleMode,
  })
}

function settingsToMatrixPreferences(
  notifications: NotificationPreferences,
  privacy: PrivacyPreferences,
) {
  return {
    schemaVersion: PREFERENCES_SCHEMA_VERSION,
    notificationsEnabled: notifications.enabled,
    notificationSound: notifications.sound,
    // Matrix room notification modes are authoritative in m.push_rules. Keep
    // the legacy fields empty so a second client does not mistake local-only
    // expiry state for portable room mute state.
    mutedChannels: [],
    mutedCommunities: [],
    notificationSoundId: notifications.soundId,
    doNotDisturb: notifications.doNotDisturb,
    quietHoursEnabled: notifications.quietHours.enabled,
    quietHoursStart: notifications.quietHours.start,
    quietHoursEnd: notifications.quietHours.end,
    mutedChannelUntil: {},
    mutedCommunityUntil: {},
    channelNotificationLevels: {},
    // Keep the legacy boolean populated for older Mesh clients. Their true
    // value means private-only; newer clients use readReceiptMode below.
    sendReadReceipts: privacy.readReceiptMode === 'private',
    readReceiptMode: privacy.readReceiptMode,
    sendTypingIndicators: privacy.sendTypingIndicators,
    sharePresence: privacy.sharePresence,
    invisibleMode: privacy.invisibleMode,
  }
}

export interface SettingsStore {
  notifications: NotificationPreferences
  appearance: AppearancePreferences
  backup: BackupPreferences
  privacy: PrivacyPreferences
  matrixPreferenceSync: MatrixPreferenceSyncState
  setNotificationsEnabled: (enabled: boolean) => void
  setNotificationSound: (sound: boolean) => void
  setNotificationSoundId: (soundId: NotificationSoundId) => void
  setDoNotDisturb: (enabled: boolean) => void
  setQuietHoursEnabled: (enabled: boolean) => void
  setQuietHours: (start: string, end: string) => void
  setAppearanceTheme: (theme: AppearanceTheme) => void
  setAppearanceDensity: (density: AppearanceDensity) => void
  setAppearanceAccent: (accent: AppearanceAccent) => void
  setBackupConfigured: (configured: boolean) => void
  scheduleBackupReminder: () => void
  dismissBackupReminder: () => void
  setReadReceiptMode: (mode: ReadReceiptMode) => void
  setSendTypingIndicators: (enabled: boolean) => void
  setSharePresence: (enabled: boolean) => void
  setInvisibleMode: (enabled: boolean) => void
  muteChannelFor: (channelId: string, durationMs: number | null) => void
  muteChannel: (channelId: string) => void
  unmuteChannel: (channelId: string) => void
  toggleChannelMute: (channelId: string) => void
  isChannelMuted: (channelId: string, now?: number) => boolean
  setChannelNotificationLevel: (channelId: string, level: NotificationLevel) => void
  getChannelNotificationLevel: (channelId: string) => NotificationLevel
  muteCommunityFor: (communityId: string, durationMs: number | null) => void
  muteCommunity: (communityId: string) => void
  unmuteCommunity: (communityId: string) => void
  toggleCommunityMute: (communityId: string) => void
  isCommunityMuted: (communityId: string, now?: number) => boolean
}

function muteUntil(durationMs: number | null, now = Date.now()): string | null {
  if (durationMs == null) return null
  if (!Number.isFinite(durationMs) || durationMs <= 0) {
    throw new RangeError('Mute duration must be a positive number of milliseconds or null.')
  }
  return new Date(now + durationMs).toISOString()
}

function hasActiveMute(
  id: string,
  mutedIds: string[],
  expirations: Record<string, string | null>,
  now = Date.now(),
): boolean {
  if (!mutedIds.includes(id)) return false
  const expiry = expirations[id]
  if (expiry == null) return true
  const expiryTime = Date.parse(expiry)
  return Number.isFinite(expiryTime) && expiryTime > now
}

function wallClockMinutes(value: string): number {
  const [hours, minutes] = value.split(':').map(Number)
  return hours * 60 + minutes
}

export function isQuietHoursActive(
  quietHours: QuietHoursPreferences,
  now = new Date(),
): boolean {
  if (!quietHours.enabled) return false
  const start = wallClockMinutes(quietHours.start)
  const end = wallClockMinutes(quietHours.end)
  const current = now.getHours() * 60 + now.getMinutes()
  if (start === end) return true
  return start < end
    ? current >= start && current < end
    : current >= start || current < end
}

export function getEffectiveChannelNotificationLevel(
  notifications: NotificationPreferences,
  channelId: string,
  communityId?: string | null,
  now = new Date(),
): NotificationLevel {
  if (
    !notifications.enabled ||
    notifications.doNotDisturb ||
    isQuietHoursActive(notifications.quietHours, now) ||
    hasActiveMute(
      channelId,
      notifications.mutedChannels,
      notifications.channelMuteUntil,
      now.getTime(),
    ) ||
    (communityId != null &&
      hasActiveMute(
        communityId,
        notifications.mutedCommunities,
        notifications.communityMuteUntil,
        now.getTime(),
      ))
  ) {
    return 'nothing'
  }
  return notifications.channelNotificationLevels[channelId] ?? 'all'
}

export const useSettingsStore = create<SettingsStore>()(
  persist(
    (set, get) => ({
      notifications: DEFAULT_NOTIFICATIONS,
      appearance: DEFAULT_APPEARANCE,
      backup: {
        configured: false,
        reminderPending: false,
        dismissedAt: null,
      },
      privacy: DEFAULT_PRIVACY,
      matrixPreferenceSync: DEFAULT_MATRIX_PREFERENCE_SYNC,

      setNotificationsEnabled: (enabled) =>
        set((state) => ({
          notifications: { ...state.notifications, enabled },
        })),

      setNotificationSound: (sound) =>
        set((state) => ({
          notifications: { ...state.notifications, sound },
        })),

      setNotificationSoundId: (soundId) =>
        set((state) => ({
          notifications: { ...state.notifications, soundId },
        })),

      setDoNotDisturb: (doNotDisturb) =>
        set((state) => ({
          notifications: { ...state.notifications, doNotDisturb },
        })),

      setQuietHoursEnabled: (enabled) =>
        set((state) => ({
          notifications: {
            ...state.notifications,
            quietHours: { ...state.notifications.quietHours, enabled },
          },
        })),

      setQuietHours: (start, end) => {
        if (!WALL_CLOCK_TIME.test(start) || !WALL_CLOCK_TIME.test(end)) {
          throw new RangeError('Quiet hours must use 24-hour HH:mm values.')
        }
        set((state) => ({
          notifications: {
            ...state.notifications,
            quietHours: { ...state.notifications.quietHours, start, end },
          },
        }))
      },

      setAppearanceTheme: (theme) => {
        const appearance = { ...get().appearance, theme }
        set({ appearance })
        applyAppearancePreferences(appearance)
      },

      setAppearanceDensity: (density) => {
        const appearance = { ...get().appearance, density }
        set({ appearance })
        applyAppearancePreferences(appearance)
      },

      setAppearanceAccent: (accent) => {
        const appearance = { ...get().appearance, accent }
        set({ appearance })
        applyAppearancePreferences(appearance)
      },

      setBackupConfigured: (configured) =>
        set({
          backup: {
            configured,
            reminderPending: !configured,
            dismissedAt: null,
          },
        }),

      scheduleBackupReminder: () =>
        set({
          backup: {
            configured: false,
            reminderPending: true,
            dismissedAt: null,
          },
        }),

      dismissBackupReminder: () =>
        set((state) => ({
          backup: {
            ...state.backup,
            dismissedAt: new Date().toISOString(),
          },
        })),

      setReadReceiptMode: (readReceiptMode) =>
        set((state) => ({ privacy: { ...state.privacy, readReceiptMode } })),

      setSendTypingIndicators: (sendTypingIndicators) =>
        set((state) => ({ privacy: { ...state.privacy, sendTypingIndicators } })),

      setSharePresence: (sharePresence) =>
        set((state) => ({ privacy: { ...state.privacy, sharePresence } })),

      setInvisibleMode: (invisibleMode) =>
        set((state) => ({ privacy: { ...state.privacy, invisibleMode } })),

      muteChannelFor: (channelId, durationMs) =>
        set((state) => {
          const expiry = muteUntil(durationMs)
          return {
            notifications: {
              ...state.notifications,
              mutedChannels: [
                ...state.notifications.mutedChannels.filter((id) => id !== channelId),
                channelId,
              ],
              channelMuteUntil: {
                ...state.notifications.channelMuteUntil,
                [channelId]: expiry,
              },
            },
          }
        }),

      muteChannel: (channelId) => get().muteChannelFor(channelId, null),

      unmuteChannel: (channelId) =>
        set((state) => {
          const { [channelId]: _removed, ...channelMuteUntil } =
            state.notifications.channelMuteUntil
          return {
            notifications: {
              ...state.notifications,
              mutedChannels: state.notifications.mutedChannels.filter((id) => id !== channelId),
              channelMuteUntil,
            },
          }
        }),

      toggleChannelMute: (channelId) => {
        if (get().isChannelMuted(channelId)) {
          get().unmuteChannel(channelId)
        } else {
          get().muteChannel(channelId)
        }
      },

      isChannelMuted: (channelId, now) => {
        const { notifications } = get()
        return hasActiveMute(
          channelId,
          notifications.mutedChannels,
          notifications.channelMuteUntil,
          now,
        )
      },

      setChannelNotificationLevel: (channelId, level) =>
        set((state) => {
          const channelNotificationLevels = { ...state.notifications.channelNotificationLevels }
          if (level === 'all') {
            delete channelNotificationLevels[channelId]
          } else {
            channelNotificationLevels[channelId] = level
          }
          return {
            notifications: {
              ...state.notifications,
              channelNotificationLevels,
            },
          }
        }),

      getChannelNotificationLevel: (channelId) =>
        get().notifications.channelNotificationLevels[channelId] ?? 'all',

      muteCommunityFor: (communityId, durationMs) =>
        set((state) => {
          const expiry = muteUntil(durationMs)
          return {
            notifications: {
              ...state.notifications,
              mutedCommunities: [
                ...state.notifications.mutedCommunities.filter((id) => id !== communityId),
                communityId,
              ],
              communityMuteUntil: {
                ...state.notifications.communityMuteUntil,
                [communityId]: expiry,
              },
            },
          }
        }),

      muteCommunity: (communityId) => get().muteCommunityFor(communityId, null),

      unmuteCommunity: (communityId) =>
        set((state) => {
          const { [communityId]: _removed, ...communityMuteUntil } =
            state.notifications.communityMuteUntil
          return {
            notifications: {
              ...state.notifications,
              mutedCommunities: state.notifications.mutedCommunities.filter(
                (id) => id !== communityId,
              ),
              communityMuteUntil,
            },
          }
        }),

      toggleCommunityMute: (communityId) => {
        if (get().isCommunityMuted(communityId)) {
          get().unmuteCommunity(communityId)
        } else {
          get().muteCommunity(communityId)
        }
      },

      isCommunityMuted: (communityId, now) => {
        const { notifications } = get()
        return hasActiveMute(
          communityId,
          notifications.mutedCommunities,
          notifications.communityMuteUntil,
          now,
        )
      },
    }),
    {
      name: 'mesh-settings',
      partialize: (state) => ({
        notifications: state.notifications,
        // Appearance stays device-local; MatrixUserPreferences contains only
        // portable notification and wire-privacy fields.
        appearance: state.appearance,
        backup: state.backup,
        privacy: state.privacy,
      }),
      merge: (persistedState, currentState) => {
        const persisted = (persistedState ?? {}) as Partial<SettingsStore>
        return {
          ...currentState,
          ...persisted,
          notifications: normalizeNotificationPreferences(persisted.notifications),
          appearance: normalizeAppearancePreferences(persisted.appearance),
          privacy: normalizePrivacyPreferences(persisted.privacy),
          backup: {
            configured: persisted.backup?.configured ?? false,
            reminderPending: persisted.backup?.reminderPending ?? false,
            dismissedAt: persisted.backup?.dismissedAt ?? null,
          },
          matrixPreferenceSync: DEFAULT_MATRIX_PREFERENCE_SYNC,
        }
      },
      onRehydrateStorage: () => (state) => {
        if (state) applyAppearancePreferences(state.appearance)
      },
    },
  ),
)

export function isBackupReminderDue(
  backup: BackupPreferences,
  now = Date.now(),
): boolean {
  if (backup.configured || !backup.reminderPending) return false
  if (!backup.dismissedAt) return true
  const dismissedAt = Date.parse(backup.dismissedAt)
  return !Number.isFinite(dismissedAt) || now - dismissedAt >= BACKUP_REMINDER_INTERVAL_MS
}

// Apply defaults immediately when storage is unavailable, and make the initial
// paint deterministic before any settings UI mounts.
applyAppearancePreferences(useSettingsStore.getState().appearance)

// Sync muted channels to backend kv_store whenever they change
// so the Rust desktop notification filter can check them.
let prevMutedChannels: string[] = useSettingsStore.getState().notifications.mutedChannels
let prevNotifications = useSettingsStore.getState().notifications
let prevPrivacy = useSettingsStore.getState().privacy
let activeMatrixUserId: string | null = null
let matrixRemoteReady = false
let applyingRemotePreferences = false
let localPreferenceRevision = 0
let matrixSaveRequestId = 0
let matrixSaveTimer: ReturnType<typeof setTimeout> | null = null
let channelMuteTimers = new Map<string, ReturnType<typeof setTimeout>>()
let communityMuteTimers = new Map<string, ReturnType<typeof setTimeout>>()

function replaceMuteExpiryTimers(
  expirations: Record<string, string | null>,
  currentTimers: Map<string, ReturnType<typeof setTimeout>>,
  isMuted: (id: string) => boolean,
  unmute: (id: string) => void,
): Map<string, ReturnType<typeof setTimeout>> {
  for (const timer of currentTimers.values()) clearTimeout(timer)
  const nextTimers = new Map<string, ReturnType<typeof setTimeout>>()
  const now = Date.now()
  for (const [id, expiry] of Object.entries(expirations)) {
    if (expiry == null) continue
    const expiryTime = Date.parse(expiry)
    if (!Number.isFinite(expiryTime)) continue
    const delay = Math.max(0, Math.min(expiryTime - now, 2_147_483_647))
    nextTimers.set(
      id,
      setTimeout(() => {
        if (isMuted(id)) {
          // The platform timeout limit can be shorter than a persisted expiry.
          if (expiryTime > Date.now()) {
            // Any no-op state replacement goes through the subscriber and
            // safely schedules the remaining interval.
            const notifications = useSettingsStore.getState().notifications
            useSettingsStore.setState({ notifications: { ...notifications } })
          }
          return
        }
        unmute(id)
      }, delay),
    )
  }
  return nextTimers
}

function scheduleMuteExpiryCleanup(notifications: NotificationPreferences) {
  channelMuteTimers = replaceMuteExpiryTimers(
    notifications.channelMuteUntil,
    channelMuteTimers,
    (id) => useSettingsStore.getState().isChannelMuted(id),
    (id) => useSettingsStore.getState().unmuteChannel(id),
  )
  communityMuteTimers = replaceMuteExpiryTimers(
    notifications.communityMuteUntil,
    communityMuteTimers,
    (id) => useSettingsStore.getState().isCommunityMuted(id),
    (id) => useSettingsStore.getState().unmuteCommunity(id),
  )
}

function currentMatrixPreferenceSnapshot() {
  const state = useSettingsStore.getState()
  return {
    notifications: state.notifications,
    privacy: state.privacy,
  }
}

function setMatrixPreferenceSync(next: MatrixPreferenceSyncState) {
  useSettingsStore.setState({ matrixPreferenceSync: next })
}

async function persistMatrixPreferences(
  revision: number,
  snapshot: ReturnType<typeof currentMatrixPreferenceSnapshot>,
) {
  if (!matrixRemoteReady || !activeMatrixUserId || !isMatrixBackend()) return

  const requestId = ++matrixSaveRequestId
  setMatrixPreferenceSync({ status: 'saving', error: null })
  try {
    await updateMatrixUserPreferences(
      settingsToMatrixPreferences(snapshot.notifications, snapshot.privacy),
    )
    if (revision === localPreferenceRevision && requestId === matrixSaveRequestId) {
      setMatrixPreferenceSync({ status: 'saved', error: null })
    }
  } catch (error) {
    if (revision === localPreferenceRevision && requestId === matrixSaveRequestId) {
      setMatrixPreferenceSync({ status: 'failed', error })
    }
    throw error
  }
}

function scheduleMatrixPreferenceSave() {
  if (!matrixRemoteReady || !activeMatrixUserId || !isMatrixBackend()) return
  if (matrixSaveTimer) clearTimeout(matrixSaveTimer)
  matrixSaveTimer = setTimeout(() => {
    matrixSaveTimer = null
    void persistMatrixPreferences(
      localPreferenceRevision,
      currentMatrixPreferenceSnapshot(),
    ).catch((error) => {
      console.error('Failed to sync Matrix preferences:', error)
    })
  }, MATRIX_SAVE_DEBOUNCE_MS)
}

export async function retryMatrixPreferenceSync(): Promise<void> {
  if (!isMatrixBackend() || !activeMatrixUserId) return
  if (!matrixRemoteReady) {
    await refreshMatrixPreferences(activeMatrixUserId)
    return
  }
  await persistMatrixPreferences(localPreferenceRevision, currentMatrixPreferenceSnapshot())
}

/**
 * Pull the latest portable preferences for the authenticated Matrix account.
 * Local state remains immediately usable; a concurrent local edit wins over a
 * stale fetch and is pushed back after the read completes.
 */
export async function refreshMatrixPreferences(userId: string): Promise<void> {
  if (!isMatrixBackend()) return
  if (activeMatrixUserId !== userId) {
    activeMatrixUserId = userId
    matrixRemoteReady = false
    matrixSaveRequestId += 1
    setMatrixPreferenceSync(DEFAULT_MATRIX_PREFERENCE_SYNC)
    if (matrixSaveTimer) {
      clearTimeout(matrixSaveTimer)
      matrixSaveTimer = null
    }
  }

  const revisionAtStart = localPreferenceRevision
  let remote: MatrixUserPreferences | null
  try {
    remote = await getMatrixUserPreferences()
  } catch (error) {
    if (activeMatrixUserId === userId) {
      matrixSaveRequestId += 1
      setMatrixPreferenceSync({ status: 'failed', error })
    }
    throw error
  }
  if (activeMatrixUserId !== userId) return
  const changedWhileFetching = revisionAtStart !== localPreferenceRevision

  if (remote && !changedWhileFetching) {
    applyingRemotePreferences = true
    const channelNotificationLevels =
      useSettingsStore.getState().notifications.channelNotificationLevels
    useSettingsStore.setState({
      notifications: {
        ...matrixPreferencesToNotifications(remote),
        // Matrix push rules are authoritative for per-room levels. The custom
        // account-data mirror is only a migration fallback and must not
        // overwrite a newer rule changed by another Matrix client.
        channelNotificationLevels,
      },
      privacy: matrixPreferencesToPrivacy(remote),
    })
    applyingRemotePreferences = false
  }

  matrixRemoteReady = true
  if (!remote || changedWhileFetching) {
    await persistMatrixPreferences(localPreferenceRevision, currentMatrixPreferenceSnapshot())
  } else {
    setMatrixPreferenceSync({ status: 'saved', error: null })
  }
}

useSettingsStore.subscribe((state) => {
  const current = state.notifications.mutedChannels
  if (current !== prevMutedChannels && !isMatrixBackend()) {
    prevMutedChannels = current
    setKv('muted_channels', JSON.stringify(current)).catch(() => {})
  }

  if (state.notifications !== prevNotifications) {
    prevNotifications = state.notifications
    scheduleMuteExpiryCleanup(state.notifications)
    if (!applyingRemotePreferences) {
      localPreferenceRevision += 1
      scheduleMatrixPreferenceSave()
    }
  }

  if (state.privacy !== prevPrivacy) {
    prevPrivacy = state.privacy
    if (!applyingRemotePreferences) {
      localPreferenceRevision += 1
      if (matrixSaveTimer) {
        clearTimeout(matrixSaveTimer)
        matrixSaveTimer = null
      }
      void persistMatrixPreferences(
        localPreferenceRevision,
        currentMatrixPreferenceSnapshot(),
      ).catch((error) => {
        console.error('Failed to sync Matrix privacy preferences:', error)
      })
    }
  }
})

scheduleMuteExpiryCleanup(useSettingsStore.getState().notifications)
