import { memo, useState, useRef, useEffect, useCallback, useLayoutEffect, useMemo } from 'react'
import type { Channel, Message as MessageType } from '../../types/ipc'
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
import { federatedTimestampMilliseconds } from '../../lib/federated-time'
import { getBackoffDelay, registerPoll, waitForDelay } from '../../lib/scheduler'
import { useMessageNavigationStore } from '../../store/message-navigation'
import { ErrorBoundary } from '../ui/ErrorBoundary'
import { Icon } from '../ui/Icon'
import { ConversationProtection } from './ConversationProtection'
import { useCommunityMembers } from '../../store/membership'

interface ChatViewProps {
  channel: Channel
  showMembersToggle?: boolean
  isMembersOpen?: boolean
  onToggleMembers?: () => void
}

const EMPTY_MESSAGES: MessageType[] = []

export function ChatView({ channel, showMembersToggle, isMembersOpen, onToggleMembers }: ChatViewProps) {
  const channelMessages = useMessageStore((state) => state.messages[channel.id] ?? EMPTY_MESSAGES)
  const replaceMessages = useMessageStore((state) => state.replaceMessages)
  const prependMessages = useMessageStore((state) => state.prependMessages)
  const addMessage = useMessageStore((state) => state.addMessage)
  const updateReaction = useMessageStore((state) => state.updateReaction)
  const editMessage = useMessageStore((state) => state.editMessage)
  const deleteMessage = useMessageStore((state) => state.deleteMessage)
  const removeMessage = useMessageStore((state) => state.removeMessage)
  const removeMessagesByAuthorAllChannels = useMessageStore((state) => state.removeMessagesByAuthorAllChannels)
  const setDeliveryStatus = useMessageStore((state) => state.setDeliveryStatus)
  const loadOlderMessages = useMessageStore((state) => state.loadOlderMessages)
  const isLoadingOlder = useMessageStore((state) => state.loadingOlder[channel.id] ?? false)
  const isBrowsingOlder = useMessageStore((state) => state.browsingOlder[channel.id] ?? false)
  const hiddenNewerCount = useMessageStore((state) => state.newerGapCount[channel.id] ?? 0)
  const matrixMode = bridge.isMatrixBackend()
  const communityMembers = useCommunityMembers(channel.communityId)
  const patchChannel = useChannelStore((state) => state.patchChannel)
  const setActiveChannel = useChannelStore((state) => state.setActiveChannel)
  const navigationRequest = useMessageNavigationStore((state) => (
    state.pending?.message.channelId === channel.id ? state.pending : null
  ))
  const isViewingLatest = !isBrowsingOlder && hiddenNewerCount === 0
  const hydratingLatestRef = useRef(false)
  const bufferedMessagesRef = useRef<MessageType[]>([])
  const loadGenerationRef = useRef(0)
  const windowLoadRef = useRef<Promise<void>>(Promise.resolve())
  const highlightTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined)
  const [isLoading, setIsLoading] = useState(false)
  const [showNewMessages, setShowNewMessages] = useState(false)
  const [replyingTo, setReplyingTo] = useState<MessageType | null>(null)
  const [preparedNavigationId, setPreparedNavigationId] = useState<number | null>(null)
  const [highlightedMessageId, setHighlightedMessageId] = useState<string | null>(null)
  const [jumpAnnouncement, setJumpAnnouncement] = useState('')
  const [editRequest, setEditRequest] = useState<{ messageId: string; token: number } | null>(null)
  const legacyPublicKey = useIdentityStore((state) => state.identity?.publicKey)
  const ownAuthorId = matrixMode
    ? bridge.getMatrixUserId() ?? undefined
    : legacyPublicKey

  // Build the virtual item list
  const virtualItems = useMemo<VirtualItem[]>(() => {
    const items: VirtualItem[] = channelMessages.map((message) => ({
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
        + (Array.isArray(message.attachments) && message.attachments.length > 0 ? 96 : 0),
    }))
    if (hiddenNewerCount > 0) {
      items.push({
        key: `history-gap:${channel.id}`,
        type: 'gap' as const,
        height: 88,
      })
    }
    return items
  }, [channel.id, channelMessages, hiddenNewerCount])

  const vs = useVirtualScroll(virtualItems)
  const visibleItems = virtualItems.length === 0
    ? []
    : virtualItems.slice(vs.visibleRange.start, vs.visibleRange.end + 1)

  // Keep a stable ref to the latest vs so effects/callbacks don't depend on the
  // vs object (whose identity changes on every render due to computed values).
  const vsRef = useRef(vs)
  vsRef.current = vs

  const markChannelSeen = useCallback(async () => {
    await bridge.markChannelRead(channel.id)
    patchChannel(channel.id, { unreadCount: 0 })
  }, [channel.id, patchChannel])

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

      replaceMessages(channel.id, latest)
      if (!matrixMode) {
        await bridge.requestMessageHistory(channel.id, { limit: 100 })
        if (generation !== loadGenerationRef.current) return
      }
      setShowNewMessages(false)

      requestAnimationFrame(() => {
        if (generation !== loadGenerationRef.current) return
        vsRef.current.scrollToBottom()
      })
    } finally {
      if (generation === loadGenerationRef.current) {
        hydratingLatestRef.current = false
        flushBufferedMessages()
      }
    }

    if (generation === loadGenerationRef.current) {
      await markChannelSeen()
    }
  }, [channel.id, flushBufferedMessages, markChannelSeen, matrixMode, replaceMessages])

  // Load messages on channel switch
  useEffect(() => {
    const loadMessages = async () => {
      setIsLoading(true)
      const pendingLoad = resetToLatestWindow()
      windowLoadRef.current = pendingLoad
      const generation = loadGenerationRef.current
      try {
        await pendingLoad
      } catch (err) {
        console.error('Failed to load messages:', err)
      } finally {
        if (generation === loadGenerationRef.current) {
          setIsLoading(false)
        }
      }
    }
    void loadMessages()
    return () => {
      loadGenerationRef.current += 1
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channel.id])

  // Search can target another channel or a message outside the bounded hot
  // window. Wait for the channel-switch load first, then merge older context
  // around the search result so the latest load cannot evict the target.
  useEffect(() => {
    if (!navigationRequest) {
      setPreparedNavigationId(null)
      return
    }

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
    if (!vsRef.current.scrollToItem(target.id, 'center')) return

    clearTimeout(highlightTimerRef.current)
    setHighlightedMessageId(target.id)
    setJumpAnnouncement(`Jumped to message from ${target.authorDisplayName}`)
    highlightTimerRef.current = setTimeout(() => {
      setHighlightedMessageId(null)
      setJumpAnnouncement('')
    }, 2_000)
    useMessageNavigationStore.getState().completeNavigation(navigationRequest.requestId)
  }, [navigationRequest, preparedNavigationId, virtualItems])

  useEffect(
    () => () => {
      clearTimeout(highlightTimerRef.current)
    },
    [],
  )

  // Matrix sync runs in Rust. Wait on the SDK room update stream, then refresh
  // the DTO projection so federated state appears without fixed-interval polling.
  useEffect(() => {
    if (!matrixMode || !isViewingLatest) return

    let active = true
    const refresh = async () => {
      if (hydratingLatestRef.current) return
      try {
        const existing = useMessageStore.getState().messages[channel.id] ?? []
        const existingIds = new Set(existing.map((message) => message.id))
        const latest = await bridge.getMessages(channel.id, 50)
        if (!active) return

        const hasNewMessage = latest.some((message) => !existingIds.has(message.id))
        replaceMessages(channel.id, latest)
        if (hasNewMessage) {
          if (vsRef.current.isAtBottom) {
            requestAnimationFrame(() => vsRef.current.scrollToBottom())
          } else {
            setShowNewMessages(true)
          }
        }
      } catch (error) {
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
  }, [channel.id, isViewingLatest, matrixMode, replaceMessages])

  // Reset scroll state on channel switch
  useEffect(() => {
    setShowNewMessages(false)
    vsRef.current.resetLayout()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channel.id])

  // Request history from new peers
  useEffect(() => {
    if (matrixMode) return
    const unsub = bridge.onPeerJoined(({ peerId }) => {
      bridge.requestMessageHistory(channel.id, { peerId, limit: 100 }).catch((err) => {
        console.error('Failed to request message history:', err)
      })
    })
    return () => { unsub.then((fn) => fn()) }
  }, [channel.id, matrixMode])

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

        if (isViewingLatest && vs.isAtBottom) {
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
  }, [addMessage, channel.id, isViewingLatest, markChannelSeen, matrixMode, vs.isAtBottom])

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
  }, [channel.id, matrixMode, setTyping])

  const isGrouped = (msg: MessageType, prevMsg?: MessageType) => {
    if (!prevMsg) return false
    if (msg.authorPublicKey !== prevMsg.authorPublicKey) return false
    const timestamp = federatedTimestampMilliseconds(msg.timestamp)
    const previousTimestamp = federatedTimestampMilliseconds(prevMsg.timestamp)
    if (timestamp === null || previousTimestamp === null) return false
    const timeDiff = timestamp - previousTimestamp
    return timeDiff < 5 * 60 * 1000
  }

  const jumpToLatest = useCallback(async () => {
    if (hiddenNewerCount > 0 || isBrowsingOlder) {
      try {
        await resetToLatestWindow()
      } catch (err) {
        console.error('Failed to jump to latest:', err)
      }
      return
    }

    vsRef.current.scrollToBottom()
    setShowNewMessages(false)
    markChannelSeen().catch((err) => {
      console.error('Failed to mark channel as read:', err)
    })
  }, [hiddenNewerCount, isBrowsingOlder, markChannelSeen, resetToLatestWindow])

  const handleNavigateToMessage = useCallback((message: MessageType) => {
    useMessageNavigationStore.getState().requestNavigation(message)
    setActiveChannel(message.channelId)
  }, [setActiveChannel])

  const handleScroll = useCallback(async () => {
    vsRef.current.handleScroll()

    const el = vsRef.current.scrollRef.current
    if (!el) return

    if (vsRef.current.isAtBottom && showNewMessages && isViewingLatest) {
      setShowNewMessages(false)
      markChannelSeen().catch((err) => {
        console.error('Failed to mark channel as read:', err)
      })
    }

    if (el.scrollTop < 100 && !isLoadingOlder) {
      const anchorItem = visibleItems.find((item) => item.type === 'message')
      if (anchorItem) {
        const anchorIndex = virtualItems.findIndex((item) => item.key === anchorItem.key)
        vsRef.current.setScrollAnchor({
          messageId: anchorItem.key,
          offset: Math.max(0, el.scrollTop - (anchorIndex >= 0 ? vsRef.current.topSpacerHeight : 0)),
        })
      }

      await loadOlderMessages(channel.id)
    }
  }, [
    channel.id,
    isLoadingOlder,
    isViewingLatest,
    loadOlderMessages,
    markChannelSeen,
    showNewMessages,
    virtualItems,
    visibleItems,
  ])

  const handleSend = async (
    content: string,
    files: StagedFile[] = [],
    onAttachmentSent?: (file: StagedFile, contentConsumed: boolean) => void | Promise<void>,
  ) => {
    if (matrixMode && files.length > 0) {
      const replyToId = replyingTo?.id
      for (const [index, file] of files.entries()) {
        const msg = await bridge.matrixSendAttachment(
          channel.id,
          file.grant,
          file.transferId ?? bridge.createMatrixTransferId(),
          index === 0 ? content : '',
          index === 0 ? replyToId : undefined,
        )
        addMessage(channel.id, { ...msg, deliveryStatus: 'sent' })
        if (index === 0) setReplyingTo(null)
        await onAttachmentSent?.(file, index === 0 && content.length > 0)
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
      const msg = await bridge.sendMessage(channel.id, content, [], replyingTo?.id ?? undefined)
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
    removeMessage(channel.id, failedMessage.id)

    const identity = resolveSenderIdentity(
      useIdentityStore.getState().identity,
      matrixMode ? bridge.getMatrixUserId() : null,
    )
    const retryId = `pending-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

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
      deliveryStatus: 'pending',
    }

    addMessage(channel.id, optimistic)

    try {
      const msg = await bridge.sendMessage(
        channel.id,
        failedMessage.content,
        [],
        failedMessage.replyToId ?? undefined,
      )
      removeMessage(channel.id, retryId)
      if (hydratingLatestRef.current) {
        bufferedMessagesRef.current.push({ ...msg, deliveryStatus: 'sent' })
      } else {
        addMessage(channel.id, { ...msg, deliveryStatus: 'sent' })
      }
    } catch (err) {
      console.error('Failed to retry message:', err)
      setDeliveryStatus(channel.id, retryId, 'failed')
    }
  }, [addMessage, channel.id, removeMessage, setDeliveryStatus])

  return (
    <div className="flex h-full flex-1 flex-col">
      {/* Channel header */}
      <div
        className="flex h-12 flex-shrink-0 items-center justify-between border-b border-border-subtle px-4 shadow-elevation-low"
        data-tauri-drag-region
      >
        <div className="flex min-w-0 items-center gap-2">
          <Icon name="hash" className="flex-shrink-0 text-muted" />
          <span className="truncate text-sm font-semibold text-primary">{channel.name}</span>
          {matrixMode && <ConversationProtection roomId={channel.id} />}
        </div>

        <div className="flex items-center gap-1">
          <SearchBar onNavigateToMessage={handleNavigateToMessage} />

          {showMembersToggle && (
            <Tooltip content={isMembersOpen ? 'Hide Member List' : 'Show Member List'} side="bottom">
              <button
                onClick={onToggleMembers}
                aria-label={isMembersOpen ? 'Hide member list' : 'Show member list'}
                className={`flex h-6 w-6 items-center justify-center rounded transition-colors ${
                  isMembersOpen
                    ? 'text-primary'
                    : 'text-muted hover:text-secondary'
                }`}
              >
                <Icon name="users" />
              </button>
            </Tooltip>
          )}
        </div>
      </div>

      {/* Message area */}
      <div className="relative flex-1">
        <p className="sr-only" role="status" aria-live="polite">
          {jumpAnnouncement}
        </p>
        <div
          ref={vs.scrollRef}
          onScroll={() => void handleScroll()}
          className="flex-1 overflow-y-auto"
          role="log"
          aria-live="polite"
          aria-label={`Messages in #${channel.name}`}
        >
          {isLoading ? (
            <div className="space-y-1 pt-4">
              {Array.from({ length: 8 }).map((_, i) => (
                <MessageSkeleton key={i} />
              ))}
            </div>
          ) : channelMessages.length === 0 ? (
            <div className="flex h-full items-center justify-center">
              <div className="text-center px-4">
                <div className="mx-auto mb-4 flex h-empty-icon w-empty-icon items-center justify-center rounded-full bg-bg-modifier-hover">
                  <Icon name="hash" size="lg" className="text-muted" />
                </div>
                <h3 className="mb-1 text-lg font-semibold text-primary">Welcome to #{channel.name}!</h3>
                <p className="text-sm text-muted">This is the start of the #{channel.name} channel.</p>
              </div>
            </div>
          ) : (
            <div className="relative">
              {isLoadingOlder && (
                <div className="flex justify-center py-4">
                  <Spinner size={20} />
                </div>
              )}
              <div
                data-design-token-exception="data-driven-virtual-spacer-geometry"
                style={{
                  paddingTop: `${vs.topSpacerHeight}px`,
                  paddingBottom: `${vs.bottomSpacerHeight}px`,
                }}
              >
                {visibleItems.map((item, index) => {
                  const nextItem = visibleItems[index + 1]

                  if (item.type === 'gap') {
                    return (
                      <HistoryGapRow
                        key={item.key}
                        rowKey={item.key}
                        hiddenCount={hiddenNewerCount}
                        onHeightChange={vs.handleMeasuredHeight}
                        onJumpToLatest={() => void jumpToLatest()}
                      />
                    )
                  }

                  const messageIndex = channelMessages.findIndex((m) => m.id === item.key)
                  const message = channelMessages[messageIndex]
                  if (!message) return null

                  return (
                    <VirtualMessageRow
                      key={item.key}
                      rowKey={item.key}
                      message={message}
                      isGrouped={isGrouped(message, channelMessages[messageIndex - 1])}
                      hasGap={nextItem?.type !== 'gap'}
                      onHeightChange={vs.handleMeasuredHeight}
                      onReply={setReplyingTo}
                      onRetry={handleRetry}
                      limitedActions={false}
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
      {replyingTo && (
        <div className="flex items-center gap-2 bg-bg-secondary px-4 py-2">
          <Icon name="reply" size="sm" className="shrink-0 text-secondary" />
          <span className="text-sm text-secondary">
            Replying to <span className="font-medium text-primary">{replyingTo.authorDisplayName}</span>
          </span>
          <span className="truncate text-sm text-muted flex-1">{replyingTo.content.slice(0, 100)}</span>
          <button
            onClick={() => setReplyingTo(null)}
            aria-label="Cancel reply"
            className="shrink-0 rounded p-1 text-muted transition-colors hover:text-primary"
          >
            <Icon name="x" size="sm" />
          </button>
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
        onEditLastMessage={() => {
          const ownMessage = [...channelMessages]
            .reverse()
            .find((message) => message.authorPublicKey === ownAuthorId && !message.deletedAt)
          if (!ownMessage) return
          setEditRequest((current) => ({
            messageId: ownMessage.id,
            token: (current?.token ?? 0) + 1,
          }))
        }}
      />
    </div>
  )
}

interface VirtualMessageRowProps {
  rowKey: string
  message: MessageType
  isGrouped: boolean
  hasGap: boolean
  onHeightChange: (rowKey: string, height: number) => void
  onReply: (message: MessageType) => void
  onRetry?: (message: MessageType) => void
  limitedActions?: boolean
  isHighlighted: boolean
  editRequestToken: number
}

const VirtualMessageRow = memo(function VirtualMessageRow({
  rowKey,
  message,
  isGrouped,
  hasGap,
  onHeightChange,
  onReply,
  onRetry,
  limitedActions,
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
  }, [hasGap, isGrouped, message, onHeightChange, rowKey])

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
      aria-current={isHighlighted ? 'true' : undefined}
      tabIndex={isHighlighted ? -1 : undefined}
      className={
        isHighlighted
          ? 'animate-[pulse_2s_ease-in-out_1] rounded-md bg-blue/10 ring-2 ring-inset ring-blue'
          : undefined
      }
    >
      <ErrorBoundary
        scope="feature"
        fallback={(resetError) => (
          <div
            className="mx-4 my-1 flex min-w-0 items-center justify-between gap-3 rounded bg-bg-secondary px-4 py-3"
            role="alert"
          >
            <p className="text-xs text-muted">This message couldn't be displayed.</p>
            <button
              type="button"
              onClick={resetError}
              className="shrink-0 text-xs font-medium text-text-link transition-colors hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue"
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
          onReply={onReply}
          onRetry={onRetry}
          limitedActions={limitedActions}
          editRequestToken={editRequestToken}
        />
      </ErrorBoundary>
    </div>
  )
})

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
      <div className="flex items-center justify-between rounded bg-bg-modifier-hover px-4 py-2">
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
