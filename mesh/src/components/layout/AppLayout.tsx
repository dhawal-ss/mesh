import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  type CSSProperties,
} from 'react'
import { CommunitySidebar } from './CommunitySidebar'
import { ChannelSidebar } from './ChannelSidebar'
import { ContentArea } from './ContentArea'
import { DmSidebar } from './DmSidebar'
import { DmView } from '../chat/DmView'
import { useCommunitySync } from '../../hooks/useCommunitySync'
import { useChannelStore, type CommunityRefreshState } from '../../store/channels'
import { useCommunityStore } from '../../store/communities'
import { useDmStore, type LoadStatus } from '../../store/dms'
import { useIdentityStore } from '../../store/identity'
import { useSettingsStore } from '../../store/settings'
import { useShellStore } from '../../store/shell'
import * as bridge from '../../lib/bridge'
import { ScopedErrorBoundary } from '../ui/ScopedErrorBoundary'
import { Icon } from '../ui/Icon'
import { useNotificationSync } from '../../hooks/useNotificationSync'
import { useNetworkStore } from '../../store/network'
import { COMPACT_VIEWPORT_QUERY, useMediaQuery } from '../../hooks/useMediaQuery'
import {
  useQueuedMessageSync,
  type QueuedMessageSyncStatus,
} from '../../hooks/useQueuedMessageSync'
import { useFirstSessionRecoveryReminder } from '../../hooks/useFirstSessionRecoveryReminder'
import { useIgnoredUserSync } from '../../hooks/useIgnoredUserSync'
import { CONTEXT_SIDEBAR_WIDTH_KEY } from '../../lib/layout-preferences'
import { usePersistentPanelWidth } from '../../hooks/usePersistentPanelWidth'
import { PanelResizeHandle } from './PanelResizeHandle'
import { NetworkStatus } from '../ui/NetworkStatus'
import {
  isVisibleMeshRegion,
  MESH_REGION_SELECTOR,
  nextMeshRegion,
} from '../../lib/region-navigation'
import { VoiceDock } from '../voice/VoiceDock'
import { HomeSurface } from '../home/HomeSurface'
import { useCurrentMeshRoute, useMeshNavigationStore } from '../../store/navigation'
import { RouteSurface } from '../navigation/RouteSurface'
import { UserPanel } from './UserPanel'

const CommandPalette = lazy(() =>
  import('../navigation/CommandPalette').then((module) => ({ default: module.CommandPalette })),
)

export function hasAuthoritativeSavedRoomSnapshot(
  kind: 'room' | 'dm',
  conversationStatus: LoadStatus,
  roomStatus?: CommunityRefreshState['status'],
): boolean {
  return kind === 'dm' ? conversationStatus === 'loaded' : roomStatus === 'loaded'
}

export function QueuedMessageSyncNotice({
  status,
  onRetry,
}: {
  status: QueuedMessageSyncStatus
  onRetry: () => void
}) {
  const failed = status === 'failed' || status === 'retrying-failed'
  const degraded = status === 'degraded' || status === 'retrying-degraded'
  const retrying = status === 'retrying-failed' || status === 'retrying-degraded'
  if (!degraded && !failed) return null

  return (
    <div
      role={failed ? 'alert' : 'status'}
      className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1 border-b border-status-warning/30 bg-status-warning/10 px-4 py-2 text-center text-xs text-content"
    >
      <span>
        {failed
          ? 'Mesh couldn’t restore saved messages. They are still saved on this device.'
          : 'Saved messages are visible, but their status may not update yet.'}
      </span>
      <button
        type="button"
        className="font-semibold text-accent hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        onClick={onRetry}
        disabled={retrying}
      >
        {retrying ? 'Trying again…' : 'Try again'}
      </button>
    </div>
  )
}

export function AppLayout({ onSignInRequired }: { onSignInRequired: () => void }) {
  useCommunitySync()
  const matrixMode = bridge.isMatrixBackend()
  useIgnoredUserSync(matrixMode)
  const networkStatus = useNetworkStore((state) => state.status)
  const recoveredConnection = useNetworkStore((state) => state.recoveredConnection)
  const queuedMessageSync = useQueuedMessageSync(
    matrixMode,
    recoveredConnection?.recoveredAt,
  )
  const directMessagesAvailable = bridge.getBackendCapabilities().directMessages
  const activeChannelId = useChannelStore((state) => state.activeChannelId)
  const activeChannel = useChannelStore((state) => (
    state.activeChannelId ? state.channelEntities[state.activeChannelId] : undefined
  ))
  const channelEntities = useChannelStore((state) => state.channelEntities)
  const setActiveChannel = useChannelStore((state) => state.setActiveChannel)
  const activeCommunityId = useCommunityStore((state) => state.activeCommunityId)
  const communityEntities = useCommunityStore((state) => state.communityEntities)
  const setActiveCommunity = useCommunityStore((state) => state.setActiveCommunity)
  const patchChannel = useChannelStore((state) => state.patchChannel)
  const isDmMode = useDmStore((state) => state.isDmMode)
  const activeConversationId = useDmStore((state) => state.activeConversationId)
  const conversationEntities = useDmStore((state) => state.conversationEntities)
  const setActiveConversation = useDmStore((state) => state.setActiveConversation)
  const setDmMode = useDmStore((state) => state.setDmMode)
  const dismissBackupReminder = useSettingsStore((state) => state.dismissBackupReminder)
  const pendingInvitation = useShellStore((state) => state.pendingInvitation)
  const foregroundInvitationHandle = useShellStore(
    (state) => state.foregroundInvitationHandle,
  )
  const contextSidebarWidth = usePersistentPanelWidth({
    storageKey: CONTEXT_SIDEBAR_WIDTH_KEY,
    defaultWidth: 250,
    minimum: 208,
    maximum: 280,
  })

  const myPublicKey = useIdentityStore((state) => state.identity?.publicKey)
  const roomTabAccountId = myPublicKey ?? 'local-device'
  const route = useCurrentMeshRoute()
  const backupReminderDue = useFirstSessionRecoveryReminder({
    matrixMode,
    accountId: myPublicKey ?? null,
    successfulUse: queuedMessageSync.status === 'ready'
      || queuedMessageSync.status === 'degraded',
    invitationForegrounded: route.kind === 'invitation'
      || foregroundInvitationHandle !== null,
  })
  const navigationHydrated = useMeshNavigationStore((state) => state.hydrated)
  const initializeNavigation = useMeshNavigationStore((state) => state.initialize)
  const navigate = useMeshNavigationStore((state) => state.navigate)
  const goBack = useMeshNavigationStore((state) => state.back)
  const goForward = useMeshNavigationStore((state) => state.forward)
  const focusRequest = useMeshNavigationStore((state) => state.focusRequest)
  const drawer = useMeshNavigationStore((state) => state.drawer)
  const setDrawer = useMeshNavigationStore((state) => state.setDrawer)
  const contextNavigationOpen = drawer === 'context'
  const contextNavigationRef = useRef<HTMLElement>(null)
  const activeRoomId = isDmMode ? activeConversationId : activeChannelId
  /*
   * The navigation drawer only exists below 800px. Deriving "is the drawer
   * actually a drawer right now" from the media query: rather than latching it
   * when the drawer opened: fixes a keyboard trap: widening the window used to
   * leave the Tab cycle and `aria-modal` installed on a sidebar that had
   * reverted to a static column, with its only Close control display:none.
   */
  const isCompactViewport = useMediaQuery(COMPACT_VIEWPORT_QUERY)
  const drawerActive = contextNavigationOpen && isCompactViewport
  const closeNavigationDrawer = useCallback((restoreFocus = true) => {
    setDrawer('none')
    if (restoreFocus && typeof document !== 'undefined') {
      window.requestAnimationFrame(() => {
        document.querySelector<HTMLButtonElement>('.mesh-compact-header button')?.focus()
      })
    }
  }, [setDrawer])
  // Naming the main landmark after the open conversation is far more useful for
  // landmark navigation than the previous static "Content area".
  const directRouteActive = route.kind === 'direct'
  const roomNavigationVisible = route.kind === 'room'
    || route.kind === 'voice'
    || route.kind === 'community'
    || route.kind === 'community-admin'
    || directRouteActive
  const activeConversationLabel = route.kind === 'home'
    ? 'Home'
    : route.kind === 'communities'
      ? 'Communities'
      : route.kind === 'community'
        ? `${communityEntities[route.communityId]?.name ?? 'Community'} community`
        : route.kind === 'you'
          ? 'You'
          : route.kind === 'invitation'
            ? 'Community invitation'
            : route.kind === 'community-admin'
              ? `${communityEntities[route.communityId]?.name ?? 'Community'} settings`
    : directRouteActive
              ? 'Direct message conversation'
              : activeChannel?.name
                ? `Conversation in ${activeChannel.name}`
                : 'Conversation'
  useNotificationSync({
    matrixMode,
    accountUserId: matrixMode ? (myPublicKey ?? null) : null,
    activeRoomId,
  })

  useEffect(() => {
    initializeNavigation(roomTabAccountId)
  }, [initializeNavigation, roomTabAccountId])

  useEffect(() => {
    if (!navigationHydrated || !foregroundInvitationHandle) return
    if (route.kind === 'invitation' && route.handle === foregroundInvitationHandle) return
    navigate({ kind: 'invitation', handle: foregroundInvitationHandle })
  }, [foregroundInvitationHandle, navigate, navigationHydrated, route])

  useEffect(() => {
    if (!navigationHydrated) return
    if (route.kind === 'room') {
      if (!channelEntities[route.roomId]) return
      setDmMode(false)
      setActiveCommunity(route.communityId)
      setActiveChannel(route.roomId)
      return
    }
    if (route.kind === 'direct') {
      if (!conversationEntities[route.conversationId]) return
      setDmMode(true)
      setActiveConversation(route.conversationId)
      return
    }
    if (route.kind === 'voice') {
      if (!channelEntities[route.roomId]) return
      setDmMode(false)
      setActiveCommunity(route.communityId)
      setActiveChannel(route.roomId)
      return
    }
    if (route.kind === 'community' || route.kind === 'community-admin') {
      setDmMode(false)
      setActiveCommunity(route.communityId)
    }
  }, [
    channelEntities,
    conversationEntities,
    navigationHydrated,
    route,
    setActiveChannel,
    setActiveCommunity,
    setActiveConversation,
    setDmMode,
  ])

  useEffect(() => {
    if (focusRequest === 0) return
    let framesRemaining = 4
    let focusFrame = 0
    const focusRouteHeading = () => {
      document.querySelector<HTMLElement>('[data-mesh-route-heading]')?.focus({
        preventScroll: true,
      })
      framesRemaining -= 1
      if (framesRemaining > 0) {
        focusFrame = window.requestAnimationFrame(focusRouteHeading)
      }
    }
    focusFrame = window.requestAnimationFrame(focusRouteHeading)
    return () => window.cancelAnimationFrame(focusFrame)
  }, [focusRequest])

  useEffect(() => {
    const communityName = route.kind === 'room' || route.kind === 'voice'
      ? communityEntities[route.communityId]?.name
      : route.kind === 'community' || route.kind === 'community-admin'
        ? communityEntities[route.communityId]?.name
        : null
    const roomName = route.kind === 'room' || route.kind === 'voice'
      ? useChannelStore.getState().channelEntities[route.roomId]?.name
      : null
    const conversationName = route.kind === 'direct'
      ? useDmStore.getState().conversationEntities[route.conversationId]?.peerDisplayName
      : null
    document.title = route.kind === 'home'
      ? 'Home | Mesh'
      : route.kind === 'you'
        ? 'You | Mesh'
        : route.kind === 'invitation'
          ? `Invitation to ${pendingInvitation?.communityName?.trim() || 'a community'} | Mesh`
        : route.kind === 'direct'
          ? `${conversationName ?? 'Messages'} | Mesh`
          : route.kind === 'room'
            ? `#${roomName ?? 'Room'}${communityName ? ` | ${communityName}` : ''} | Mesh`
            : route.kind === 'voice'
              ? `${roomName ?? 'Voice'} | Mesh`
              : communityName
                ? `${communityName} | Mesh`
                : 'Mesh'
  }, [communityEntities, pendingInvitation?.communityName, route])

  useEffect(() => {
    const handleProductHistory = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented
        || !event.altKey
        || event.ctrlKey
        || event.metaKey
        || event.shiftKey
        || (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight')
      ) {
        return
      }
      event.preventDefault()
      if (event.key === 'ArrowLeft') goBack()
      else goForward()
    }
    window.addEventListener('keydown', handleProductHistory)
    return () => window.removeEventListener('keydown', handleProductHistory)
  }, [goBack, goForward])

  useEffect(() => {
    if (!directMessagesAvailable && isDmMode) setDmMode(false)
  }, [directMessagesAvailable, isDmMode, setDmMode])

  useEffect(() => {
    const handleRegionCycle = (event: KeyboardEvent) => {
      if (
        event.key !== 'F6'
        || event.defaultPrevented
        || event.altKey
        || event.ctrlKey
        || event.metaKey
        || document.querySelector('[role="dialog"][aria-modal="true"]')
      ) {
        return
      }

      const regions = [...document.querySelectorAll<HTMLElement>(MESH_REGION_SELECTOR)]
        .filter(isVisibleMeshRegion)
      const nextRegion = nextMeshRegion(regions, document.activeElement, event.shiftKey)
      if (!nextRegion) return

      event.preventDefault()
      nextRegion.focus({ preventScroll: true })
    }

    document.addEventListener('keydown', handleRegionCycle)
    return () => document.removeEventListener('keydown', handleRegionCycle)
  }, [])

  useLayoutEffect(() => {
    if (!drawerActive) return
    const focusableSelector = [
      'button:not([disabled])',
      'a[href]',
      'input:not([disabled])',
      'select:not([disabled])',
      'textarea:not([disabled])',
      '[tabindex]:not([tabindex="-1"])',
    ].join(',')
    const focusFirstElement = () => {
      const drawer = contextNavigationRef.current
      if (!drawer) return
      const firstVisible = [...drawer.querySelectorAll<HTMLElement>(focusableSelector)]
        .find((element) => !element.hidden && element.getClientRects().length > 0)
      ;(firstVisible ?? drawer).focus()
    }
    contextNavigationRef.current?.focus()
    focusFirstElement()
    const focusFirst = window.requestAnimationFrame(focusFirstElement)
    const handleKeyDown = (event: KeyboardEvent) => {
      const openDialog = document.querySelector('[role="dialog"]')
      const nestedDialogOpen = openDialog != null && openDialog !== contextNavigationRef.current
      if (event.key === 'Escape' && !event.defaultPrevented && !nestedDialogOpen) {
        event.preventDefault()
        closeNavigationDrawer()
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
  }, [closeNavigationDrawer, drawerActive])

  useEffect(() => {
    const unlisten = matrixMode
      ? Promise.resolve(() => {})
      : bridge.onMessageReceived((message) => {
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
      })

    return () => {
      unlisten.then((fn) => fn())
    }
  }, [activeChannelId, isDmMode, matrixMode, patchChannel])

  // The user IS a peer. A mesh of size 1 (just them) is a VALID working
  // state: they can send messages, create communities, queue things for
  // delivery. We only surface a banner when something actually blocks
  // them, not just because they're solo.
  //
  // Banner is NEVER shown for solo mode. If the swarm task hasn't started
  // at all (real failure), the user sees errors elsewhere. Solo is
  // advertised gently via the sidebar indicator instead.
  return (
    <div className="mesh-app-shell relative flex h-full flex-col overflow-hidden bg-surface-base text-content">
      {/*
        Skip link. The room list is a flat list of buttons, so in a community
        with forty rooms it cost forty-plus Tab presses to reach the
        conversation. This is the first thing in the tab order.
      */}
      <a
        href="#mesh-conversation"
        className="sr-only rounded-control bg-surface-overlay px-3 py-2 text-sm font-medium text-content shadow-overlay focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-tooltip"
      >
        Skip to conversation
      </a>
      <Suspense fallback={null}>
        <CommandPalette />
      </Suspense>
      {backupReminderDue && (
        <div
          role="status"
          className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1 border-b border-status-warning/30 bg-status-warning/10 px-4 py-2 text-xs text-content"
        >
          <span>Message backup needs attention. Check it in Your devices.</span>
          <button
            type="button"
            className="font-semibold text-accent hover:underline"
            onClick={() => navigate({ kind: 'you', section: 'safety-devices' })}
          >
            Review backup
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
          You are offline. Saved rooms stay available. New activity will arrive when the connection returns.
        </div>
      )}
      {matrixMode && recoveredConnection && networkStatus.state === 'connected' && (
        <div
          role="status"
          className="border-b border-status-success/30 bg-status-success/10 px-4 py-2 text-center text-xs text-content"
        >
          {queuedMessageSync.status === 'ready'
            ? 'Connection restored. Saved messages can continue sending and new activity can arrive.'
            : 'Connection restored. New activity can arrive.'}
        </div>
      )}
      {matrixMode && (
        <QueuedMessageSyncNotice
          status={queuedMessageSync.status}
          onRetry={queuedMessageSync.retry}
        />
      )}
      <div className="mesh-workspace-frame flex min-h-0 min-w-0 flex-1 overflow-hidden">
        <nav
          className="mesh-community-rail flex min-h-0 flex-shrink-0 flex-col items-center overflow-y-auto border-r border-border-subtle bg-surface-sunken pt-2"
          aria-label="Communities and direct messages"
          data-mesh-region
          tabIndex={-1}
        >
          <ScopedErrorBoundary
            name="Community navigation"
            description="Community shortcuts could not be displayed."
            resetKey={activeCommunityId}
          >
            <CommunitySidebar />
          </ScopedErrorBoundary>
          <div className="mt-auto pb-3 flex flex-col items-center">
            <NetworkStatus matrixMode={matrixMode} />
          </div>
        </nav>

        {drawerActive && (
          <button
            type="button"
            className="mesh-nav-backdrop"
            aria-label="Dismiss room navigation"
            onClick={() => closeNavigationDrawer()}
          />
        )}

        {roomNavigationVisible && <aside
          ref={contextNavigationRef}
          id="mesh-context-sidebar"
          data-open={contextNavigationOpen ? 'true' : 'false'}
          className="mesh-context-sidebar relative flex min-h-0 flex-shrink-0 flex-col border-r border-border-subtle bg-surface-sidebar"
          data-design-token-exception="user-resizable-persisted-context-sidebar-width"
          style={{
            '--mesh-context-sidebar-width': `${contextSidebarWidth.width}px`,
          } as CSSProperties}
          aria-label={directRouteActive && directMessagesAvailable ? 'Direct message conversations' : 'Room list'}
          data-mesh-region
          tabIndex={-1}
          /* Only a real drawer is a modal dialog. Above the compact breakpoint
             this is an ordinary static column and must not claim aria-modal. */
          data-state={drawerActive ? 'open' : undefined}
          role={drawerActive ? 'dialog' : undefined}
          aria-modal={drawerActive || undefined}
        >
          {drawerActive && (
            <div className="flex min-h-11 flex-shrink-0 items-center justify-between border-b border-border-subtle px-2">
              <span className="min-w-0 truncate px-2 text-sm font-semibold text-secondary">
                {directRouteActive && directMessagesAvailable ? 'Conversations' : 'Rooms'}
              </span>
              <button
                type="button"
                className="flex min-h-11 min-w-11 flex-shrink-0 items-center justify-center rounded-control text-muted transition-colors hover:bg-surface-hover hover:text-secondary"
                aria-label={directRouteActive ? 'Close conversation navigation drawer' : 'Close room navigation drawer'}
                onClick={() => closeNavigationDrawer()}
              >
                <Icon name="x" size="sm" />
              </button>
            </div>
          )}
          <PanelResizeHandle
            label="Resize room navigation"
            side="right"
            value={contextSidebarWidth.width}
            minimum={208}
            maximum={280}
            onPointerDown={contextSidebarWidth.startResize}
            onResizeBy={contextSidebarWidth.resizeBy}
          />
          <ScopedErrorBoundary
            name={directRouteActive && directMessagesAvailable ? 'Conversation list' : 'Room list'}
            description="Navigation failed to render. The current conversation remains available."
            className="m-2"
            resetKey={`${directRouteActive ? 'dm' : 'channel'}:${activeCommunityId ?? ''}`}
          >
            {directRouteActive && directMessagesAvailable ? <DmSidebar /> : <ChannelSidebar />}
          </ScopedErrorBoundary>
        </aside>}

        <main
          id="mesh-conversation"
          tabIndex={-1}
          className="mesh-workspace-main flex min-h-0 min-w-0 flex-1 flex-col bg-surface-base outline-none"
          aria-label={activeConversationLabel}
          data-mesh-region
        >
          {roomNavigationVisible && <div className="mesh-compact-header">
            <button
              type="button"
              className="flex h-8 items-center gap-2 rounded-control px-2 text-sm font-medium text-secondary hover:bg-surface-hover hover:text-primary"
              aria-controls="mesh-context-sidebar"
              aria-expanded={contextNavigationOpen}
              aria-label={
                contextNavigationOpen
                  ? 'Close room navigation'
                  : directRouteActive
                    ? 'Open conversation navigation'
                    : 'Open room navigation'
              }
              onClick={() => setDrawer(contextNavigationOpen ? 'none' : 'context')}
            >
              <Icon name={contextNavigationOpen ? 'x' : 'menu'} size="sm" />
              {contextNavigationOpen ? 'Close' : directRouteActive ? 'Conversations' : 'Rooms'}
            </button>
            <span className="truncate text-xs text-muted">
              {route.kind === 'direct'
                ? 'Direct messages'
                : route.kind === 'community' || route.kind === 'community-admin'
                  ? communityEntities[route.communityId]?.name ?? 'Community'
                  : route.kind === 'room' || route.kind === 'voice'
                    ? communityEntities[route.communityId]?.name ?? 'Community'
                    : 'Mesh'}
            </span>
          </div>}
          <div className="flex min-h-0 min-w-0 flex-1 overflow-hidden">
            {route.kind === 'home' ? (
              <HomeSurface />
            ) : route.kind === 'community'
              || route.kind === 'communities'
              || route.kind === 'you'
              || route.kind === 'invitation'
              || route.kind === 'community-admin' ? (
              <RouteSurface route={route} onSignInRequired={onSignInRequired} />
            ) : directRouteActive && directMessagesAvailable ? (
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
      <div className="mesh-party-strip-row flex flex-shrink-0">
        <div className="mesh-party-strip-rail-spacer flex-shrink-0 border-r border-border-subtle bg-surface-sunken" aria-hidden="true" />
        <VoiceDock />
      </div>
      {!roomNavigationVisible && <UserPanel controls={false} />}
    </div>
  )
}
