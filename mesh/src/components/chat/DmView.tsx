import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'

import { motion } from '../../lib/lazy-motion'
import { variants } from '../../lib/motion'
import { getBackoffDelay, waitForDelay } from '../../lib/scheduler'
import { federatedTimestampMilliseconds } from '../../lib/federated-time'
import { shouldGroupMessage } from '../../lib/message-grouping'
import { resolveSenderIdentity } from '../../lib/matrixIdentity'
import { groupThreadReplies, mergeThreadMessages } from '../../lib/threads'
import { restorePaneTriggerFocus } from '../../lib/pane-focus'
import { openPeopleCommandPalette } from '../../lib/command-palette'
import * as bridge from '../../lib/bridge'
import { serverName, serverRelation } from '../../lib/trust'
import { useRoomTrust } from '../../hooks/useRoomTrust'
import { useVirtualScroll, type VirtualItem } from '../../hooks/useVirtualScroll'
import { useDmConversation, useDmStore } from '../../store/dms'
import { useIdentityStore } from '../../store/identity'
import { useMessageStore } from '../../store/messages'
import { useShellStore } from '../../store/shell'
import { useCurrentMeshRoute, useMeshNavigationStore } from '../../store/navigation'
import { useFailedMessageAnnouncement } from '../../hooks/useFailedMessageAnnouncement'
import { ROOM_CONTEXT_COMPACT_QUERY, useMediaQuery } from '../../hooks/useMediaQuery'
import { useCompactPaneFocus } from '../../hooks/useCompactPaneFocus'
import { useMatrixThreadContext } from '../../hooks/useMatrixThreadContext'
import type { DirectMessage, Message as MessageType } from '../../types/ipc'
import { dmPrimaryPeer } from '../../types/ipc'
import { EmptyState } from '../ui/Primitives'
import { Button } from '../ui/Button'
import { ErrorBoundary } from '../ui/ErrorBoundary'
import { Avatar } from '../ui/Avatar'
import { Icon } from '../ui/Icon'
import { MessageSkeleton } from '../ui/Skeleton'
import { AsyncStatus } from '../ui/AsyncStatus'
import { setNextModalRestoreFocusTarget } from '../ui/Modal'
import { DmSafetyPanel } from './DmSafetyPanel'
import type { StagedFile } from './FileAttachment'
import { MessageComponent } from './Message'
import { MessageInput } from './MessageInput'
import { TypingIndicator } from './TypingIndicator'
import { useTypingStore } from '../../store/typing'
import { OfflineQueueSummary } from './OfflineQueueSummary'
import { SearchBar } from './SearchBar'
import { disposeSubscription } from '../../lib/subscription-cleanup'

const EMPTY_DIRECT_MESSAGES: DirectMessage[] = []
const EMPTY_MESSAGES: MessageType[] = []

/** Stable id for the author-name element a timeline article names itself from. */
function timelineAuthorNameId(messageId: string): string {
  return `mesh-timeline-author-${messageId}`
}
const ThreadPanel = lazy(() =>
  import('./ThreadPanel').then((module) => ({ default: module.ThreadPanel })),
)

type DmBlockState = {
  peerPublicKey: string
  status: 'loading' | 'ready' | 'failed'
  blocked: boolean
}

function directMessageToTimelineMessage(message: DirectMessage): MessageType {
  return {
    id: message.id,
    channelId: message.conversationId,
    authorPublicKey: message.authorPublicKey,
    authorDisplayName: message.authorDisplayName,
    authorAvatarColor: message.authorAvatarColor,
    authorAvatarUrl: message.authorAvatarUrl,
    content: message.content,
    attachments: message.attachments ?? [],
    reactions: message.reactions ?? {},
    timestamp: message.timestamp,
    signature: message.signature,
    editedAt: message.editedAt,
    deletedAt: message.deletedAt,
    replyToId: message.replyToId,
    threadRootId: message.threadRootId,
    deliveryStatus: message.deliveryStatus,
  }
}

function timelineMessageToDirectMessage(message: MessageType): DirectMessage {
  return {
    id: message.id,
    conversationId: message.channelId,
    authorPublicKey: message.authorPublicKey,
    authorDisplayName: message.authorDisplayName,
    authorAvatarColor: message.authorAvatarColor,
    authorAvatarUrl: message.authorAvatarUrl,
    content: message.content,
    attachments: message.attachments,
    reactions: message.reactions,
    timestamp: message.timestamp,
    signature: message.signature,
    editedAt: message.editedAt,
    deletedAt: message.deletedAt,
    replyToId: message.replyToId,
    threadRootId: message.threadRootId,
    deliveryStatus: message.deliveryStatus,
    mentions: message.mentions,
  }
}

function deliveryAliases(message: MessageType): string[] {
  return [
    `event:${message.id}`,
    message.transactionId ? `transaction:${message.transactionId}` : '',
    message.clientRequestId ? `request:${message.clientRequestId}` : '',
  ].filter(Boolean)
}

function messagesShareDeliveryIdentity(left: MessageType, right: MessageType): boolean {
  const aliases = new Set(deliveryAliases(left))
  return deliveryAliases(right).some((alias) => aliases.has(alias))
}

function mergeDirectMessageTimeline(
  directMessages: readonly DirectMessage[],
  deliveryMessages: readonly MessageType[],
): MessageType[] {
  const merged = directMessages.map(directMessageToTimelineMessage)
  for (const deliveryMessage of deliveryMessages) {
    const index = merged.findIndex((message) =>
      messagesShareDeliveryIdentity(message, deliveryMessage),
    )
    if (index < 0) merged.push(deliveryMessage)
    else merged[index] = { ...merged[index], ...deliveryMessage }
  }
  return merged.sort((left, right) => {
    const timeDifference =
      (federatedTimestampMilliseconds(left.timestamp) ?? 0)
      - (federatedTimestampMilliseconds(right.timestamp) ?? 0)
    return timeDifference || left.id.localeCompare(right.id)
  })
}

function DmMessageBoundary({
  messageId,
  children,
}: {
  messageId: string
  children: () => ReactNode
}) {
  return (
    <ErrorBoundary
      scope="feature"
      fallback={(resetError) => (
        <div
          className="mx-4 my-1 flex items-center gap-2 rounded-xl bg-error-container px-3 py-2"
          role="alert"
        >
          <p className="min-w-0 flex-1 text-body-sm text-on-surface-variant">
            One message could not be displayed.
          </p>
          <button
            type="button"
            onClick={resetError}
            className="min-h-8 rounded-full px-2 text-body-sm font-medium text-primary hover:bg-surface-container-high hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus"
            aria-label={`Retry message ${messageId}`}
          >
            Retry
          </button>
        </div>
      )}
    >
      <DmMessageRenderer render={children} />
    </ErrorBoundary>
  )
}

function DmMessageRenderer({ render }: { render: () => ReactNode }) {
  return render()
}

function DmLanding() {
  const conversations = useDmStore((state) => state.conversations)
  const messagesByConversation = useDmStore((state) => state.messages)
  const setDmMode = useDmStore((state) => state.setDmMode)
  const setActiveConversation = useDmStore((state) => state.setActiveConversation)
  const navigate = useMeshNavigationStore((state) => state.navigate)
  const orderedConversations = useMemo(() => [...conversations].sort((left, right) => {
    const leftTime = Date.parse(left.lastMessageAt ?? left.createdAt)
    const rightTime = Date.parse(right.lastMessageAt ?? right.createdAt)
    return rightTime - leftTime
      || dmPrimaryPeer(left).displayName.localeCompare(dmPrimaryPeer(right).displayName)
  }), [conversations])
  const [featuredConversation, ...recentConversations] = orderedConversations

  const openConversation = useCallback((conversationId: string) => {
    setDmMode(true)
    setActiveConversation(conversationId)
    navigate({ kind: 'direct', conversationId })
  }, [navigate, setActiveConversation, setDmMode])

  if (!featuredConversation) {
    return (
      <section className="mesh-dm-landing flex flex-1 items-start overflow-y-auto" aria-labelledby="mesh-dm-landing-heading">
        <div className="mesh-dm-landing-inner w-full">
          <header className="mesh-dm-landing-header grid gap-4 border-b border-outline-variant pb-4">
            <div>
              <h1 id="mesh-dm-landing-heading" data-mesh-route-heading tabIndex={-1} className="mesh-dm-landing-title font-semibold text-on-surface outline-none">
                Direct messages
              </h1>
            </div>
            <Button variant="outline" onClick={openPeopleCommandPalette}>
              <Icon name="squarePen" size="sm" />
              New conversation
            </Button>
          </header>
        </div>
      </section>
    )
  }

  const featuredMessages = messagesByConversation[featuredConversation.id] ?? []
  const featuredMessage = featuredMessages[featuredMessages.length - 1]
  const featuredName = dmPrimaryPeer(featuredConversation).displayName.trim() || 'Unknown account'

  return (
    <section className="mesh-dm-landing flex flex-1 items-start overflow-y-auto" aria-labelledby="mesh-dm-landing-heading">
      <div className="mesh-dm-landing-inner w-full">
        <header className="mesh-dm-landing-header grid gap-4 border-b border-outline-variant pb-4">
          <div>
            <h1 id="mesh-dm-landing-heading" data-mesh-route-heading tabIndex={-1} className="mesh-dm-landing-title font-semibold text-on-surface outline-none">
              Direct messages
            </h1>
          </div>
          <Button variant="outline" onClick={openPeopleCommandPalette}>
            <Icon name="squarePen" size="sm" />
            New conversation
          </Button>
        </header>

        <button
          type="button"
          className="mesh-dm-lead grid w-full gap-4 border-b border-outline-variant text-left"
          onClick={() => openConversation(featuredConversation.id)}
          aria-label={`Continue with ${featuredName}`}
        >
          <span className="mesh-dm-lead-index text-label-sm font-semibold lowercase tracking-label-md text-on-surface-variant">
            01 · Continue{featuredConversation.unreadCount > 0 ? ` · ${featuredConversation.unreadCount} unread` : ''}
          </span>
          <Avatar
            color={dmPrimaryPeer(featuredConversation).avatarColor}
            size={52}
            name={featuredName}
            imageUrl={dmPrimaryPeer(featuredConversation).avatarUrl}
          />
          <span className="mesh-dm-lead-copy min-w-0">
            <span className="mesh-dm-lead-title block truncate font-semibold text-on-surface">{featuredName}</span>
            {/*
              The last message or nothing. The slot used to fall back to "Open
              your private conversation.", which described the card rather than
              the conversation, and sat directly under a name set in display
              type where a reader looks for what was actually said.
            */}
            {featuredMessage?.content && (
              <span className="mt-1 block max-w-2xl truncate text-body-md text-on-surface-variant">
                {featuredMessage.content}
              </span>
            )}
          </span>
          <span className="mesh-dm-lead-action flex items-center gap-3 font-semibold text-on-surface">
            Open
            <Icon name="arrowRight" size="sm" />
          </span>
          <time className="mesh-dm-lead-time text-body-sm text-on-surface-variant" dateTime={featuredConversation.lastMessageAt ?? featuredConversation.createdAt}>
            {formatDmLandingDate(featuredConversation.lastMessageAt ?? featuredConversation.createdAt)}
          </time>
        </button>

        {recentConversations.length > 0 && (
          <section className="mesh-dm-landing-recent" aria-labelledby="mesh-dm-recent-heading">
            <div className="flex items-center justify-between border-b border-outline-variant py-2">
              <h2 id="mesh-dm-recent-heading" className="text-label-sm font-semibold lowercase tracking-label-md text-on-surface-variant">Recent conversations</h2>
              <span className="text-body-sm text-on-surface-variant">{recentConversations.length}</span>
            </div>
            {recentConversations.slice(0, 5).map((conversation, index) => {
              const name = dmPrimaryPeer(conversation).displayName.trim() || 'Unknown account'
              const messages = messagesByConversation[conversation.id] ?? []
              const latestMessage = messages[messages.length - 1]
              return (
                <button
                  key={conversation.id}
                  type="button"
                  className="mesh-dm-landing-row flex w-full items-center gap-3 border-b border-outline-variant text-left hover:bg-surface-container-high"
                  onClick={() => openConversation(conversation.id)}
                  aria-label={`Open conversation with ${name}`}
                >
                  <span className="text-body-sm text-primary">{String(index + 2).padStart(2, '0')}</span>
                  <Avatar
                    color={dmPrimaryPeer(conversation).avatarColor}
                    size={36}
                    name={name}
                    imageUrl={dmPrimaryPeer(conversation).avatarUrl}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-semibold text-on-surface">{name}</span>
                    {latestMessage?.content && (
                      <span className="block truncate text-label-sm text-on-surface-variant">{latestMessage.content}</span>
                    )}
                  </span>
                  {conversation.unreadCount > 0 && <span className="text-body-sm text-primary">{Math.min(conversation.unreadCount, 999)}</span>}
                  <time className="text-body-sm text-on-surface-variant" dateTime={conversation.lastMessageAt ?? conversation.createdAt}>
                    {formatDmLandingDate(conversation.lastMessageAt ?? conversation.createdAt)}
                  </time>
                </button>
              )
            })}
          </section>
        )}
      </div>
    </section>
  )
}

export function formatDmLandingDate(value: string): string {
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) return 'Recent'
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(parsed)
}

const EMPTY_ENTERING_DM_IDS: ReadonlySet<string> = new Set<string>()

/**
 * Every id a single message has answered to. A sent message renders first
 * under the renderer request id and again under the server event id, so
 * identity by `id` alone would read the acknowledgement as a second arrival
 * and replay the animation at the moment the row is meant to settle.
 */
function dmMessageIdentities(message: MessageType): string[] {
  const identities = [message.id]
  if (message.clientRequestId) identities.push(message.clientRequestId)
  if (message.transactionId) identities.push(message.transactionId)
  return identities
}

function DmVirtualMessageRow({
  rowKey,
  position,
  setSize,
  onHeightChange,
  isHighlighted,
  isEntering,
  children,
}: {
  rowKey: string
  position: number
  setSize: number
  onHeightChange: (rowKey: string, height: number) => void
  isHighlighted: boolean
  isEntering: boolean
  children: ReactNode
}) {
  const rowRef = useRef<HTMLDivElement>(null)
  // Read once at mount. A later prop flip must not replay the arrival, and
  // virtualization remounts rows every time they scroll back into the window.
  // A state initializer says exactly that and, unlike a ref, may be read during
  // render. See ChatView for why that distinction is not cosmetic.
  const [animateArrival] = useState(() => isEntering)

  useLayoutEffect(() => {
    const element = rowRef.current
    if (!element) return
    const reportHeight = () => onHeightChange(rowKey, element.offsetHeight)
    reportHeight()
    const observer = new ResizeObserver(reportHeight)
    observer.observe(element)
    return () => observer.disconnect()
  }, [onHeightChange, rowKey])

  useLayoutEffect(() => {
    if (isHighlighted) {
      rowRef.current?.focus({ preventScroll: true })
    }
  }, [isHighlighted])

  return (
    <motion.div
      ref={rowRef}
      variants={variants.messageEnter}
      initial={animateArrival ? 'initial' : false}
      animate="animate"
      data-message-id={rowKey}
      data-jump-highlighted={isHighlighted ? 'true' : undefined}
      role="article"
      /* Named from the author element inside the row, and positioned within
         the feed, so the row announces "Peer, article, 12 of 40". Both
         attributes are only honoured on an article inside a feed. */
      aria-labelledby={timelineAuthorNameId(rowKey)}
      aria-posinset={position}
      aria-setsize={setSize}
      aria-current={isHighlighted ? 'true' : undefined}
      tabIndex={isHighlighted ? -1 : undefined}
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
      {children}
    </motion.div>
  )
}

export function DmView() {
  const activeConversationId = useDmStore((state) => state.activeConversationId)
  const conversation = useDmConversation(activeConversationId)
  const directMessages = useDmStore((state) =>
    state.activeConversationId
      ? (state.messages[state.activeConversationId] ?? EMPTY_DIRECT_MESSAGES)
      : EMPTY_DIRECT_MESSAGES,
  )
  const deliveryMessages = useMessageStore((state) =>
    activeConversationId
      ? (state.messages[activeConversationId] ?? EMPTY_MESSAGES)
      : EMPTY_MESSAGES,
  )
  const queueStates = useMessageStore((state) => (
    activeConversationId ? state.matrixQueueStates[activeConversationId] : undefined
  ))
  const loadMessages = useDmStore((state) => state.loadMessages)
  const loadOlderMessages = useDmStore((state) => state.loadOlderMessages)
  const mergeHistoricalMessages = useDmStore((state) => state.mergeHistoricalMessages)
  const isLoadingOlder = useDmStore((state) => (
    activeConversationId ? state.loadingOlder[activeConversationId] ?? false : false
  ))
  const hasMoreOlder = useDmStore((state) => (
    activeConversationId ? state.hasMoreOlder[activeConversationId] !== false : false
  ))
  const isBrowsingOlder = useDmStore((state) => (
    activeConversationId ? state.browsingOlder[activeConversationId] ?? false : false
  ))
  const hiddenNewerCount = useDmStore((state) => (
    activeConversationId ? state.newerGapCount[activeConversationId] ?? 0 : 0
  ))
  const addDirectMessage = useDmStore((state) => state.addMessage)
  const patchDirectMessage = useDmStore((state) => state.patchMessage)
  const updateDirectReaction = useDmStore((state) => state.updateReaction)
  const identity = useIdentityStore((state) => state.identity)
  const setSecurityOpen = useShellStore((state) => state.setSecurityOpen)
  const compactSecondaryPane = useMediaQuery(ROOM_CONTEXT_COMPACT_QUERY)
  const route = useCurrentMeshRoute()
  const navigate = useMeshNavigationStore((state) => state.navigate)
  const closePane = useMeshNavigationStore((state) => state.closePane)
  const matrixMode = bridge.isMatrixBackend()

  const openSecurityFrom = useCallback((trigger: HTMLButtonElement) => {
    setNextModalRestoreFocusTarget(trigger)
    setSecurityOpen(true)
  }, [setSecurityOpen])
  const ownAuthorId = matrixMode ? bridge.getMatrixUserId() : identity?.publicKey

  /*
    The newest message of yours the other person has actually read.

    Receipts were already sent with correct per-thread scoping, and the backend
    already applies the reciprocity rule (it reports someone else's public
    receipt only while this account shares its own in the same conversation),
    so the only thing missing was saying so. Marking one message rather than
    every read one is deliberate: in a conversation you both keep up with,
    every message carries a receipt and a marker on each is noise. The newest
    one answers the only question being asked, which is whether they have seen
    what you just said.
  */

  const messageLoad = useDmStore((state) => (
    activeConversationId ? state.messageLoads[activeConversationId] : undefined
  ))
  const [blockState, setBlockState] = useState<DmBlockState | null>(null)
  const [blockRefreshToken, setBlockRefreshToken] = useState(0)
  const [isBlockBusy, setIsBlockBusy] = useState(false)
  const [blockError, setBlockError] = useState<unknown | null>(null)
  const [markReadError, setMarkReadError] = useState<{
    conversationId: string
    error: unknown
  } | null>(null)
  const [replyingTo, setReplyingTo] = useState<MessageType | null>(null)
  const [threadReplyRoot, setThreadReplyRoot] = useState<MessageType | null>(null)
  const [editRequest, setEditRequest] = useState<{
    messageId: string
    token: number
  } | null>(null)
  const previousConversationIdRef = useRef(activeConversationId)
  /*
   * The open conversation, for listeners that live as long as the component.
   *
   * Registering a bridge listener is asynchronous, so re-registering on every
   * conversation switch left a window with no listener attached and every
   * message that arrived in that window was lost. The subscriptions below stay
   * for the component's lifetime and compare against this ref instead. Mirrors
   * useNotificationSync.
   */
  const activeConversationIdRef = useRef(activeConversationId)
  useEffect(() => {
    activeConversationIdRef.current = activeConversationId
  }, [activeConversationId])
  const olderLoadInFlightRef = useRef(false)
  const [olderLoadError, setOlderLoadError] = useState<unknown | null>(null)
  const [searchContextLimited, setSearchContextLimited] = useState(false)
  const [highlightedMessageId, setHighlightedMessageId] = useState<string | null>(null)
  const searchHighlightTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const channelMessages = useMemo(
    () => mergeDirectMessageTimeline(directMessages, deliveryMessages),
    [deliveryMessages, directMessages],
  )
  // Read from the DM records rather than the merged timeline: `seenBy` is a
  // direct-message field, and the merged view is the shared Message shape.
  const lastSeenOwnMessageId = useMemo(() => {
    if (!ownAuthorId) return null
    for (let index = directMessages.length - 1; index >= 0; index -= 1) {
      const message = directMessages[index]
      if (message.authorPublicKey !== ownAuthorId) continue
      if (message.seenBy && message.seenBy.length > 0) return message.id
    }
    return null
  }, [directMessages, ownAuthorId])

  const failedSendAnnouncement = useFailedMessageAnnouncement(
    activeConversationId ?? 'no-conversation',
    channelMessages,
  )
  const savedMessages = useMemo(
    () => channelMessages.filter((message) => {
      const transactionId = message.transactionId ?? message.id
      return message.deliveryStatus === 'pending'
        && queueStates?.[transactionId]?.state === 'pending'
    }),
    [channelMessages, queueStates],
  )
  const failedMessages = useMemo(
    () => channelMessages.filter((message) => message.deliveryStatus === 'failed'),
    [channelMessages],
  )
  /** Scrolls a queued or failed row into view and moves focus to it. */
  const revealMessageRow = (messageId: string | undefined) => {
    if (!messageId) return
    const row = [...document.querySelectorAll<HTMLElement>('[data-message-id]')]
      .find((candidate) => candidate.dataset.messageId === messageId)
    row?.scrollIntoView({ block: 'center' })
    if (row) {
      row.tabIndex = -1
      row.focus({ preventScroll: true })
    }
  }
  const { visibleMessages: visibleChannelMessages, repliesByRoot } = useMemo(
    () => groupThreadReplies(channelMessages),
    [channelMessages],
  )
  const messageIndexById = useMemo(
    () => new Map(visibleChannelMessages.map((message, index) => [message.id, index] as const)),
    [visibleChannelMessages],
  )

  /**
   * Which rows are a genuine arrival, as opposed to a row scrolling back into
   * the virtual window. Mirrors ChatView exactly: only an unbroken run of
   * never-before-seen messages at the tail counts, so a send or an incoming
   * message animates, a prepended history page does not, and the first paint
   * of a conversation animates nothing.
   */
  const seenDmMessagesRef = useRef<{ conversationId: string | null; ids: Set<string> }>({
    conversationId: activeConversationId,
    ids: new Set<string>(),
  })
  const enteringMessageIds = useMemo(() => {
    const seen = seenDmMessagesRef.current
    if (seen.conversationId !== activeConversationId || seen.ids.size === 0) {
      return EMPTY_ENTERING_DM_IDS
    }
    const entering = new Set<string>()
    for (let index = visibleChannelMessages.length - 1; index >= 0; index -= 1) {
      const message = visibleChannelMessages[index]
      if (dmMessageIdentities(message).some((identity) => seen.ids.has(identity))) break
      entering.add(message.id)
    }
    return entering.size === 0 ? EMPTY_ENTERING_DM_IDS : entering
  }, [activeConversationId, visibleChannelMessages])

  useEffect(() => {
    const seen = seenDmMessagesRef.current
    if (seen.conversationId !== activeConversationId) {
      seen.conversationId = activeConversationId
      seen.ids = new Set<string>()
    }
    for (const message of visibleChannelMessages) {
      for (const identity of dmMessageIdentities(message)) seen.ids.add(identity)
    }
  }, [activeConversationId, visibleChannelMessages])
  const messageById = useMemo(
    () => new Map(channelMessages.map((message) => [message.id, message] as const)),
    [channelMessages],
  )
  const virtualItems = useMemo<VirtualItem[]>(
    () => visibleChannelMessages.map((message) => ({
      key: message.id,
      type: 'message',
      height:
        52
        + Math.min(160, Math.max(1, Math.ceil(message.content.length / 80)) * 20)
        + ((message.attachments?.length ?? 0) > 0 ? 96 : 0)
        + (repliesByRoot.has(message.id) ? 36 : 0),
    })),
    [repliesByRoot, visibleChannelMessages],
  )
  const {
    scrollContainerRef,
    topSpacerHeight,
    bottomSpacerHeight,
    visibleRange,
    handleMeasuredHeight,
    handleScroll,
    scrollToBottom,
    scrollToItem,
    resetLayout,
    setScrollAnchor,
  } = useVirtualScroll(virtualItems, {
    estimatedMessageHeight: 76,
    overscanPx: 500,
  })
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
   * MessageInput, so this asks the region for its control rather than reaching
   * for a component-private ref.
   */
  const visibleMessages = useMemo(
    () => virtualItems.length === 0
      ? []
      : virtualItems
          .slice(visibleRange.start, visibleRange.end + 1)
          .map((item) => {
            const index = messageIndexById.get(item.key) ?? -1
            return index >= 0 ? { message: visibleChannelMessages[index], index } : null
          })
          .filter(
            (entry): entry is { message: MessageType; index: number } => entry !== null,
          ),
    [
      messageIndexById,
      virtualItems,
      visibleChannelMessages,
      visibleRange.end,
      visibleRange.start,
    ],
  )
  const peerPublicKey = conversation ? dmPrimaryPeer(conversation).userId : undefined
  const trustMembers = useMemo(
    () => [ownAuthorId, peerPublicKey]
      .filter((publicKey): publicKey is string => Boolean(publicKey))
      .map((publicKey) => ({ publicKey })),
    [peerPublicKey, ownAuthorId],
  )
  const trust = useRoomTrust(activeConversationId, trustMembers)
  const isLoading = (!messageLoad || messageLoad.status === 'idle' || messageLoad.status === 'loading')
    && visibleChannelMessages.length === 0
  const loadFailed = messageLoad?.status === 'failed'
  /**
   * Which timeline state the log is presenting, named rather than left as a
   * chain of inline conditions, so the branch order below stays readable.
   */
  const showsLoadError = loadFailed && visibleChannelMessages.length === 0
  const showsEmptyConversation = visibleChannelMessages.length === 0
  // Only this state renders `article` rows, and only it may sit inside the feed.
  const showsMessageArticles = !showsLoadError && !showsEmptyConversation
  /**
   * Whether this conversation's history is known good.
   *
   * Only a completed load is evidence that an empty timeline means "nothing
   * has been said yet" rather than "Mesh could not read this conversation".
   * Stated explicitly rather than inferred from the order of the render
   * branches, because the branch order is exactly what a later edit would
   * change without noticing.
   */
  const conversationHistoryLoaded = messageLoad?.status === 'loaded'
  const blockStatus = !matrixMode
    ? 'ready'
    : peerPublicKey && blockState?.peerPublicKey === peerPublicKey
      ? blockState.status
      : 'loading'
  const isBlocked = blockStatus === 'ready' && Boolean(blockState?.blocked)
  const blockSafetyUnavailable = matrixMode && blockStatus !== 'ready'
  const sendingProtectionUnavailable = matrixMode && trust.protection !== 'protected'
  const safetyOpen = route.kind === 'direct'
    && route.conversationId === activeConversationId
    && route.pane?.kind === 'safety'
  const openThreadId = route.kind === 'direct'
    && route.conversationId === activeConversationId
    && route.pane?.kind === 'thread'
      ? route.pane.rootEventId
      : null
  const threadContext = useMatrixThreadContext(
    activeConversationId,
    openThreadId,
    matrixMode,
  )
  const openThread = useMemo(() => {
    if (!openThreadId) return { root: null, replies: EMPTY_MESSAGES }
    const localRoot = messageById.get(openThreadId) ?? null
    const serverRoot = threadContext.context?.root ?? null
    return {
      root: serverRoot && localRoot ? { ...serverRoot, ...localRoot } : serverRoot ?? localRoot,
      replies: mergeThreadMessages(
        threadContext.context?.replies ?? EMPTY_MESSAGES,
        repliesByRoot.get(openThreadId) ?? EMPTY_MESSAGES,
      ),
    }
  }, [messageById, openThreadId, repliesByRoot, threadContext.context])
  const reportMessages = useMemo(
    () => [...channelMessages]
      .reverse()
      .filter((message) => (
        message.authorPublicKey === peerPublicKey
        && !message.deletedAt
        && message.deliveryStatus !== 'pending'
        && message.deliveryStatus !== 'failed'
      ))
      .slice(0, 3),
    [channelMessages, peerPublicKey],
  )

  const beginThreadReply = useCallback(
    (root: MessageType, target: MessageType = root) => {
      setThreadReplyRoot(root)
      setReplyingTo(target)
    },
    [],
  )
  const beginOrdinaryReply = useCallback((message: MessageType) => {
    setThreadReplyRoot(null)
    setReplyingTo(message)
  }, [])
  const toggleThread = useCallback((messageId: string) => {
    if (route.kind !== 'direct' || route.conversationId !== activeConversationId) return
    if (openThreadId === messageId) {
      closePane()
      return
    }
    navigate({
      ...route,
      pane: { kind: 'thread', rootEventId: messageId },
    }, { focus: false })
  }, [activeConversationId, closePane, navigate, openThreadId, route])
  const closeThread = useCallback(() => {
    const rootId = openThreadId
    closePane()
    restorePaneTriggerFocus('mesh-thread-panel', rootId)
  }, [closePane, openThreadId])
  const closeSafety = useCallback(() => {
    closePane()
    restorePaneTriggerFocus('mesh-dm-safety-panel')
  }, [closePane])
  const closeActivePane = useCallback(() => {
    if (safetyOpen) closeSafety()
    else closeThread()
  }, [closeSafety, closeThread, safetyOpen])
  useCompactPaneFocus({
    active: safetyOpen || openThreadId !== null,
    compact: compactSecondaryPane,
    panelId: safetyOpen ? 'mesh-dm-safety-panel' : openThreadId ? 'mesh-thread-panel' : null,
    onClose: closeActivePane,
  })

  const markConversationRead = useCallback(async (conversationId: string) => {
    try {
      await bridge.markDmRead(conversationId)
      useDmStore.getState().patchConversation(conversationId, { unreadCount: 0 })
      setMarkReadError((current) => (
        current?.conversationId === conversationId ? null : current
      ))
    } catch (error) {
      setMarkReadError({ conversationId, error })
    }
  }, [])

  const requestOlderMessages = useCallback(async (scrollElement?: HTMLDivElement) => {
    if (
      !activeConversationId
      || !hasMoreOlder
      || isLoadingOlder
      || olderLoadInFlightRef.current
    ) return

    olderLoadInFlightRef.current = true
    if (scrollElement) {
      const containerBounds = scrollElement.getBoundingClientRect()
      const anchorRow = [...scrollElement.querySelectorAll<HTMLElement>('[data-message-id]')]
        .find((row) => {
          const bounds = row.getBoundingClientRect()
          return bounds.top >= containerBounds.top && bounds.bottom <= containerBounds.bottom
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
     * window, so once it is saturated a page of older messages trims the same
     * number of newer ones and the count is identical either way. The oldest id
     * changes if and only if something landed above the anchor row.
     */
    const oldestBefore =
      (useDmStore.getState().messages[activeConversationId] ?? EMPTY_DIRECT_MESSAGES)[0]?.id
    try {
      await loadOlderMessages(activeConversationId)
      setOlderLoadError(null)
    } catch (error) {
      setOlderLoadError(error)
    } finally {
      // A load that prepended nothing (the end of history, a rejected page, a
      // superseded request, a page already in the window) must not leave the
      // anchor armed: the next layout pass that happens to change the item list
      // would consume it and hard-set scrollTop to a position the reader has
      // long since left.
      const oldestAfter =
        (useDmStore.getState().messages[activeConversationId] ?? EMPTY_DIRECT_MESSAGES)[0]?.id
      if (oldestAfter === oldestBefore) setScrollAnchor(null)
      olderLoadInFlightRef.current = false
    }
  }, [
    activeConversationId,
    hasMoreOlder,
    isLoadingOlder,
    loadOlderMessages,
    setScrollAnchor,
  ])

  const handleDmScroll = useCallback((scrollElement: HTMLDivElement) => {
    const position = handleScroll()
    if (position && position.scrollTop < 100) {
      void requestOlderMessages(scrollElement)
    }
  }, [handleScroll, requestOlderMessages])

  const jumpToLatest = useCallback(async () => {
    if (!activeConversationId) return
    try {
      await loadMessages(activeConversationId, { resetToLatest: true })
      setOlderLoadError(null)
      requestAnimationFrame(() => scrollToBottom())
      await markConversationRead(activeConversationId)
    } catch (error) {
      console.error('Failed to jump to the latest direct messages:', error)
    }
  }, [activeConversationId, loadMessages, markConversationRead, scrollToBottom])

  const handleNavigateToSearchResult = useCallback((message: MessageType) => {
    if (!activeConversationId || message.channelId !== activeConversationId) return
    void (async () => {
      let context: DirectMessage[] = []
      try {
        context = await bridge.getDmMessages(activeConversationId, 49, {
          timestamp: message.timestamp,
          id: message.id,
        })
        setSearchContextLimited(false)
      } catch (error) {
        console.error('Failed to load context for a searched direct message:', error)
        setSearchContextLimited(true)
      }
      mergeHistoricalMessages(activeConversationId, [
        ...context,
        timelineMessageToDirectMessage(message),
      ])
      requestAnimationFrame(() => {
        scrollToItem(message.id, 'center')
        setHighlightedMessageId(message.id)
        if (searchHighlightTimerRef.current) clearTimeout(searchHighlightTimerRef.current)
        searchHighlightTimerRef.current = setTimeout(() => {
          setHighlightedMessageId(null)
          searchHighlightTimerRef.current = null
        }, 2_000)
      })
    })()
  }, [activeConversationId, mergeHistoricalMessages, scrollToItem])

  useEffect(() => {
    if (previousConversationIdRef.current === activeConversationId) return
    previousConversationIdRef.current = activeConversationId
    setThreadReplyRoot(null)
    setReplyingTo(null)
    setEditRequest(null)
    setOlderLoadError(null)
    setSearchContextLimited(false)
    setHighlightedMessageId(null)
    olderLoadInFlightRef.current = false
  }, [activeConversationId])

  useEffect(() => () => {
    if (searchHighlightTimerRef.current) clearTimeout(searchHighlightTimerRef.current)
  }, [])

  useEffect(() => {
    if (!matrixMode || !peerPublicKey) return
    let active = true
    void bridge.matrixDmBlocked(peerPublicKey)
      .then((blocked) => {
        if (active) setBlockState({ peerPublicKey, status: 'ready', blocked })
      })
      .catch((error) => {
        if (active) setBlockState({ peerPublicKey, status: 'failed', blocked: false })
        if (active) console.error('Failed to load Matrix DM block state:', error)
      })
    return () => {
      active = false
    }
  }, [blockRefreshToken, matrixMode, peerPublicKey])

  useEffect(() => {
    if (!activeConversationId) return
    let active = true
    const conversationId = activeConversationId
    void Promise.resolve().then(async () => {
      if (!active) return
      try {
        await loadMessages(conversationId, { resetToLatest: true })
        if (!active) return
        await markConversationRead(conversationId)
      } catch (error) {
        if (active) console.error('Failed to load direct messages:', error)
      }
    })
    return () => {
      active = false
    }
  }, [activeConversationId, loadMessages, markConversationRead])

  useEffect(() => {
    resetLayout()
  }, [activeConversationId, resetLayout])

  useEffect(() => {
    if (matrixMode) return
    const unsubscribe = bridge.onDmReceived((message) => {
      if (message.conversationId !== activeConversationIdRef.current) return
      addDirectMessage(message)
    })
    return () => {
      disposeSubscription(unsubscribe, 'direct-message listener')
    }
  }, [addDirectMessage, matrixMode])

  useEffect(() => {
    if (!matrixMode || !activeConversationId) return
    let active = true
    const retryController = new AbortController()
    let retryAttempt = 0
    const watchUpdates = async () => {
      while (active) {
        try {
          const kind = await bridge.matrixWaitForRoomUpdate(activeConversationId)
          retryAttempt = 0
          // A read receipt is the single most frequent update in an open DM,
          // and it used to cost a full history reload. Only a timeline change
          // means there is anything new to load.
          if (active && kind === 'timeline') await loadMessages(activeConversationId)
        } catch (error) {
          if (!active) return
          console.error('Failed to watch Matrix direct-message updates:', error)
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
      retryController.abort()
    }
  }, [activeConversationId, loadMessages, matrixMode])

  const handleSend = useCallback(async (
    content: string,
    files: StagedFile[] = [],
    onAttachmentSent?: (
      file: StagedFile,
      contentConsumed: boolean,
    ) => void | Promise<void>,
  ) => {
    if (
      !conversation
      || (matrixMode && (blockStatus !== 'ready' || isBlocked || sendingProtectionUnavailable))
    ) return
    if (isBrowsingOlder || hiddenNewerCount > 0) {
      await loadMessages(conversation.id, { resetToLatest: true })
      requestAnimationFrame(() => scrollToBottom())
    }
    const replyToId = replyingTo?.id
    const threadRootId = threadReplyRoot?.id

    if (matrixMode && files.length > 0) {
      try {
        for (const [index, file] of files.entries()) {
          const message = await bridge.matrixSendDmAttachment(
            dmPrimaryPeer(conversation).userId,
            file.grant,
            file.transferId ?? bridge.createMatrixTransferId(),
            index === 0 ? content : '',
            index === 0 ? replyToId : undefined,
            index === 0 ? threadRootId : undefined,
          )
          addDirectMessage(message)
          if (index === 0) {
            setReplyingTo(null)
            setThreadReplyRoot(null)
          }
          await onAttachmentSent?.(file, index === 0 && content.length > 0)
        }
        return
      } catch (error) {
        console.error('Failed to send DM attachment:', error)
        throw error
      }
    }

    const clientRequestId = bridge.createMatrixTransactionId()
    const sender = resolveSenderIdentity(
      useIdentityStore.getState().identity,
      matrixMode ? bridge.getMatrixUserId() : null,
    )
    const optimistic: MessageType = {
      id: clientRequestId,
      channelId: conversation.id,
      authorPublicKey: sender.publicKey,
      authorDisplayName: sender.displayName,
      authorAvatarColor: sender.avatarColor,
      // Carried on the local echo so a message does not show its own author a
      // generated mark for the moment before the sent copy arrives.
      authorAvatarUrl: sender.avatarUrl,
      content,
      attachments: [],
      reactions: {},
      timestamp: new Date().toISOString(),
      signature: '',
      replyToId,
      threadRootId,
      clientRequestId,
      deliveryStatus: 'pending',
    }
    useMessageStore.getState().addMessage(conversation.id, optimistic)
    setReplyingTo(null)
    setThreadReplyRoot(null)

    try {
      if (matrixMode) {
        const sent = await bridge.sendMessage(
          conversation.id,
          content,
          [],
          replyToId ?? undefined,
          clientRequestId,
          threadRootId ?? undefined,
        )
        useMessageStore.getState().acceptQueuedMessage({
          ...sent,
          clientRequestId: sent.clientRequestId ?? clientRequestId,
        })
      } else {
        const sent = await bridge.sendDm(
          dmPrimaryPeer(conversation).userId,
          content,
          replyToId ?? undefined,
          clientRequestId,
          threadRootId ?? undefined,
        )
        useMessageStore.getState().removeMessage(conversation.id, clientRequestId)
        addDirectMessage({ ...sent, deliveryStatus: 'sent' })
      }
    } catch (error) {
      console.error('Failed to send DM:', error)
      useMessageStore
        .getState()
        .setDeliveryStatus(conversation.id, clientRequestId, 'failed')
    }
  }, [
    addDirectMessage,
    blockStatus,
    conversation,
    hiddenNewerCount,
    isBrowsingOlder,
    loadMessages,
    isBlocked,
    matrixMode,
    replyingTo,
    scrollToBottom,
    sendingProtectionUnavailable,
    threadReplyRoot,
  ])

  const handleRetry = useCallback(async (message: MessageType) => {
    if (!conversation || (matrixMode && (blockStatus !== 'ready' || isBlocked))) return
    const deliveryStore = useMessageStore.getState()
    deliveryStore.setDeliveryStatus(conversation.id, message.id, 'pending')
    try {
      if (matrixMode && message.transactionId) {
        await bridge.matrixRetryQueuedMessage(conversation.id, message.transactionId)
        return
      }
      if (matrixMode) {
        const requestId = message.clientRequestId ?? message.id
        const sent = await bridge.sendMessage(
          conversation.id,
          message.content,
          [],
          message.replyToId ?? undefined,
          requestId,
          message.threadRootId ?? undefined,
        )
        deliveryStore.acceptQueuedMessage({
          ...sent,
          clientRequestId: sent.clientRequestId ?? requestId,
        })
        return
      }
      const sent = await bridge.sendDm(
        dmPrimaryPeer(conversation).userId,
        message.content,
        message.replyToId ?? undefined,
      )
      deliveryStore.removeMessage(conversation.id, message.id)
      addDirectMessage({ ...sent, deliveryStatus: 'sent' })
    } catch (error) {
      console.error('Failed to retry DM:', error)
      deliveryStore.setDeliveryStatus(conversation.id, message.id, 'failed')
    }
  }, [addDirectMessage, blockStatus, conversation, isBlocked, matrixMode])

  const handleCancelQueued = useCallback(async (message: MessageType) => {
    if (!conversation) return
    try {
      if (matrixMode && message.transactionId) {
        await bridge.matrixCancelQueuedMessage(conversation.id, message.transactionId)
      }
      useMessageStore.getState().removeMessage(conversation.id, message.id)
    } catch (error) {
      console.error('Failed to cancel saved DM:', error)
    }
  }, [conversation, matrixMode])

  const handleReaction = useCallback(async (message: MessageType, emoji: string) => {
    if (!matrixMode || !activeConversationId || !ownAuthorId) return
    const currentUsers = message.reactions[emoji] ?? []
    const verb = currentUsers.includes(ownAuthorId) ? 'remove' : 'add'
    updateDirectReaction(activeConversationId, message.id, emoji, ownAuthorId, verb)
    useMessageStore
      .getState()
      .updateReaction(activeConversationId, message.id, emoji, ownAuthorId, verb)
    try {
      await bridge.addReaction(message.id, emoji, activeConversationId)
    } catch (error) {
      const revertVerb = verb === 'add' ? 'remove' : 'add'
      updateDirectReaction(
        activeConversationId,
        message.id,
        emoji,
        ownAuthorId,
        revertVerb,
      )
      useMessageStore
        .getState()
        .updateReaction(activeConversationId, message.id, emoji, ownAuthorId, revertVerb)
      console.error('Failed to update DM reaction:', error)
      throw error
    }
  }, [activeConversationId, matrixMode, ownAuthorId, updateDirectReaction])

  const handleEdit = useCallback(async (
    message: MessageType,
    content: string,
    mentionUserIds: readonly string[],
  ) => {
    if (!matrixMode || !activeConversationId) return
    await bridge.editMessage(message.id, content, activeConversationId, mentionUserIds)
    const editedAt = new Date().toISOString()
    patchDirectMessage(activeConversationId, message.id, {
      content,
      editedAt,
      mentions: [...mentionUserIds],
    })
    useMessageStore
      .getState()
      .editMessage(activeConversationId, message.id, content, editedAt, mentionUserIds)
  }, [activeConversationId, matrixMode, patchDirectMessage])

  const handleDelete = useCallback(async (message: MessageType) => {
    if (!matrixMode || !activeConversationId) return
    await bridge.deleteMessage(message.id, activeConversationId)
    patchDirectMessage(activeConversationId, message.id, {
      content: '',
      deletedAt: new Date().toISOString(),
    })
    useMessageStore.getState().deleteMessage(activeConversationId, message.id)
  }, [activeConversationId, matrixMode, patchDirectMessage])

  // Surface the peer's typing state in the DM, mirroring the channel view.
  const setTyping = useTypingStore((state) => state.setTyping)
  const setTypingUsers = useTypingStore((state) => state.setTypingUsers)
  const refreshMatrixTyping = useCallback(async (conversationId: string) => {
    try {
      const users = await bridge.matrixTypingUsers(conversationId)
      if (activeConversationIdRef.current !== conversationId) return
      setTypingUsers(
        conversationId,
        users.map((user) => ({ author: user.userId, displayName: user.displayName })),
      )
    } catch (error) {
      console.error('Failed to refresh Matrix DM typing notifications:', error)
    }
  }, [setTypingUsers])

  useEffect(() => {
    if (matrixMode) {
      const listener = bridge.onMatrixTypingChanged((change) => {
        if (change.roomId === activeConversationIdRef.current) void refreshMatrixTyping(change.roomId)
      })
      void listener.catch((error) => {
        console.warn('Failed to register the Matrix DM typing listener:', error)
      })
      return () => disposeSubscription(listener, 'Matrix DM typing listener')
    }
    const unsub = bridge.onTypingUpdate((data) => {
      if (data.channelId !== activeConversationIdRef.current) return
      setTyping(data.channelId, data.author, data.displayName)
    })
    return () => disposeSubscription(unsub, 'DM typing listener')
  }, [matrixMode, refreshMatrixTyping, setTyping])

  // The listener only reports changes, so each conversation needs one snapshot.
  useEffect(() => {
    if (!matrixMode || !activeConversationId) return
    void refreshMatrixTyping(activeConversationId)
  }, [activeConversationId, matrixMode, refreshMatrixTyping])

  const handleToggleBlocked = async () => {
    if (!matrixMode || !conversation || isBlockBusy) return
    setIsBlockBusy(true)
    setBlockError(null)
    try {
      const blocked = await bridge.matrixSetDmBlocked(
        dmPrimaryPeer(conversation).userId,
        !isBlocked,
      )
      setBlockState({ peerPublicKey: dmPrimaryPeer(conversation).userId, status: 'ready', blocked })
      if (blocked) {
        // Do not wait for the next Matrix poll to hide an already-rendered
        // conversation. The native projection independently enforces the same
        // account-data boundary for subsequent reads.
        useDmStore.getState().upsertBlockedAccount({ userId: dmPrimaryPeer(conversation).userId })
      } else {
        useDmStore.getState().removeBlockedAccount(dmPrimaryPeer(conversation).userId)
      }
    } catch (error) {
      console.error('Failed to update Matrix DM block state:', error)
      setBlockError(error)
    } finally {
      setIsBlockBusy(false)
    }
  }

  if (!activeConversationId || !conversation) {
    return <DmLanding />
  }

  const peerName = dmPrimaryPeer(conversation).displayName.trim() || 'Unknown account'
  /*
    The peer's homeserver, when it is not yours. Read from the shared
    derivation so the ring on this header, the ring in the conversation list
    and any rail in the timeline agree about the same person.
  */
  const peerIsRemote = bridge.isMatrixBackend()
    && serverRelation(dmPrimaryPeer(conversation).userId, bridge.getMatrixUserId()) === 'remote'
  const peerServer = serverName(dmPrimaryPeer(conversation).userId)

  return (
    <div className="relative flex h-full min-h-0 min-w-0 flex-1 overflow-hidden">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div
        className="mesh-conversation-header flex h-conversation-header flex-shrink-0 items-center border-b border-rule border-outline-variant px-shell-gutter py-2"
        data-tauri-drag-region
      >
        <Avatar
          color={dmPrimaryPeer(conversation).avatarColor}
          size={26}
          name={peerName}
          imageUrl={dmPrimaryPeer(conversation).avatarUrl}
          className={`mr-3 ${peerIsRemote ? 'mesh-remote-mark' : ''}`}
        />
        <span className="min-w-0">
          <h1
            className="block truncate text-title-lg font-semibold text-on-surface outline-none"
            data-mesh-route-heading
            tabIndex={-1}
          >
            {peerName}
          </h1>
          {/*
            The subtitle is the peer's homeserver when it differs from yours,
            and nothing at all when it does not. "Private conversation" under
            every direct message was the norm restating itself.
          */}
          {peerIsRemote && (
            <span className="mt-0.5 block truncate text-label-sm text-on-surface-variant">
              {peerServer}
            </span>
          )}
        </span>
        <div className="ml-auto flex items-center gap-1.5">
          <SearchBar
            label="Find"
            scopeId={activeConversationId}
            resultLocationLabel={peerName}
            onNavigateToMessage={handleNavigateToSearchResult}
          />
          {matrixMode && (
            <button
              type="button"
              onClick={() => {
                if (safetyOpen) closeSafety()
                else navigate({
                  kind: 'direct',
                  conversationId: activeConversationId,
                  pane: { kind: 'safety' },
                })
              }}
              className={`flex min-h-8 items-center gap-1.5 rounded-full px-2 text-label-sm font-medium transition-colors ${
                safetyOpen
                  ? 'bg-secondary-container text-on-surface'
                  : trust.devicesNeedReview > 0 || trust.protection !== 'protected'
                    ? 'bg-marker-container text-marker hover:bg-marker-container-hover'
                    : 'text-on-surface-variant hover:bg-surface-container-high hover:text-on-surface'
              }`}
              aria-controls="mesh-dm-safety-panel"
              aria-expanded={safetyOpen}
              /* "Safety" is the pane's proper name, so it stays capitalised in
                 the control that opens it, matching the pane's own label. */
              aria-label={safetyOpen ? 'Close Safety' : `Open Safety with ${peerName}`}
            >
              <Icon
                name={trust.devicesNeedReview > 0 || trust.protection !== 'protected' ? 'triangleAlert' : 'shieldCheck'}
                size="xs"
              />
              Safety
            </button>
          )}
        </div>
      </div>
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

      {matrixMode && !trust.loadingAccountTrust && trust.devicesNeedReview > 0 && (
        <div className="flex min-h-10 items-center gap-2 border-b border-marker-container-line bg-marker-container px-4 py-1.5 text-body-sm text-on-surface-variant">
          <Icon
            name="triangleAlert"
            size="sm"
            className="flex-shrink-0 text-marker"
          />
          <span className="min-w-0 flex-1">
            {trust.devicesNeedReview}{' '}
            {trust.devicesNeedReview === 1 ? 'device needs' : 'devices need'} review.
          </span>
          <button
            type="button"
            onClick={(event) => openSecurityFrom(event.currentTarget)}
            className="min-h-8 flex-shrink-0 rounded-full px-2 font-semibold text-marker hover:bg-marker-container-hover"
          >
            Review
          </button>
        </div>
      )}

      {markReadError?.conversationId === activeConversationId && (
        <div
          role="alert"
          className="flex flex-wrap items-center justify-between gap-2 border-b border-marker-container-line bg-marker-container px-4 py-2 text-body-sm text-on-surface-variant"
        >
          <span>This conversation could not be marked as read.</span>
          <button
            type="button"
            className="min-h-8 rounded-full px-2 font-semibold text-primary hover:bg-surface-container-high"
            onClick={() => void markConversationRead(activeConversationId)}
          >
            Retry read status
          </button>
        </div>
      )}

      {(isBrowsingOlder || hiddenNewerCount > 0) && (
        <button
          type="button"
          onClick={() => void jumpToLatest()}
          className="flex min-h-9 flex-shrink-0 items-center justify-center border-b border-outline-variant bg-primary px-4 text-body-md font-semibold text-on-error hover:bg-primary"
        >
          {hiddenNewerCount > 0
            ? `Jump to latest messages (${hiddenNewerCount} newer)`
            : 'Jump to latest messages'}
        </button>
      )}

      {isLoadingOlder && visibleChannelMessages.length > 0 && (
        <AsyncStatus
          compact
          title="Loading earlier messages"
          detail="Your place stays here."
        />
      )}

      {olderLoadError !== null && (
        <div
          role="alert"
          className="flex flex-wrap items-center justify-between gap-2 border-b border-marker-container-line bg-marker-container px-4 py-2 text-body-sm text-on-surface-variant"
        >
          <span>Earlier messages could not be loaded.</span>
          <button
            type="button"
            className="min-h-8 rounded-full px-2 font-semibold text-primary hover:bg-surface-container-high"
            onClick={() => void requestOlderMessages()}
          >
            Retry earlier messages
          </button>
        </div>
      )}

      {searchContextLimited && (
        <div
          role="status"
          className="border-b border-marker-container-line bg-marker-container px-4 py-2 text-center text-body-sm text-on-surface-variant"
        >
          The surrounding messages could not be loaded.
        </div>
      )}

      {!hasMoreOlder && visibleChannelMessages.length > 0 && (
        <div className="border-b border-outline-variant bg-surface-container-lowest px-4 py-2 text-center text-body-sm text-on-surface-variant">
          Beginning of this conversation
        </div>
      )}

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
        <div className="flex-1 overflow-y-auto bg-surface py-5">
        {showsLoadError ? (
          <div className="flex h-full items-center justify-center px-4">
            <div
              role="alert"
              className="max-w-sm rounded-xl border border-marker-container-line bg-marker-container p-4 text-center text-body-md text-on-surface-variant"
            >
              <p>Messages could not be loaded.</p>
              <button
                type="button"
                className="mt-3 min-h-8 rounded-full px-3 font-semibold text-primary hover:bg-surface-container-high"
                onClick={() => void loadMessages(activeConversationId)
                  .then(() => markConversationRead(activeConversationId))
                  .catch(() => {})}
              >
                Retry messages
              </button>
            </div>
          </div>
        ) : isLoading ? (
          /*
            The placeholder has to be the shape of the thing being loaded:
            MessageSkeleton mirrors the real row exactly (64px gutter, 40px
            avatar column, 4px block padding, 65ch measure) and the grouped
            rhythm here matches real conversation.
          */
          <div>
            <AsyncStatus
              compact
              title="Bringing in this conversation"
              detail="Checking for new activity."
            />
            {Array.from({ length: 8 }).map((_, index) => (
              <MessageSkeleton key={index} index={index} grouped={index % 3 !== 0} />
            ))}
          </div>
        ) : showsEmptyConversation ? (
          /*
            Two different states share this branch. An empty timeline in a
            conversation that loaded cleanly is genuinely new, and can be
            specific about who you are writing to and what to do. An empty
            timeline whose history is unknown is not evidence of anything, so
            it keeps the honest generic copy.
          */
          <div className="flex h-full items-center justify-center">
            {conversationHistoryLoaded ? (
              <EmptyState
                eyebrow="Direct message"
                markSeed={activeConversationId}
                title="Nothing here yet"
                description={`Be the first to say something to ${peerName}.`}
                  /*
                    No first-message action. It focused the composer, which is
                    visible directly below this state and is the next thing Tab
                    reaches, so the button was a second control for a control
                    already on screen. The eyebrow keeps naming the room.
                  */
              />
            ) : (
              <EmptyState
                icon={<Icon name="messageCircle" size="lg" />}
                title="Nothing here yet"
                description={`Say something to ${peerName}.`}
              />
            )}
          </div>
          ) : null}
        </div>
      )}
      <div
        ref={attachMessageLog}
        onScroll={(event) => handleDmScroll(event.currentTarget)}
        className="flex flex-1 flex-col overflow-y-auto bg-surface py-5"
        /*
          `feed`, not `log`. `log` implies aria-live="polite", which is wrong
          here: this container's children are inserted and removed by
          *virtualization*, not by message arrival, so scrolling through
          history announced every old message as if it were new, and
          aria-live="off" was reaching for a role that is not a live region at
          all. `feed` is that role: it is not live, it makes the rows'
          aria-posinset and aria-setsize meaningful (both are only honoured on
          an `article` inside a `feed`), it gives Page Down and Page Up article
          navigation, and it defines aria-busy for infinite-scroll loading.

          A feed must contain at least one `article`, so the role is only
          claimed while there are messages to own. The element itself stays
          mounted either way, which keeps the scroll container and its ref
          stable across the empty-to-first-message transition.
        */
        role={showsMessageArticles ? 'feed' : undefined}
        aria-busy={showsMessageArticles ? isLoadingOlder || undefined : undefined}
        aria-label={showsMessageArticles ? `Messages with ${peerName}` : undefined}
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
          <div className="mt-auto">
            {hasMoreOlder && (
              /*
                Only the visible window exists in the DOM, so in browse mode
                Ctrl+Home lands on a spacer and there is nothing to say that
                history continues above. The scroll threshold is unreachable
                without a pointer, so history needs one activatable control.
                It stays enabled while loading (disabling it would drop focus);
                the feed's aria-busy carries the loading state.
              */
              <div className="flex h-10 items-center justify-center gap-2 px-4">
                <span className="h-px min-w-6 flex-1 bg-outline-variant" aria-hidden="true" />
                <button
                  type="button"
                  aria-disabled={isLoadingOlder || undefined}
                  onClick={() => void requestOlderMessages(messageLogRef.current ?? undefined)}
                  className="min-h-control-sm rounded-full px-2 text-label-sm font-medium text-on-surface-variant transition-colors hover:bg-surface-container-high hover:text-on-surface-variant focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus"
                >
                  Load earlier messages
                </button>
                <span className="h-px min-w-6 flex-1 bg-outline-variant" aria-hidden="true" />
              </div>
            )}
            <div
              data-design-token-exception="data-driven-virtual-spacer-geometry"
              style={{
                paddingTop: `${topSpacerHeight}px`,
                paddingBottom: `${bottomSpacerHeight}px`,
              }}
            >
            {visibleMessages.map(({ message, index }) => {
              const threadReplies = repliesByRoot.get(message.id) ?? EMPTY_MESSAGES
              return (
                <DmVirtualMessageRow
                  key={message.id}
                  rowKey={message.id}
                  position={index + 1}
                  setSize={visibleChannelMessages.length}
                  onHeightChange={handleMeasuredHeight}
                  isHighlighted={highlightedMessageId === message.id}
                  isEntering={enteringMessageIds.has(message.id)}
                >
                  <DmMessageBoundary messageId={message.id}>
                    {() => (
                      <>
                        <MessageComponent
                          message={message}
                          isGrouped={shouldGroupMessage(
                            message,
                            visibleChannelMessages[index - 1],
                          )}
                          authorNameId={timelineAuthorNameId(message.id)}
                          surface="dm"
                          disableMotion
                          limitedActions
                          trust={trust}
                          replyPreview={
                            message.replyToId
                              ? messageById.get(message.replyToId) ?? null
                              : null
                          }
                          onReply={beginOrdinaryReply}
                          threadReplyCount={threadReplies.length}
                          threadOpen={openThreadId === message.id}
                          onToggleThread={() => toggleThread(message.id)}
                          onRetry={handleRetry}
                          onCancel={handleCancelQueued}
                          onEdit={handleEdit}
                          onDelete={handleDelete}
                          onReact={handleReaction}
                          editRequestToken={
                            editRequest?.messageId === message.id
                              ? editRequest.token
                              : 0
                          }
                        />
                        {message.id === lastSeenOwnMessageId && (
                          /*
                            Not a live region. These rows mount and unmount as
                            the timeline virtualizes, so anything with a live
                            role re-announces every time the row scrolls back
                            into view.
                          */
                          <p className="mt-0.5 pl-11 text-right text-label-sm text-on-surface-variant">
                            Seen
                          </p>
                        )}
                      </>
                    )}
                  </DmMessageBoundary>
                </DmVirtualMessageRow>
              )
            })}
            </div>
          </div>
        ) : null}
      </div>

      {loadFailed && visibleChannelMessages.length > 0 && (
        <div
          role="alert"
          className="mx-4 mb-2 flex flex-wrap items-center justify-between gap-2 rounded-full border border-marker-container-line bg-marker-container px-3 py-2 text-body-sm text-on-surface-variant"
        >
          <span>Could not refresh messages.</span>
          <button
            type="button"
            className="min-h-8 rounded-full px-2 font-semibold text-primary hover:bg-surface-container-high"
            onClick={() => void loadMessages(activeConversationId).catch(() => {})}
          >
            Retry
          </button>
        </div>
      )}

      {isBlocked && (
        <div className="mx-4 mb-2 rounded-xl border border-error-container-line bg-error-container px-3 py-2 text-body-sm text-error">
          Messages from this user are blocked. Unblock {peerName} to send a message.
        </div>
      )}
      {blockSafetyUnavailable && (
        <div
          role={blockStatus === 'failed' ? 'alert' : 'status'}
          className="mx-4 mb-2 rounded-xl border border-marker-container-line bg-marker-container px-3 py-2 text-body-sm text-on-surface-variant"
        >
          {blockStatus === 'failed' ? (
            <>
              <span>Sending is off until Mesh can check whether this account is blocked.</span>{' '}
              <button
                type="button"
                className="min-h-8 rounded-full px-2 font-semibold text-primary hover:bg-surface-container-high"
                onClick={() => {
                  if (!peerPublicKey) return
                  setBlockState({ peerPublicKey, status: 'loading', blocked: false })
                  setBlockRefreshToken((token) => token + 1)
                }}
              >
                Retry safety check
              </button>
            </>
          ) : (
            'Checking your blocked-account setting before messages can be sent.'
          )}
        </div>
      )}
      {replyingTo && (
        <div className="flex items-center justify-between gap-2 border-t border-outline-variant bg-surface-container-lowest px-4 py-2 text-body-sm text-on-surface-variant">
          <span>
            {threadReplyRoot && (
              <span className="mr-1 font-semibold text-primary">In thread ·</span>
            )}
            Replying to {replyingTo.authorDisplayName}:{' '}
            {replyingTo.content.slice(0, 80)}
          </span>
          <button
            type="button"
            onClick={() => {
              setReplyingTo(null)
              setThreadReplyRoot(null)
            }}
            className="min-h-8 rounded-full px-2 text-on-surface-variant hover:bg-surface-container-high hover:text-on-surface"
            aria-label="Cancel reply"
          >
            Cancel
          </button>
        </div>
      )}
      {/*
        The composer is its own region so it can be reached directly. Every
        message contributes eight to twelve tab stops, so from the conversation
        list the composer was several hundred Tab presses away, and neither the
        skip link nor the F6 cycle had a target for it.
      */}
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
          onReview={() => revealMessageRow(savedMessages[0]?.id)}
          onReviewFailed={() => revealMessageRow(failedMessages[0]?.id)}
        />
        {sendingProtectionUnavailable && (
          <div
            role="status"
            className="border-t border-marker-container-line bg-marker-container px-4 py-2 text-body-sm text-on-surface-variant"
          >
            {trust.protection === 'checking'
              ? "Checking this conversation's protection before sending."
              : trust.protection === 'unencrypted'
                ? 'Sending is paused until this conversation is protected.'
                : (
                  <>
                    Mesh could not check this conversation&rsquo;s protection, so sending is
                    paused.
                    <button
                      type="button"
                      className="ml-1 rounded-full underline underline-offset-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus"
                      onClick={() => trust.recheckProtection()}
                    >
                      Check again
                    </button>
                  </>
                )}
          </div>
        )}
        <TypingIndicator channelId={activeConversationId} />
        <MessageInput
          channelId={activeConversationId}
          channelName={peerName}
          placeholder={`Message ${peerName}`}
          onSend={handleSend}
          disableAttachments={false}
          disabled={(matrixMode && (isBlocked || blockStatus !== 'ready')) || sendingProtectionUnavailable}
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
      </div>
      {(matrixMode && safetyOpen) || openThreadId ? (
        <button
          type="button"
          className="mesh-room-context-backdrop"
          aria-label={safetyOpen ? 'Dismiss safety' : 'Dismiss thread'}
          onClick={safetyOpen ? closeSafety : closeThread}
        />
      ) : null}
      {matrixMode && safetyOpen && (
        <DmSafetyPanel
          key={activeConversationId}
          conversationId={activeConversationId}
          peerName={peerName}
          accountAddress={dmPrimaryPeer(conversation).userId}
          trust={trust}
          reportMessages={reportMessages}
          isBlocked={isBlocked}
          isBlockBusy={isBlockBusy}
          blockError={blockError}
          onReviewDevices={openSecurityFrom}
          onToggleBlocked={() => void handleToggleBlocked()}
          onClose={closeSafety}
        />
      )}
      {openThreadId && (
        <Suspense fallback={<DmThreadPanelLoadingFallback onClose={closeThread} />}>
          <ThreadPanel
            key={`${activeConversationId}:${openThreadId}`}
            title={peerName}
            root={openThread.root}
            replies={openThread.replies}
            surface="dm"
            trust={trust}
            onReply={beginThreadReply}
            onClose={closeThread}
            onMarkRead={async (rootEventId, eventId) => {
              await bridge.markThreadRead(activeConversationId, rootEventId, eventId)
              threadContext.clearUnread()
            }}
            loadState={threadContext.status}
            unreadCount={threadContext.context?.unreadCount}
            unreadMentions={threadContext.context?.unreadMentions}
            unreadStateAvailable={threadContext.context?.unreadStateAvailable}
            hasMore={threadContext.context?.hasMore}
            onRetry={threadContext.retry}
          />
        </Suspense>
      )}
    </div>
  )
}

function DmThreadPanelLoadingFallback({ onClose }: { onClose: () => void }) {
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
          className="min-h-10 rounded-full px-2 text-body-sm font-medium text-on-surface-variant hover:bg-surface-container-high hover:text-on-surface"
        >
          Close
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-hidden py-3" aria-hidden="true">
        <MessageSkeleton />
        <MessageSkeleton />
      </div>
    </aside>
  )
}
