import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
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
import { isBackupReminderDue, useSettingsStore } from '../../store/settings'
import { useShellStore } from '../../store/shell'
import * as bridge from '../../lib/bridge'
import { playNotificationSound } from '../../lib/bridge'
import { ScopedErrorBoundary } from '../ui/ScopedErrorBoundary'
import { Icon } from '../ui/Icon'
import { useNotificationSync } from '../../hooks/useNotificationSync'
import { getEffectiveChannelNotificationLevel } from '../../store/settings'
import { useNetworkStore } from '../../store/network'
import { COMPACT_VIEWPORT_QUERY, useMediaQuery } from '../../hooks/useMediaQuery'
import { useQueuedMessageSync } from '../../hooks/useQueuedMessageSync'
import { CONTEXT_SIDEBAR_WIDTH_KEY } from '../../lib/layout-preferences'
import { usePersistentPanelWidth } from '../../hooks/usePersistentPanelWidth'
import { PanelResizeHandle } from './PanelResizeHandle'
import { NetworkStatus } from '../ui/NetworkStatus'
import {
  isVisibleMeshRegion,
  MESH_REGION_SELECTOR,
  nextMeshRegion,
} from '../../lib/region-navigation'
import {
  findRestorableActiveRoomTab,
  openRoomTab,
  restoreRoomTabState,
  roomTabKey,
  roomTabStorageKey,
  serializeRoomTabState,
  type RoomTab,
  type RoomTabState,
} from '../../lib/room-tabs'
import { safeLocalStorageGet, safeLocalStorageSet } from '../../lib/safe-storage'
import { VoiceDock } from '../voice/VoiceDock'

const CommandPalette = lazy(() =>
  import('../navigation/CommandPalette').then((module) => ({ default: module.CommandPalette })),
)

function createLazyRoomTabStrip() {
  return lazy(() =>
    import('../navigation/RoomTabStrip')
      .then((module) => ({ default: module.RoomTabStrip })),
  )
}

function loadRoomTabs(accountId: string): RoomTabState {
  return restoreRoomTabState(safeLocalStorageGet(roomTabStorageKey(accountId)), accountId)
}

export function hasAuthoritativeSavedRoomSnapshot(
  kind: RoomTab['kind'],
  conversationStatus: LoadStatus,
  roomStatus?: CommunityRefreshState['status'],
): boolean {
  return kind === 'dm' ? conversationStatus === 'loaded' : roomStatus === 'loaded'
}

export function AppLayout() {
  useCommunitySync()
  const matrixMode = bridge.isMatrixBackend()
  useQueuedMessageSync(matrixMode)
  const directMessagesAvailable = bridge.getBackendCapabilities().directMessages
  const activeChannelId = useChannelStore((state) => state.activeChannelId)
  const activeChannel = useChannelStore((state) => (
    state.activeChannelId ? state.channelEntities[state.activeChannelId] : undefined
  ))
  const channelEntities = useChannelStore((state) => state.channelEntities)
  const setActiveChannel = useChannelStore((state) => state.setActiveChannel)
  const activeCommunityId = useCommunityStore((state) => state.activeCommunityId)
  const setActiveCommunity = useCommunityStore((state) => state.setActiveCommunity)
  const patchChannel = useChannelStore((state) => state.patchChannel)
  const isDmMode = useDmStore((state) => state.isDmMode)
  const activeConversationId = useDmStore((state) => state.activeConversationId)
  const activeConversation = useDmStore((state) => (
    state.activeConversationId
      ? state.conversationEntities[state.activeConversationId]
      : undefined
  ))
  const conversationEntities = useDmStore((state) => state.conversationEntities)
  const setActiveConversation = useDmStore((state) => state.setActiveConversation)
  const setDmMode = useDmStore((state) => state.setDmMode)
  const conversationLoadStatus = useDmStore((state) => state.conversationLoad.status)
  const loadDmConversations = useDmStore((state) => state.loadConversations)
  const channelRefreshByCommunity = useChannelStore((state) => state.refreshByCommunity)
  const backup = useSettingsStore((state) => state.backup)
  const dismissBackupReminder = useSettingsStore((state) => state.dismissBackupReminder)
  const setProfileOpen = useShellStore((state) => state.setProfileOpen)
  const backupReminderDue = isBackupReminderDue(backup)
  const networkStatus = useNetworkStore((state) => state.status)
  const contextSidebarWidth = usePersistentPanelWidth({
    storageKey: CONTEXT_SIDEBAR_WIDTH_KEY,
    defaultWidth: 304,
    minimum: 180,
    maximum: 360,
  })

  const myPublicKey = useIdentityStore((state) => state.identity?.publicKey)
  const roomTabAccountId = myPublicKey ?? 'local-device'
  const [roomTabs, setRoomTabs] = useState<RoomTabState>(() => loadRoomTabs(roomTabAccountId))
  const [roomTabRestorationPending, setRoomTabRestorationPending] = useState(true)
  const [RoomTabStrip, setRoomTabStrip] = useState(createLazyRoomTabStrip)
  const navigationContextKey = `${activeCommunityId ?? ''}\u0000${activeChannelId ?? ''}\u0000${isDmMode}`
  const [openNavigationContextKey, setOpenNavigationContextKey] = useState<string | null>(null)
  const contextNavigationOpen = openNavigationContextKey === navigationContextKey
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
    setOpenNavigationContextKey(null)
    if (restoreFocus && typeof document !== 'undefined') {
      window.requestAnimationFrame(() => {
        document.querySelector<HTMLButtonElement>('.mesh-compact-header button')?.focus()
      })
    }
  }, [])
  // Naming the main landmark after the open conversation is far more useful for
  // landmark navigation than the previous static "Content area".
  const activeConversationLabel = isDmMode
    ? 'Direct message conversation'
    : activeChannel?.name
      ? `Conversation in ${activeChannel.name}`
      : 'Conversation'
  useNotificationSync({ matrixMode, activeRoomId })

  useEffect(() => {
    if (!directMessagesAvailable && isDmMode) setDmMode(false)
  }, [directMessagesAvailable, isDmMode, setDmMode])

  useEffect(() => {
    // This is an external-storage/account boundary: switching accounts must
    // replace, rather than merge, persisted room identifiers.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setRoomTabs((current) => (
      current.accountId === roomTabAccountId ? current : loadRoomTabs(roomTabAccountId)
    ))
    setRoomTabRestorationPending(true)
  }, [roomTabAccountId])

  useEffect(() => {
    if (roomTabs.accountId !== roomTabAccountId) return
    safeLocalStorageSet(roomTabStorageKey(roomTabAccountId), serializeRoomTabState(roomTabs))
  }, [roomTabAccountId, roomTabs])

  useEffect(() => {
    if (!roomTabRestorationPending || roomTabs.accountId !== roomTabAccountId) return
    const activeTab = findRestorableActiveRoomTab(
      roomTabs,
      (roomId) => Boolean(channelEntities[roomId]),
      (conversationId) => Boolean(conversationEntities[conversationId]),
    )
    const savedActiveTab = roomTabs.tabs.find((tab) => tab.key === roomTabs.activeKey)
    if (savedActiveTab && !activeTab) {
      if (savedActiveTab.kind === 'dm') {
        if (conversationLoadStatus === 'idle') {
          void loadDmConversations().catch(() => {})
          return
        }
        if (!hasAuthoritativeSavedRoomSnapshot('dm', conversationLoadStatus)) return
      } else {
        const refreshStatus = savedActiveTab.communityId
          ? channelRefreshByCommunity[savedActiveTab.communityId]?.status
          : undefined
        if (!hasAuthoritativeSavedRoomSnapshot('room', conversationLoadStatus, refreshStatus)) {
          return
        }
      }
      // The saved room no longer exists in a completed source snapshot.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setRoomTabRestorationPending(false)
      return
    }
    if (!activeTab) {
      // The persisted model is an external cache; this one-time flag prevents
      // the default room from replacing a saved selection during hydration.
      setRoomTabRestorationPending(false)
      return
    }
    if (activeTab.kind === 'dm') {
      setDmMode(true)
      setActiveConversation(activeTab.roomId)
    } else {
      setDmMode(false)
      if (activeTab.communityId) setActiveCommunity(activeTab.communityId)
      setActiveChannel(activeTab.roomId)
    }
    setRoomTabRestorationPending(false)
  }, [
    channelEntities,
    channelRefreshByCommunity,
    conversationLoadStatus,
    conversationEntities,
    loadDmConversations,
    roomTabAccountId,
    roomTabRestorationPending,
    roomTabs,
    setActiveChannel,
    setActiveCommunity,
    setActiveConversation,
    setDmMode,
  ])

  useEffect(() => {
    let currentTab: RoomTab | null = null
    if (isDmMode && activeConversation) {
      currentTab = {
        key: roomTabKey('dm', activeConversation.id),
        kind: 'dm',
        roomId: activeConversation.id,
        communityId: null,
        title: activeConversation.peerDisplayName,
        pinned: false,
        unreadCount: activeConversation.unreadCount,
        mentionCount: activeConversation.unreadMentions ?? 0,
        lastOpenedAt: Date.now(),
      }
    } else if (!isDmMode && activeChannel) {
      currentTab = {
        key: roomTabKey('room', activeChannel.id),
        kind: 'room',
        roomId: activeChannel.id,
        communityId: activeChannel.communityId,
        title: activeChannel.name,
        pinned: false,
        unreadCount: activeChannel.unreadCount,
        mentionCount: activeChannel.unreadMentions ?? 0,
        lastOpenedAt: Date.now(),
      }
    }
    if (!currentTab || roomTabRestorationPending) return
    const tab = currentTab
    // Channel/DM stores are external Zustand sources. Mirror only their
    // current navigation identity into the bounded tab model.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setRoomTabs((current) => (
      current.accountId === roomTabAccountId ? openRoomTab(current, tab) : current
    ))
  }, [activeChannel, activeConversation, isDmMode, roomTabAccountId, roomTabRestorationPending])

  useEffect(() => {
    // Keep badges and safe display labels fresh for every open tab, not only
    // the active conversation. The existing Matrix unread listener owns the
    // authoritative counts; tabs remain a bounded navigation projection.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setRoomTabs((current) => {
      if (current.accountId !== roomTabAccountId) return current
      let changed = false
      const tabs = current.tabs.map((tab) => {
        const source = tab.kind === 'dm'
          ? conversationEntities[tab.roomId]
          : channelEntities[tab.roomId]
        if (!source) return tab
        const title = tab.kind === 'dm'
          ? conversationEntities[tab.roomId]?.peerDisplayName ?? tab.title
          : channelEntities[tab.roomId]?.name ?? tab.title
        const mentionCount = source.unreadMentions ?? 0
        if (
          tab.title === title
          && tab.unreadCount === source.unreadCount
          && tab.mentionCount === mentionCount
        ) {
          return tab
        }
        changed = true
        return {
          ...tab,
          title,
          unreadCount: source.unreadCount,
          mentionCount,
        }
      })
      return changed ? { ...current, tabs } : current
    })
  }, [channelEntities, conversationEntities, roomTabAccountId])

  const changeRoomTabs = (next: RoomTabState) => {
    if (next.accountId !== roomTabAccountId) return
    const activeTab = next.tabs.find((tab) => tab.key === next.activeKey)
    if (activeTab && activeTab.key !== roomTabs.activeKey) {
      if (activeTab.kind === 'dm') {
        setDmMode(true)
        setActiveConversation(activeTab.roomId)
      } else {
        setDmMode(false)
        if (activeTab.communityId) setActiveCommunity(activeTab.communityId)
        setActiveChannel(activeTab.roomId)
      }
    }
    setRoomTabs(next)
  }

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
  // state: they can send messages, create communities, queue things for
  // delivery. We only surface a banner when something actually blocks
  // them, not just because they're solo.
  //
  // Banner is NEVER shown for solo mode. If the swarm task hasn't started
  // at all (real failure), the user sees errors elsewhere. Solo is
  // advertised gently via the sidebar indicator instead.
  return (
    <div className="mesh-app-shell relative flex h-screen flex-col overflow-hidden bg-surface-base text-content">
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
      <div className="flex min-h-0 min-w-0 flex-1 overflow-hidden">
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

        <aside
          ref={contextNavigationRef}
          id="mesh-context-sidebar"
          data-open={contextNavigationOpen ? 'true' : 'false'}
          className="mesh-context-sidebar relative flex min-h-0 flex-shrink-0 flex-col border-r border-border-subtle bg-surface-sidebar"
          data-design-token-exception="user-resizable-persisted-context-sidebar-width"
          style={{
            '--mesh-context-sidebar-width': `${contextSidebarWidth.width}px`,
          } as CSSProperties}
          aria-label={isDmMode && directMessagesAvailable ? 'Direct message conversations' : 'Room list'}
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
                {isDmMode && directMessagesAvailable ? 'Conversations' : 'Rooms'}
              </span>
              <button
                type="button"
                className="flex min-h-11 min-w-11 flex-shrink-0 items-center justify-center rounded-control text-muted transition-colors hover:bg-surface-hover hover:text-secondary"
                aria-label={isDmMode ? 'Close conversation navigation drawer' : 'Close room navigation drawer'}
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
            minimum={180}
            maximum={360}
            onPointerDown={contextSidebarWidth.startResize}
            onResizeBy={contextSidebarWidth.resizeBy}
          />
          <ScopedErrorBoundary
            name={isDmMode && directMessagesAvailable ? 'Conversation list' : 'Room list'}
            description="Navigation failed to render. The current conversation remains available."
            className="m-2"
            resetKey={`${isDmMode ? 'dm' : 'channel'}:${activeCommunityId ?? ''}`}
          >
            {isDmMode && directMessagesAvailable ? <DmSidebar /> : <ChannelSidebar />}
          </ScopedErrorBoundary>
        </aside>

        <main
          id="mesh-conversation"
          tabIndex={-1}
          className="flex min-h-0 min-w-0 flex-1 flex-col bg-surface-base outline-none"
          aria-label={activeConversationLabel}
          data-mesh-region
        >
          <ScopedErrorBoundary
            name="Conversation tabs"
            description="Open conversations are still available from the room and direct-message lists."
            resetKey={roomTabAccountId}
            onRetry={() => setRoomTabStrip(createLazyRoomTabStrip())}
          >
            <Suspense fallback={null}>
              <RoomTabStrip state={roomTabs} onChange={changeRoomTabs} />
            </Suspense>
          </ScopedErrorBoundary>
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
              onClick={() => setOpenNavigationContextKey((openKey) => (
                openKey === navigationContextKey ? null : navigationContextKey
              ))}
            >
              <Icon name={contextNavigationOpen ? 'x' : 'menu'} size="sm" />
              {contextNavigationOpen ? 'Close' : isDmMode ? 'Conversations' : 'Rooms'}
            </button>
            <span className="truncate text-xs text-muted">
              {matrixMode ? 'Encrypted session' : 'Local Mesh session'}
            </span>
          </div>
          <div className="flex min-h-0 min-w-0 flex-1 overflow-hidden">
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
      <VoiceDock />
    </div>
  )
}
