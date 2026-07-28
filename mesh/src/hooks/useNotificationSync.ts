import { useEffect, useMemo, useState } from 'react'
import * as bridge from '../lib/bridge'
import { effectiveMutedRoomIds } from '../lib/notifications'
import { useChannelStore } from '../store/channels'
import { useDmStore } from '../store/dms'
import {
  isQuietHoursActive,
  useSettingsStore,
  type NotificationLevel,
} from '../store/settings'
import { showToast } from '../components/ui/Toast'

interface UseNotificationSyncOptions {
  matrixMode: boolean
  activeRoomId: string | null
}

function normalizedLevel(
  levels: Record<string, NotificationLevel>,
  roomId: string,
): NotificationLevel {
  return levels[roomId] ?? 'all'
}

export function useNotificationSync({
  matrixMode,
  activeRoomId,
}: UseNotificationSyncOptions) {
  const channels = useChannelStore((state) => state.channels)
  const notifications = useSettingsStore((state) => state.notifications)
  const patchChannel = useChannelStore((state) => state.patchChannel)
  const patchConversation = useDmStore((state) => state.patchConversation)
  const [policyClock, setPolicyClock] = useState(() => Date.now())
  const [focusRevision, setFocusRevision] = useState(0)
  const channelIdsKey = channels.map((channel) => channel.id).join('\u0000')

  useEffect(() => {
    const interval = window.setInterval(() => setPolicyClock(Date.now()), 30_000)
    return () => window.clearInterval(interval)
  }, [])

  useEffect(() => {
    const reconcileOnFocus = () => setFocusRevision((revision) => revision + 1)
    window.addEventListener('focus', reconcileOnFocus)
    return () => window.removeEventListener('focus', reconcileOnFocus)
  }, [])

  const mutedRoomIds = useMemo(
    () =>
      effectiveMutedRoomIds(
        channels,
        notifications.channelMuteUntil,
        notifications.communityMuteUntil,
        notifications.channelNotificationLevels,
        policyClock,
      ),
    [
      channels,
      notifications.channelMuteUntil,
      notifications.channelNotificationLevels,
      notifications.communityMuteUntil,
      policyClock,
    ],
  )

  useEffect(() => {
    if (!matrixMode) return
    void bridge
      .setNotificationContext({
        activeRoomId,
        notificationsEnabled: notifications.enabled,
        doNotDisturb: notifications.doNotDisturb,
        quietHoursActive: isQuietHoursActive(
          notifications.quietHours,
          new Date(policyClock),
        ),
        mutedRoomIds,
      })
      .catch((error) => {
        console.error('Failed to update native notification policy:', error)
      })
  }, [
    activeRoomId,
    matrixMode,
    mutedRoomIds,
    notifications.doNotDisturb,
    notifications.enabled,
    notifications.quietHours,
    policyClock,
  ])

  useEffect(() => {
    if (!matrixMode) return

    const notificationListener = bridge.onMatrixNotification(() => {
      const current = useSettingsStore.getState().notifications
      if (current.sound) bridge.playNotificationSound(current.soundId)
    })
    const unreadListener = bridge.onMatrixUnreadUpdate((update) => {
      if (useChannelStore.getState().channelEntities[update.roomId]) {
        patchChannel(update.roomId, {
          unreadCount: Math.min(update.unreadMessages, 0xffff_ffff),
          unreadMentions: Math.min(update.unreadMentions, 0xffff_ffff),
        })
        return
      }
      if (useDmStore.getState().conversationEntities[update.roomId]) {
        patchConversation(update.roomId, {
          unreadCount: Math.min(update.unreadMessages, Number.MAX_SAFE_INTEGER),
        })
      }
    })

    return () => {
      void notificationListener.then((unlisten) => unlisten())
      void unreadListener.then((unlisten) => unlisten())
    }
  }, [matrixMode, patchChannel, patchConversation])

  useEffect(() => {
    if (!matrixMode || !channelIdsKey) return
    let cancelled = false
    let unsubscribe: (() => void) | undefined

    const reconcilePushRules = async () => {
      const remoteModes = new Map<string, NotificationLevel>()
      const roomIds = channelIdsKey ? channelIdsKey.split('\u0000') : []
      await Promise.all(
        roomIds.map(async (roomId) => {
          try {
            remoteModes.set(
              roomId,
              await bridge.getMatrixRoomNotificationMode(roomId),
            )
          } catch {
            // A newly joined room can briefly lack notification settings.
            // Keep the local optimistic mode until the next channel refresh.
          }
        }),
      )
      if (cancelled) return

      const settings = useSettingsStore.getState()
      for (const [roomId, mode] of remoteModes) {
        if (settings.getChannelNotificationLevel(roomId) !== mode) {
          settings.setChannelNotificationLevel(roomId, mode)
        }
      }

      let previous = {
        ...useSettingsStore.getState().notifications.channelNotificationLevels,
      }
      unsubscribe = useSettingsStore.subscribe((state) => {
        const next = state.notifications.channelNotificationLevels
        const roomIds = new Set([...Object.keys(previous), ...Object.keys(next)])
        for (const roomId of roomIds) {
          const previousMode = normalizedLevel(previous, roomId)
          const nextMode = normalizedLevel(next, roomId)
          if (previousMode === nextMode) continue

          void bridge
            .setMatrixRoomNotificationMode(roomId, nextMode)
            .catch(() => {
              const current = useSettingsStore.getState()
              if (current.getChannelNotificationLevel(roomId) === nextMode) {
                current.setChannelNotificationLevel(roomId, previousMode)
              }
              showToast(
                'Could not save notification settings for this room. Try again.',
                'error',
              )
            })
        }
        previous = { ...next }
      })
    }

    void reconcilePushRules()
    return () => {
      cancelled = true
      unsubscribe?.()
    }
  }, [channelIdsKey, focusRevision, matrixMode])
}
