import { memo, useState, useRef, useEffect, useCallback, useLayoutEffect, useMemo } from 'react'
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
import { getBackoffDelay, registerPoll, waitForDelay } from '../../lib/scheduler'
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
import { EmptyState } from '../ui/Primitives'
import { useRoomPinStore } from '../../store/room-pins'

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

/** Fixed height of a DayDivider row, so virtual layout needs no measurement. */
const DAY_DIVIDER_HEIGHT = 36
const UNREAD_DIVIDER_HEIGHT = 40

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
  const pinnedMessage = pinnedMessages[0] ?? null
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
  const matrixMode = bridge.isMatrixBackend()
  const communityName = useCommunityStore(
    (state) => state.communityEntities[channel.communityId]?.name,
  )
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
  const setCommunities = useCommunityStore((state) => state.setCommunities)
  const setActiveCommunity = useCommunityStore((state) => state.setActiveCommunity)
  const communityMembers = useCommunityMembers(channel.communityId)
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
  const [openThreadId, setOpenThreadId] = useState<string | null>(null)
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
  const legacyPublicKey = useIdentityStore((state) => state.identity?.publicKey)
  const ownAuthorId = matrixMode
    ? bridge.getMatrixUserId() ?? undefined
    : legacyPublicKey
  const { visibleMessages, repliesByRoot } = useMemo(
    () => groupThreadReplies(channelMessages),
    [channelMessages],
  )
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
  const sendingProtectionUnavailable = matrixMode && trust?.protection !== 'protected'

  const beginThreadReply = useCallback((root: MessageType, target: MessageType = root) => {
    setOpenThreadId(root.id)
    setThreadReplyRoot(root)
    setReplyingTo(target)
  }, [])

  const beginOrdinaryReply = useCallback((message: MessageType) => {
    setThreadReplyRoot(null)
    setReplyingTo(message)
  }, [])

  const toggleThread = useCallback((messageId: string) => {
    setOpenThreadId((current) => current === messageId ? null : messageId)
  }, [])

  useEffect(() => {
    if (previousChannelIdRef.current === channel.id) return
    previousChannelIdRef.current = channel.id
    setOpenThreadId(null)
    setThreadReplyRoot(null)
    setReplyingTo(null)
  }, [channel.id])

  // O(1) message lookup for the render map and the scroll handler, which both
  // previously did a linear scan per row / per scroll event.
  const messageIndexById = useMemo(() => {
    const index = new Map<string, number>()
    visibleMessages.forEach((message, position) => index.set(message.id, position))
    return index
  }, [visibleMessages])

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
          + (repliesByRoot.get(message.id)?.length ?? 0) * 88
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
  const visibleItems = useMemo(
    () => virtualItems.length === 0
      ? []
      : virtualItems.slice(visibleRange.start, visibleRange.end + 1),
    [virtualItems, visibleRange.end, visibleRange.start],
  )

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
          message: 'Room upgrade information could not be refreshed. Retry by reopening this room.',
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
  // the DTO projection so federated state appears without fixed-interval polling.
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

    const retryController = new AbortController()
    let retryAttempt = 0
    const watchUpdates = async () => {
      while (active) {
        try {
          await bridge.matrixWaitForRoomUpdate(channel.id)
          retryAttempt = 0
          if (active) await refresh()
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
      bridge.requestMessageHistory(channel.id, { peerId, limit: 100 }).catch((err) => {
        console.error('Failed to request message history:', err)
      })
    })
    return () => { unsub.then((fn) => fn()) }
  }, [channel.communityId, channel.id, matrixMode])

  // Listen for incoming messages
  useEffect(() => {
    if (matrixMode) return
    const unsub = bridge.onMessageReceived((msg) => {
      if (msg.channelId === channel.id) {
        if (hydratingLatestRef.current) {
          bufferedMessagesRef.current.push(msg)
          return
        }
        addMessage(channel.id, msg)

        if (isViewingLatest && getIsAtBottom()) {
          markChannelSeen().catch((err) => {
            console.error('Failed to mark channel as read:', err)
          })
          setShowNewMessages(false)
        } else {
          setShowNewMessages(true)
        }
      }
    })
    return () => { unsub.then((fn) => fn()) }
  }, [
    addMessage,
    channel.id,
    getIsAtBottom,
    isViewingLatest,
    markChannelSeen,
    matrixMode,
  ])

  // Listen for reactions
  useEffect(() => {
    if (matrixMode) return
    const unsub = bridge.onReactionReceived((data) => {
      if (data.channelId === channel.id) {
        updateReaction(channel.id, data.messageId, data.emoji, data.author, data.verb)
      }
    })
    return () => { unsub.then((fn) => fn()) }
  }, [channel.id, matrixMode, updateReaction])

  // Listen for bans
  useEffect(() => {
    const unsub = bridge.onBanReceived((data) => {
      removeMessagesByAuthorAllChannels(data.bannedPublicKey)
    })
    return () => { unsub.then((fn) => fn()) }
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
      if (data.channelId === channel.id) {
        editMessage(channel.id, data.messageId, data.content, data.editedAt)
      }
    })
    const unsubDelete = bridge.onMessageDeleted?.((data: { messageId: string; channelId: string }) => {
      if (data.channelId === channel.id) {
        deleteMessage(channel.id, data.messageId)
      }
    })
    return () => {
      unsubEdit?.then((fn) => fn())
      unsubDelete?.then((fn) => fn())
    }
  }, [channel.id, deleteMessage, editMessage, matrixMode])

  // Listen for typing events
  const setTyping = useTypingStore((state) => state.setTyping)
  useEffect(() => {
    if (matrixMode) {
      if (!roomUpgradeReady || roomUpgrade) return
      let active = true
      const refreshTyping = async () => {
        try {
          const users = await bridge.matrixTypingUsers(channel.id)
          if (!active) return
          for (const user of users) {
            setTyping(channel.id, user.userId, user.displayName)
          }
        } catch (error) {
          console.error('Failed to refresh Matrix typing notifications:', error)
          throw error
        }
      }
      const unregisterPoll = registerPoll({
        key: `matrix-typing:${channel.id}`,
        intervalMs: 2_000,
        run: refreshTyping,
        pauseWhenHidden: true,
        backoffOnError: true,
      })
      return () => {
        active = false
        unregisterPoll()
      }
    }
    const unsub = bridge.onTypingUpdate((data) => {
      if (data.channelId === channel.id) {
        setTyping(channel.id, data.author, data.displayName)
      }
    })
    return () => { unsub.then((fn) => fn()) }
  }, [channel.id, matrixMode, roomUpgrade, roomUpgradeReady, setTyping])

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
  const handleJumpToReply = useCallback((target: MessageType) => {
    if (!scrollToItem(target.id, 'center')) return
    clearTimeout(highlightTimerRef.current)
    setHighlightedMessageId(target.id)
    setJumpAnnouncement(`Jumped to message from ${target.authorDisplayName}`)
    highlightTimerRef.current = setTimeout(() => {
      setHighlightedMessageId(null)
      setJumpAnnouncement('')
    }, 2_000)
  }, [scrollToItem])

  const handleNavigateToMessage = useCallback((message: MessageType) => {
    useMessageNavigationStore.getState().requestNavigation(message)
    setActiveChannel(message.channelId)
  }, [setActiveChannel])

  const handleScroll = useCallback(async (scrollElement: HTMLDivElement) => {
    const position = updateVirtualScroll()
    if (!position) return

    if (position.isAtBottom && showNewMessages && isViewingLatest) {
      setShowNewMessages(false)
      markChannelSeenFromScroll()
    }

    if (
      position.scrollTop < 100
      && hasMoreOlder
      && !isLoadingOlder
      && !olderLoadInFlightRef.current
    ) {
      olderLoadInFlightRef.current = true
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

      try {
        await loadOlderMessages(channel.id)
      } finally {
        olderLoadInFlightRef.current = false
      }
    }
  }, [
    channel.id,
    hasMoreOlder,
    isLoadingOlder,
    isViewingLatest,
    loadOlderMessages,
    markChannelSeenFromScroll,
    setScrollAnchor,
    showNewMessages,
    updateVirtualScroll,
  ])

  const handleSend = async (
    content: string,
    files: StagedFile[] = [],
    onAttachmentSent?: (file: StagedFile, contentConsumed: boolean) => void | Promise<void>,
  ) => {
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
            )
          : await bridge.sendMessage(
              channel.id,
              content,
              [],
              replyToId ?? undefined,
              clientRequestId,
            )
        acceptQueuedMessage({
          ...message,
          clientRequestId: message.clientRequestId ?? clientRequestId,
        })
      } catch (error) {
        console.error('Failed to queue Matrix message:', error)
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
      content: failedMessage.content,
      attachments: [],
      reactions: {},
      timestamp: new Date().toISOString(),
      signature: '',
      replyToId: failedMessage.replyToId,
      threadRootId: failedMessage.threadRootId,
      clientRequestId: retryId,
      deliveryStatus: 'pending',
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
          )
        : await bridge.sendMessage(
            channel.id,
            failedMessage.content,
            [],
            failedMessage.replyToId ?? undefined,
            retryId,
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
        message: 'The new room could not be opened yet. Try again in a moment.',
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
    <div className="flex h-full min-h-0 flex-1 flex-col overflow-hidden">
      <div
        className="mesh-conversation-header flex min-h-16 flex-shrink-0 items-center justify-between gap-4 border-b border-border-subtle px-4 py-2.5"
        data-tauri-drag-region
      >
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <span className="flex min-w-0 items-center gap-1.5">
              <Icon name="hash" size="sm" className="flex-shrink-0 text-muted" />
              <span className="truncate text-lg font-semibold tracking-tight text-primary">{channel.name}</span>
            </span>
          </div>
          <div className="mt-0.5 hidden truncate text-caption text-muted sm:block">
              {channel.name.toLocaleLowerCase() === 'general'
                ? `Anything and everything ${communityName ?? 'Mesh'}`
                : `Share work, swap feedback, and stay close in ${communityName ?? 'this community'}.`}
          </div>
          {matrixMode && trust && onOpenContext && (
            <div className="mt-1">
              <RoomTrustSummary trust={trust} onOpenContext={onOpenContext} />
            </div>
          )}
        </div>

        <div className="flex flex-shrink-0 items-center gap-1">
          <SearchBar label="Find" onNavigateToMessage={handleNavigateToMessage} />

          {matrixMode && onOpenContext && (
            <Tooltip content="Pinned messages" side="bottom">
              <button
                type="button"
                onClick={() => onOpenContext('pins')}
                aria-label="Show pinned messages"
                aria-pressed={Boolean(isContextOpen && activeContextTab === 'pins')}
                className={`flex h-8 items-center gap-1.5 rounded-control px-2 text-xs font-medium transition-colors ${
                  isContextOpen && activeContextTab === 'pins'
                    ? 'bg-surface-selected text-primary'
                    : 'text-muted hover:bg-surface-hover hover:text-secondary'
                }`}
              >
                <Icon name="pin" size="sm" />
                <span className="hidden xl:inline">Pins</span>
              </button>
            </Tooltip>
          )}

          {showContextToggle && (
            <Tooltip content={isContextOpen ? 'Hide room context' : 'Show room context'} side="bottom">
              <button
                id="mesh-room-context-toggle"
                onClick={() => {
                  if (isContextOpen && activeContextTab === 'people') onToggleContext?.()
                  else onOpenContext?.('people')
                }}
                aria-label={
                  isContextOpen && activeContextTab === 'people'
                    ? 'Hide room context'
                    : 'Show room context'
                }
                aria-controls="mesh-room-context-panel"
                aria-expanded={isContextOpen}
                className={`flex h-8 items-center justify-center gap-1.5 rounded-control px-2 text-xs font-medium transition-colors ${
                  isContextOpen && activeContextTab === 'people'
                    ? 'bg-surface-selected text-primary'
                    : 'text-muted hover:bg-surface-hover hover:text-secondary'
                }`}
              >
                <Icon name="users" size="sm" />
                <span className="hidden xl:inline">People</span>
              </button>
            </Tooltip>
          )}

          {studioVoiceRoom && (
            <button
              type="button"
              onClick={() => setActiveChannel(studioVoiceRoom.id)}
              className="ml-1 hidden min-h-9 items-center gap-2 rounded-control bg-accent px-3 text-xs font-semibold text-content-on-accent transition-colors hover:bg-accent-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent md:flex"
              aria-label={`Open voice room ${studioVoiceRoom.name}`}
            >
              <Icon name="volume" size="sm" />
              Open {studioVoiceRoom.name}
            </button>
          )}
        </div>
      </div>

      {pinnedMessage && onOpenContext && (
        <button
          type="button"
          onClick={() => onOpenContext('pins')}
          className="mx-4 mt-3 flex min-h-12 flex-shrink-0 items-center gap-3 rounded-control border border-border-subtle bg-surface-sunken px-3 py-2 text-left transition-colors hover:border-border-emphasis hover:bg-surface-hover"
          aria-label={`Open pinned message from ${pinnedMessage.authorDisplayName}`}
        >
          <Icon name="pin" size="sm" className="flex-shrink-0 text-accent" />
          <span className="min-w-0 flex-1">
            <span className="block text-caption font-medium text-muted">
              Pinned by {pinnedMessage.authorDisplayName}
            </span>
            <span className="block truncate text-sm text-secondary">
              {pinnedMessage.content || 'Pinned attachment'}
            </span>
          </span>
          <span className="hidden text-caption font-semibold text-accent sm:block">View pins</span>
        </button>
      )}

      {matrixMode && trust && !trust.loadingAccountTrust && trust.devicesNeedReview > 0 && (
        <button
          type="button"
          aria-live="polite"
          aria-label={`${trust.devicesNeedReview} ${trust.devicesNeedReview === 1 ? 'device needs' : 'devices need'} review. Open the room ledger.`}
          className="flex min-h-control-md flex-shrink-0 items-center gap-2 border-b border-status-warning/20 bg-status-warning/10 px-4 text-left text-xs text-status-warning transition-colors hover:bg-status-warning/20"
          onClick={() => onOpenContext?.('ledger')}
        >
          <Icon name="triangleAlert" size="sm" />
          <span className="min-w-0 flex-1">
            {trust.devicesNeedReview} {trust.devicesNeedReview === 1 ? 'device needs' : 'devices need'} review before you rely on this room’s trust status.
          </span>
          <span className="font-semibold">Review</span>
        </button>
      )}

      {activeRoomUpgradeError && !roomUpgrade && (
        <div
          role="alert"
          className="flex flex-wrap items-center justify-between gap-2 border-b border-status-warning/20 bg-status-warning/10 px-4 py-2 text-xs text-secondary"
        >
          <span>{activeRoomUpgradeError}</span>
          <button
            type="button"
            className="min-h-8 rounded-control px-2 font-semibold text-text-link hover:bg-surface-hover"
            onClick={() => setRoomUpgradeAttempt((attempt) => attempt + 1)}
          >
            Retry room status
          </button>
        </div>
      )}

      {activeMarkReadError && (
        <div
          role="alert"
          className="flex flex-wrap items-center justify-between gap-2 border-b border-status-warning/20 bg-status-warning/10 px-4 py-2 text-xs text-secondary"
        >
          <span>This room could not be marked as read.</span>
          <button
            type="button"
            className="min-h-8 rounded-control px-2 font-semibold text-text-link hover:bg-surface-hover"
            onClick={() => void markChannelSeen().catch(() => {})}
          >
            Retry read status
          </button>
        </div>
      )}

      <div className="relative min-h-0 flex-1">
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
        <div
          ref={scrollContainerRef}
          onScroll={(event) => void handleScroll(event.currentTarget)}
          className="absolute inset-0 overflow-y-auto"
          role="log"
          /*
            `role="log"` implies aria-live="polite", which is wrong here: this
            container's children are inserted and removed by *virtualization*,
            not by message arrival, so scrolling through history announced every
            old message as if it were new. Overriding to "off" keeps the log
            structure for navigation while moving announcements to the dedicated
            region above, which is driven by the timeline tail.
          */
          aria-live="off"
          aria-label={`Messages in #${channel.name}`}
        >
          {roomUpgrade ? (
            <RoomUpgradeSignpost
              roomName={channel.name}
              reason={roomUpgrade.reason}
              error={activeRoomUpgradeError}
              isFollowing={isFollowingRoomUpgrade}
              onFollow={() => void handleFollowRoomUpgrade()}
            />
          ) : activeLoadError != null && visibleMessages.length === 0 ? (
            <div className="flex h-full items-center justify-center px-4">
              <div
                role="alert"
                className="max-w-sm rounded-panel border border-status-warning/30 bg-status-warning/10 p-4 text-center text-sm text-secondary"
              >
                <p>Messages could not be loaded. This room has not been marked as read.</p>
                <button
                  type="button"
                  className="mt-3 min-h-8 rounded-control px-3 font-semibold text-text-link hover:bg-surface-hover"
                  onClick={() => void loadLatestMessages().catch(() => {})}
                >
                  Retry messages
                </button>
              </div>
            </div>
          ) : !roomUpgradeReady || awaitingFirstLoad || (isLoading && visibleMessages.length === 0) ? (
            <div className="space-y-1 pt-4">
              {Array.from({ length: 8 }).map((_, i) => (
                <MessageSkeleton key={i} />
              ))}
            </div>
          ) : visibleMessages.length === 0 ? (
            <div className="flex h-full items-center justify-center">
              <EmptyState
                icon={<Icon name="hash" size="lg" />}
                title={`Welcome to #${channel.name}`}
                description={`This is the start of the #${channel.name} channel.`}
              />
            </div>
          ) : (
            <div className="relative">
              <div
                className="relative"
                data-design-token-exception="data-driven-virtual-spacer-geometry"
                style={{
                  paddingTop: `${topSpacerHeight}px`,
                  paddingBottom: `${bottomSpacerHeight}px`,
                }}
              >
                {isLoadingOlder && (
                  <div
                    className="pointer-events-none absolute inset-x-0 top-2 z-sticky flex justify-center"
                    role="status"
                    aria-label="Loading earlier messages"
                  >
                    <Spinner size={20} />
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
                    return <UnreadDivider key={item.key} />
                  }

                  const messageIndex = messageIndexById.get(item.key) ?? -1
                  const message = visibleMessages[messageIndex]
                  if (!message) return null
                  const threadReplies = repliesByRoot.get(message.id) ?? EMPTY_MESSAGES
                  const replyPreview = message.replyToId
                    ? visibleMessages[messageIndexById.get(message.replyToId) ?? -1] ?? null
                    : null

                  return (
                    <VirtualMessageRow
                      key={item.key}
                      rowKey={item.key}
                      position={messageIndex + 1}
                      setSize={visibleMessages.length}
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
                      onThreadReply={beginThreadReply}
                      onRetry={handleRetry}
                      onCancel={handleCancelQueued}
                      replyPreview={replyPreview}
                      onJumpToReply={handleJumpToReply}
                      limitedActions={false}
                      trust={trust}
                      isHighlighted={highlightedMessageId === message.id}
                      editRequestToken={
                        editRequest?.messageId === message.id ? editRequest.token : 0
                      }
                    />
                  )
                })}
              </div>
            </div>
          )}
        </div>

        {activeLoadError != null && visibleMessages.length > 0 && (
          <div
            role="alert"
            className="absolute inset-x-4 bottom-3 z-sticky flex flex-wrap items-center justify-between gap-2 rounded-control border border-status-warning/30 bg-surface-overlay px-3 py-2 text-xs text-secondary shadow-overlay"
          >
            <span>Could not refresh messages. Showing the last update.</span>
            <button
              type="button"
              className="min-h-8 rounded-control px-2 font-semibold text-text-link hover:bg-surface-hover"
              onClick={() => void loadLatestMessages().catch(() => {})}
            >
              Retry
            </button>
          </div>
        )}

        {/* New messages banner */}
        {showNewMessages && (
          <button
            onClick={() => void jumpToLatest()}
            className="absolute left-0 right-0 top-0 z-sticky flex items-center justify-center bg-status-info px-4 py-1.5 text-sm font-medium text-content-on-status transition-colors hover:bg-status-info/90"
          >
            {hiddenNewerCount > 0 || isBrowsingOlder ? 'Jump to latest messages' : 'New messages ↓'}
          </button>
        )}
      </div>

      {/* Reply bar */}
      {!roomUpgradeReady || roomUpgrade ? null : replyingTo && (
        <div className="flex items-center gap-2 border-t border-border-subtle bg-surface-sunken px-4 py-2">
          <Icon name="reply" size="sm" className="shrink-0 text-secondary" />
          <span className="text-sm text-secondary">
            Replying to <span className="font-medium text-primary">{replyingTo.authorDisplayName}</span>
          </span>
          <span className="truncate text-sm text-muted flex-1">{replyingTo.content.slice(0, 100)}</span>
          <button
            onClick={() => {
              setReplyingTo(null)
              setThreadReplyRoot(null)
            }}
            aria-label="Cancel reply"
            className="shrink-0 rounded p-1 text-muted transition-colors hover:text-primary"
          >
            <Icon name="x" size="sm" />
          </button>
        </div>
      )}

      {!roomUpgradeReady || roomUpgrade ? null : (
        <>
          {sendingProtectionUnavailable && (
            <div
              role="status"
              className="border-t border-status-warning/30 bg-status-warning/10 px-4 py-2 text-xs text-secondary"
            >
              {trust?.protection === 'checking'
                ? "Checking this room's protection before sending."
                : trust?.protection === 'unencrypted'
                  ? 'Sending is unavailable because this room is not protected end to end.'
                  : "Sending is unavailable until this room's protection can be verified."}
            </div>
          )}
          <TypingIndicator channelId={channel.id} />
          <MessageInput
            channelId={channel.id}
            channelName={channel.name}
            onSend={handleSend}
            communityId={channel.communityId}
            members={communityMembers}
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
        </>
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
      <div className="w-full max-w-md rounded-panel border border-border-subtle bg-surface-raised p-6 text-center shadow-overlay">
        <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-surface-selected text-accent">
          <Icon name="refresh" size="lg" />
        </div>
        <h2 className="text-base font-semibold text-primary">This room has moved</h2>
        <p className="mt-2 text-sm leading-6 text-muted">
          <span className="font-medium text-secondary">#{roomName}</span> was replaced by a new room.
          Mesh will keep this room here and will not move you automatically.
        </p>
        {reason && <p className="mt-2 text-xs text-muted">{reason}</p>}
        <button
          type="button"
          className="mt-5 inline-flex min-h-control-md items-center justify-center rounded-control bg-accent px-4 text-sm font-semibold text-content-on-accent transition-colors hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-60"
          onClick={onFollow}
          disabled={isFollowing}
        >
          {isFollowing ? 'Opening new room...' : 'Go to new room'}
        </button>
        {error && (
          <p className="mt-3 text-sm text-status-danger" role="alert">{error}</p>
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
  onThreadReply: (root: MessageType, target?: MessageType) => void
  onRetry?: (message: MessageType) => void
  onCancel?: (message: MessageType) => void
  replyPreview?: MessageType | null
  onJumpToReply?: (message: MessageType) => void
  limitedActions?: boolean
  trust?: RoomTrustSnapshot
  isHighlighted: boolean
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
  onThreadReply,
  onRetry,
  onCancel,
  replyPreview,
  onJumpToReply,
  limitedActions,
  trust,
  isHighlighted,
  editRequestToken,
}: VirtualMessageRowProps) {
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
  }, [hasGap, isGrouped, message, onHeightChange, rowKey, threadOpen, threadReplies])

  useLayoutEffect(() => {
    if (isHighlighted) {
      rowRef.current?.focus({ preventScroll: true })
    }
  }, [isHighlighted])

  return (
    <div
      ref={rowRef}
      data-message-id={message.id}
      data-jump-highlighted={isHighlighted ? 'true' : undefined}
      role="article"
      aria-posinset={position}
      aria-setsize={setSize}
      aria-current={isHighlighted ? 'true' : undefined}
      tabIndex={isHighlighted ? -1 : undefined}
      className={
        isHighlighted
          ? 'animate-[pulse_2s_ease-in-out_1] rounded-panel bg-accent/10 ring-2 ring-inset ring-accent'
          : undefined
      }
    >
      <ErrorBoundary
        scope="feature"
        fallback={(resetError) => (
          <div
            className="mx-4 my-1 flex min-w-0 items-center justify-between gap-3 rounded-panel border border-border-subtle bg-surface-sunken px-4 py-3"
            role="alert"
          >
            <p className="text-xs text-muted">This message couldn't be displayed.</p>
            <button
              type="button"
              onClick={resetError}
              className="min-h-8 shrink-0 rounded-control px-2 text-xs font-medium text-text-link transition-colors hover:bg-surface-hover hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
            >
              Try again
            </button>
          </div>
        )}
      >
        <MessageComponent
          message={message}
          isGrouped={isGrouped}
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
        {threadOpen && threadReplies.length > 0 && (
          <div className="ml-10 mr-4 border-l border-border-subtle pl-3" aria-label="Thread replies">
            {threadReplies.map((reply) => (
              <MessageComponent
                key={reply.id}
                message={reply}
                isGrouped={false}
                disableMotion
                onReply={() => onThreadReply(message, reply)}
                limitedActions={limitedActions}
                trust={trust}
              />
            ))}
            <button
              type="button"
              onClick={() => onThreadReply(message)}
              className="mb-2 mt-1 min-h-8 rounded-control px-2 text-xs font-medium text-text-link transition-colors hover:bg-surface-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
            >
              Reply in thread
            </button>
          </div>
        )}
      </ErrorBoundary>
    </div>
  )
})

function HistoryStartRow() {
  return (
    <div
      className="flex h-10 items-center justify-center gap-2 px-4 text-caption text-content-muted"
      role="status"
    >
      <span className="h-px min-w-6 flex-1 bg-border-subtle" aria-hidden="true" />
      <span>Beginning of this conversation</span>
      <span className="h-px min-w-6 flex-1 bg-border-subtle" aria-hidden="true" />
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
      <div className="flex items-center justify-between rounded-panel border border-border-subtle bg-surface-sunken px-4 py-2">
        <div>
          <p className="text-sm font-medium text-primary">
            {hiddenCount} newer message{hiddenCount === 1 ? '' : 's'} hidden
          </p>
        </div>
        <button
          onClick={onJumpToLatest}
          className="rounded bg-status-info px-3 py-1 text-sm font-medium text-content-on-status transition-colors hover:bg-status-info/80"
        >
          Jump to latest
        </button>
      </div>
    </div>
  )
}
