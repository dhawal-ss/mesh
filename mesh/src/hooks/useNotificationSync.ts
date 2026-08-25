import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
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
import { disposeSubscription } from '../lib/subscription-cleanup'

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

/**
 * Bookkeeping for room notification writes, kept in a ref so it survives the
 * effect re-runs a channel-list refresh causes. `inFlight` counts unsettled
 * writes; `settledAt` is the tick of the most recent one that finished.
 */
interface RoomWriteState {
  inFlight: number
  settledAt: number
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
  const [notificationModeFailureCount, setNotificationModeFailureCount] = useState(0)
  const roomIdsKey = [...channels.map((channel) => channel.id), ...conversationOrder].join('\u0000')
  // Write bookkeeping has to outlive the effect: its deps include the room id
  // list, so a community refresh mid-write used to reset it, and the reconcile
  // then wrote the stale server value back over the choice the person had just
  // made, visibly reverting their menu selection.
  const roomWritesRef = useRef(new Map<string, RoomWriteState>())
  const writeTickRef = useRef(0)
  // Set while a remote snapshot is being applied to the settings store, so the
  // store subscription does not mistake it for a local change and echo it back
  // to the server. A reconcile from an earlier effect run can still be in
  // flight when the next run subscribes, so this cannot live in the effect.
  const applyingRemoteSnapshotRef = useRef(false)
  const activeRoomIdRef = useRef(activeRoomId)

  useEffect(() => {
    activeRoomIdRef.current = activeRoomId
  }, [activeRoomId])

  // A timed mute (a timestamp string, as opposed to null = indefinite or
  // undefined = not muted) only expires as wall-clock time advances, which is
  // driven exclusively by policyClock. Keep the ticking clock alive whenever a
  // timed mute exists, not just during quiet hours, or such mutes never expire.
  const hasTimedMute = useMemo(
    () =>
      Object.values(notifications.channelMuteUntil).some((until) => typeof until === 'string')
      || Object.values(notifications.communityMuteUntil).some((until) => typeof until === 'string'),
    [notifications.channelMuteUntil, notifications.communityMuteUntil],
  )

  useEffect(() => {
    if (!notifications.quietHours.enabled && !hasTimedMute) return
    const interval = window.setInterval(() => setPolicyClock(Date.now()), 30_000)
    return () => window.clearInterval(interval)
  }, [notifications.quietHours.enabled, hasTimedMute])

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

    // Registration is asynchronous, so re-running this on every room switch
    // left a window with no unread listener attached, and the counts emitted
    // in that window never reached the badges. The handler reads the open room
    // from a ref instead, so the listeners live for the hook's lifetime.
    const notificationListener = bridge.onMatrixNotification((notification) => {
      if (notification.roomId === activeRoomIdRef.current) return
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
          unreadMarked: update.unreadMarked,
        })
        return
      }
      if (useDmStore.getState().conversationEntities[update.roomId]) {
        patchConversation(update.roomId, {
          unreadCount: Math.min(update.unreadMessages, Number.MAX_SAFE_INTEGER),
          unreadMentions: Math.min(update.unreadMentions, Number.MAX_SAFE_INTEGER),
          unreadMarked: update.unreadMarked,
        })
      }
    })

    return () => {
      disposeSubscription(notificationListener, 'Matrix notification listener')
      disposeSubscription(unreadListener, 'Matrix unread listener')
    }
  }, [matrixMode, patchChannel, patchConversation])

  useEffect(() => {
    if (!matrixMode || !roomIdsKey) return
    let cancelled = false
    const roomWrites = roomWritesRef.current
    const applyRemoteSnapshot = (roomId: string, mode: NotificationLevel) => {
      applyingRemoteSnapshotRef.current = true
      useSettingsStore.getState().setChannelNotificationLevel(roomId, mode)
      applyingRemoteSnapshotRef.current = false
    }
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
        if (applyingRemoteSnapshotRef.current) continue

        const write = roomWrites.get(roomId) ?? { inFlight: 0, settledAt: 0 }
        write.inFlight += 1
        roomWrites.set(roomId, write)
        void bridge
          .setMatrixRoomNotificationMode(roomId, nextMode)
          .catch(() => {
            const current = useSettingsStore.getState()
            if (current.getChannelNotificationLevel(roomId) === nextMode) {
              applyRemoteSnapshot(roomId, previousMode)
            }
            showToast(
              'Could not save notification settings for this room. Try again.',
              'error',
            )
          })
          .finally(() => {
            // The room stops being protected only once its write settles, and
            // even then only for reconciles that start afterwards.
            write.inFlight -= 1
            write.settledAt = ++writeTickRef.current
          })
      }
      previous = { ...next }
    })

    const reconcilePushRules = async () => {
      // Everything this reconcile reads is a view of the server from this
      // point in time, so a write that settles later wins over it.
      const startedAt = ++writeTickRef.current
      const remoteModes = new Map<string, NotificationLevel>()
      const failedRoomIds = new Set<string>()
      const roomIds = [...new Set(roomIdsKey.split('\u0000'))]
      await mapSettledWithConcurrency(roomIds, 4, async (roomId) => {
        if (cancelled) return
        try {
          remoteModes.set(
            roomId,
            await bridge.getMatrixRoomNotificationMode(roomId),
          )
        } catch (error) {
          // A newly joined room can briefly lack notification settings.
          // Keep the local optimistic mode until the next channel refresh.
          failedRoomIds.add(roomId)
          console.warn('Failed to load notification settings for a room:', error)
        }
      }, () => !cancelled)
      if (cancelled) return
      setNotificationModeFailureCount(failedRoomIds.size)

      const settings = useSettingsStore.getState()
      for (const [roomId, mode] of remoteModes) {
        const write = roomWrites.get(roomId)
        // Skip rooms whose write is still unsettled, and rooms whose write
        // settled after this reconcile read the server: in both cases the
        // remote value in hand predates the person's choice.
        if (write && (write.inFlight > 0 || write.settledAt > startedAt)) continue
        if (settings.getChannelNotificationLevel(roomId) !== mode) {
          applyRemoteSnapshot(roomId, mode)
        }
      }
    }

    void reconcilePushRules()
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [focusRevision, matrixMode, roomIdsKey])

  const retryNotificationModeSync = useCallback(() => {
    setFocusRevision((revision) => revision + 1)
  }, [])

  return {
    notificationModeFailureCount:
      matrixMode && roomIdsKey ? notificationModeFailureCount : 0,
    retryNotificationModeSync,
  }
}
