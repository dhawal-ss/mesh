import { lazy, Suspense, useEffect, useRef, useState } from 'react'
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
import { ScopedErrorBoundary } from '../ui/ScopedErrorBoundary'
import { Icon } from '../ui/Icon'
import { useNotificationSync } from '../../hooks/useNotificationSync'
import { getEffectiveChannelNotificationLevel } from '../../store/settings'
import { useNetworkStore } from '../../store/network'
import { useQueuedMessageSync } from '../../hooks/useQueuedMessageSync'

const CommandPalette = lazy(() =>
  import('../navigation/CommandPalette').then((module) => ({ default: module.CommandPalette })),
)

export function AppLayout() {
  useCommunitySync()
  const matrixMode = bridge.isMatrixBackend()
  useQueuedMessageSync(matrixMode)
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
  const networkStatus = useNetworkStore((state) => state.status)

  const myPublicKey = useIdentityStore((state) => state.identity?.publicKey)
  const [contextNavigationOpen, setContextNavigationOpen] = useState(false)
  const contextNavigationRef = useRef<HTMLElement>(null)
  const activeRoomId = isDmMode ? activeConversationId : activeChannelId
  useNotificationSync({ matrixMode, activeRoomId })

  useEffect(() => {
    if (!directMessagesAvailable && isDmMode) setDmMode(false)
  }, [directMessagesAvailable, isDmMode, setDmMode])

  useEffect(() => {
    setContextNavigationOpen(false)
  }, [activeChannelId, activeCommunityId, isDmMode])

  useEffect(() => {
    if (!contextNavigationOpen) return
    const compact = typeof window.matchMedia === 'function'
      && window.matchMedia('(max-width: 799px)').matches
    if (!compact) return
    const focusableSelector = [
      'button:not([disabled])',
      'a[href]',
      'input:not([disabled])',
      'select:not([disabled])',
      'textarea:not([disabled])',
      '[tabindex]:not([tabindex="-1"])',
    ].join(',')
    const focusFirst = window.requestAnimationFrame(() => {
      contextNavigationRef.current?.querySelector<HTMLElement>(focusableSelector)?.focus()
    })
    const handleKeyDown = (event: KeyboardEvent) => {
      const openDialog = document.querySelector('[role="dialog"]')
      const nestedDialogOpen = openDialog != null && openDialog !== contextNavigationRef.current
      if (event.key === 'Escape' && !event.defaultPrevented && !nestedDialogOpen) {
        event.preventDefault()
        setContextNavigationOpen(false)
        window.requestAnimationFrame(() => {
          document.querySelector<HTMLButtonElement>('.mesh-compact-header button')?.focus()
        })
        return
      }
      if (event.key !== 'Tab') return
      const focusable = [...(contextNavigationRef.current?.querySelectorAll<HTMLElement>(focusableSelector) ?? [])]
        .filter((element) => !element.hidden && element.getClientRects().length > 0)
      if (focusable.length === 0) return
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      window.cancelAnimationFrame(focusFirst)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [contextNavigationOpen])

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
  const remotePeerCount = networkStatus.peerCount
  const isRunningSolo =
    !matrixMode
    && networkStatus.state !== 'connecting'
    && networkStatus.state !== 'disconnected'
    && remotePeerCount === 0
  const networkLabel = matrixMode
    ? networkStatus.state === 'connected'
      ? 'Online'
      : networkStatus.state === 'connecting'
        ? 'Connecting'
        : 'Offline'
    : networkStatus.state === 'connecting'
      ? 'Starting'
      : networkStatus.state === 'disconnected'
        ? 'Offline'
        : isRunningSolo
          ? 'Solo (you)'
          : `You + ${remotePeerCount}`
  const networkDescription = matrixMode
    ? networkStatus.state === 'connected'
      ? 'Connected to Mesh'
      : networkStatus.state === 'connecting'
        ? 'Connecting to Mesh'
        : 'Mesh is offline. It will retry automatically.'
    : networkStatus.state === 'connecting'
      ? 'Starting Mesh'
      : isRunningSolo
        ? 'You are running as a solo peer. Messages are stored locally and will sync when other peers join.'
        : networkStatus.state === 'disconnected'
          ? 'Mesh is offline. It will retry automatically.'
          : `Connected to ${remotePeerCount} other peer${remotePeerCount === 1 ? '' : 's'}`

  return (
    <div className="relative flex h-screen flex-col overflow-hidden bg-surface-base text-content">
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
      {matrixMode && networkStatus.state === 'disconnected' && (
        <div
          role="status"
          className="border-b border-status-warning/30 bg-status-warning/10 px-4 py-2 text-center text-xs text-content"
        >
          You’re offline. Messages marked Saved will send when Mesh reconnects.
        </div>
      )}
      <div className="flex flex-1 overflow-hidden">
        <nav
          className="mesh-community-rail flex flex-shrink-0 flex-col items-center overflow-y-auto border-r border-border-subtle bg-surface-sunken pt-2"
          aria-label="Communities and direct messages"
        >
          <ScopedErrorBoundary
            name="Community navigation"
            description="Community shortcuts could not be displayed."
            resetKey={activeCommunityId}
          >
            <CommunitySidebar />
          </ScopedErrorBoundary>
          <div className="mt-auto pb-3 flex flex-col items-center">
            <div
              className="flex max-w-full items-center justify-center gap-1.5 px-1 text-center text-caption text-muted"
              role="status"
              aria-label={networkDescription}
              title={networkDescription}
            >
              <span
                className={`w-2 h-2 rounded-full flex-shrink-0 ${
                  // Connected is verified green; every recoverable network state uses attention amber.
                  matrixMode
                    ? networkStatus.state === 'connected'
                      ? 'bg-status-success'
                      : 'bg-status-warning'
                    : networkStatus.state === 'connecting'
                      ? 'bg-status-warning'
                      : isRunningSolo
                        ? 'bg-status-warning'
                        : networkStatus.state === 'connected'
                          ? 'bg-status-success'
                          : 'bg-status-warning'
                }`}
                aria-hidden
              />
              <span className="mesh-network-label min-w-0 truncate">{networkLabel}</span>
            </div>
          </div>
        </nav>

        {contextNavigationOpen && (
          <button
            type="button"
            className="mesh-nav-backdrop"
            aria-label="Dismiss room navigation"
            onClick={() => setContextNavigationOpen(false)}
          />
        )}

        <aside
          ref={contextNavigationRef}
          id="mesh-context-sidebar"
          data-open={contextNavigationOpen ? 'true' : 'false'}
          className="mesh-context-sidebar flex flex-shrink-0 flex-col border-r border-border-subtle bg-surface-sidebar"
          aria-label={isDmMode && directMessagesAvailable ? 'Direct message conversations' : 'Room list'}
          role={contextNavigationOpen ? 'dialog' : undefined}
          aria-modal={contextNavigationOpen || undefined}
        >
          <ScopedErrorBoundary
            name={isDmMode && directMessagesAvailable ? 'Conversation list' : 'Room list'}
            description="Navigation failed to render. The current conversation remains available."
            className="m-2"
            resetKey={`${isDmMode ? 'dm' : 'channel'}:${activeCommunityId ?? ''}`}
          >
            {isDmMode && directMessagesAvailable ? <DmSidebar /> : <ChannelSidebar />}
          </ScopedErrorBoundary>
        </aside>

        <main className="flex min-w-0 flex-1 flex-col bg-surface-base" aria-label="Content area">
          <div className="mesh-compact-header">
            <button
              type="button"
              className="flex h-8 items-center gap-2 rounded-control px-2 text-sm font-medium text-secondary hover:bg-surface-hover hover:text-primary"
              aria-controls="mesh-context-sidebar"
              aria-expanded={contextNavigationOpen}
              aria-label={
                contextNavigationOpen
                  ? 'Close room navigation'
                  : isDmMode
                    ? 'Open conversation navigation'
                    : 'Open room navigation'
              }
              onClick={() => setContextNavigationOpen((open) => !open)}
            >
              <Icon name={contextNavigationOpen ? 'x' : 'menu'} size="sm" />
              {contextNavigationOpen ? 'Close' : isDmMode ? 'Conversations' : 'Rooms'}
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
