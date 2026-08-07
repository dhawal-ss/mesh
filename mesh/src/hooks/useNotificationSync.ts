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
import { playInterfaceSound } from '../lib/interface-sounds'
import { mapSettledWithConcurrency } from '../lib/concurrency'

interface UseNotificationSyncOptions {
  matrixMode: boolean
  accountUserId: string | null
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
  accountUserId,
  activeRoomId,
}: UseNotificationSyncOptions) {
  const channels = useChannelStore((state) => state.channels)
  const conversationOrder = useDmStore((state) => state.conversationOrder)
  const notifications = useSettingsStore((state) => state.notifications)
  const patchChannel = useChannelStore((state) => state.patchChannel)
  const patchConversation = useDmStore((state) => state.patchConversation)
  const [policyClock, setPolicyClock] = useState(() => Date.now())
  const [focusRevision, setFocusRevision] = useState(0)
  const roomIdsKey = [...channels.map((channel) => channel.id), ...conversationOrder].join('\u0000')

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
    if (!matrixMode || !accountUserId) return
    let cancelled = false
    const synchronizePolicy = async () => {
      const scope = await bridge.getNotificationAccountScope(accountUserId)
      if (cancelled) return
      await bridge.setNotificationContext(scope, {
        activeRoomId,
        notificationsEnabled: notifications.enabled,
        doNotDisturb: notifications.doNotDisturb,
        showMessageContent: notifications.showMessageContent,
        quietHoursActive: isQuietHoursActive(
          notifications.quietHours,
          new Date(policyClock),
        ),
        mutedRoomIds,
      })
    }
    void synchronizePolicy().catch((error) => {
      if (!cancelled) {
        console.error('Failed to update native notification policy:', error)
      }
    })
    return () => {
      cancelled = true
    }
  }, [
    accountUserId,
    activeRoomId,
    matrixMode,
    mutedRoomIds,
    notifications.doNotDisturb,
    notifications.enabled,
    notifications.quietHours,
    notifications.showMessageContent,
    policyClock,
  ])

  useEffect(() => {
    if (!matrixMode) return

    const notificationListener = bridge.onMatrixNotification((notification) => {
      if (notification.roomId === activeRoomId) return
      if (notification.isDm) {
        void playInterfaceSound('message-direct', {
          contextKey: notification.roomId,
          focused: false,
        })
      } else if (notification.isMention) {
        void playInterfaceSound('message-mention', {
          contextKey: notification.roomId,
          focused: false,
        })
      }
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
          unreadMentions: Math.min(update.unreadMentions, Number.MAX_SAFE_INTEGER),
        })
      }
    })

    return () => {
      void notificationListener.then((unlisten) => unlisten())
      void unreadListener.then((unlisten) => unlisten())
    }
  }, [activeRoomId, matrixMode, patchChannel, patchConversation])

  useEffect(() => {
    if (!matrixMode || !roomIdsKey) return
    let cancelled = false
    let applyingRemoteSnapshot = false
    const locallyChangedRooms = new Set<string>()
    let previous = {
      ...useSettingsStore.getState().notifications.channelNotificationLevels,
    }
    const unsubscribe = useSettingsStore.subscribe((state) => {
      const next = state.notifications.channelNotificationLevels
      const changedRoomIds = new Set([...Object.keys(previous), ...Object.keys(next)])
      for (const roomId of changedRoomIds) {
        const previousMode = normalizedLevel(previous, roomId)
        const nextMode = normalizedLevel(next, roomId)
        if (previousMode === nextMode) continue
        if (applyingRemoteSnapshot) continue

        locallyChangedRooms.add(roomId)
        void bridge
          .setMatrixRoomNotificationMode(roomId, nextMode)
          .catch(() => {
            const current = useSettingsStore.getState()
            if (current.getChannelNotificationLevel(roomId) === nextMode) {
              applyingRemoteSnapshot = true
              current.setChannelNotificationLevel(roomId, previousMode)
              applyingRemoteSnapshot = false
            }
            showToast(
              'Could not save notification settings for this room. Try again.',
              'error',
            )
          })
      }
      previous = { ...next }
    })

    const reconcilePushRules = async () => {
      const remoteModes = new Map<string, NotificationLevel>()
      const roomIds = [...new Set(roomIdsKey.split('\u0000'))]
      await mapSettledWithConcurrency(roomIds, 4, async (roomId) => {
        if (cancelled) return
        try {
          remoteModes.set(
            roomId,
            await bridge.getMatrixRoomNotificationMode(roomId),
          )
        } catch {
          // A newly joined room can briefly lack notification settings.
          // Keep the local optimistic mode until the next channel refresh.
        }
      }, () => !cancelled)
      if (cancelled) return

      const settings = useSettingsStore.getState()
      for (const [roomId, mode] of remoteModes) {
        if (locallyChangedRooms.has(roomId)) continue
        if (settings.getChannelNotificationLevel(roomId) !== mode) {
          applyingRemoteSnapshot = true
          settings.setChannelNotificationLevel(roomId, mode)
          applyingRemoteSnapshot = false
        }
      }
    }

    void reconcilePushRules()
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [focusRevision, matrixMode, roomIdsKey])
}
