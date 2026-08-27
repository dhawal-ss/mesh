import {
  memo,
  useState,
  useRef,
  useEffect,
  useCallback,
  useLayoutEffect,
  useMemo,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react'
import type { Channel, MatrixRoomUpgrade, Message as MessageType } from '../../types/ipc'
import { MessageComponent } from './Message'
import { MessageInput } from './MessageInput'
import type { StagedFile } from './FileAttachment'
import { useMessageStore } from '../../store/messages'
import { useChannelStore } from '../../store/channels'
import { SearchBar } from './SearchBar'
import { Tooltip } from '../ui/Tooltip'
import { Spinner } from '../ui/Spinner'
import { MessageSkeleton } from '../ui/Skeleton'
import { AsyncStatus } from '../ui/AsyncStatus'
import * as bridge from '../../lib/bridge'
import { useFileDownloadStore } from '../../store/file-downloads'
import { useIdentityStore } from '../../store/identity'
import { useVirtualScroll, type VirtualItem } from '../../hooks/useVirtualScroll'
import { useTypingStore } from '../../store/typing'
import { TypingIndicator } from './TypingIndicator'
import { resolveSenderIdentity } from '../../lib/matrixIdentity'
import { dayIndex } from '../../lib/message-time'
import { DayDivider } from './DayDivider'
import { UnreadDivider } from './UnreadDivider'
import { getBackoffDelay, waitForDelay } from '../../lib/scheduler'
import { describeError, errorLine } from '../../lib/errors'
import { showToast } from '../ui/Toast'
import { useMessageNavigationStore } from '../../store/message-navigation'
import { ErrorBoundary } from '../ui/ErrorBoundary'
import { Icon } from '../ui/Icon'
import { useCommunityMembers } from '../../store/membership'
import { useCommunityStore } from '../../store/communities'
import { groupThreadReplies } from '../../lib/threads'
import { shouldGroupMessage } from '../../lib/message-grouping'
import type { RoomTrustSnapshot } from '../../hooks/useRoomTrust'
import type { RoomContextTab } from '../community/RoomContextPanel'
import { RoomTrustSummary } from './RoomTrustSummary'
import { serverReach } from '../../lib/trust'
import { EmptyState } from '../ui/Primitives'
import { ClipsView } from './ClipsView'
import { EventView } from './EventView'
import { RSVP_REPLIES, rsvpFromReactions, clipsFromMessages } from '../../lib/room-shape'
import { useRoomShapeStore } from '../../store/room-shape'
import { useRoomPinStore } from '../../store/room-pins'
import { useVoiceStore } from '../../store/voice'
import { useCurrentMeshRoute, useMeshNavigationStore } from '../../store/navigation'
import { shouldExposeVoiceRoutes } from '../../lib/voice-runtime'
import { useFailedMessageAnnouncement } from '../../hooks/useFailedMessageAnnouncement'
import { OfflineQueueSummary } from './OfflineQueueSummary'
import { disposeSubscription } from '../../lib/subscription-cleanup'
import { motion } from '../../lib/lazy-motion'
import { variants } from '../../lib/motion'

interface ChatViewProps {
  channel: Channel
  trust?: RoomTrustSnapshot
  showContextToggle?: boolean
  isContextOpen?: boolean
  activeContextTab?: RoomContextTab
  onToggleContext?: () => void
  onOpenContext?: (tab: RoomContextTab) => void
}

const EMPTY_MESSAGES: MessageType[] = []

/** Shared empty set, so "nothing is arriving" keeps every row's props stable. */
const EMPTY_ENTERING_IDS: ReadonlySet<string> = new Set<string>()

/**
 * Every id a single message has answered to.
 *
 * A sent message is rendered first under the renderer request id and then
 * again under the server or queue event id, so identity by `id` alone would
 * read the acknowledgement as a second arrival and replay its animation at the
 * exact moment the row is meant to settle.
 */
function messageIdentities(message: MessageType): string[] {
  const identities = [message.id]
  if (message.clientRequestId) identities.push(message.clientRequestId)
  if (message.transactionId) identities.push(message.transactionId)
  return identities
}

/** Fixed height of a DayDivider row, so virtual layout needs no measurement. */
const DAY_DIVIDER_HEIGHT = 36
const UNREAD_DIVIDER_HEIGHT = 40

/**
 * Trailing window for Matrix room-update refreshes.
 *
 * The SDK records a room update for every change it sees, including read
 * receipts and typing, so in a room with ten active readers one sent message
 * produced a dozen full 50-message refetches. Updates are coalesced onto this
 * window: the first update after a room opens still refetches immediately, a
 * receipt storm collapses to a single refetch, and a steady stream keeps
 * refreshing once per window instead of starving.
 */
export const ROOM_UPDATE_COALESCE_MS = 100

/** Stable id for the author-name element a timeline article names itself from. */
function timelineAuthorNameId(messageId: string): string {
  return `mesh-timeline-author-${messageId}`
}

type UnreadBoundary = {
  channelId: string
  lastReadEventId: string | null
  firstUnreadEventId: string
}

export function ChatView({
  channel,
  trust,
  showContextToggle,
  isContextOpen,
  activeContextTab,
  onToggleContext,
  onOpenContext,
}: ChatViewProps) {
  const channelMessages = useMessageStore((state) => state.messages[channel.id] ?? EMPTY_MESSAGES)
  const pinnedMessages = useRoomPinStore((state) => (
    state.roomId === channel.id ? state.messages : EMPTY_MESSAGES
  ))

  useEffect(() => {
    const handleOpenRoomContext = (event: Event) => {
      const tab = event instanceof CustomEvent ? event.detail : null
      if (tab === 'people' || tab === 'ledger' || tab === 'files' || tab === 'pins') {
        onOpenContext?.(tab)
      }
    }
    window.addEventListener('mesh:open-room-context', handleOpenRoomContext)
    return () => window.removeEventListener('mesh:open-room-context', handleOpenRoomContext)
  }, [onOpenContext])
  const pinnedMessage = pinnedMessages[0] ?? null
  const failedSendAnnouncement = useFailedMessageAnnouncement(channel.id, channelMessages)
  const replaceMessages = useMessageStore((state) => state.replaceMessages)
  const prependMessages = useMessageStore((state) => state.prependMessages)
  const addMessage = useMessageStore((state) => state.addMessage)
  const updateReaction = useMessageStore((state) => state.updateReaction)
  const editMessage = useMessageStore((state) => state.editMessage)
  const deleteMessage = useMessageStore((state) => state.deleteMessage)
  const removeMessage = useMessageStore((state) => state.removeMessage)
  const removeMessagesByAuthorAllChannels = useMessageStore((state) => state.removeMessagesByAuthorAllChannels)
  const setDeliveryStatus = useMessageStore((state) => state.setDeliveryStatus)
  const acceptQueuedMessage = useMessageStore((state) => state.acceptQueuedMessage)
  const loadOlderMessages = useMessageStore((state) => state.loadOlderMessages)
  const isLoadingOlder = useMessageStore((state) => state.loadingOlder[channel.id] ?? false)
  const hasMoreOlder = useMessageStore((state) => state.hasMoreOlder[channel.id] !== false)
  const isBrowsingOlder = useMessageStore((state) => state.browsingOlder[channel.id] ?? false)
  const hiddenNewerCount = useMessageStore((state) => state.newerGapCount[channel.id] ?? 0)
  const queueStates = useMessageStore((state) => state.matrixQueueStates[channel.id])
  const matrixMode = bridge.isMatrixBackend()
  const studioVoiceRoom = useChannelStore((state) =>
    state.channels.find(
      (candidate) =>
        candidate.communityId === channel.communityId &&
        candidate.channelType === 'voice' &&
        candidate.name.toLocaleLowerCase() === 'studio',
    ) ?? state.channels.find(
      (candidate) =>
        candidate.communityId === channel.communityId && candidate.channelType === 'voice',
    ),
  )
  const currentVoiceChannelId = useVoiceStore((state) => state.currentChannelId)
  const setCurrentVoiceSession = useVoiceStore((state) => state.setCurrentVoiceSession)
  const route = useCurrentMeshRoute()
  const navigate = useMeshNavigationStore((state) => state.navigate)
  const closePane = useMeshNavigationStore((state) => state.closePane)
  const voiceRoutesEnabled = shouldExposeVoiceRoutes(
    matrixMode,
    bridge.getBackendStatusSnapshot(),
  )
  const currentStudioParty = currentVoiceChannelId === studioVoiceRoom?.id
  const canOpenStudioVoice = voiceRoutesEnabled
  const setCommunities = useCommunityStore((state) => state.setCommunities)
  const setActiveCommunity = useCommunityStore((state) => state.setActiveCommunity)
  const communityMembers = useCommunityMembers(channel.communityId)
  /*
    The sentence the app bar's assist chip carries.

    It counts servers rather than people, so it does not change every time
    somebody joins from a server already in the room, and it is null unless the
    room is actually protected. Saying "encrypted" while the protection probe is
    still running, or while it has told us the room is not encrypted, would be
    the one kind of lie this whole vocabulary exists to make impossible.
  */
  const encryptionLabel = useMemo(() => {
    if (!matrixMode || trust?.protection !== 'protected') return null
    const reach = serverReach(communityMembers.map((member) => member.publicKey))
    if (reach <= 1) return 'Encrypted'
    return `Encrypted \u00b7 ${reach} servers carry this room`
  }, [communityMembers, matrixMode, trust?.protection])
  const patchChannel = useChannelStore((state) => state.patchChannel)
  const replaceCommunityChannels = useChannelStore((state) => state.replaceCommunityChannels)
  const setActiveChannel = useChannelStore((state) => state.setActiveChannel)
  const navigationRequest = useMessageNavigationStore((state) => (
    state.pending?.message.channelId === channel.id ? state.pending : null
  ))
  const isViewingLatest = !isBrowsingOlder && hiddenNewerCount === 0
  const hydratingLatestRef = useRef(false)
  const bufferedMessagesRef = useRef<MessageType[]>([])
  const loadGenerationRef = useRef(0)
  const olderLoadInFlightRef = useRef(false)
  const lastScrollSeenRequestAtRef = useRef(0)
  const scrollSeenRequestRef = useRef<Promise<void> | null>(null)
  const windowLoadRef = useRef<Promise<void>>(Promise.resolve())
  const highlightTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined)
  const [isLoading, setIsLoading] = useState(true)
  const [loadedChannelId, setLoadedChannelId] = useState<string | null>(null)
  const [loadError, setLoadError] = useState<{
    channelId: string
    error: unknown
  } | null>(null)
  const [markReadErrors, setMarkReadErrors] = useState<Record<string, unknown>>({})
  const [showNewMessages, setShowNewMessages] = useState(false)
  const [replyingTo, setReplyingTo] = useState<MessageType | null>(null)
  const [threadReplyRoot, setThreadReplyRoot] = useState<MessageType | null>(null)
  const [preparedNavigationId, setPreparedNavigationId] = useState<number | null>(null)
  const [highlightedMessageId, setHighlightedMessageId] = useState<string | null>(null)
  const [jumpAnnouncement, setJumpAnnouncement] = useState('')
  const [unreadBoundary, setUnreadBoundary] = useState<UnreadBoundary | null>(null)
  const [announcement, setAnnouncement] = useState<{
    channelId: string | null
    tailId: string | null
    text: string
  }>({ channelId: null, tailId: null, text: '' })
  const [editRequest, setEditRequest] = useState<{ messageId: string; token: number } | null>(null)
  const [roomUpgradeState, setRoomUpgradeState] = useState<{
    roomId: string
    checked: boolean
    upgrade: MatrixRoomUpgrade | null
  }>({ roomId: '', checked: !matrixMode, upgrade: null })
  const [isFollowingRoomUpgrade, setIsFollowingRoomUpgrade] = useState(false)
  const [roomUpgradeError, setRoomUpgradeError] = useState<{
    roomId: string
    message: string
  } | null>(null)
  const [roomUpgradeAttempt, setRoomUpgradeAttempt] = useState(0)
  const previousChannelIdRef = useRef(channel.id)
  /*
   * The open room, for listeners that live as long as the component.
   *
   * Registering a bridge listener is asynchronous, so re-registering on every
   * room switch left a window with no listener attached and everything that
   * arrived in that window was lost. The subscriptions below stay for the
   * component's lifetime and compare against this ref instead. Mirrors
   * useNotificationSync.
   */
  const activeChannelIdRef = useRef(channel.id)
  useEffect(() => {
    activeChannelIdRef.current = channel.id
  }, [channel.id])
  const legacyPublicKey = useIdentityStore((state) => state.identity?.publicKey)
  const ownAuthorId = matrixMode
    ? bridge.getMatrixUserId() ?? undefined
    : legacyPublicKey
  // A hint for the composer affordance, not an authority: Matrix's own
  // threshold is `notifications.room`, which the backend reads at send time.
  // Mesh's three roles project onto 100/50/0 and the Matrix default for that
  // threshold is 50, so anybody above plain member is worth offering it to.
  const canNotifyRoom = matrixMode
    && communityMembers.some((member) => (
      member.publicKey === ownAuthorId && member.role !== 'member'
    ))
  const { visibleMessages, repliesByRoot } = useMemo(
    () => groupThreadReplies(channelMessages),
    [channelMessages],
  )
  /*
    A clips room reads the same timeline through a different lens. The gallery
    is derived, never stored, so a room can be switched back and forth and no
    message is ever filed anywhere it cannot be found again.
  */
  const roomShape = useRoomShapeStore((state) => state.shapes[channel.id] ?? 'conversation')
  const setRoomShape = useRoomShapeStore((state) => state.setShape)
  const clips = useMemo(
    () => (roomShape === 'clips' ? clipsFromMessages(visibleMessages) : []),
    [roomShape, visibleMessages],
  )
  /*
    An event room's plan is the room's pinned message, and the replies are the
    reactions already on it. Nothing here is a new kind of object, so a room
    read as an event and the same room read as a conversation cannot disagree.
  */
  /*
    The pin store keeps its own copy of the pinned message, so its reactions go
    stale the moment anybody replies. It is authoritative about *which* message
    is pinned and nothing else; the timeline is authoritative about what that
    message currently says. Falling back to the pinned copy matters for a plan
    pinned long enough ago to sit outside the loaded window.
  */
  const planMessage = useMemo(() => {
    if (!pinnedMessage) return null
    return channelMessages.find((message) => message.id === pinnedMessage.id) ?? pinnedMessage
  }, [channelMessages, pinnedMessage])
  const eventPlan = useMemo(() => (
    roomShape === 'event' && planMessage
      ? {
          id: planMessage.id,
          authorDisplayName: planMessage.authorDisplayName,
          content: planMessage.content,
          timestamp: planMessage.timestamp,
        }
      : null
  ), [roomShape, planMessage])
  const eventRsvp = useMemo(
    () => rsvpFromReactions(planMessage?.reactions ?? {}),
    [planMessage],
  )
  const eventMemberNames = useMemo(() => {
    const names: Record<string, string> = {}
    for (const member of communityMembers) names[member.publicKey] = member.displayName
    return names
  }, [communityMembers])
  const roomUpgradeReady = !matrixMode || (
    roomUpgradeState.roomId === channel.id && roomUpgradeState.checked
  )
  const roomUpgrade = matrixMode && roomUpgradeReady && roomUpgradeState.upgrade?.replacementRoomId
    ? roomUpgradeState.upgrade
    : null
  const roomUpgradeIsCommunity = roomUpgrade?.roomId === channel.communityId
  const activeUnreadBoundary = unreadBoundary?.channelId === channel.id
    ? unreadBoundary
    : null
  const activeLoadError = loadError?.channelId === channel.id ? loadError.error : null
  const activeMarkReadError = Object.prototype.hasOwnProperty.call(markReadErrors, channel.id)
  const activeRoomUpgradeError = roomUpgradeState.roomId === channel.id
    && roomUpgradeState.checked
    && roomUpgradeError?.roomId === channel.id
      ? roomUpgradeError.message
      : null
  const awaitingFirstLoad = loadedChannelId !== channel.id && activeLoadError == null
  /**
   * Whether this room's history is known good.
   *
   * Only a completed load with no outstanding error is evidence that an empty
   * timeline means "nobody has written here yet" rather than "Mesh could not
   * read this room". Stated explicitly rather than inferred from the order of
   * the render branches, because the branch order is exactly what a later edit
   * would change without noticing.
   */
  const roomHistoryLoaded = loadedChannelId === channel.id && activeLoadError == null
  /**
   * Which timeline state the log is presenting, named rather than left as a
   * chain of inline conditions, so the branch order below is readable and a
   * later edit cannot silently reorder the meaning.
   */
  const showsLoadError = activeLoadError != null && visibleMessages.length === 0
  const showsInitialLoad = !roomUpgradeReady
    || awaitingFirstLoad
    || (isLoading && visibleMessages.length === 0)
  const showsEmptyRoom = visibleMessages.length === 0
  // Only this state renders `article` rows, and only it may sit inside the feed.
  const showsMessageArticles = !roomUpgrade && !showsLoadError && !showsInitialLoad && !showsEmptyRoom
  const sendingProtectionUnavailable = matrixMode && trust?.protection !== 'protected'
  const savedMessages = useMemo(
    () => channelMessages.filter((message) => {
      const transactionId = message.transactionId ?? message.id
      return message.deliveryStatus === 'pending'
        && queueStates?.[transactionId]?.state === 'pending'
    }),
    [channelMessages, queueStates],
  )
  /*
    Failures never expired from this room's view, so counting them here is what
    gives an undelivered message a surface that survives scrolling away.
  */
  const failedMessages = useMemo(
    () => channelMessages.filter((message) => message.deliveryStatus === 'failed'),
    [channelMessages],
  )
  const openThreadId = route.kind === 'room'
    && route.roomId === channel.id
    && route.pane?.kind === 'thread'
      ? route.pane.rootEventId
      : null

  const beginThreadReply = useCallback((root: MessageType, target: MessageType = root) => {
    setThreadReplyRoot(root)
    setReplyingTo(target)
  }, [])

  const beginOrdinaryReply = useCallback((message: MessageType) => {
    setThreadReplyRoot(null)
    setReplyingTo(message)
  }, [])

  const toggleThread = useCallback((messageId: string) => {
    if (route.kind !== 'room' || route.roomId !== channel.id) return
    if (openThreadId === messageId) {
      closePane()
      return
    }
    navigate({
      ...route,
      pane: { kind: 'thread', rootEventId: messageId },
    }, { focus: false })
  }, [channel.id, closePane, navigate, openThreadId, route])

  useEffect(() => {
    if (previousChannelIdRef.current === channel.id) return
    previousChannelIdRef.current = channel.id
    setThreadReplyRoot(null)
    setReplyingTo(null)
  }, [channel.id])

  useEffect(() => {
    const handleThreadReply = (event: Event) => {
      const detail = (event as CustomEvent<{ rootId?: string; targetId?: string }>).detail
      if (!detail?.rootId) return
      const root = channelMessages.find((message) => message.id === detail.rootId)
      if (!root) return
      const target = detail.targetId
        ? channelMessages.find((message) => message.id === detail.targetId) ?? root
        : root
      beginThreadReply(root, target)
    }
    window.addEventListener('mesh:reply-in-thread', handleThreadReply)
    return () => window.removeEventListener('mesh:reply-in-thread', handleThreadReply)
  }, [beginThreadReply, channelMessages])

  /*
   * Which rows are allowed to play the arrival animation.
   *
   * A virtualized row mounts every time it scrolls back into the window, so
   * "animate on mount" would animate the whole timeline on every scroll. Only
   * an unbroken run of never-before-seen messages at the *tail* counts as an
   * arrival: that is a send or an incoming message. A history page prepended
   * at the head is equally new to this component and deliberately does not
   * qualify, and the first paint of a room animates nothing at all.
   */
  const seenMessagesRef = useRef<{ channelId: string; ids: Set<string>, hydrated: boolean }>({
    channelId: channel.id,
    ids: new Set<string>(),
    hydrated: false,
  })
  const enteringMessageIds = useMemo(() => {
    const seen = seenMessagesRef.current
    // Gate on having settled this room's history rather than on having seen any
    // message. A room that loaded empty has seen nothing, and the first message
    // sent into it is a real arrival that should animate. Waiting for the load
    // to settle still keeps a history page, which lands all at once and is
    // entirely unseen, from animating the whole timeline.
    if (seen.channelId !== channel.id || !seen.hydrated) return EMPTY_ENTERING_IDS
    const entering = new Set<string>()
    for (let index = visibleMessages.length - 1; index >= 0; index -= 1) {
      const message = visibleMessages[index]
      if (messageIdentities(message).some((identity) => seen.ids.has(identity))) break
      entering.add(message.id)
    }
    return entering.size === 0 ? EMPTY_ENTERING_IDS : entering
  }, [channel.id, visibleMessages])

  useEffect(() => {
    const seen = seenMessagesRef.current
    if (seen.channelId !== channel.id) {
      seen.channelId = channel.id
      seen.ids = new Set<string>()
      seen.hydrated = false
    }
    for (const message of visibleMessages) {
      for (const identity of messageIdentities(message)) seen.ids.add(identity)
    }
    // Recorded after this pass, so whatever arrived with the history is already
    // marked seen before anything is allowed to count as an arrival.
    if (roomHistoryLoaded) seen.hydrated = true
  }, [channel.id, roomHistoryLoaded, visibleMessages])

  // O(1) message lookup for the render map and the scroll handler, which both
  // previously did a linear scan per row / per scroll event.
  const messageIndexById = useMemo(() => {
    const index = new Map<string, number>()
    visibleMessages.forEach((message, position) => index.set(message.id, position))
    return index
  }, [visibleMessages])

  /*
    Reply targets are resolved from the whole loaded room, not from the render
    window.

    The preview used to be looked up in `visibleMessages`, which the reset path
    caps at 50 rows, so a reply to anything further back rendered nothing at all
    even when the message it answered was sitting in the store. The reply
    relationship was simply dropped: `replyToId` was present and proved the row
    was a reply, and the reader saw an ordinary message.
  */
  const replyTargetById = useMemo(() => {
    const index = new Map<string, MessageType>()
    for (const message of channelMessages) index.set(message.id, message)
    return index
  }, [channelMessages])

  // The first message of each calendar day, keyed by divider key. The divider
  // must not read its date off whichever row happens to follow it in the
  // virtual window, because that row can be clipped at a window boundary.
  const dividerTimestamps = useMemo(() => {
    const firstOfDay = new Map<string, unknown>()
    for (const message of visibleMessages) {
      const day = dayIndex(message.timestamp)
      if (day === null) continue
      const key = `day:${day}`
      if (!firstOfDay.has(key)) firstOfDay.set(key, message.timestamp)
    }
    return firstOfDay
  }, [visibleMessages])

  // Build the virtual item list
  const virtualItems = useMemo<VirtualItem[]>(() => {
    const items: VirtualItem[] = []
    let previousDay: number | null = null
    let unreadDividerAdded = false

    if (!hasMoreOlder && visibleMessages.length > 0) {
      items.push({
        key: `history-start:${channel.id}`,
        type: 'history-start',
        height: 40,
      })
    }

    for (const message of visibleMessages) {
      // Date separators are emitted as their own fixed-height virtual items so
      // the timeline stays scannable when scrolled back through history.
      const currentDay = dayIndex(message.timestamp)
      if (currentDay !== null && currentDay !== previousDay) {
        items.push({
          key: `day:${currentDay}`,
          type: 'divider' as const,
          height: DAY_DIVIDER_HEIGHT,
        })
        previousDay = currentDay
      }

      if (
        !unreadDividerAdded
        && activeUnreadBoundary?.firstUnreadEventId === message.id
      ) {
        items.push({
          key: `unread:${channel.id}:${activeUnreadBoundary.lastReadEventId ?? 'start'}`,
          type: 'unread-divider',
          height: UNREAD_DIVIDER_HEIGHT,
        })
        unreadDividerAdded = true
      }

      items.push({
        key: message.id,
        type: 'message' as const,
        height:
          56
          + Math.min(
            160,
            Math.max(
              1,
              Math.ceil((typeof message.content === 'string' ? message.content.length : 0) / 80),
            ) * 20,
          )
          + (Array.isArray(message.attachments) && message.attachments.length > 0 ? 96 : 0)
          + (repliesByRoot.has(message.id) ? 36 : 0),
      })
    }
    if (hiddenNewerCount > 0) {
      items.push({
        key: `history-gap:${channel.id}`,
        type: 'gap' as const,
        height: 88,
      })
    }
    return items
  }, [
    activeUnreadBoundary,
    channel.id,
    hasMoreOlder,
    hiddenNewerCount,
    repliesByRoot,
    visibleMessages,
  ])

  const {
    scrollContainerRef,
    topSpacerHeight,
    bottomSpacerHeight,
    visibleRange,
    handleMeasuredHeight,
    handleScroll: updateVirtualScroll,
    getIsAtBottom,
    scrollToBottom,
    scrollToItem,
    resetLayout,
    setScrollAnchor,
  } = useVirtualScroll(virtualItems)
  /*
    The feed's keyboard contract.

    `role="feed"` was claimed with a comment saying it "gives Page Down and Page
    Up article navigation". It does not: the role carries no behaviour, it only
    tells assistive technology what the pattern is meant to be. Rows were never
    focusable either, so a keyboard user in a two hundred message room had no
    per-message navigation at all and had to Tab through one toolbar stop per
    message to get out of the timeline. That is a WCAG 2.1.1 failure on the
    product's primary reading surface.

    `focusedMessageId` is the roving tab stop: exactly one article is reachable
    with Tab, and the arrow, page and home/end keys move it.
  */
  const [focusedMessageId, setFocusedMessageId] = useState<string | null>(null)
  const visibleItems = useMemo(() => {
    if (virtualItems.length === 0) return []
    const slice = virtualItems.slice(visibleRange.start, visibleRange.end + 1)
    /*
      Keep the row holding focus rendered even when scrolling carries it out of
      the window. Slicing strictly to the range unmounted the focused element,
      which drops focus to <body> and silently ends keyboard navigation.
    */
    if (!focusedMessageId || slice.some((item) => item.key === focusedMessageId)) return slice
    const focusedIndex = virtualItems.findIndex((item) => item.key === focusedMessageId)
    if (focusedIndex === -1) return slice
    return focusedIndex < visibleRange.start
      ? [virtualItems[focusedIndex], ...slice]
      : [...slice, virtualItems[focusedIndex]]
  }, [focusedMessageId, virtualItems, visibleRange.end, visibleRange.start])
  // The hook owns the scroll element through a callback ref. Controls outside
  // the scroll handler (the explicit "Load earlier messages" button) still need
  // the element to anchor the reader's position across a prepend.
  const messageLogRef = useRef<HTMLDivElement | null>(null)
  const attachMessageLog = useCallback((node: HTMLDivElement | null) => {
    messageLogRef.current = node
    scrollContainerRef(node)
  }, [scrollContainerRef])

  /**
   * Moves the caret to the composer.
   *
   * The composer region owns the id; the field inside it belongs to
   * MessageInput, so this asks the region for its control rather than
   * reaching for a component-private ref.
   */
  const focusComposer = useCallback(() => {
    const composer = document.getElementById('mesh-composer')
    const field = composer?.querySelector<HTMLTextAreaElement>('textarea')
    // A disabled field cannot take focus, so the region itself is the fallback
    // and the reader still lands on the composer rather than nowhere.
    if (field && !field.disabled) field.focus()
    else composer?.focus()
  }, [])

  const markChannelSeen = useCallback(async () => {
    try {
      await bridge.markChannelRead(channel.id)
      patchChannel(channel.id, { unreadCount: 0 })
      setMarkReadErrors((current) => {
        if (!Object.prototype.hasOwnProperty.call(current, channel.id)) return current
        const next = { ...current }
        delete next[channel.id]
        return next
      })
    } catch (error) {
      setMarkReadErrors((current) => ({ ...current, [channel.id]: error }))
      throw error
    }
  }, [channel.id, patchChannel])

  const markChannelSeenFromScroll = useCallback(() => {
    const now = Date.now()
    if (
      scrollSeenRequestRef.current
      || now - lastScrollSeenRequestAtRef.current < 1_000
    ) {
      return
    }
    lastScrollSeenRequestAtRef.current = now
    const request = markChannelSeen()
      .catch((err) => {
        console.error('Failed to mark channel as read:', err)
      })
      .finally(() => {
        if (scrollSeenRequestRef.current === request) {
          scrollSeenRequestRef.current = null
        }
      })
    scrollSeenRequestRef.current = request
  }, [markChannelSeen])

  /**
   * The unread divider's own "Mark as read".
   *
   * Reuses `markChannelSeen`, the room's single read-marker path, so a failure
   * still lands in the existing retryable banner instead of being swallowed.
   * Clearing the boundary is the visible result of the action: the divider is
   * the control, so it has to go away when the control is used. Because it
   * unmounts under the caret, focus is handed to the composer rather than
   * dropped on the body, which is also where someone who has just caught up is
   * heading.
   */
  const handleMarkReadFromDivider = useCallback(() => {
    setUnreadBoundary(null)
    focusComposer()
    void markChannelSeen().catch(() => {})
  }, [focusComposer, markChannelSeen])

  const flushBufferedMessages = useCallback(() => {
    if (bufferedMessagesRef.current.length === 0) return
    const pending = bufferedMessagesRef.current
    bufferedMessagesRef.current = []
    for (const message of pending) {
      addMessage(channel.id, message)
    }
  }, [addMessage, channel.id])

  const resetToLatestWindow = useCallback(async () => {
    const generation = ++loadGenerationRef.current
    hydratingLatestRef.current = true
    bufferedMessagesRef.current = []

    try {
      const latest = await bridge.getMessages(channel.id, 50)
      if (generation !== loadGenerationRef.current) return

      const unreadCount = channel.unreadCount
      if (unreadCount > 0) {
        const latestVisible = groupThreadReplies(latest).visibleMessages
        const firstUnreadIndex = Math.max(0, latestVisible.length - unreadCount)
        const firstUnread = latestVisible[firstUnreadIndex]
        if (firstUnread) {
          setUnreadBoundary((current) => (
            current?.channelId === channel.id
              ? current
              : {
                  channelId: channel.id,
                  lastReadEventId: latestVisible[firstUnreadIndex - 1]?.id ?? null,
                  firstUnreadEventId: firstUnread.id,
                }
          ))
        }
      }
      replaceMessages(channel.id, latest)
      if (!matrixMode) {
        await bridge.requestMessageHistory(channel.id, { limit: 100 })
        if (generation !== loadGenerationRef.current) return
      }
      setShowNewMessages(false)

      requestAnimationFrame(() => {
        if (generation !== loadGenerationRef.current) return
        scrollToBottom()
      })
    } finally {
      if (generation === loadGenerationRef.current) {
        hydratingLatestRef.current = false
        flushBufferedMessages()
      }
    }

    if (generation === loadGenerationRef.current) {
      await markChannelSeen().catch(() => {})
    }
  }, [
    channel.id,
    channel.unreadCount,
    flushBufferedMessages,
    markChannelSeen,
    matrixMode,
    replaceMessages,
    scrollToBottom,
  ])

  const loadLatestMessages = useCallback(async () => {
    setIsLoading(true)
    setLoadError((current) => current?.channelId === channel.id ? null : current)
    const pendingLoad = resetToLatestWindow()
    windowLoadRef.current = pendingLoad
    const generation = loadGenerationRef.current
    try {
      await pendingLoad
      if (generation === loadGenerationRef.current) setLoadedChannelId(channel.id)
    } catch (error) {
      if (generation === loadGenerationRef.current) setLoadError({ channelId: channel.id, error })
      throw error
    } finally {
      if (generation === loadGenerationRef.current) setIsLoading(false)
    }
  }, [channel.id, resetToLatestWindow])

  // Read room-upgrade state before loading a Matrix room.
  useEffect(() => {
    let active = true
    if (!matrixMode) return () => { active = false }

    Promise.allSettled([
      bridge.matrixRoomUpgrade(channel.id),
      bridge.matrixRoomUpgrade(channel.communityId),
    ])
      .then(([channelResult, communityResult]) => {
        if (!active) return
        const channelUpgrade = channelResult.status === 'fulfilled' ? channelResult.value : null
        const communityUpgrade = communityResult.status === 'fulfilled' ? communityResult.value : null
        const failed = [channelResult, communityResult].some((result) => result.status === 'rejected')
        setRoomUpgradeError(failed ? {
          roomId: channel.id,
          message: 'Room move details could not be refreshed.',
        } : null)
        setRoomUpgradeState({
          roomId: channel.id,
          checked: true,
          upgrade: communityUpgrade?.replacementRoomId ? communityUpgrade : channelUpgrade,
        })
      })

    return () => { active = false }
  }, [channel.communityId, channel.id, matrixMode, roomUpgradeAttempt])

  // Load messages on channel switch
  useEffect(() => {
    if (!roomUpgradeReady || roomUpgrade) {
      return
    }
    void Promise.resolve().then(() => loadLatestMessages()).catch((error) => {
      console.error('Failed to load messages:', error)
    })
    return () => {
      loadGenerationRef.current += 1
    }
  }, [loadLatestMessages, roomUpgrade, roomUpgradeReady])

  // Search can target another channel or a message outside the bounded hot
  // window. Wait for the channel-switch load first, then merge older context
  // around the search result so the latest load cannot evict the target.
  useEffect(() => {
    if (!navigationRequest) return

    let active = true
    const prepareNavigation = async () => {
      try {
        await windowLoadRef.current
      } catch {
        // The target DTO from search still lets navigation proceed when the
        // latest-window refresh is temporarily unavailable.
      }
      if (!active) return

      const currentRequest = useMessageNavigationStore.getState().pending
      if (currentRequest?.requestId !== navigationRequest.requestId) return

      const target = navigationRequest.message
      const currentMessages =
        useMessageStore.getState().messages[channel.id] ?? EMPTY_MESSAGES
      if (!currentMessages.some((message) => message.id === target.id)) {
        let olderContext: MessageType[] = []
        try {
          olderContext = await bridge.getMessages(channel.id, 49, {
            timestamp: target.timestamp,
            id: target.id,
          })
        } catch (error) {
          console.error('Failed to load context for searched message:', error)
        }
        if (!active) return

        const latestRequest = useMessageNavigationStore.getState().pending
        if (latestRequest?.requestId !== navigationRequest.requestId) return
        prependMessages(channel.id, [...olderContext, target])
      }

      setPreparedNavigationId(navigationRequest.requestId)
    }

    void prepareNavigation()
    return () => {
      active = false
    }
  }, [channel.id, navigationRequest, prependMessages])

  // Once the target is in the virtual layout, center it and leave both a
  // visible and screen-reader-visible indication for exactly two seconds.
  useLayoutEffect(() => {
    if (
      !navigationRequest
      || navigationRequest.message.threadRootId
      || preparedNavigationId !== navigationRequest.requestId
      || !virtualItems.some((item) => item.key === navigationRequest.message.id)
    ) {
      return
    }

    const target = navigationRequest.message
    if (!scrollToItem(target.id, 'center')) return

    clearTimeout(highlightTimerRef.current)
    let active = true
    void Promise.resolve().then(() => {
      if (!active) return
      setHighlightedMessageId(target.id)
      setJumpAnnouncement(`Jumped to message from ${target.authorDisplayName}`)
      highlightTimerRef.current = setTimeout(() => {
        setHighlightedMessageId(null)
        setJumpAnnouncement('')
      }, 2_000)
      useMessageNavigationStore.getState().completeNavigation(navigationRequest.requestId)
    })
    return () => {
      active = false
    }
  }, [navigationRequest, preparedNavigationId, scrollToItem, virtualItems])

  useEffect(
    () => () => {
      clearTimeout(highlightTimerRef.current)
    },
    [],
  )

  // Matrix sync runs in Rust. Wait on the SDK room update stream, then refresh
  // the DTO projection so federated state appears without fixed-interval
  // polling. The stream carries every kind of room update, including read
  // receipts and typing, so refreshes are coalesced onto
  // ROOM_UPDATE_COALESCE_MS rather than run once per wake-up.
  useEffect(() => {
    if (!matrixMode || !isViewingLatest || !roomUpgradeReady || roomUpgrade) return

    let active = true
    const refresh = async () => {
      if (hydratingLatestRef.current) return
      const generation = loadGenerationRef.current
      try {
        const existing = useMessageStore.getState().messages[channel.id] ?? []
        const existingIds = new Set(existing.map((message) => message.id))
        const latest = await bridge.getMessages(channel.id, 50)
        if (!active || generation !== loadGenerationRef.current) return

        const hasNewMessage = latest.some((message) => !existingIds.has(message.id))
        replaceMessages(channel.id, latest)
        setLoadError((current) => current?.channelId === channel.id ? null : current)
        if (hasNewMessage) {
          if (getIsAtBottom()) {
            requestAnimationFrame(scrollToBottom)
          } else {
            setShowNewMessages(true)
          }
        }
      } catch (error) {
        if (!active || generation !== loadGenerationRef.current) return
        setLoadError({ channelId: channel.id, error })
        console.error('Failed to refresh Matrix timeline:', error)
      }
    }

    /*
     * Coalescing state. `refresh` itself is unchanged and still reads
     * `loadGenerationRef` at call time, so it remains the single cancellation
     * token, and it still returns early while `hydratingLatestRef` is set, so
     * arrivals during the initial load stay buffered rather than dropped.
     */
    let refreshInFlight = false
    let refreshQueued = false
    let lastRefreshEndedAt = 0
    let coalesceTimer: ReturnType<typeof setTimeout> | null = null

    const runRefresh = async () => {
      refreshInFlight = true
      try {
        await refresh()
      } finally {
        refreshInFlight = false
        lastRefreshEndedAt = Date.now()
      }
      if (!active || !refreshQueued) return
      // Updates that arrived mid-refetch read server state this pass had
      // already left behind, so they collapse into one follow-up pass.
      refreshQueued = false
      coalesceTimer = setTimeout(() => {
        coalesceTimer = null
        if (active) void runRefresh()
      }, ROOM_UPDATE_COALESCE_MS)
    }

    const scheduleRefresh = () => {
      if (!active) return
      if (refreshInFlight) {
        refreshQueued = true
        return
      }
      if (coalesceTimer !== null) return
      // Zero on the first update after this room opened, so opening a room and
      // the first message in it are never delayed by the window.
      const waitMs = ROOM_UPDATE_COALESCE_MS - (Date.now() - lastRefreshEndedAt)
      if (waitMs <= 0) {
        void runRefresh()
        return
      }
      coalesceTimer = setTimeout(() => {
        coalesceTimer = null
        if (active) void runRefresh()
      }, waitMs)
    }

    const retryController = new AbortController()
    let retryAttempt = 0
    const watchUpdates = async () => {
      while (active) {
        try {
          const kind = await bridge.matrixWaitForRoomUpdate(channel.id)
          retryAttempt = 0
          // Deliberately not awaited: the wait re-subscribes on the Rust side
          // only after this call returns, so going straight back to waiting
          // shortens the window in which an update can be missed.
          //
          // Only a timeline change earns a refetch. Read receipts and typing
          // are the most frequent updates in an active room, and refetching the
          // whole timeline for one of those was pure waste on both sides of the
          // IPC boundary.
          if (active && kind === 'timeline') scheduleRefresh()
        } catch (error) {
          if (!active) return
          console.error('Matrix room update subscription failed:', error)
          const retryDelay = getBackoffDelay(retryAttempt, {
            baseMs: 1_000,
            maxMs: 30_000,
            jitterRatio: 0.2,
          })
          retryAttempt += 1
          await waitForDelay(retryDelay, retryController.signal)
        }
      }
    }
    void watchUpdates()
    return () => {
      active = false
      if (coalesceTimer !== null) {
        clearTimeout(coalesceTimer)
        coalesceTimer = null
      }
      retryController.abort()
    }
  }, [
    channel.id,
    getIsAtBottom,
    isViewingLatest,
    matrixMode,
    roomUpgrade,
    roomUpgradeReady,
    replaceMessages,
    scrollToBottom,
  ])

  // Reset scroll state on channel switch
  useEffect(() => {
    resetLayout()
  }, [channel.id, resetLayout])

  // Request history from new peers
  useEffect(() => {
    if (matrixMode) return
    const unsub = bridge.onPeerJoined(({ peerId }) => {
      bridge
        .requestMessageHistory(activeChannelIdRef.current, { peerId, limit: 100 })
        .catch((err) => {
          console.error('Failed to request message history:', err)
        })
    })
    return () => disposeSubscription(unsub, 'peer-joined listener')
  }, [matrixMode])

  /*
   * The message handler changes with the room's read state, but the
   * subscription must not: it is kept current through a ref so the listener
   * itself can live for the component's lifetime.
   */
  const receiveMessage = useCallback((msg: MessageType) => {
    if (msg.channelId !== activeChannelIdRef.current) return
    if (hydratingLatestRef.current) {
      bufferedMessagesRef.current.push(msg)
      return
    }
    addMessage(msg.channelId, msg)

    if (isViewingLatest && getIsAtBottom()) {
      markChannelSeen().catch((err) => {
        console.error('Failed to mark channel as read:', err)
      })
      setShowNewMessages(false)
    } else {
      setShowNewMessages(true)
    }
  }, [addMessage, getIsAtBottom, isViewingLatest, markChannelSeen])
  const receiveMessageRef = useRef(receiveMessage)
  useEffect(() => {
    receiveMessageRef.current = receiveMessage
  }, [receiveMessage])

  // Listen for incoming messages
  useEffect(() => {
    if (matrixMode) return
    const unsub = bridge.onMessageReceived((msg) => receiveMessageRef.current(msg))
    return () => disposeSubscription(unsub, 'message listener')
  }, [matrixMode])

  // Listen for reactions
  useEffect(() => {
    if (matrixMode) return
    const unsub = bridge.onReactionReceived((data) => {
      if (data.channelId !== activeChannelIdRef.current) return
      updateReaction(data.channelId, data.messageId, data.emoji, data.author, data.verb)
    })
    return () => disposeSubscription(unsub, 'reaction listener')
  }, [matrixMode, updateReaction])

  // Listen for bans
  useEffect(() => {
    const unsub = bridge.onBanReceived((data) => {
      removeMessagesByAuthorAllChannels(data.bannedPublicKey)
    })
    return () => disposeSubscription(unsub, 'ban listener')
  }, [removeMessagesByAuthorAllChannels])

  // Wire file download events
  useEffect(() => {
    let active = true
    const unsubs: Array<() => void> = []

    const wireFileEvents = async () => {
      const progressUnlisten = await bridge.onFileDownloadProgress((payload) => {
        useFileDownloadStore.getState().updateDownloadProgress(payload)
      })
      if (!active) { progressUnlisten(); return }
      unsubs.push(progressUnlisten)

      const availableUnlisten = await bridge.onFileAvailable((payload) => {
        useFileDownloadStore.getState().markDownloadAvailable(payload)
      })
      if (!active) { availableUnlisten(); return }
      unsubs.push(availableUnlisten)
    }

    wireFileEvents().catch((err) => {
      console.error('Failed to wire file events:', err)
    })

    return () => {
      active = false
      unsubs.forEach((unlisten) => unlisten())
    }
  }, [])

  // Listen for edit/delete events
  useEffect(() => {
    if (matrixMode) return
    const unsubEdit = bridge.onMessageEdited?.((data: { messageId: string; channelId: string; content: string; editedAt: string }) => {
      if (data.channelId !== activeChannelIdRef.current) return
      editMessage(data.channelId, data.messageId, data.content, data.editedAt)
    })
    const unsubDelete = bridge.onMessageDeleted?.((data: { messageId: string; channelId: string }) => {
      if (data.channelId !== activeChannelIdRef.current) return
      deleteMessage(data.channelId, data.messageId)
    })
    return () => {
      disposeSubscription(unsubEdit, 'message edit listener')
      disposeSubscription(unsubDelete, 'message delete listener')
    }
  }, [deleteMessage, editMessage, matrixMode])

  // Listen for typing events
  const setTyping = useTypingStore((state) => state.setTyping)
  const setTypingUsers = useTypingStore((state) => state.setTypingUsers)
  /*
   * The room typing may be reported for, or null while this room is moving or
   * its upgrade state is unknown. The old effect said the same thing by not
   * registering at all, which cost a teardown and an asynchronous
   * re-registration on every room switch.
   */
  const typingRoomIdRef = useRef<string | null>(null)
  useEffect(() => {
    if (!roomUpgradeReady || roomUpgrade) {
      typingRoomIdRef.current = null
      return
    }
    typingRoomIdRef.current = channel.id
    return () => {
      typingRoomIdRef.current = null
    }
  }, [channel.id, roomUpgrade, roomUpgradeReady])

  const refreshMatrixTyping = useCallback(async (roomId: string) => {
    try {
      const users = await bridge.matrixTypingUsers(roomId)
      if (typingRoomIdRef.current !== roomId) return
      setTypingUsers(
        roomId,
        users.map((user) => ({ author: user.userId, displayName: user.displayName })),
      )
    } catch (error) {
      console.error('Failed to refresh Matrix typing notifications:', error)
    }
  }, [setTypingUsers])

  useEffect(() => {
    if (matrixMode) {
      const listener = bridge.onMatrixTypingChanged((change) => {
        if (change.roomId === typingRoomIdRef.current) void refreshMatrixTyping(change.roomId)
      })
      void listener.catch((error) => {
        console.warn('Failed to register the Matrix typing listener:', error)
      })
      return () => disposeSubscription(listener, 'Matrix typing listener')
    }
    const unsub = bridge.onTypingUpdate((data) => {
      if (data.channelId !== typingRoomIdRef.current) return
      setTyping(data.channelId, data.author, data.displayName)
    })
    return () => disposeSubscription(unsub, 'typing listener')
  }, [matrixMode, refreshMatrixTyping, setTyping])

  // The listener only reports changes, so each room still needs one snapshot.
  useEffect(() => {
    if (!matrixMode || !roomUpgradeReady || roomUpgrade) return
    void refreshMatrixTyping(channel.id)
  }, [channel.id, matrixMode, refreshMatrixTyping, roomUpgrade, roomUpgradeReady])

  const jumpToLatest = useCallback(async () => {
    if (hiddenNewerCount > 0 || isBrowsingOlder) {
      try {
        await resetToLatestWindow()
      } catch (err) {
        console.error('Failed to jump to latest:', err)
      }
      return
    }

    scrollToBottom()
    setShowNewMessages(false)
    markChannelSeen().catch((err) => {
      console.error('Failed to mark channel as read:', err)
    })
  }, [
    hiddenNewerCount,
    isBrowsingOlder,
    markChannelSeen,
    resetToLatestWindow,
    scrollToBottom,
  ])

  /**
   * Announce genuinely new messages, once each. Driven off the tail of the
   * timeline rather than off DOM insertion, so virtualization and history
   * pagination never trigger it. Own messages are skipped: the sender already
   * knows what they sent.
   */
  /*
   * Announcement text is adjusted during render (React's supported
   * "adjust state when inputs change" pattern) rather than in an effect, so it
   * neither triggers cascading renders nor mutates refs during render.
   *
   * Switching channels re-baselines without announcing, so arriving in a room
   * does not read its last message aloud; only a genuinely new tail does.
   */
  const tailMessage = visibleMessages[visibleMessages.length - 1]
  const tailMessageId = tailMessage?.id ?? null

  if (announcement.channelId !== channel.id) {
    setAnnouncement({ channelId: channel.id, tailId: tailMessageId, text: '' })
  } else if (announcement.tailId !== tailMessageId) {
    const isOwnMessage = Boolean(
      ownAuthorId && tailMessage && tailMessage.authorPublicKey === ownAuthorId,
    )
    const isUnsent = Boolean(
      tailMessage?.deliveryStatus && tailMessage.deliveryStatus !== 'sent',
    )
    const body = typeof tailMessage?.content === 'string'
      ? tailMessage.content.slice(0, 140)
      : ''
    const shouldAnnounce = Boolean(
      tailMessage && announcement.tailId !== null && !isOwnMessage && !isUnsent,
    )
    setAnnouncement({
      channelId: channel.id,
      tailId: tailMessageId,
      text: shouldAnnounce && tailMessage
        ? (body
            ? `${tailMessage.authorDisplayName}: ${body}`
            : `New message from ${tailMessage.authorDisplayName}`)
        : '',
    })
  }

  const arrivalAnnouncement = announcement.text

  /**
   * Jump from a reply to the message it answers. Reuses the search-jump
   * highlight so both entry points look and announce the same.
   */
  const handleNavigateToMessage = useCallback((message: MessageType) => {
    useMessageNavigationStore.getState().requestNavigation(message)
    const targetChannel = useChannelStore.getState().channels
      .find((candidate) => candidate.id === message.channelId)
    if (targetChannel) {
      setActiveCommunity(targetChannel.communityId)
      navigate({
        kind: 'room',
        communityId: targetChannel.communityId,
        roomId: targetChannel.id,
        pane: message.threadRootId
          ? { kind: 'thread', rootEventId: message.threadRootId }
          : undefined,
      }, { focus: false })
    }
    setActiveChannel(message.channelId)
  }, [navigate, setActiveChannel, setActiveCommunity])

  const handleJumpToReply = useCallback((target: MessageType) => {
    /*
      The target may be loaded but outside the render window, in which case the
      virtual list cannot scroll to it. Fall back to the navigation path, which
      loads context around the event and then reveals it, rather than doing
      nothing and leaving the click looking broken.
    */
    if (!scrollToItem(target.id, 'center')) {
      handleNavigateToMessage(target)
      return
    }
    clearTimeout(highlightTimerRef.current)
    setHighlightedMessageId(target.id)
    setJumpAnnouncement(`Jumped to message from ${target.authorDisplayName}`)
    highlightTimerRef.current = setTimeout(() => {
      setHighlightedMessageId(null)
      setJumpAnnouncement('')
    }, 2_000)
  }, [handleNavigateToMessage, scrollToItem])

  /*
    Opening a clip puts the room back into its conversation shape at that
    message, so a gallery is never a dead end: the replies, the thread and the
    context are all still there, one click away.
  */
  const handleOpenClip = useCallback((messageId: string) => {
    const target = visibleMessages.find((message) => message.id === messageId)
    if (!target) return
    setRoomShape(channel.id, 'conversation')
    handleJumpToReply(target)
  }, [channel.id, handleJumpToReply, setRoomShape, visibleMessages])

  /*
    One reply, not a pile of reactions.

    An RSVP is a single answer, so choosing one clears whichever other reply
    this account was holding. `addReaction` toggles, so removing means calling
    it again on the emoji already held; choosing the reply already chosen
    withdraws it, which is how somebody says they are no longer coming.

    The optimistic update mirrors what a reaction does anywhere else in the
    product, and reverts the same way, so an event room has no separate failure
    behaviour to learn.
  */
  const handleRsvp = useCallback(async (replyId: string) => {
    const plan = planMessage
    const chosen = RSVP_REPLIES.find((reply) => reply.id === replyId)
    if (!plan || !chosen || !ownAuthorId) return

    const holds = (emoji: string) => (plan.reactions?.[emoji] ?? []).includes(ownAuthorId)
    const withdrawing = holds(chosen.emoji)
    const toClear = withdrawing
      ? []
      : RSVP_REPLIES.filter((reply) => reply.id !== chosen.id && holds(reply.emoji))

    for (const reply of [...toClear, chosen]) {
      const verb = reply.emoji === chosen.emoji && !withdrawing ? 'add' : 'remove'
      updateReaction(channel.id, plan.id, reply.emoji, ownAuthorId, verb)
      try {
        await bridge.addReaction(plan.id, reply.emoji, channel.id)
      } catch {
        updateReaction(
          channel.id,
          plan.id,
          reply.emoji,
          ownAuthorId,
          verb === 'add' ? 'remove' : 'add',
        )
      }
    }
  }, [channel.id, ownAuthorId, planMessage, updateReaction])

  /*
    Which rendered row owns the feed's Tab stop.

    It must be a row that actually exists in the DOM. Defaulting to the newest
    message by index left the feed with no tab stop at all whenever the newest
    message was outside the render window, which makes the timeline unreachable
    by keyboard entirely: worse than the problem the roving stop is here to fix.
  */
  const rovingStopId = useMemo(() => {
    const renderedMessageKeys = visibleItems
      .filter((item) => messageIndexById.has(item.key))
      .map((item) => item.key)
    if (focusedMessageId && renderedMessageKeys.includes(focusedMessageId)) return focusedMessageId
    return renderedMessageKeys[renderedMessageKeys.length - 1] ?? null
  }, [focusedMessageId, messageIndexById, visibleItems])

  /**
   * Moves the roving tab stop to a message and gives it focus.
   *
   * The row may be outside the render window, so scroll first and focus on the
   * next frame, once the virtualizer has mounted it.
   */
  const focusMessageAt = useCallback((index: number) => {
    const target = visibleMessages[index]
    if (!target) return
    setFocusedMessageId(target.id)
    scrollToItem(target.id, 'center')
    requestAnimationFrame(() => {
      const row = messageLogRef.current
        ?.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(target.id)}"]`)
      row?.focus({ preventScroll: true })
    })
  }, [scrollToItem, visibleMessages])

  /**
   * The article navigation `role="feed"` describes but does not implement.
   *
   * One screen is deliberately a fixed number of articles rather than a pixel
   * measurement: rows vary in height, and a reader paging through history wants
   * a predictable step, not one that shrinks whenever the messages get taller.
   */
  const handleFeedKeyDown = useCallback((event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.altKey || event.metaKey) return
    // Only drive navigation from the feed itself or from a row. A keystroke
    // inside a row's own control belongs to that control.
    const target = event.target as HTMLElement
    if (target.closest('button, a, input, textarea, select, [contenteditable="true"]')) return
    if (visibleMessages.length === 0) return

    const currentIndex = focusedMessageId
      ? visibleMessages.findIndex((message) => message.id === focusedMessageId)
      : -1
    const from = currentIndex === -1 ? visibleMessages.length - 1 : currentIndex
    const lastIndex = visibleMessages.length - 1
    const page = 10

    let nextIndex: number | null = null
    switch (event.key) {
      case 'ArrowDown': nextIndex = Math.min(lastIndex, from + 1); break
      case 'ArrowUp': nextIndex = Math.max(0, from - 1); break
      case 'PageDown': nextIndex = Math.min(lastIndex, from + page); break
      case 'PageUp': nextIndex = Math.max(0, from - page); break
      case 'Home': if (event.ctrlKey) nextIndex = 0; break
      case 'End': if (event.ctrlKey) nextIndex = lastIndex; break
      default: return
    }
    if (nextIndex === null) return
    event.preventDefault()
    focusMessageAt(nextIndex)
  }, [focusMessageAt, focusedMessageId, visibleMessages])

  /**
   * Page one screen of history in, keeping the reader's place.
   *
   * Shared by the scroll threshold and by the explicit "Load earlier messages"
   * control, which is the only way to reach history from browse mode or from
   * the keyboard.
   */
  const loadOlderHistory = useCallback(async (scrollElement?: HTMLDivElement | null) => {
    if (!hasMoreOlder || isLoadingOlder || olderLoadInFlightRef.current) return
    olderLoadInFlightRef.current = true

    if (scrollElement) {
      const containerBounds = scrollElement.getBoundingClientRect()
      const anchorRow = [...scrollElement.querySelectorAll<HTMLElement>('[data-message-id]')]
        .find((row) => {
          const bounds = row.getBoundingClientRect()
          return (
            bounds.top >= containerBounds.top
            && bounds.bottom <= containerBounds.bottom
          )
        })
      if (anchorRow?.dataset.messageId) {
        const anchorBounds = anchorRow.getBoundingClientRect()
        setScrollAnchor({
          messageId: anchorRow.dataset.messageId,
          offset: containerBounds.top - anchorBounds.top,
        })
      }
    }

    /*
     * The oldest id, not the message count: the store bounds the history
     * window, so once it is saturated a page of 50 older messages trims 50
     * newer ones and the count is identical either way. The oldest id changes
     * if and only if something landed above the anchor row.
     */
    const oldestBefore =
      (useMessageStore.getState().messages[channel.id] ?? EMPTY_MESSAGES)[0]?.id
    try {
      await loadOlderMessages(channel.id)
    } finally {
      // A load that prepended nothing (the end of history, a rejected page, a
      // superseded request, a page already in the window) must not leave the
      // anchor armed: the next layout pass that happens to change the item list
      // would consume it and hard-set scrollTop to a position the reader has
      // long since left.
      const oldestAfter =
        (useMessageStore.getState().messages[channel.id] ?? EMPTY_MESSAGES)[0]?.id
      if (oldestAfter === oldestBefore) setScrollAnchor(null)
      olderLoadInFlightRef.current = false
    }
  }, [channel.id, hasMoreOlder, isLoadingOlder, loadOlderMessages, setScrollAnchor])

  const handleScroll = useCallback(async (scrollElement: HTMLDivElement) => {
    const position = updateVirtualScroll()
    if (!position) return

    if (position.isAtBottom && showNewMessages && isViewingLatest) {
      setShowNewMessages(false)
      markChannelSeenFromScroll()
    }

    if (position.scrollTop < 100) {
      await loadOlderHistory(scrollElement)
    }
  }, [
    isViewingLatest,
    loadOlderHistory,
    markChannelSeenFromScroll,
    showNewMessages,
    updateVirtualScroll,
  ])

  const handleSend = async (
    content: string,
    files: StagedFile[] = [],
    onAttachmentSent?: (file: StagedFile, contentConsumed: boolean) => void | Promise<void>,
    mentionUserIds: readonly string[] = [],
    mentionsRoom = false,
  ) => {
    // While the reader is parked in history, addMessage diverts arrivals into
    // the "new messages" gap counter instead of the window, and that includes
    // the sender's own optimistic echo: the composer cleared, nothing appeared,
    // and the person's message was counted as an anonymous unread. DmView has
    // always reset to the live window before sending; this is the same guard.
    // The store is read at send time because the subscribed values can be a
    // render behind the scroll position.
    const timelineState = useMessageStore.getState()
    if (
      (timelineState.browsingOlder[channel.id] ?? false)
      || (timelineState.newerGapCount[channel.id] ?? 0) > 0
    ) {
      // Through the bookkeeping wrapper, not the raw window reset: the wrapper
      // records loadedChannelId and clears isLoading under the correct load
      // generation, so a send that lands during the initial hydration cannot
      // strand the room on its loading skeleton.
      await loadLatestMessages()
    }
    const threadRootId = threadReplyRoot?.id
    if (matrixMode && files.length > 0) {
      const replyToId = replyingTo?.id
      for (const [index, file] of files.entries()) {
        const msg = await bridge.matrixSendAttachment(
          channel.id,
          file.grant,
          file.transferId ?? bridge.createMatrixTransferId(),
          index === 0 ? content : '',
          index === 0 ? replyToId : undefined,
          index === 0 ? threadRootId : undefined,
          index === 0 ? mentionUserIds : [],
        )
        addMessage(channel.id, { ...msg, deliveryStatus: 'sent' })
        if (index === 0) {
          setReplyingTo(null)
          setThreadReplyRoot(null)
        }
        await onAttachmentSent?.(file, index === 0 && content.length > 0)
      }
      return
    }
    if (matrixMode) {
      const clientRequestId = bridge.createMatrixTransactionId()
      const replyToId = replyingTo?.id
      const identity = resolveSenderIdentity(
        useIdentityStore.getState().identity,
        bridge.getMatrixUserId(),
      )
      const optimistic: MessageType = {
        id: clientRequestId,
        channelId: channel.id,
        authorPublicKey: identity.publicKey,
        authorDisplayName: identity.displayName,
        authorAvatarColor: identity.avatarColor,
        // Carried on the local echo so a message does not show its own author a
        // generated mark for the moment before the sent copy arrives.
        authorAvatarUrl: identity.avatarUrl,
        content,
        attachments: [],
        reactions: {},
        timestamp: new Date().toISOString(),
        signature: '',
        replyToId,
        threadRootId,
        clientRequestId,
        deliveryStatus: 'pending',
        mentions: [...mentionUserIds],
        mentionsRoom,
      }
      addMessage(channel.id, optimistic)
      setReplyingTo(null)
      setThreadReplyRoot(null)
      try {
        const message = threadRootId
          ? await bridge.sendMessage(
              channel.id,
              content,
              [],
              replyToId ?? undefined,
              clientRequestId,
              threadRootId,
              mentionUserIds,
              mentionsRoom,
            )
          : await bridge.sendMessage(
              channel.id,
              content,
              [],
              replyToId ?? undefined,
              clientRequestId,
              undefined,
              mentionUserIds,
              mentionsRoom,
            )
        acceptQueuedMessage({
          ...message,
          clientRequestId: message.clientRequestId ?? clientRequestId,
        })
      } catch (error) {
        /*
          Reached before anything is queued, so the failures that land here are
          the ones a retry cannot fix: an unencrypted room, a rejected body, a
          full send queue, or a power level that refuses a room-wide mention.
          The failed row offers a retry and states no reason, so on its own it
          reads as a network blip and invites the same attempt forever.
        */
        console.error('Failed to queue Matrix message:', error)
        const description = describeError(error, { operation: 'send this message' })
        showToast(errorLine(description), 'error')
        setDeliveryStatus(channel.id, clientRequestId, 'failed')
      }
      return
    }
    const identity = resolveSenderIdentity(
      useIdentityStore.getState().identity,
      matrixMode ? bridge.getMatrixUserId() : null,
    )
    const optimisticId = `pending-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

    const optimistic: MessageType = {
      id: optimisticId,
      channelId: channel.id,
      authorPublicKey: identity.publicKey,
      authorDisplayName: identity.displayName,
      authorAvatarColor: identity.avatarColor,
      authorAvatarUrl: identity.avatarUrl,
      content,
      attachments: [],
      reactions: {},
      timestamp: new Date().toISOString(),
      signature: '',
      replyToId: replyingTo?.id,
      deliveryStatus: 'pending',
    }

    addMessage(channel.id, optimistic)
    setReplyingTo(null)

    try {
      const msg = await bridge.sendMessage(
        channel.id,
        content,
        [],
        replyingTo?.id ?? undefined,
        optimisticId,
        threadRootId,
      )
      removeMessage(channel.id, optimisticId)
      if (hydratingLatestRef.current) {
        bufferedMessagesRef.current.push({ ...msg, deliveryStatus: 'sent' })
      } else {
        addMessage(channel.id, { ...msg, deliveryStatus: 'sent' })
      }
    } catch (err) {
      console.error('Failed to send message:', err)
      setDeliveryStatus(channel.id, optimisticId, 'failed')
      throw err
    }
  }

  const handleRetry = useCallback(async (failedMessage: MessageType) => {
    if (matrixMode && failedMessage.transactionId) {
      setDeliveryStatus(channel.id, failedMessage.id, 'pending')
      try {
        await bridge.matrixRetryQueuedMessage(
          channel.id,
          failedMessage.transactionId,
        )
      } catch (error) {
        console.error('Failed to retry saved message:', error)
        setDeliveryStatus(channel.id, failedMessage.id, 'failed')
      }
      return
    }
    removeMessage(channel.id, failedMessage.id)

    const identity = resolveSenderIdentity(
      useIdentityStore.getState().identity,
      matrixMode ? bridge.getMatrixUserId() : null,
    )
    // Reuse the failed optimistic ID as the Matrix transaction ID. If the
    // first request was accepted but its response was lost, Matrix returns
    // the original event instead of publishing a duplicate on retry.
    const retryId = failedMessage.id

    const optimistic: MessageType = {
      id: retryId,
      channelId: channel.id,
      authorPublicKey: identity.publicKey,
      authorDisplayName: identity.displayName,
      authorAvatarColor: identity.avatarColor,
      authorAvatarUrl: identity.avatarUrl,
      content: failedMessage.content,
      attachments: [],
      reactions: {},
      timestamp: new Date().toISOString(),
      signature: '',
      replyToId: failedMessage.replyToId,
      threadRootId: failedMessage.threadRootId,
      clientRequestId: retryId,
      deliveryStatus: 'pending',
      mentions: [...(failedMessage.mentions ?? [])],
    }

    setDeliveryStatus(channel.id, retryId, 'pending')
    addMessage(channel.id, optimistic)

    try {
      const msg = failedMessage.threadRootId
        ? await bridge.sendMessage(
            channel.id,
            failedMessage.content,
            [],
            failedMessage.replyToId ?? undefined,
            retryId,
            failedMessage.threadRootId,
            failedMessage.mentions ?? [],
          )
        : await bridge.sendMessage(
            channel.id,
            failedMessage.content,
            [],
            failedMessage.replyToId ?? undefined,
            retryId,
            undefined,
            failedMessage.mentions ?? [],
          )
      if (matrixMode) {
        acceptQueuedMessage({
          ...msg,
          clientRequestId: msg.clientRequestId ?? retryId,
        })
      } else if (hydratingLatestRef.current) {
        removeMessage(channel.id, retryId)
        bufferedMessagesRef.current.push({ ...msg, deliveryStatus: 'sent' })
      } else {
        removeMessage(channel.id, retryId)
        addMessage(channel.id, { ...msg, deliveryStatus: 'sent' })
      }
    } catch (err) {
      console.error('Failed to retry message:', err)
      setDeliveryStatus(channel.id, retryId, 'failed')
    }
  }, [acceptQueuedMessage, addMessage, channel.id, matrixMode, removeMessage, setDeliveryStatus])

  const handleCancelQueued = useCallback(async (message: MessageType) => {
    if (!matrixMode || !message.transactionId) return
    try {
      await bridge.matrixCancelQueuedMessage(channel.id, message.transactionId)
      removeMessage(channel.id, message.id)
    } catch (error) {
      console.error('Failed to cancel saved message:', error)
    }
  }, [channel.id, matrixMode, removeMessage])

  const handleFollowRoomUpgrade = useCallback(async () => {
    const replacementRoomId = roomUpgrade?.replacementRoomId
    if (!replacementRoomId || isFollowingRoomUpgrade) return

    setIsFollowingRoomUpgrade(true)
    setRoomUpgradeError(null)
    try {
      if (roomUpgradeIsCommunity) {
        const joinedCommunity = await bridge.joinCommunity(replacementRoomId)
        await bridge.matrixSyncOnce()
        const communities = await bridge.getCommunities()
        const replacementCommunity = communities.find((candidate) => candidate.id === joinedCommunity.id)
          ?? joinedCommunity
        const replacementChannels = await bridge.getChannels(replacementCommunity.id)
        const currentCommunities = useCommunityStore.getState().communities
        setCommunities([
          ...currentCommunities.filter((candidate) => candidate.id !== channel.communityId),
          replacementCommunity,
        ])
        if (replacementCommunity.id !== channel.communityId) {
          replaceCommunityChannels(channel.communityId, [])
        }
        replaceCommunityChannels(replacementCommunity.id, replacementChannels)
        setActiveCommunity(replacementCommunity.id)
        setActiveChannel(replacementChannels[0]?.id ?? null)
        return
      }

      await bridge.matrixJoinRoom(replacementRoomId)
      await bridge.matrixSyncOnce()
      const replacementChannels = await bridge.getChannels(channel.communityId)
      replaceCommunityChannels(channel.communityId, replacementChannels)
      const replacement = replacementChannels.find((candidate) => candidate.id === replacementRoomId)
      if (!replacement) {
        throw new Error('The new room is not available in this community yet.')
      }
      setActiveChannel(replacement.id)
    } catch (error) {
      console.error('Failed to open the replacement Matrix room:', error)
      setRoomUpgradeError({
        roomId: channel.id,
        message: 'The new room could not be opened yet.',
      })
    } finally {
      setIsFollowingRoomUpgrade(false)
    }
  }, [
    channel.communityId,
    channel.id,
    isFollowingRoomUpgrade,
    roomUpgrade,
    roomUpgradeIsCommunity,
    setActiveCommunity,
    setActiveChannel,
    setCommunities,
    replaceCommunityChannels,
  ])

  return (
    <div className="mesh-chat-view flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
      <div
        /*
          A Material 3 small top app bar: one 64px line carrying the room name,
          the encryption chip and the actions.

          The 56px screen title is gone, and so is the two-line header it
          needed. A poster-scale room name cost the conversation 112px of
          height at the 1280 reference and forced a step-down rule at short
          viewports; a title-large name fits beside its own actions on one line
          at every width the shell supports.
        */
        className="mesh-conversation-header flex h-conversation-header min-w-0 flex-shrink-0 items-center gap-3 px-5"
        data-tauri-drag-region
      >
        <h1
          className="mesh-room-title min-w-0 truncate text-title-lg text-on-surface outline-none"
          data-mesh-route-heading
          tabIndex={-1}
        >
          {channel.name}
        </h1>
        {/*
          Only a room being read in a non-default shape says so. A room read
          the ordinary way carries no chip at all, so this is chrome that
          exists exactly when there is state to explain, and it is the way
          back as well as the label: finding a context menu to undo something
          you can see is the wrong shape of fix.
        */}
        {roomShape !== 'conversation' && (
          <button
            type="button"
            data-room-shape-chip
            onClick={() => setRoomShape(channel.id, 'conversation')}
            aria-label={`Reading ${channel.name} as ${roomShape}. Go back to the conversation.`}
            className="flex flex-shrink-0 items-center gap-1.5 rounded-sm border border-outline px-2 py-1 text-label-lg text-on-surface-variant hover:bg-state-hover hover:text-on-surface focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus"
          >
            <Icon name={roomShape === 'event' ? 'calendar' : 'image'} size="sm" />
            {roomShape === 'event' ? 'Event' : 'Clips'}
          </button>
        )}

        <div className="ml-auto flex min-w-0 flex-shrink-0 items-center gap-1">
          {matrixMode && trust && onOpenContext && (
            <RoomTrustSummary trust={trust} encryptionLabel={encryptionLabel} onOpenContext={onOpenContext} />
          )}

          <SearchBar onNavigateToMessage={handleNavigateToMessage} />

          {matrixMode && onOpenContext && (
            <Tooltip content="Pinned messages" side="bottom">
              <button
                type="button"
                onClick={() => onOpenContext('pins')}
                aria-label="Show pinned messages"
                aria-pressed={Boolean(isContextOpen && activeContextTab === 'pins')}
                /*
                  A Material 3 app bar keeps at most three trailing actions on
                  a compact window. Pins is the one that goes: the pinned tab
                  is a tab of the details sheet the next button opens, so
                  nothing becomes unreachable, and at 320px the room name was
                  down to 48px with this button on the line.
                */
                className={`mesh-icon-button hidden h-control-md w-control-md items-center justify-center rounded-full transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus sm:flex ${
                  isContextOpen && activeContextTab === 'pins'
                    ? 'bg-secondary-container text-on-secondary-container'
                    : 'text-on-surface-variant hover:bg-state-hover hover:text-on-surface'
                }`}
              >
                <Icon name="pin" />
              </button>
            </Tooltip>
          )}

          {showContextToggle && (
            <Tooltip content={isContextOpen ? 'Hide details' : 'Show details'} side="bottom">
              <button
                id="mesh-room-context-toggle"
                onClick={() => {
                  if (isContextOpen && activeContextTab === 'people') onToggleContext?.()
                  else onOpenContext?.('people')
                }}
                aria-label={
                  isContextOpen && activeContextTab === 'people'
                    ? 'Hide details'
                    : 'Show details'
                }
                aria-controls="mesh-room-context-panel"
                aria-expanded={isContextOpen}
                className={`mesh-icon-button flex h-control-md w-control-md items-center justify-center rounded-full transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus ${
                  isContextOpen && activeContextTab === 'people'
                    ? 'bg-secondary-container text-on-secondary-container'
                    : 'text-on-surface-variant hover:bg-state-hover hover:text-on-surface'
                }`}
              >
                <Icon name="panelRight" />
              </button>
            </Tooltip>
          )}

          {studioVoiceRoom && canOpenStudioVoice && (
            <button
              type="button"
              onClick={() => {
                setActiveChannel(studioVoiceRoom.id)
                if (!currentStudioParty) {
                  setCurrentVoiceSession(channel.communityId, studioVoiceRoom.id)
                }
                navigate({
                  kind: 'voice',
                  communityId: channel.communityId,
                  roomId: studioVoiceRoom.id,
                })
              }}
              className="ml-1 hidden min-h-9 items-center gap-2 rounded-full bg-primary px-3 text-body-sm font-semibold text-on-primary transition-colors hover:bg-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus md:flex"
              aria-label={`${currentStudioParty ? 'Open' : 'Join'} voice room ${studioVoiceRoom.name}`}
            >
              <Icon name="volume" size="sm" />
              {currentStudioParty ? 'Open' : 'Join'} {studioVoiceRoom.name}
            </button>
          )}
        </div>
      </div>

      {pinnedMessage && onOpenContext && (
        <button
          type="button"
          onClick={() => onOpenContext('pins')}
          /*
            Amber marks pinned, and a marker container is what that looks like:
            an inset card rather than a ruled strip across the conversation. It
            carries its own ink for the whole row, so nothing inside it names a
            colour of its own.
          */
          className="mesh-pinned-message-bar mx-4 mt-2 flex min-h-shell-pin min-w-0 flex-shrink-0 items-center gap-3 overflow-hidden rounded-lg-inc bg-marker-container px-4 py-3 text-left text-on-marker-container transition-colors hover:bg-marker-container-hover"
          aria-label={`Open pinned message from ${pinnedMessage.authorDisplayName}`}
        >
          <Icon name="pin" size="sm" className="flex-shrink-0" />
          <span className="mesh-pinned-message-copy flex min-w-0 flex-1 items-baseline gap-2 overflow-hidden">
            <span className="flex-shrink-0 text-body-sm">
              Pinned by {pinnedMessage.authorDisplayName}
            </span>
            <span className="min-w-0 truncate text-body-sm">
              {pinnedMessage.content || 'Pinned attachment'}
            </span>
          </span>
          <span className="mesh-pinned-message-action flex-shrink-0 text-label-lg">
            View
          </span>
        </button>
      )}

      {matrixMode && trust && !trust.loadingAccountTrust && trust.devicesNeedReview > 0 && (
        <button
          type="button"
          aria-live="polite"
          aria-label={`${trust.devicesNeedReview} ${trust.devicesNeedReview === 1 ? 'device needs' : 'devices need'} review. Open the room ledger.`}
          data-notice-tone="warning"
          className="flex min-h-control-md flex-shrink-0 items-center gap-2 border-b border-marker-container-line bg-marker-container px-4 text-left text-body-sm text-on-marker-container transition-colors hover:bg-marker-container-hover"
          onClick={() => onOpenContext?.('ledger')}
        >
          <Icon name="triangleAlert" size="sm" />
          <span className="min-w-0 flex-1">
            {trust.devicesNeedReview} {trust.devicesNeedReview === 1 ? 'device needs' : 'devices need'} review.
          </span>
          <span className="font-semibold">Review</span>
        </button>
      )}

      {activeRoomUpgradeError && !roomUpgrade && (
        <div
          role="alert"
          data-notice-tone="warning"
          className="flex flex-wrap items-center justify-between gap-2 border-b border-marker-container-line bg-marker-container px-4 py-2 text-body-sm text-on-marker-container"
        >
          <span>{activeRoomUpgradeError}</span>
          <button
            type="button"
            className="min-h-8 rounded-full px-2 font-semibold text-primary hover:bg-state-hover"
            onClick={() => setRoomUpgradeAttempt((attempt) => attempt + 1)}
          >
            Retry room status
          </button>
        </div>
      )}

      {activeMarkReadError && (
        <div
          role="alert"
          data-notice-tone="warning"
          className="flex flex-wrap items-center justify-between gap-2 border-b border-marker-container-line bg-marker-container px-4 py-2 text-body-sm text-on-marker-container"
        >
          <span>This room could not be marked as read.</span>
          <button
            type="button"
            className="min-h-8 rounded-full px-2 font-semibold text-primary hover:bg-state-hover"
            onClick={() => void markChannelSeen().catch(() => {})}
          >
            Retry read status
          </button>
        </div>
      )}

      {/*
        A clips room swaps the timeline for a gallery and nothing else. The
        header above and the composer below are the same components in the same
        places, because the shape changes how the room is read, not what it is:
        the same messages, the same permissions, the same way to post.
      */}
      {roomShape === 'clips' ? (
        <ClipsView
          roomId={channel.id}
          channelName={channel.name}
          clips={clips}
          onOpenClip={handleOpenClip}
        />
      ) : roomShape === 'event' ? (
        <EventView
          roomId={channel.id}
          channelName={channel.name}
          plan={eventPlan}
          rsvp={eventRsvp}
          memberNames={eventMemberNames}
          myUserId={ownAuthorId ?? null}
          onReply={handleRsvp}
          onOpenPlan={handleOpenClip}
        />
      ) : (
      <div className="relative min-h-0 min-w-0 flex-1">
        <p className="sr-only" role="status" aria-live="polite">
          {jumpAnnouncement}
        </p>
        {/*
          Genuinely new messages are announced here, not by the scroll container.
        */}
        <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">
          {arrivalAnnouncement}
        </p>
        <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">
          {activeUnreadBoundary ? 'New messages start here.' : ''}
        </p>
        {failedSendAnnouncement.text ? (
          <p
            key={failedSendAnnouncement.generation}
            className="sr-only"
            role="alert"
            aria-live="assertive"
            aria-atomic="true"
          >
            {failedSendAnnouncement.text}
          </p>
        ) : null}
        {/*
          Only message articles may live inside `role="feed"`. An EmptyState is a
          `section` with an accessible name, which is a `region`, and a region is
          not a permitted child of a feed: axe reports it as a critical
          aria-required-children violation. So every state that is not a list of
          messages renders beside the feed rather than inside it. The feed itself
          stays mounted either way so its scroll container and ref are stable,
          and it claims the feed role only while it actually owns messages.
        */}
        {showsMessageArticles ? null : (
          <div className="absolute inset-0 min-w-0 overflow-y-auto overflow-x-hidden">
          {roomUpgrade ? (
            <RoomUpgradeSignpost
              roomName={channel.name}
              reason={roomUpgrade.reason}
              error={activeRoomUpgradeError}
              isFollowing={isFollowingRoomUpgrade}
              onFollow={() => void handleFollowRoomUpgrade()}
            />
          ) : showsLoadError ? (
            <div className="flex h-full items-center justify-center px-4">
              <div
                role="alert"
                data-notice-tone="warning"
                className="max-w-sm rounded-xl border border-marker-container-line bg-marker-container p-4 text-center text-body-md text-on-marker-container"
              >
                <p>Messages could not be loaded.</p>
                <button
                  type="button"
                  className="mt-3 min-h-8 rounded-full px-3 font-semibold text-primary hover:bg-state-hover"
                  onClick={() => void loadLatestMessages().catch(() => {})}
                >
                  Retry messages
                </button>
              </div>
            </div>
          ) : showsInitialLoad ? (
            /*
              The placeholder has to be the shape of the thing being loaded.
              MessageSkeleton mirrors the real row exactly (64px gutter, 40px
              avatar column, 4px block padding, 65ch measure), and the grouped
              rhythm here matches real conversation, so opening a room no
              longer reflows twice.
            */
            <div className="pt-2">
              <AsyncStatus
                compact
                title="Bringing in this room"
                detail="Checking for new activity."
              />
              {Array.from({ length: 8 }).map((_, index) => (
                <MessageSkeleton key={index} index={index} grouped={index % 3 !== 0} />
              ))}
            </div>
          ) : showsEmptyRoom ? (
            /*
              Two different states share this branch. An empty timeline in a
              room that loaded cleanly is a genuinely new room, and can be
              specific about where you are and what to do. An empty timeline
              whose history is unknown (a failed or never-completed load) is
              not evidence of anything, so it keeps the honest generic copy: a
              warm welcome there would be a lie.
            */
            <div className="flex h-full items-center justify-center">
              {roomHistoryLoaded ? (
                <EmptyState
                  eyebrow={`#${channel.name}`}
                  markSeed={channel.id}
                  title="Nothing here yet"
                /*
                  No first-message action. It focused the composer, which is
                  visible directly below this state and is the next thing Tab
                  reaches, so the button was a second control for a control
                  already on screen. The eyebrow keeps naming the room.
                */
                  description="Say hello, drop a screenshot, or paste a link."
                />
              ) : (
                <EmptyState
                  icon={<Icon name="hash" size="lg" />}
                  title="Nothing here yet"
                  description="Say hello, drop a screenshot, or paste a link."
                />
              )}
            </div>
            ) : null}
          </div>
        )}
        <div
          ref={attachMessageLog}
          onScroll={(event) => void handleScroll(event.currentTarget)}
          className="mesh-message-log absolute inset-0 flex min-w-0 flex-col overflow-y-auto overflow-x-hidden"
          /*
            `feed`, not `log`. `log` implies aria-live="polite", which is wrong
            here: this container's children are inserted and removed by
            *virtualization*, not by message arrival, so scrolling through
            history announced every old message as if it were new, and
            aria-live="off" was reaching for a role that is not a live region
            at all. `feed` is that role: it is not live, it makes the rows'
            aria-posinset and aria-setsize meaningful (both are only honoured
            on an `article` inside a `feed`, so "message 12 of 40" was computed
            and never announced), and it defines aria-busy for infinite-scroll
            loading. The role itself carries no behaviour: the Page Up, Page
            Down, arrow and Ctrl+Home/End navigation it describes is implemented
            by handleFeedKeyDown, and the rows carry a roving tab stop.
            Announcements stay in the dedicated regions above, which are driven
            by the timeline tail rather than by DOM insertion.

            A feed must contain at least one `article`, so the role is only
            claimed while there are messages to own. The element itself stays
            mounted either way, which keeps the scroll container and its ref
            stable across the empty-to-first-message transition.
          */
          role={showsMessageArticles ? 'feed' : undefined}
          aria-busy={showsMessageArticles ? isLoadingOlder || undefined : undefined}
          aria-label={showsMessageArticles ? `Messages in #${channel.name}` : undefined}
          onKeyDown={showsMessageArticles ? handleFeedKeyDown : undefined}
        >
          {showsMessageArticles ? (
          /*
            Bottom-aligned. The scroller filled from the top, so a two-message
            conversation sat under the header with a few hundred pixels of empty
            canvas between the last message and the composer -- the reading eye
            and the writing hand at opposite ends of the screen. mt-auto rather
            than justify-end: when the content outgrows the viewport the auto
            margin resolves to zero and normal scrolling resumes, whereas
            justify-end on a scroll container makes the overflowing top
            unreachable.
          */
            <div className="relative mt-auto">
              {hasMoreOlder && (
                /*
                  Only the visible window exists in the DOM, so in browse mode
                  Ctrl+Home lands on a spacer and there is nothing to say that
                  history continues above. The scroll threshold is unreachable
                  without a pointer, so history needs one activatable control.
                  It stays enabled while loading (disabling it would drop
                  focus); the feed's aria-busy carries the loading state.
                */
                <div className="flex h-10 items-center justify-center gap-2 px-4">
                  <span className="h-px min-w-6 flex-1 bg-outline-variant" aria-hidden="true" />
                  <button
                    type="button"
                    aria-disabled={isLoadingOlder || undefined}
                    onClick={() => void loadOlderHistory(messageLogRef.current)}
                    className="min-h-control-sm rounded-full px-2 text-label-sm font-medium text-on-surface-variant transition-colors hover:bg-state-hover hover:text-on-surface-variant focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus"
                  >
                    Load earlier messages
                  </button>
                  <span className="h-px min-w-6 flex-1 bg-outline-variant" aria-hidden="true" />
                </div>
              )}
              <div
                className="mesh-message-lane relative w-full"
                data-design-token-exception="data-driven-virtual-spacer-geometry"
                style={{
                  paddingTop: `${topSpacerHeight}px`,
                  paddingBottom: `${bottomSpacerHeight}px`,
                }}
              >
                {isLoadingOlder && (
                  /*
                    No role="status" here. It implies aria-live on the element
                    itself, which the container cannot suppress, so every
                    virtualized pass re-announced it. The feed's aria-busy is
                    the defined way to say this, and the visible chip stays for
                    sighted readers.
                  */
                  <div
                    aria-hidden="true"
                    data-loading-older="true"
                    className="pointer-events-none absolute inset-x-0 top-2 z-sticky flex justify-center"
                  >
                    <span className="flex items-center gap-2 rounded-full border border-outline-variant bg-surface-container px-3 py-1.5 text-label-sm font-medium text-on-surface-variant shadow-elev-3">
                      <Spinner size={16} />
                      Loading earlier messages
                    </span>
                  </div>
                )}
                {visibleItems.map((item, index) => {
                  const nextItem = visibleItems[index + 1]

                  if (item.type === 'history-start') {
                    return <HistoryStartRow key={item.key} />
                  }

                  if (item.type === 'gap') {
                    return (
                      <HistoryGapRow
                        key={item.key}
                        rowKey={item.key}
                        hiddenCount={hiddenNewerCount}
                        onHeightChange={handleMeasuredHeight}
                        onJumpToLatest={() => void jumpToLatest()}
                      />
                    )
                  }

                  if (item.type === 'divider') {
                    return (
                      <DayDivider
                        key={item.key}
                        timestamp={dividerTimestamps.get(item.key) ?? null}
                      />
                    )
                  }

                  if (item.type === 'unread-divider') {
                    return (
                      <UnreadDivider
                        key={item.key}
                        onMarkRead={handleMarkReadFromDivider}
                      />
                    )
                  }

                  const messageIndex = messageIndexById.get(item.key) ?? -1
                  const message = visibleMessages[messageIndex]
                  if (!message) return null
                  const threadReplies = repliesByRoot.get(message.id) ?? EMPTY_MESSAGES
                  const replyPreview = message.replyToId
                    ? replyTargetById.get(message.replyToId) ?? null
                    : null

                  return (
                    <VirtualMessageRow
                      key={item.key}
                      rowKey={item.key}
                      position={messageIndex + 1}
                      /*
                        -1 means "the size is not known", which APG sanctions
                        for exactly this case. Reporting the loaded count
                        renumbered every message a screen reader had already
                        been told about as soon as one more page arrived, so
                        "message 12 of 40" silently became "12 of 90".
                      */
                      setSize={hasMoreOlder ? -1 : visibleMessages.length}
                      message={message}
                      isGrouped={shouldGroupMessage(
                        message,
                        visibleMessages[messageIndex - 1],
                      )}
                      hasGap={nextItem?.type !== 'gap'}
                      onHeightChange={handleMeasuredHeight}
                      onReply={beginOrdinaryReply}
                      threadReplies={threadReplies}
                      threadOpen={openThreadId === message.id}
                      onToggleThread={toggleThread}
                      onRetry={handleRetry}
                      onCancel={handleCancelQueued}
                      replyPreview={replyPreview}
                      onJumpToReply={handleJumpToReply}
                      limitedActions={false}
                      trust={trust}
                      isHighlighted={highlightedMessageId === message.id}
                      /*
                        Exactly one row is tabbable. Until the reader has moved
                        the roving stop, it sits on the newest message, which is
                        where a reader entering the timeline expects to be.
                      */
                      isRovingStop={rovingStopId === message.id}
                      onRowFocus={setFocusedMessageId}
                      isEntering={enteringMessageIds.has(message.id)}
                      editRequestToken={
                        editRequest?.messageId === message.id ? editRequest.token : 0
                      }
                    />
                  )
                })}
              </div>
            </div>
          ) : null}
        </div>

        {activeLoadError != null && visibleMessages.length > 0 && (
          <div
            role="alert"
            className="absolute inset-x-4 bottom-3 z-sticky flex flex-wrap items-center justify-between gap-2 rounded-full border border-marker-container-line bg-surface-container-high px-3 py-2 text-body-sm text-on-surface-variant shadow-elev-3"
          >
            <span>Could not refresh messages.</span>
            <button
              type="button"
              className="min-h-8 rounded-full px-2 font-semibold text-primary hover:bg-state-hover"
              onClick={() => void loadLatestMessages().catch(() => {})}
            >
              Retry
            </button>
          </div>
        )}

        {/*
          New messages banner. A container fill with a ruled edge, not a
          saturated full-bleed bar: this is a quiet pointer back to the bottom
          of a warm, near-black surface, and it was the most saturated cool
          area in the product.
        */}
        {showNewMessages && (
          <button
            type="button"
            onClick={() => void jumpToLatest()}
            className="absolute left-0 right-0 top-0 z-sticky flex items-center justify-center gap-1.5 border-y border-primary-container-line bg-primary-container px-4 py-1.5 text-body-md font-medium text-on-primary-container transition-colors hover:bg-primary-container-hover"
          >
            {hiddenNewerCount > 0 || isBrowsingOlder ? 'Jump to latest messages' : 'New messages'}
            <Icon name="chevronDown" size="sm" />
          </button>
        )}
      </div>
      )}

      {/* Reply bar */}
      {!roomUpgradeReady || roomUpgrade ? null : replyingTo && (
        <div className="flex min-w-0 items-center gap-2 border-t border-outline-variant bg-surface-container-lowest px-4 py-2">
          <Icon name="reply" size="sm" className="shrink-0 text-on-surface-variant" />
          <span className="text-body-md text-on-surface-variant">
            Replying to <span className="font-medium text-on-surface">{replyingTo.authorDisplayName}</span>
          </span>
          <span className="truncate text-body-md text-on-surface-variant flex-1">{replyingTo.content.slice(0, 100)}</span>
          <button
            onClick={() => {
              setReplyingTo(null)
              setThreadReplyRoot(null)
            }}
            aria-label="Cancel reply"
            className="shrink-0 rounded-full p-1 text-on-surface-variant transition-colors hover:text-on-surface"
          >
            <Icon name="x" size="sm" />
          </button>
        </div>
      )}

      {!roomUpgradeReady || roomUpgrade ? null : (
        /*
          The composer is its own region so it can be reached directly. Every
          message contributes eight to twelve tab stops, so from the room list
          the composer was several hundred Tab presses away, and neither the
          skip link nor the F6 cycle had a target for it.
        */
        <section
          id="mesh-composer"
          data-mesh-region
          tabIndex={-1}
          aria-label="Message composer"
          className="flex min-w-0 flex-shrink-0 flex-col outline-none"
        >
          <OfflineQueueSummary
            count={savedMessages.length}
            failedCount={failedMessages.length}
            onReview={() => {
              if (savedMessages[0]) {
                useMessageNavigationStore.getState().requestNavigation(savedMessages[0])
              }
            }}
            onReviewFailed={() => {
              if (failedMessages[0]) {
                useMessageNavigationStore.getState().requestNavigation(failedMessages[0])
              }
            }}
          />
          {sendingProtectionUnavailable && (
            <div
              role="status"
              data-notice-tone="warning"
              className="border-t border-marker-container-line bg-marker-container px-4 py-2 text-body-sm text-on-marker-container"
            >
              {trust?.protection === 'checking'
                ? "Checking this room's protection before sending."
                : trust?.protection === 'unencrypted'
                  ? 'Sending is paused until this room is protected.'
                  : (
                    <>
                      {/*
                        The old copy here was present tense, "while Mesh checks",
                        for a check that had already failed and would never run
                        again. Name the real state and offer the way out.
                      */}
                      Mesh could not check this room&rsquo;s protection, so sending is paused.
                      <button
                        type="button"
                        className="ml-1 rounded-full underline underline-offset-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus"
                        onClick={() => trust?.recheckProtection()}
                      >
                        Check again
                      </button>
                    </>
                  )}
            </div>
          )}
          <TypingIndicator channelId={channel.id} />
          <MessageInput
            channelId={channel.id}
            channelName={channel.name}
            onSend={handleSend}
            communityId={channel.communityId}
            members={communityMembers}
            canNotifyRoom={canNotifyRoom}
            disableAttachments={matrixMode && !bridge.getBackendCapabilities().encryptedAttachments}
            disabled={sendingProtectionUnavailable}
            onEditLastMessage={() => {
              const ownMessage = [...channelMessages]
                .reverse()
                .find((message) =>
                  message.authorPublicKey === ownAuthorId
                  && !message.deletedAt
                  && message.deliveryStatus !== 'pending'
                  && message.deliveryStatus !== 'failed',
                )
              if (!ownMessage) return
              setEditRequest((current) => ({
                messageId: ownMessage.id,
                token: (current?.token ?? 0) + 1,
              }))
            }}
          />
        </section>
      )}
    </div>
  )
}

interface RoomUpgradeSignpostProps {
  roomName: string
  reason?: string | null
  error: string | null
  isFollowing: boolean
  onFollow: () => void
}

export function RoomUpgradeSignpost({
  roomName,
  reason,
  error,
  isFollowing,
  onFollow,
}: RoomUpgradeSignpostProps) {
  return (
    <div className="flex h-full items-center justify-center px-4 py-8">
      <div className="w-full max-w-md rounded-xl border border-outline-variant bg-surface-container p-6 text-center shadow-elev-3">
        <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-xl bg-secondary-container text-primary">
          <Icon name="refresh" size="lg" />
        </div>
        <h2 className="text-body-lg font-semibold text-on-surface">This room has moved</h2>
        <p className="mt-2 text-body-md text-on-surface-variant">
          <span className="font-medium text-on-surface-variant">#{roomName}</span> was replaced by a new room.
        </p>
        {reason && <p className="mt-2 text-body-sm text-on-surface-variant">{reason}</p>}
        <button
          type="button"
          className="mt-5 inline-flex min-h-control-md items-center justify-center rounded-full bg-primary px-4 text-body-md font-semibold text-on-primary transition-colors hover:bg-primary disabled:cursor-not-allowed disabled:opacity-60"
          onClick={onFollow}
          disabled={isFollowing}
        >
          {isFollowing ? 'Opening new room...' : 'Go to new room'}
        </button>
        {error && (
          <p className="mt-3 text-body-md text-error" role="alert">{error}</p>
        )}
      </div>
    </div>
  )
}

interface VirtualMessageRowProps {
  rowKey: string
  position: number
  setSize: number
  message: MessageType
  isGrouped: boolean
  hasGap: boolean
  onHeightChange: (rowKey: string, height: number) => void
  onReply: (message: MessageType) => void
  threadReplies: MessageType[]
  threadOpen: boolean
  onToggleThread: (messageId: string) => void
  onRetry?: (message: MessageType) => void
  onCancel?: (message: MessageType) => void
  replyPreview?: MessageType | null
  onJumpToReply?: (message: MessageType) => void
  limitedActions?: boolean
  trust?: RoomTrustSnapshot
  isHighlighted: boolean
  /** This row owns the feed's single Tab stop. */
  isRovingStop: boolean
  /** Stable setter: an inline closure here would break the row's memo. */
  onRowFocus: (messageId: string) => void
  isEntering: boolean
  editRequestToken: number
}

const VirtualMessageRow = memo(function VirtualMessageRow({
  rowKey,
  position,
  setSize,
  message,
  isGrouped,
  hasGap,
  onHeightChange,
  onReply,
  threadReplies,
  threadOpen,
  onToggleThread,
  onRetry,
  onCancel,
  replyPreview,
  onJumpToReply,
  limitedActions,
  trust,
  isHighlighted,
  isRovingStop,
  onRowFocus,
  isEntering,
  editRequestToken,
}: VirtualMessageRowProps) {
  const rowRef = useRef<HTMLDivElement>(null)
  /*
   * Read once, at mount. The owner flips this back to false as soon as the
   * next render marks the message seen, and an arrival that has already played
   * must not replay because a later prop changed.
   *
   * A state initializer rather than a ref, because that is what "the value at
   * first mount" is. The ref said the same thing but had to be read during
   * render to say it, which is the one thing a ref may not do -- the React
   * Compiler is a production-only transform, so a render that reads mutable
   * state is a class of bug that cannot reproduce in dev or in Vitest.
   */
  const [animateArrival] = useState(() => isEntering)

  useLayoutEffect(() => {
    const el = rowRef.current
    if (!el) return

    const reportHeight = () => {
      onHeightChange(rowKey, el.offsetHeight)
    }

    reportHeight()

    const observer = new ResizeObserver(() => {
      reportHeight()
    })

    observer.observe(el)
    return () => observer.disconnect()
  }, [hasGap, isGrouped, message, onHeightChange, rowKey, threadOpen, threadReplies.length])

  useLayoutEffect(() => {
    if (isHighlighted) {
      rowRef.current?.focus({ preventScroll: true })
    }
  }, [isHighlighted])

  return (
    <motion.div
      ref={rowRef}
      /*
         The one repeated interaction in the product finally acknowledges
         itself: an arriving message fades up over the tight offset, 150ms on
         the arrive curve, from the shared `messageEnter` variant. Rows that
         are merely being re-virtualized pass `initial={false}` and are painted
         at their resting values with no animation at all. The global
         MotionConfig sets reducedMotion="always" when the OS or the Mesh
         setting asks for it, which drops the transform and leaves the opacity
         change, so no spatial travel survives a reduced-motion session.
      */
      variants={variants.messageEnter}
      initial={animateArrival ? 'initial' : false}
      animate="animate"
      data-message-id={message.id}
      data-jump-highlighted={isHighlighted ? 'true' : undefined}
      role="article"
      /* Named from the author element inside the row, so the feed announces
         "Sender, article, 12 of 40" instead of an unnamed article. */
      aria-labelledby={timelineAuthorNameId(message.id)}
      aria-posinset={position}
      aria-setsize={setSize}
      aria-current={isHighlighted ? 'true' : undefined}
      /*
        The feed's roving tab stop. Exactly one article is reachable with Tab,
        so the timeline costs a keyboard user one stop rather than one per
        message; the rest are focusable only programmatically. A jump-highlighted
        row takes the stop so focus lands where the reader was sent.
      */
      tabIndex={isRovingStop ? 0 : -1}
      onFocus={() => onRowFocus(message.id)}
      /*
        A jump target is marked structurally, not by tint alone: the leading
        3px bar is the Werkstatt cue for "this is the one thing", and it
        survives a monochrome or high-contrast theme where the container tint
        collapses into the canvas. It replaces an inset ring, which floated
        rather than sitting flush to an edge. The inactive branch reserves the
        same 3px so only the colour changes: a live border would narrow the
        content box of the highlighted row alone, rewrapping its text and
        remeasuring its height at the exact moment the reader is sent to it.
      */
      className={
        isHighlighted
          ? 'animate-highlight border-l-bar border-primary bg-primary-container'
          : 'border-l-bar border-transparent'
      }
    >
      <ErrorBoundary
        scope="feature"
        fallback={(resetError) => (
          <div
            className="mx-4 my-1 flex min-w-0 items-center justify-between gap-3 rounded-xl border border-outline-variant bg-surface-container-lowest px-4 py-3"
            role="alert"
          >
            <p className="text-body-sm text-on-surface-variant">This message couldn't be displayed.</p>
            <button
              type="button"
              onClick={resetError}
              className="min-h-8 shrink-0 rounded-full px-2 text-body-sm font-medium text-primary transition-colors hover:bg-state-hover hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus"
            >
              Try again
            </button>
          </div>
        )}
      >
        <MessageComponent
          message={message}
          isGrouped={isGrouped}
          authorNameId={timelineAuthorNameId(message.id)}
          disableMotion
          replyPreview={replyPreview}
          onJumpToReply={onJumpToReply}
          onReply={onReply}
          threadReplyCount={threadReplies.length}
          threadOpen={threadOpen}
          onToggleThread={() => onToggleThread(message.id)}
          onRetry={onRetry}
          onCancel={onCancel}
          limitedActions={limitedActions}
          trust={trust}
          editRequestToken={editRequestToken}
        />
      </ErrorBoundary>
    </motion.div>
  )
})

/*
 * The top of loaded history. No role="status": this is static descriptive
 * content, not a status change, and role="status" carries an implicit
 * aria-live on the element itself, so every virtualized pass over the top of
 * the timeline re-announced "Beginning of this conversation".
 */
function HistoryStartRow() {
  return (
    <div className="flex h-10 items-center justify-center gap-2 px-4 text-label-sm text-on-surface-variant">
      <span className="h-px min-w-6 flex-1 bg-outline-variant" aria-hidden="true" />
      <span>Beginning of this conversation</span>
      <span className="h-px min-w-6 flex-1 bg-outline-variant" aria-hidden="true" />
    </div>
  )
}

function HistoryGapRow({
  rowKey,
  hiddenCount,
  onHeightChange,
  onJumpToLatest,
}: {
  rowKey: string
  hiddenCount: number
  onHeightChange: (rowKey: string, height: number) => void
  onJumpToLatest: () => void
}) {
  const rowRef = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    const el = rowRef.current
    if (!el) return

    const reportHeight = () => {
      onHeightChange(rowKey, el.offsetHeight)
    }

    reportHeight()

    const observer = new ResizeObserver(() => {
      reportHeight()
    })

    observer.observe(el)
    return () => observer.disconnect()
  }, [hiddenCount, onHeightChange, rowKey])

  return (
    <div ref={rowRef} className="px-4 py-2">
      <div className="flex items-center justify-between rounded-xl border border-outline-variant bg-surface-container-lowest px-4 py-2">
        <div>
          <p className="text-body-md font-medium text-on-surface">
            {hiddenCount} newer message{hiddenCount === 1 ? '' : 's'} hidden
          </p>
        </div>
        <button
          onClick={onJumpToLatest}
          className="rounded-full bg-primary px-3 py-1 text-body-md font-medium text-on-error transition-colors hover:bg-primary"
        >
          Jump to latest
        </button>
      </div>
    </div>
  )
}
