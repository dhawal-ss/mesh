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
import {
  getBackendStatusSnapshot,
  isMatrixBackend,
  markThreadRead,
  onMatrixRoomPinsUpdate,
} from '../../lib/bridge'
import { setVolatileInviteLink } from '../../lib/pending-invitation-runtime'
import { ROOM_CONTEXT_WIDTH_KEY } from '../../lib/layout-preferences'
import { usePersistentPanelWidth } from '../../hooks/usePersistentPanelWidth'
import { MemberListSkeleton, MessageSkeleton, Skeleton } from '../ui/Skeleton'
import { EmptyState } from '../ui/Primitives'
import { Button } from '../ui/Button'
import { useJoinCommunityRoom } from '../../hooks/useJoinCommunityRoom'
import {
  ROOM_CONTEXT_COMPACT_QUERY,
  useMediaQuery,
} from '../../hooks/useMediaQuery'
import { useCurrentMeshRoute, useMeshNavigationStore } from '../../store/navigation'
import { useMessageStore } from '../../store/messages'
import { groupThreadReplies, mergeThreadMessages } from '../../lib/threads'
import type { Message } from '../../types/ipc'
import { restorePaneTriggerFocus, threadListFocusScopeId } from '../../lib/pane-focus'
import { useCompactPaneFocus } from '../../hooks/useCompactPaneFocus'
import { useMessageNavigationStore } from '../../store/message-navigation'
import { useMatrixThreadContext } from '../../hooks/useMatrixThreadContext'
import { shouldExposeVoiceRoutes } from '../../lib/voice-runtime'

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
const ThreadPanel = lazy(() =>
  import('../chat/ThreadPanel').then((module) => ({ default: module.ThreadPanel })),
)

export function ContentArea() {
  const activeChannel = useActiveChannel()
  const { joiningRoomId, joinRoom } = useJoinCommunityRoom()
  const voiceRoutesEnabled = shouldExposeVoiceRoutes(
    isMatrixBackend(),
    getBackendStatusSnapshot(),
  )
  const communityCount = useCommunityStore((state) => state.communityOrder.length)
  const activeCommunityId = useCommunityStore((state) => state.activeCommunityId)
  const activeCommunityRefresh = useChannelStore((state) => (
    activeCommunityId ? state.refreshByCommunity[activeCommunityId] : undefined
  ))
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
    defaultWidth: 400,
    minimum: 320,
    maximum: 480,
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
  const threadOpenedFromList = route.kind === 'room'
    && route.roomId === activeTextRoomId
    && route.pane?.kind === 'thread'
      ? route.pane.from === 'threads-list'
      : false
  const threadContext = useMatrixThreadContext(
    activeTextRoomId,
    threadRootId,
    isMatrixBackend(),
  )
  const thread = useMemo(() => {
    if (!threadRootId) return { root: null, replies: EMPTY_MESSAGES }
    const { repliesByRoot } = groupThreadReplies(roomMessages)
    const localRoot = roomMessages.find((message) => message.id === threadRootId) ?? null
    const serverRoot = threadContext.context?.root ?? null
    return {
      root: serverRoot && localRoot ? { ...serverRoot, ...localRoot } : serverRoot ?? localRoot,
      replies: mergeThreadMessages(
        threadContext.context?.replies ?? EMPTY_MESSAGES,
        repliesByRoot.get(threadRootId) ?? EMPTY_MESSAGES,
      ),
    }
  }, [roomMessages, threadContext.context, threadRootId])
  const threadNavigationRequest = useMessageNavigationStore((state) => {
    const pending = state.pending
    return pending?.message.channelId === activeTextRoomId
      && pending.message.threadRootId === threadRootId
        ? pending
        : null
  })
  const showThread = threadRootId !== null
  const closeThread = useCallback(() => {
    // A thread root can be both the trigger inside a message row and a row
    // in the "My threads" list at once; the list uses a distinct scope key
    // so closing never hands focus to the wrong one of the two triggers.
    const focusScopeId = threadOpenedFromList && threadRootId
      ? threadListFocusScopeId(threadRootId)
      : threadRootId
    if (threadOpenedFromList && route.kind === 'room') {
      navigate({ ...route, pane: { kind: 'details', tab: 'threads' } }, { focus: false })
    } else {
      closePane()
    }
    restorePaneTriggerFocus('mesh-thread-panel', focusScopeId)
  }, [closePane, navigate, route, threadOpenedFromList, threadRootId])
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
  const closeContextRoute = useCallback((restoreFocus = true) => {
    closePane()
    if (useMeshNavigationStore.getState().drawer === 'secondary') setDrawer('none')
    if (restoreFocus && typeof document !== 'undefined') {
      restorePaneTriggerFocus('mesh-room-context-panel')
    }
  }, [closePane, setDrawer])
  const closeContext = useCallback((restoreFocus = true) => {
    closeContextRoute(restoreFocus)
  }, [closeContextRoute])

  useEffect(() => {
    if (!routeContextTab) {
      if (drawer === 'secondary') setDrawer('none')
      return
    }
    setDrawer(compactRoomContext ? 'secondary' : 'none')
  }, [compactRoomContext, drawer, routeContextTab, setDrawer])

  useEffect(() => {
    if (compactRoomContext && drawer === 'context' && showContext) {
      closeContextRoute(false)
    }
  }, [closeContextRoute, compactRoomContext, drawer, showContext])

  useEffect(() => {
    const wasCompact = previousCompactRoomContext.current
    previousCompactRoomContext.current = compactRoomContext
    if (!wasCompact && compactRoomContext && showContext) closeContextRoute()
  }, [closeContextRoute, compactRoomContext, showContext])

  const openContext = useCallback((tab: RoomContextTab) => {
    if (route.kind !== 'room') return
    navigate({
      ...route,
      pane: tab === 'ledger'
        ? { kind: 'signal', subject: { kind: 'room', id: route.roomId } }
        : { kind: 'details', tab },
    }, { focus: false })
  }, [navigate, route])
  const openThreadFromList = useCallback((rootEventId: string) => {
    if (route.kind !== 'room') return
    navigate({ ...route, pane: { kind: 'thread', rootEventId, from: 'threads-list' } }, { focus: false })
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
    /*
      The sidebar's own note says both panes have to say which state this is,
      and only the sidebar was doing it: this pane derived everything from the
      community id alone, so an empty community got "Select a room to start
      messaging" beside a column reading "No rooms yet". It asks for the same
      refresh state the sidebar uses, so neither pane can claim a community is
      empty while its first load is still running.
    */
    const roomsLoaded = activeCommunityRefresh?.status === 'loaded'
    const communityIsEmpty = hasCommunity
      && roomsLoaded
      && !channels.some((candidate) => candidate.communityId === activeCommunityId)

    return (
      <div className="flex min-h-0 min-w-0 flex-1 items-start justify-start overflow-y-auto px-4 py-6 sm:px-6 sm:py-8">
        <EmptyState
          className="w-full min-w-0 max-w-2xl"
          eyebrow={isFirstCommunity ? 'Welcome' : hasCommunity ? 'Rooms' : 'Communities'}
          markSeed={activeCommunityId ?? 'mesh'}
          markVariant={hasCommunity ? 'community' : 'brand'}
          title={isFirstCommunity
            ? 'Welcome to Mesh'
            : communityIsEmpty
              ? 'No rooms yet'
              : hasCommunity
                ? 'Choose a room'
                : 'Choose a community'}
          description={isFirstCommunity
            ? 'Make your first community, or join one with an invite.'
            : communityIsEmpty
              ? 'Rooms appear here as soon as they are created or finish arriving.'
              : hasCommunity
                ? 'Select a room to start messaging.'
                : 'Select a community icon, then choose one of its rooms.'}
          action={isFirstCommunity ? (
            <div className="w-full space-y-4">
              {/* The three tiles below name themselves, and the empty state
                  above already says what this screen is. A greeting between
                  them was a third layer that moved nobody anywhere. */}
              <div className="grid gap-2 sm:grid-cols-3">
                <FirstAction label="Join a community" icon="userPlus" onClick={() => navigate({ kind: 'communities', mode: 'join' })} />
                <FirstAction label="Make a community" icon="plus" onClick={() => navigate({ kind: 'communities', mode: 'create' })} />
                <FirstAction
                  label="Message a friend"
                  icon="send"
                  onClick={() => {
                    setDmMode(true)
                    navigate({ kind: 'direct-list' })
                  }}
                />
              </div>
              <form
                className="max-w-sm text-left"
                onSubmit={(event) => {
                  event.preventDefault()
                  if (inviteDraft.trim()) {
                    setVolatileInviteLink(inviteDraft.trim())
                    navigate({ kind: 'communities', mode: 'join' })
                  }
                }}
              >
                <label htmlFor="first-run-invite" className="text-body-sm font-medium text-on-surface-variant">
                  Have an invite link? Paste it here
                </label>
                <div className="mt-1 flex gap-2">
                  <input
                    id="first-run-invite"
                    value={inviteDraft}
                    onChange={(event) => setInviteDraft(event.target.value)}
                    className="h-control-md min-w-0 flex-1 rounded-full border border-outline-variant bg-surface-container px-3 text-body-md text-on-surface outline-none focus:border-primary"
                  />
                  <button
                    type="submit"
                    disabled={!inviteDraft.trim()}
                    className="rounded-full bg-primary px-3 text-body-md font-medium text-on-primary disabled:opacity-40"
                  >
                    Join
                  </button>
                </div>
              </form>
            </div>
          ) : undefined}
        />
      </div>
    )
  }

  /*
   * A room of this community that this account has not joined can be selected
   * from anywhere that addresses a room by id: a room link, the command
   * palette, a restored selection from before it was created. There is no
   * timeline to show until the join happens, and the room's own load would fail
   * with a permission error that reads like a fault. This offers the join
   * instead, in the place the person is already looking.
   */
  if (activeChannel.joined === false) {
    return (
      <div className="flex min-h-0 min-w-0 flex-1 items-start justify-start overflow-y-auto px-4 py-6 sm:px-6 sm:py-8">
        <EmptyState
          className="w-full min-w-0 max-w-2xl"
          eyebrow="Room"
          markSeed={activeChannel.id}
          markVariant="community"
          title={activeChannel.name}
          description={activeChannel.topic?.trim()
            ? activeChannel.topic
            : 'You are not in this room yet.'}
          action={(
            <Button
              onClick={() => void joinRoom(activeChannel, true)}
              disabled={joiningRoomId === activeChannel.id}
            >
              {joiningRoomId === activeChannel.id ? 'Joining…' : 'Join room'}
            </Button>
          )}
        />
      </div>
    )
  }

  return (
    <div className="relative flex min-h-0 min-w-0 flex-1">
      <div className="flex min-w-0 flex-1 flex-col">
        <ErrorBoundary scope="content">
          {activeChannel.channelType === 'voice' && voiceRoutesEnabled ? (
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
          ) : activeChannel.channelType === 'text' ? (
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
          ) : null}
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
          <Suspense fallback={<ThreadPanelLoadingFallback onClose={closeThread} />}>
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
              onMarkRead={async (rootEventId, eventId) => {
                await markThreadRead(activeChannel.id, rootEventId, eventId)
                threadContext.clearUnread()
              }}
              loadState={threadContext.status}
              unreadCount={threadContext.context?.unreadCount}
              unreadMentions={threadContext.context?.unreadMentions}
              unreadStateAvailable={threadContext.context?.unreadStateAvailable}
              hasMore={threadContext.context?.hasMore}
              onRetry={threadContext.retry}
              targetMessageId={threadNavigationRequest?.message.id}
              targetRequestId={threadNavigationRequest?.requestId}
              onNavigationComplete={(requestId) => (
                useMessageNavigationStore.getState().completeNavigation(requestId)
              )}
            />
          </Suspense>
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
            description="Room context could not be displayed."
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
                onOpenThread={openThreadFromList}
                openThreadId={threadRootId}
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
      <div className="flex h-conversation-header flex-shrink-0 items-center border-b border-outline-variant px-4">
        <span className="text-body-sm font-medium text-on-surface-variant">Loading conversation…</span>
      </div>
      {/*
        * `MessageSkeleton` mirrors the real row: same gutter, same avatar
        * column, same group gap. It owns its spacing, so this column adds no
        * padding or gap of its own; anything here would be a third geometry
        * between the fallback and the conversation.
        */}
      <div className="flex min-h-0 flex-1 flex-col justify-end" aria-hidden="true">
        {Array.from({ length: 6 }).map((_, index) => (
          <MessageSkeleton key={index} index={index} grouped={index % 3 !== 0} />
        ))}
      </div>
    </div>
  )
}

function ThreadPanelLoadingFallback({ onClose }: { onClose: () => void }) {
  return (
    <aside
      id="mesh-thread-panel"
      className="mesh-secondary-pane flex min-h-0 flex-shrink-0 flex-col overflow-hidden border-l border-outline-variant bg-surface"
      aria-label="Loading thread"
      aria-busy="true"
      tabIndex={-1}
    >
      <div className="flex h-conversation-header flex-shrink-0 items-center gap-3 border-b border-outline-variant bg-surface-container px-4">
        <span className="min-w-0 flex-1 text-body-sm font-medium text-on-surface-variant" role="status">
          Loading thread
        </span>
        <button
          type="button"
          onClick={onClose}
          className="min-h-10 rounded-full px-2 text-body-sm font-medium text-on-surface-variant hover:bg-state-hover hover:text-on-surface"
        >
          Close
        </button>
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-3 p-4" aria-hidden="true">
        <Skeleton width="58%" height={12} />
        <Skeleton width="82%" height={12} />
        <Skeleton width="46%" height={12} />
      </div>
    </aside>
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
      className="mesh-room-context-panel relative flex min-w-0 flex-shrink-0 flex-col overflow-hidden border-l border-outline-variant bg-surface-container-low"
      data-design-token-exception="user-resizable-persisted-room-context-width"
      style={{
        '--mesh-room-context-width': `${panelWidth}px`,
      } as CSSProperties}
      aria-label="Loading room context"
      aria-busy="true"
      tabIndex={-1}
    >
      <div className="flex h-conversation-header flex-shrink-0 items-center gap-3 border-b border-outline-variant px-3">
        <span
          className="min-w-0 flex-1 text-body-sm font-medium text-on-surface-variant"
          role="status"
          aria-live="polite"
        >
          Loading room context
        </span>
        <button
          type="button"
          className="min-h-11 min-w-11 rounded-full px-2 text-body-sm font-medium text-on-surface-variant transition-colors hover:bg-state-hover hover:text-on-surface focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus"
          onClick={onClose}
        >
          Close
        </button>
      </div>
      <div className="space-y-3 border-b border-outline-variant px-4 py-3" aria-hidden>
        <Skeleton width={92} height={12} />
        <Skeleton width="70%" height={10} />
      </div>
      <div className="min-h-0 flex-1 overflow-hidden py-2" aria-hidden>
        <MemberListSkeleton />
      </div>
    </aside>
  )
}

/*
 * `bg-surface-container` alone is the same value as the canvas behind it, so these
 * read as three invisible boxes until hover. The resting border is what makes
 * them look like the buttons they are.
 */
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
      className="flex min-h-24 flex-col items-center justify-center gap-2 rounded-full border border-outline-variant bg-surface-container p-3 text-body-md font-medium text-on-surface transition-colors hover:border-outline hover:bg-state-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus"
    >
      <Icon name={icon} />
      {label}
    </button>
  )
}
