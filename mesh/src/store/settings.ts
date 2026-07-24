import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import {
  getMatrixUserPreferences,
  isMatrixBackend,
  setKv,
  updateMatrixUserPreferences,
} from '../lib/bridge'
import type { MatrixUserPreferences } from '../types/ipc'

export interface NotificationPreferences {
  /** Whether desktop notifications are enabled */
  enabled: boolean
  /** Whether notification sounds are enabled */
  sound: boolean
  /** List of channel IDs where notifications are muted */
  mutedChannels: string[]
  /** List of community IDs where notifications are muted */
  mutedCommunities: string[]
}

const PREFERENCES_SCHEMA_VERSION = 1
const MATRIX_SAVE_DEBOUNCE_MS = 350

export function matrixPreferencesToNotifications(
  preferences: MatrixUserPreferences,
): NotificationPreferences {
  return {
    enabled: preferences.notificationsEnabled,
    sound: preferences.notificationSound,
    mutedChannels: [...new Set(preferences.mutedChannels)],
    mutedCommunities: [...new Set(preferences.mutedCommunities)],
  }
}

function notificationsToMatrixPreferences(notifications: NotificationPreferences) {
  return {
    schemaVersion: PREFERENCES_SCHEMA_VERSION,
    notificationsEnabled: notifications.enabled,
    notificationSound: notifications.sound,
    mutedChannels: [...new Set(notifications.mutedChannels)],
    mutedCommunities: [...new Set(notifications.mutedCommunities)],
  }
}

interface SettingsStore {
  notifications: NotificationPreferences
  setNotificationsEnabled: (enabled: boolean) => void
  setNotificationSound: (sound: boolean) => void
  muteChannel: (channelId: string) => void
  unmuteChannel: (channelId: string) => void
  toggleChannelMute: (channelId: string) => void
  isChannelMuted: (channelId: string) => boolean
  muteCommunity: (communityId: string) => void
  unmuteCommunity: (communityId: string) => void
  toggleCommunityMute: (communityId: string) => void
  isCommunityMuted: (communityId: string) => boolean
}

export const useSettingsStore = create<SettingsStore>()(
  persist(
    (set, get) => ({
      notifications: {
        enabled: true,
        sound: true,
        mutedChannels: [],
        mutedCommunities: [],
      },

      setNotificationsEnabled: (enabled) =>
        set((state) => ({
          notifications: { ...state.notifications, enabled },
        })),

      setNotificationSound: (sound) =>
        set((state) => ({
          notifications: { ...state.notifications, sound },
        })),

      muteChannel: (channelId) =>
        set((state) => {
          if (state.notifications.mutedChannels.includes(channelId)) return state
          return {
            notifications: {
              ...state.notifications,
              mutedChannels: [...state.notifications.mutedChannels, channelId],
            },
          }
        }),

      unmuteChannel: (channelId) =>
        set((state) => ({
          notifications: {
            ...state.notifications,
            mutedChannels: state.notifications.mutedChannels.filter((id) => id !== channelId),
          },
        })),

      toggleChannelMute: (channelId) => {
        const { notifications } = get()
        if (notifications.mutedChannels.includes(channelId)) {
          get().unmuteChannel(channelId)
        } else {
          get().muteChannel(channelId)
        }
      },

      isChannelMuted: (channelId) => get().notifications.mutedChannels.includes(channelId),

      muteCommunity: (communityId) =>
        set((state) => {
          if (state.notifications.mutedCommunities.includes(communityId)) return state
          return {
            notifications: {
              ...state.notifications,
              mutedCommunities: [...state.notifications.mutedCommunities, communityId],
            },
          }
        }),

      unmuteCommunity: (communityId) =>
        set((state) => ({
          notifications: {
            ...state.notifications,
            mutedCommunities: state.notifications.mutedCommunities.filter((id) => id !== communityId),
          },
        })),

      toggleCommunityMute: (communityId) => {
        const { notifications } = get()
        if (notifications.mutedCommunities.includes(communityId)) {
          get().unmuteCommunity(communityId)
        } else {
          get().muteCommunity(communityId)
        }
      },

      isCommunityMuted: (communityId) => get().notifications.mutedCommunities.includes(communityId),
    }),
    {
      name: 'mesh-settings',
      partialize: (state) => ({
        notifications: state.notifications,
      }),
    },
  ),
)

// Sync muted channels to backend kv_store whenever they change
// so the Rust desktop notification filter can check them.
let prevMutedChannels: string[] = useSettingsStore.getState().notifications.mutedChannels
let prevNotifications = useSettingsStore.getState().notifications
let activeMatrixUserId: string | null = null
let matrixRemoteReady = false
let applyingRemotePreferences = false
let localPreferenceRevision = 0
let matrixSaveTimer: ReturnType<typeof setTimeout> | null = null

async function saveMatrixPreferences() {
  if (!matrixRemoteReady || !activeMatrixUserId || !isMatrixBackend()) return
  await updateMatrixUserPreferences(
    notificationsToMatrixPreferences(useSettingsStore.getState().notifications),
  )
}

function scheduleMatrixPreferenceSave() {
  if (!matrixRemoteReady || !activeMatrixUserId || !isMatrixBackend()) return
  if (matrixSaveTimer) clearTimeout(matrixSaveTimer)
  matrixSaveTimer = setTimeout(() => {
    matrixSaveTimer = null
    void saveMatrixPreferences().catch((error) => {
      console.error('Failed to sync Matrix preferences:', error)
    })
  }, MATRIX_SAVE_DEBOUNCE_MS)
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
    if (matrixSaveTimer) {
      clearTimeout(matrixSaveTimer)
      matrixSaveTimer = null
    }
  }

  const revisionAtStart = localPreferenceRevision
  const remote = await getMatrixUserPreferences()
  const changedWhileFetching = revisionAtStart !== localPreferenceRevision

  if (remote && !changedWhileFetching) {
    applyingRemotePreferences = true
    useSettingsStore.setState({ notifications: matrixPreferencesToNotifications(remote) })
    applyingRemotePreferences = false
  }

  matrixRemoteReady = true
  if (!remote || changedWhileFetching) {
    await saveMatrixPreferences()
  }
}

useSettingsStore.subscribe((state) => {
  const current = state.notifications.mutedChannels
  if (current !== prevMutedChannels) {
    prevMutedChannels = current
    setKv('muted_channels', JSON.stringify(current)).catch(() => {})
  }

  if (state.notifications !== prevNotifications) {
    prevNotifications = state.notifications
    if (!applyingRemotePreferences) {
      localPreferenceRevision += 1
      scheduleMatrixPreferenceSave()
    }
  }
})
