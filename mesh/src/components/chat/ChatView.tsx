import { useState, useRef, useEffect, useCallback, useLayoutEffect } from 'react'
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

interface ChatViewProps {
  channel: Channel
  showMembersToggle?: boolean
  isMembersOpen?: boolean
  onToggleMembers?: () => void
}

export function ChatView({ channel, showMembersToggle, isMembersOpen, onToggleMembers }: ChatViewProps) {
  const {
    messages,
    replaceMessages,
    addMessage,
    updateReaction,
    editMessage,
    deleteMessage,
    removeMessage,
    removeMessagesByAuthorAllChannels,
    setDeliveryStatus,
    loadOlderMessages,
    loadingOlder,
    browsingOlder,
    newerGapCount,
  } = useMessageStore()
  const matrixMode = bridge.isMatrixBackend()
  const patchChannel = useChannelStore((state) => state.patchChannel)
  const channelMessages = messages[channel.id] ?? []
  const isBrowsingOlder = browsingOlder[channel.id] ?? false
  const hiddenNewerCount = newerGapCount[channel.id] ?? 0
  const isViewingLatest = !isBrowsingOlder && hiddenNewerCount === 0
  const hydratingLatestRef = useRef(false)
  const bufferedMessagesRef = useRef<MessageType[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [showNewMessages, setShowNewMessages] = useState(false)
  const [replyingTo, setReplyingTo] = useState<MessageType | null>(null)
  const isLoadingOlder = loadingOlder[channel.id] ?? false

  // Build the virtual item list
  const virtualItems: VirtualItem[] = channelMessages.map((message) => ({
    key: message.id,
    type: 'message' as const,
  }))

  if (hiddenNewerCount > 0) {
    virtualItems.push({
      key: `history-gap:${channel.id}`,
      type: 'gap' as const,
    })
  }

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
    hydratingLatestRef.current = true
    bufferedMessagesRef.current = []

    try {
      const latest = await bridge.getMessages(channel.id, 50)
      replaceMessages(channel.id, latest)
      if (!matrixMode) {
        await bridge.requestMessageHistory(channel.id, { limit: 100 })
      }
      setShowNewMessages(false)

      requestAnimationFrame(() => {
        vsRef.current.scrollToBottom()
      })
    } finally {
      hydratingLatestRef.current = false
      flushBufferedMessages()
    }

    await markChannelSeen()
  }, [channel.id, flushBufferedMessages, markChannelSeen, matrixMode, replaceMessages])

  // Load messages on channel switch
  useEffect(() => {
    const loadMessages = async () => {
      setIsLoading(true)
      try {
        await resetToLatestWindow()
      } catch (err) {
        console.error('Failed to load messages:', err)
      }
      setIsLoading(false)
    }
    loadMessages()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channel.id])

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

    const watchUpdates = async () => {
      while (active) {
        try {
          await bridge.matrixWaitForRoomUpdate(channel.id)
          if (active) await refresh()
        } catch (error) {
          if (!active) return
          console.error('Matrix room update subscription failed:', error)
          await new Promise((resolve) => window.setTimeout(resolve, 1000))
        }
      }
    }
    void watchUpdates()
    return () => {
      active = false
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
        }
      }
      void refreshTyping()
      const interval = window.setInterval(() => void refreshTyping(), 2000)
      return () => {
        active = false
        window.clearInterval(interval)
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
    const timeDiff = new Date(msg.timestamp).getTime() - new Date(prevMsg.timestamp).getTime()
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
      replyToId: replyingTo?.id ?? null,
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
      replyToId: failedMessage.replyToId ?? null,
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
        className="flex h-12 flex-shrink-0 items-center justify-between border-b border-black/30 px-4 shadow-elevation-low"
        data-tauri-drag-region
      >
        <div className="flex items-center gap-2">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" className="text-muted flex-shrink-0">
            <path d="M5.88657 21C5.57547 21 5.3399 20.7189 5.39427 20.4126L6.00001 17H2.59511C2.28449 17 2.04905 16.7198 2.10259 16.4138L2.27759 15.4138C2.31946 15.1746 2.52722 15 2.77011 15H6.35001L7.41001 9H4.00511C3.69449 9 3.45905 8.71977 3.51259 8.41381L3.68759 7.41381C3.72946 7.17456 3.93722 7 4.18011 7H7.76001L8.39677 3.41262C8.43914 3.17391 8.64664 3 8.88907 3H9.88907C10.2002 3 10.4357 3.28107 10.3814 3.58738L9.76001 7H15.76L16.3968 3.41262C16.4391 3.17391 16.6466 3 16.8891 3H17.8891C18.2002 3 18.4357 3.28107 18.3814 3.58738L17.76 7H21.1649C21.4755 7 21.711 7.28023 21.6574 7.58619L21.4824 8.58619C21.4406 8.82544 21.2328 9 20.9899 9H17.41L16.35 15H19.7549C20.0655 15 20.301 15.2802 20.2474 15.5862L20.0724 16.5862C20.0306 16.8254 19.8228 17 19.5799 17H16L15.3632 20.5874C15.3209 20.8261 15.1134 21 14.8709 21H13.8709C13.5598 21 13.3243 20.7189 13.3786 20.4126L14 17H8.00001L7.36325 20.5874C7.32088 20.8261 7.11337 21 6.87094 21H5.88657ZM9.41045 9L8.35045 15H14.3504L15.4104 9H9.41045Z" />
          </svg>
          <span className="text-sm font-semibold text-primary">{channel.name}</span>
        </div>

        <div className="flex items-center gap-1">
          <SearchBar />

          {showMembersToggle && (
            <Tooltip content={isMembersOpen ? 'Hide Member List' : 'Show Member List'} side="bottom">
              <button
                onClick={onToggleMembers}
                className={`flex h-6 w-6 items-center justify-center rounded transition-colors ${
                  isMembersOpen
                    ? 'text-primary'
                    : 'text-muted hover:text-secondary'
                }`}
              >
                <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M14 8.00598C14 10.211 12.206 12.006 10 12.006C7.795 12.006 6 10.211 6 8.00598C6 5.80098 7.794 4.00598 10 4.00598C12.206 4.00598 14 5.80098 14 8.00598ZM2 19.006C2 15.473 5.29 13.006 10 13.006C14.711 13.006 18 15.473 18 19.006V20.006H2V19.006Z" />
                  <path d="M14 8.00598C14 10.211 12.206 12.006 10 12.006C7.795 12.006 6 10.211 6 8.00598C6 5.80098 7.794 4.00598 10 4.00598C12.206 4.00598 14 5.80098 14 8.00598ZM2 19.006C2 15.473 5.29 13.006 10 13.006C14.711 13.006 18 15.473 18 19.006V20.006H2V19.006ZM20 20.006H19V18.006C19 16.4229 18.2757 15.0182 17.044 13.9547C20.078 14.3816 22 16.1248 22 19.006V20.006H20Z" />
                  <path d="M14 8.006C14 10.211 12.206 12.006 10 12.006C7.795 12.006 6 10.211 6 8.006C6 5.801 7.794 4.006 10 4.006C12.206 4.006 14 5.801 14 8.006ZM18 17.006V20.006H2V17.006C2 14.2 4.686 12.006 10 12.006C15.314 12.006 18 14.2 18 17.006ZM20 20.006H22V17.006C22 14.687 20.397 13.085 17.939 12.226C19.245 13.307 20 14.937 20 17.006V20.006Z" />
                </svg>
              </button>
            </Tooltip>
          )}
        </div>
      </div>

      {/* Message area */}
      <div className="relative flex-1">
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
                <div className="mx-auto mb-4 flex h-[68px] w-[68px] items-center justify-center rounded-full bg-bg-modifier-hover">
                  <svg width="40" height="40" viewBox="0 0 24 24" fill="currentColor" className="text-muted">
                    <path d="M5.88657 21C5.57547 21 5.3399 20.7189 5.39427 20.4126L6.00001 17H2.59511C2.28449 17 2.04905 16.7198 2.10259 16.4138L2.27759 15.4138C2.31946 15.1746 2.52722 15 2.77011 15H6.35001L7.41001 9H4.00511C3.69449 9 3.45905 8.71977 3.51259 8.41381L3.68759 7.41381C3.72946 7.17456 3.93722 7 4.18011 7H7.76001L8.39677 3.41262C8.43914 3.17391 8.64664 3 8.88907 3H9.88907C10.2002 3 10.4357 3.28107 10.3814 3.58738L9.76001 7H15.76L16.3968 3.41262C16.4391 3.17391 16.6466 3 16.8891 3H17.8891C18.2002 3 18.4357 3.28107 18.3814 3.58738L17.76 7H21.1649C21.4755 7 21.711 7.28023 21.6574 7.58619L21.4824 8.58619C21.4406 8.82544 21.2328 9 20.9899 9H17.41L16.35 15H19.7549C20.0655 15 20.301 15.2802 20.2474 15.5862L20.0724 16.5862C20.0306 16.8254 19.8228 17 19.5799 17H16L15.3632 20.5874C15.3209 20.8261 15.1134 21 14.8709 21H13.8709C13.5598 21 13.3243 20.7189 13.3786 20.4126L14 17H8.00001L7.36325 20.5874C7.32088 20.8261 7.11337 21 6.87094 21H5.88657ZM9.41045 9L8.35045 15H14.3504L15.4104 9H9.41045Z" />
                  </svg>
                </div>
                <h3 className="text-lg font-bold text-primary mb-1">Welcome to #{channel.name}!</h3>
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
            className="absolute left-0 right-0 top-0 z-10 flex items-center justify-center bg-blue px-4 py-1.5 text-sm font-medium text-white hover:bg-blue/90 transition-colors"
          >
            {hiddenNewerCount > 0 || isBrowsingOlder ? 'Jump to latest messages' : 'New messages ↓'}
          </button>
        )}
      </div>

      {/* Reply bar */}
      {replyingTo && (
        <div className="flex items-center gap-2 bg-bg-secondary px-4 py-2">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="shrink-0 text-secondary">
            <polyline points="9 17 4 12 9 7" />
            <path d="M20 18v-2a4 4 0 0 0-4-4H4" />
          </svg>
          <span className="text-sm text-secondary">
            Replying to <span className="font-medium text-primary">{replyingTo.authorDisplayName}</span>
          </span>
          <span className="truncate text-sm text-muted flex-1">{replyingTo.content.slice(0, 100)}</span>
          <button
            onClick={() => setReplyingTo(null)}
            className="shrink-0 rounded p-1 text-muted transition-colors hover:text-primary"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
      )}

      <TypingIndicator channelId={channel.id} />
      <MessageInput
        channelId={channel.id}
        channelName={channel.name}
        onSend={handleSend}
        communityId={channel.communityId}
        disableAttachments={matrixMode && !bridge.getBackendCapabilities().encryptedAttachments}
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
}

function VirtualMessageRow({
  rowKey,
  message,
  isGrouped,
  hasGap,
  onHeightChange,
  onReply,
  onRetry,
  limitedActions,
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

  return (
    <div ref={rowRef}>
      <MessageComponent
        message={message}
        isGrouped={isGrouped}
        disableMotion
        onReply={onReply}
        onRetry={onRetry}
        limitedActions={limitedActions}
      />
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
      <div className="flex items-center justify-between rounded bg-bg-modifier-hover px-4 py-2">
        <div>
          <p className="text-sm font-medium text-primary">
            {hiddenCount} newer message{hiddenCount === 1 ? '' : 's'} hidden
          </p>
        </div>
        <button
          onClick={onJumpToLatest}
          className="rounded bg-blue px-3 py-1 text-sm font-medium text-white hover:bg-blue/80 transition-colors"
        >
          Jump to latest
        </button>
      </div>
    </div>
  )
}
