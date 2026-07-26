import { lazy, Suspense, useEffect, useState } from 'react'
import { CommunitySidebar } from './CommunitySidebar'
import { ChannelSidebar } from './ChannelSidebar'
import { ContentArea } from './ContentArea'
import { DmSidebar } from './DmSidebar'
import { DmView } from '../chat/DmView'
import { useCommunitySync } from '../../hooks/useCommunitySync'
import { useChannelStore } from '../../store/channels'
import { useCommunityStore } from '../../store/communities'
import { useDmStore } from '../../store/dms'
import { useIdentityStore } from '../../store/identity'
import { isBackupReminderDue, useSettingsStore } from '../../store/settings'
import { useShellStore } from '../../store/shell'
import * as bridge from '../../lib/bridge'
import { playNotificationSound } from '../../lib/bridge'
import type { NetworkStatus } from '../../types/ipc'
import { ScopedErrorBoundary } from '../ui/ScopedErrorBoundary'
import { Icon } from '../ui/Icon'
import { useNotificationSync } from '../../hooks/useNotificationSync'
import { getEffectiveChannelNotificationLevel } from '../../store/settings'

const CommandPalette = lazy(() =>
  import('../navigation/CommandPalette').then((module) => ({ default: module.CommandPalette })),
)

export function AppLayout() {
  useCommunitySync()
  const matrixMode = bridge.isMatrixBackend()
  const directMessagesAvailable = bridge.getBackendCapabilities().directMessages
  const activeChannelId = useChannelStore((state) => state.activeChannelId)
  const activeCommunityId = useCommunityStore((state) => state.activeCommunityId)
  const patchChannel = useChannelStore((state) => state.patchChannel)
  const isDmMode = useDmStore((state) => state.isDmMode)
  const activeConversationId = useDmStore((state) => state.activeConversationId)
  const setDmMode = useDmStore((state) => state.setDmMode)
  const backup = useSettingsStore((state) => state.backup)
  const dismissBackupReminder = useSettingsStore((state) => state.dismissBackupReminder)
  const setProfileOpen = useShellStore((state) => state.setProfileOpen)
  const backupReminderDue = isBackupReminderDue(backup)

  const myPublicKey = useIdentityStore((state) => state.identity?.publicKey)
  const [networkStatus, setNetworkStatus] = useState<NetworkStatus | null>(null)
  const [contextNavigationOpen, setContextNavigationOpen] = useState(false)
  const activeRoomId = isDmMode ? activeConversationId : activeChannelId
  useNotificationSync({ matrixMode, activeRoomId })

  useEffect(() => {
    if (!directMessagesAvailable && isDmMode) setDmMode(false)
  }, [directMessagesAvailable, isDmMode, setDmMode])

  useEffect(() => {
    setContextNavigationOpen(false)
  }, [activeChannelId, activeCommunityId, isDmMode])

  useEffect(() => {
    if (matrixMode) return
    const unlisten = bridge.onNetworkStatus((status) => {
      setNetworkStatus(status)
    })
    return () => { unlisten.then((fn) => fn()) }
  }, [matrixMode])

  useEffect(() => {
    const unlisten = matrixMode
      ? Promise.resolve(() => {})
      : bridge.onMessageReceived((message) => {
        const isOwnMessage = myPublicKey && message.authorPublicKey === myPublicKey
        const isActiveChannel = message.channelId === activeChannelId && !isDmMode

        if (isActiveChannel) {
          return
        }

        const channel = useChannelStore
          .getState()
          .channelEntities[message.channelId]
        patchChannel(message.channelId, {
          unreadCount: (channel?.unreadCount ?? 0) + 1,
        })

        // Legacy builds retain their renderer event while Matrix uses the
        // SDK-owned notification and unread streams installed above.
        if (!isOwnMessage) {
          const { notifications } = useSettingsStore.getState()
          const level = getEffectiveChannelNotificationLevel(
            notifications,
            message.channelId,
            channel?.communityId,
          )
          if (notifications.sound && level === 'all') {
            playNotificationSound(notifications.soundId)
          }
        }
      })

    return () => {
      unlisten.then((fn) => fn())
    }
  }, [activeChannelId, isDmMode, matrixMode, patchChannel, myPublicKey])

  // The user IS a peer. A mesh of size 1 (just them) is a VALID working
  // state — they can send messages, create communities, queue things for
  // delivery. We only surface a banner when something actually blocks
  // them, not just because they're solo.
  //
  // Banner is NEVER shown for solo mode. If the swarm task hasn't started
  // at all (real failure), the user sees errors elsewhere. Solo is
  // advertised gently via the sidebar indicator instead.
  const remotePeerCount = networkStatus?.peerCount ?? 0
  const isRunningSolo = networkStatus !== null && remotePeerCount === 0

  return (
    <div className="relative flex h-screen flex-col overflow-hidden">
      <Suspense fallback={null}>
        <CommandPalette />
      </Suspense>
      {backupReminderDue && (
        <div
          role="status"
          className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1 border-b border-status-warning/30 bg-status-warning/10 px-4 py-2 text-xs text-content"
        >
          <span>Your messages are not backed up yet. Save a backup code in Your devices.</span>
          <button
            type="button"
            className="font-semibold text-accent hover:underline"
            onClick={() => setProfileOpen(true)}
          >
            Open profile
          </button>
          <button
            type="button"
            className="text-content-secondary hover:text-content"
            aria-label="Dismiss backup reminder"
            onClick={dismissBackupReminder}
          >
            Not now
          </button>
        </div>
      )}
      <div className="flex flex-1 overflow-hidden">
        {/* Server icon bar — Discord: 72px, dark */}
        <nav
          className="mesh-community-rail flex flex-shrink-0 flex-col items-center overflow-y-auto bg-bg-tertiary pt-3"
          aria-label="Servers and DMs"
        >
          <ScopedErrorBoundary
            name="Server navigation"
            description="Server shortcuts could not be displayed."
            resetKey={activeCommunityId}
          >
            <CommunitySidebar />
          </ScopedErrorBoundary>
          <div className="mt-auto pb-3 flex flex-col items-center">
            <div className="flex items-center gap-1.5 px-1 text-center text-caption text-muted"
              title={
                matrixMode
                  ? 'Connected to Mesh'
                  : isRunningSolo
                  ? 'You are running as a solo peer. Messages are stored locally and will sync when other peers join.'
                  : `Connected to ${remotePeerCount} other peer${remotePeerCount === 1 ? '' : 's'}`
              }
            >
              <span
                className={`w-2 h-2 rounded-full flex-shrink-0 ${
                  // Solo = yellow (working but alone), connected = green, not started = red
                  matrixMode
                    ? 'bg-green'
                    : networkStatus === null
                    ? 'bg-red'
                    : isRunningSolo
                      ? 'bg-yellow'
                      : 'bg-green'
                }`}
                aria-hidden
              />
              <span>
                {matrixMode
                  ? 'Online'
                  : networkStatus === null
                  ? 'Starting'
                  : isRunningSolo
                    ? 'Solo (you)'
                    : `You + ${remotePeerCount}`}
              </span>
            </div>
          </div>
        </nav>

        {/* Channel/DM sidebar — Discord: 240px */}
        {contextNavigationOpen && (
          <button
            type="button"
            className="mesh-nav-backdrop"
            aria-label="Close channel navigation"
            onClick={() => setContextNavigationOpen(false)}
          />
        )}

        <aside
          id="mesh-context-sidebar"
          data-open={contextNavigationOpen ? 'true' : 'false'}
          className="mesh-context-sidebar flex flex-shrink-0 flex-col bg-bg-secondary"
          aria-label={isDmMode && directMessagesAvailable ? 'Direct message conversations' : 'Channel list'}
        >
          <ScopedErrorBoundary
            name={isDmMode && directMessagesAvailable ? 'Conversation list' : 'Channel list'}
            description="Navigation failed to render. The current conversation remains available."
            className="m-2"
            resetKey={`${isDmMode ? 'dm' : 'channel'}:${activeCommunityId ?? ''}`}
          >
            {isDmMode && directMessagesAvailable ? <DmSidebar /> : <ChannelSidebar />}
          </ScopedErrorBoundary>
        </aside>

        {/* Main content area */}
        <main className="flex min-w-0 flex-1 flex-col bg-bg-primary" aria-label="Content area">
          <div className="mesh-compact-header">
            <button
              type="button"
              className="flex h-8 items-center gap-2 rounded px-2 text-sm font-medium text-secondary hover:bg-bg-modifier-hover hover:text-primary"
              aria-controls="mesh-context-sidebar"
              aria-expanded={contextNavigationOpen}
              onClick={() => setContextNavigationOpen((open) => !open)}
            >
              <Icon name={contextNavigationOpen ? 'x' : 'menu'} size="sm" />
              {contextNavigationOpen ? 'Close' : isDmMode ? 'Conversations' : 'Channels'}
            </button>
            <span className="truncate text-xs text-muted">
              {matrixMode ? 'Encrypted session' : 'Local Mesh session'}
            </span>
          </div>
          <div className="flex min-h-0 flex-1">
            {isDmMode && directMessagesAvailable ? (
              <ScopedErrorBoundary
                name="Direct messages"
                description="This conversation could not be displayed. Choose another conversation or retry."
                className="m-4"
                resetKey={activeConversationId}
              >
                <DmView />
              </ScopedErrorBoundary>
            ) : (
              <ContentArea />
            )}
          </div>
        </main>
      </div>
    </div>
  )
}
