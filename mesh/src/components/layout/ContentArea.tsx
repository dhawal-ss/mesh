import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from 'react'
import { useActiveChannel, useChannelStore } from '../../store/channels'
import { useCommunityStore } from '../../store/communities'
import { usePresence } from '../../hooks/usePresence'
import { VoiceView } from '../voice/VoiceView'
import type { RoomContextTab } from '../community/RoomContextPanel'
import { ErrorBoundary } from '../ui/ErrorBoundary'
import { ScopedErrorBoundary } from '../ui/ScopedErrorBoundary'
import { Icon } from '../ui/Icon'
import { useDmStore } from '../../store/dms'
import { useRoomTrust } from '../../hooks/useRoomTrust'
import { useRoomPinStore } from '../../store/room-pins'
import { isMatrixBackend, onMatrixRoomPinsUpdate } from '../../lib/bridge'
import { setVolatileInviteLink } from '../../lib/pending-invitation-runtime'
import {
  ROOM_CONTEXT_WIDTH_KEY,
} from '../../lib/layout-preferences'
import { usePersistentPanelWidth } from '../../hooks/usePersistentPanelWidth'
import { MemberListSkeleton, Skeleton } from '../ui/Skeleton'
import {
  ROOM_CONTEXT_COMPACT_QUERY,
  useMediaQuery,
} from '../../hooks/useMediaQuery'
import { useCurrentMeshRoute, useMeshNavigationStore } from '../../store/navigation'
import { useMessageStore } from '../../store/messages'
import { groupThreadReplies } from '../../lib/threads'
import type { Message } from '../../types/ipc'
import { restorePaneTriggerFocus } from '../../lib/pane-focus'
import { useCompactPaneFocus } from '../../hooks/useCompactPaneFocus'
import { ThreadPanel } from '../chat/ThreadPanel'

const EMPTY_MESSAGES: Message[] = []

function createLazyRoomContextPanel() {
  return lazy(() =>
    import('../community/RoomContextPanel')
      .then((module) => ({ default: module.RoomContextPanel })),
  )
}

const ChatView = lazy(() =>
  import('../chat/ChatView').then((module) => ({ default: module.ChatView })),
)

export function ContentArea() {
  const activeChannel = useActiveChannel()
  const communityCount = useCommunityStore((state) => state.communityOrder.length)
  const activeCommunityId = useCommunityStore((state) => state.activeCommunityId)
  const setDmMode = useDmStore((state) => state.setDmMode)
  const channels = useChannelStore((state) => state.channels)
  const setActiveChannel = useChannelStore((state) => state.setActiveChannel)
  const compactRoomContext = useMediaQuery(ROOM_CONTEXT_COMPACT_QUERY)
  const route = useCurrentMeshRoute()
  const navigate = useMeshNavigationStore((state) => state.navigate)
  const closePane = useMeshNavigationStore((state) => state.closePane)
  const drawer = useMeshNavigationStore((state) => state.drawer)
  const setDrawer = useMeshNavigationStore((state) => state.setDrawer)

  const previousCompactRoomContext = useRef(compactRoomContext)
  const roomContextWidth = usePersistentPanelWidth({
    storageKey: ROOM_CONTEXT_WIDTH_KEY,
    defaultWidth: 280,
    minimum: 220,
    maximum: 320,
  })
  const [inviteDraft, setInviteDraft] = useState('')
  const [RoomContextPanel, setRoomContextPanel] = useState(
    createLazyRoomContextPanel,
  )
  const { members } = usePresence()
  const trust = useRoomTrust(activeChannel?.id, members)
  const activeTextRoomId = activeChannel?.channelType === 'text' ? activeChannel.id : null
  const roomMessages = useMessageStore((state) => (
    activeTextRoomId ? state.messages[activeTextRoomId] ?? EMPTY_MESSAGES : EMPTY_MESSAGES
  ))
  const threadRootId = route.kind === 'room'
    && route.roomId === activeTextRoomId
    && route.pane?.kind === 'thread'
      ? route.pane.rootEventId
      : null
  const thread = useMemo(() => {
    if (!threadRootId) return { root: null, replies: EMPTY_MESSAGES }
    const { repliesByRoot } = groupThreadReplies(roomMessages)
    return {
      root: roomMessages.find((message) => message.id === threadRootId) ?? null,
      replies: repliesByRoot.get(threadRootId) ?? EMPTY_MESSAGES,
    }
  }, [roomMessages, threadRootId])
  const showThread = threadRootId !== null
  const closeThread = useCallback(() => {
    const rootId = threadRootId
    closePane()
    restorePaneTriggerFocus('mesh-thread-panel', rootId)
  }, [closePane, threadRootId])
  useCompactPaneFocus({
    active: showThread,
    compact: compactRoomContext,
    panelId: 'mesh-thread-panel',
    onClose: closeThread,
  })
  const routeContextTab: RoomContextTab | null = route.kind === 'room'
    && route.roomId === activeTextRoomId
      ? route.pane?.kind === 'details'
        ? route.pane.tab
        : route.pane?.kind === 'signal'
          ? 'ledger'
          : null
      : null
  const showContext = routeContextTab !== null
  const contextTab = routeContextTab ?? 'people'
  const loadRoomPins = useRoomPinStore((state) => state.load)
  const clearRoomPins = useRoomPinStore((state) => state.clear)
  const closeContext = useCallback((restoreFocus = true) => {
    closePane()
    if (useMeshNavigationStore.getState().drawer === 'secondary') setDrawer('none')
    if (restoreFocus && typeof document !== 'undefined') {
      restorePaneTriggerFocus('mesh-room-context-panel')
    }
  }, [closePane, setDrawer])

  useEffect(() => {
    if (!routeContextTab) {
      if (drawer === 'secondary') setDrawer('none')
      return
    }
    setDrawer(compactRoomContext ? 'secondary' : 'none')
  }, [compactRoomContext, drawer, routeContextTab, setDrawer])

  useEffect(() => {
    if (compactRoomContext && drawer === 'context' && showContext) {
      closeContext(false)
    }
  }, [closeContext, compactRoomContext, drawer, showContext])

  useEffect(() => {
    const wasCompact = previousCompactRoomContext.current
    previousCompactRoomContext.current = compactRoomContext
    if (!wasCompact && compactRoomContext && showContext) closeContext()
  }, [closeContext, compactRoomContext, showContext])

  const openContext = useCallback((tab: RoomContextTab) => {
    if (route.kind !== 'room') return
    navigate({
      ...route,
      pane: tab === 'ledger'
        ? { kind: 'signal', subject: { kind: 'room', id: route.roomId } }
        : { kind: 'details', tab },
    }, { focus: false })
  }, [navigate, route])

  useLayoutEffect(() => {
    if (!showContext) return
    if (!compactRoomContext) return
    const focusableSelector = [
      'button:not([disabled])',
      'a[href]',
      'input:not([disabled])',
      'select:not([disabled])',
      'textarea:not([disabled])',
      '[tabindex]:not([tabindex="-1"])',
    ].join(',')
    const getContextPanel = () => document.getElementById('mesh-room-context-panel')
    const focusFirstElement = () => {
      const contextPanel = getContextPanel()
      if (!contextPanel) return false
      const firstVisible = [...contextPanel.querySelectorAll<HTMLElement>(focusableSelector)]
        .find((element) => !element.hidden && element.getClientRects().length > 0)
      ;(firstVisible ?? contextPanel).focus()
      return true
    }
    getContextPanel()?.focus()
    focusFirstElement()
    const focusFirst = window.requestAnimationFrame(focusFirstElement)
    const mountObserver = new MutationObserver(() => {
      if (focusFirstElement()) mountObserver.disconnect()
    })
    mountObserver.observe(document.body, { childList: true, subtree: true })
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented) {
        event.preventDefault()
        closeContext()
        return
      }
      if (event.key !== 'Tab') return
      const contextPanel = getContextPanel()
      const focusable = [...(contextPanel?.querySelectorAll<HTMLElement>(focusableSelector) ?? [])]
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
      mountObserver.disconnect()
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [closeContext, compactRoomContext, showContext])

  useEffect(() => {
    if (!activeTextRoomId || !isMatrixBackend()) {
      clearRoomPins()
      return
    }

    const roomId = activeTextRoomId
    let active = true
    let unlisten: (() => void) | null = null
    void loadRoomPins(roomId)
    void onMatrixRoomPinsUpdate((update) => {
      if (active && update.roomId === roomId) void loadRoomPins(roomId)
    }).then((removeListener) => {
      if (!active) {
        removeListener()
        return
      }
      unlisten = removeListener
    }).catch((error) => {
      console.error('Could not subscribe to room-pin updates:', error)
    })
    return () => {
      active = false
      unlisten?.()
      if (useRoomPinStore.getState().roomId === roomId) clearRoomPins()
    }
  }, [activeTextRoomId, clearRoomPins, loadRoomPins])

  if (!activeChannel) {
    const hasCommunity = Boolean(activeCommunityId)
    const isFirstCommunity = communityCount === 0

    return (
      <div className="flex min-h-0 min-w-0 flex-1 items-stretch justify-start overflow-y-auto px-4 py-6 sm:items-center sm:justify-center sm:px-6 sm:py-8">
        <div className="w-full min-w-0 max-w-md text-center">
          <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-panel border border-border-subtle bg-surface-sunken">
            <Icon name="messageCircle" size="lg" className="text-muted" />
          </div>
          <h3 className="mb-1 text-base font-semibold text-primary">
            {isFirstCommunity
              ? 'Welcome to Mesh'
              : hasCommunity
                ? 'Choose a room'
                : 'Choose a community'}
          </h3>
          <p className="text-sm leading-6 text-muted">
            {isFirstCommunity
              ? 'Create your first community with the plus button, or join one with an invite.'
              : hasCommunity
                ? 'Select a room to start messaging. Voice rooms appear when calling is available.'
                : 'Select a community icon, then choose one of its rooms.'}
          </p>
          {isFirstCommunity && (
            <div className="mt-5 space-y-4">
              <p className="text-sm font-medium text-secondary">You're in. What first?</p>
              <div className="grid gap-2 sm:grid-cols-3">
                <FirstAction label="Join a community" icon="userPlus" onClick={() => navigate({ kind: 'communities', mode: 'join' })} />
                <FirstAction label="Make a community" icon="plus" onClick={() => navigate({ kind: 'communities', mode: 'create' })} />
                <FirstAction label="Message a friend" icon="send" onClick={() => setDmMode(true)} />
              </div>
              <form
                className="mx-auto max-w-sm text-left"
                onSubmit={(event) => {
                  event.preventDefault()
                  if (inviteDraft.trim()) {
                    setVolatileInviteLink(inviteDraft.trim())
                    navigate({ kind: 'communities', mode: 'join' })
                  }
                }}
              >
                <label htmlFor="first-run-invite" className="text-xs font-medium text-secondary">
                  Have an invite link? Paste it here
                </label>
                <div className="mt-1 flex gap-2">
                  <input
                    id="first-run-invite"
                    value={inviteDraft}
                    onChange={(event) => setInviteDraft(event.target.value)}
                    className="h-control-md min-w-0 flex-1 rounded-md border border-border-subtle bg-surface-raised px-3 text-sm text-content outline-none focus:border-accent"
                  />
                  <button
                    type="submit"
                    disabled={!inviteDraft.trim()}
                    className="rounded-md bg-accent px-3 text-sm font-medium text-content-on-accent disabled:opacity-40"
                  >
                    Join
                  </button>
                </div>
              </form>
            </div>
          )}
        </div>
      </div>
    )
  }

  return (
    <div className="relative flex min-h-0 min-w-0 flex-1">
      <div className="flex min-w-0 flex-1 flex-col">
        <ErrorBoundary scope="content">
          {activeChannel.channelType === 'voice' ? (
            <VoiceView
              channelId={activeChannel.id}
              channelName={activeChannel.name}
              onBackToChat={() => {
                const textRoom = channels.find((candidate) => (
                  candidate.communityId === activeChannel.communityId
                  && candidate.channelType === 'text'
                ))
                if (textRoom) {
                  setActiveChannel(textRoom.id)
                  navigate({
                    kind: 'room',
                    communityId: textRoom.communityId,
                    roomId: textRoom.id,
                  })
                }
              }}
            />
          ) : (
            <Suspense fallback={<ChatViewLoadingFallback />}>
              <ChatView
                channel={activeChannel}
                trust={trust}
                showContextToggle
                isContextOpen={showContext}
                activeContextTab={contextTab}
                onToggleContext={() => {
                  if (showContext) closeContext()
                  else openContext(contextTab)
                }}
                onOpenContext={openContext}
              />
            </Suspense>
          )}
        </ErrorBoundary>
      </div>

      {activeChannel.channelType === 'text' && showThread && (
        <>
          <button
            type="button"
            className="mesh-room-context-backdrop"
            aria-label="Dismiss thread"
            onClick={closeThread}
          />
          <ThreadPanel
            title={`#${activeChannel.name}`}
            root={thread.root}
            replies={thread.replies}
            trust={trust}
            onReply={(root, target = root) => {
              window.dispatchEvent(new CustomEvent('mesh:reply-in-thread', {
                detail: { rootId: root.id, targetId: target.id },
              }))
            }}
            onClose={closeThread}
          />
        </>
      )}

      {activeChannel.channelType === 'text' && showContext && (
        <>
          <button
            type="button"
            className="mesh-room-context-backdrop"
            aria-label="Dismiss room context"
            onClick={() => closeContext()}
          />
          <ScopedErrorBoundary
            name="Room context"
            description="Room context could not be displayed. Messaging is unaffected."
            className="m-2 w-content-error"
            resetKey={activeCommunityId}
            onRetry={() => setRoomContextPanel(createLazyRoomContextPanel())}
            onDismiss={() => closeContext()}
            dismissLabel="Close"
          >
            <Suspense
              fallback={(
                <RoomContextLoadingFallback
                  panelWidth={roomContextWidth.width}
                  onClose={() => closeContext()}
                />
              )}
            >
              <RoomContextPanel
                channel={activeChannel}
                members={members}
                trust={trust}
                activeTab={contextTab}
                onTabChange={openContext}
                onClose={() => closeContext()}
                panelWidth={roomContextWidth.width}
                panelWidthMinimum={220}
                panelWidthMaximum={320}
                onResizeStart={roomContextWidth.startResize}
                onResizeBy={roomContextWidth.resizeBy}
              />
            </Suspense>
          </ScopedErrorBoundary>
        </>
      )}
    </div>
  )
}

function ChatViewLoadingFallback() {
  return (
    <div
      className="flex min-h-0 min-w-0 flex-1 flex-col"
      role="status"
      aria-label="Loading conversation"
    >
      <div className="flex min-h-control-lg items-center border-b border-border-subtle px-4">
        <span className="text-xs font-medium text-secondary">Loading conversation…</span>
      </div>
      <div className="flex min-h-0 flex-1 flex-col justify-end gap-3 p-4" aria-hidden="true">
        <Skeleton width="42%" height={12} />
        <Skeleton width="68%" height={12} />
        <Skeleton width="54%" height={12} />
        <Skeleton width="36%" height={12} />
      </div>
    </div>
  )
}

function RoomContextLoadingFallback({
  panelWidth,
  onClose,
}: {
  panelWidth: number
  onClose: () => void
}) {
  return (
    <aside
      id="mesh-room-context-panel"
      className="mesh-room-context-panel relative flex min-w-0 flex-shrink-0 flex-col overflow-hidden border-l border-border-subtle bg-surface-sidebar"
      data-design-token-exception="user-resizable-persisted-room-context-width"
      style={{
        '--mesh-room-context-width': `${panelWidth}px`,
      } as CSSProperties}
      aria-label="Loading room context"
      aria-busy="true"
      tabIndex={-1}
    >
      <div className="flex min-h-control-lg items-center gap-3 border-b border-border-subtle px-3">
        <span
          className="min-w-0 flex-1 text-xs font-medium text-secondary"
          role="status"
          aria-live="polite"
        >
          Loading room context
        </span>
        <button
          type="button"
          className="min-h-11 min-w-11 rounded-control px-2 text-xs font-medium text-content-secondary transition-colors hover:bg-surface-hover hover:text-content focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
          onClick={onClose}
        >
          Close
        </button>
      </div>
      <div className="space-y-3 border-b border-border-subtle px-4 py-3" aria-hidden>
        <Skeleton width={92} height={12} />
        <Skeleton width="70%" height={10} />
      </div>
      <div className="min-h-0 flex-1 overflow-hidden py-2" aria-hidden>
        <MemberListSkeleton />
      </div>
    </aside>
  )
}

function FirstAction({
  label,
  icon,
  onClick,
}: {
  label: string
  icon: 'userPlus' | 'plus' | 'send'
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex min-h-24 flex-col items-center justify-center gap-2 rounded-lg bg-surface-raised p-3 text-sm font-medium text-content transition-colors hover:bg-surface-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
    >
      <Icon name={icon} />
      {label}
    </button>
  )
}
