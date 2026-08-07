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

import { getBackoffDelay, waitForDelay } from '../../lib/scheduler'
import { federatedTimestampMilliseconds } from '../../lib/federated-time'
import { shouldGroupMessage } from '../../lib/message-grouping'
import { resolveSenderIdentity } from '../../lib/matrixIdentity'
import { groupThreadReplies, mergeThreadMessages } from '../../lib/threads'
import { restorePaneTriggerFocus } from '../../lib/pane-focus'
import * as bridge from '../../lib/bridge'
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
import { EmptyState } from '../ui/Primitives'
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
import { OfflineQueueSummary } from './OfflineQueueSummary'

const EMPTY_DIRECT_MESSAGES: DirectMessage[] = []
const EMPTY_MESSAGES: MessageType[] = []
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
          className="mx-4 my-1 flex items-center gap-2 rounded-panel bg-status-danger/5 px-3 py-2"
          role="alert"
        >
          <p className="min-w-0 flex-1 text-xs text-muted">
            One message could not be displayed.
          </p>
          <button
            type="button"
            onClick={resetError}
            className="min-h-8 rounded-control px-2 text-xs font-medium text-text-link hover:bg-surface-hover hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
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

function DmVirtualMessageRow({
  rowKey,
  onHeightChange,
  children,
}: {
  rowKey: string
  onHeightChange: (rowKey: string, height: number) => void
  children: ReactNode
}) {
  const rowRef = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    const element = rowRef.current
    if (!element) return
    const reportHeight = () => onHeightChange(rowKey, element.offsetHeight)
    reportHeight()
    const observer = new ResizeObserver(reportHeight)
    observer.observe(element)
    return () => observer.disconnect()
  }, [onHeightChange, rowKey])

  return (
    <div ref={rowRef} data-message-id={rowKey}>
      {children}
    </div>
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

  const channelMessages = useMemo(
    () => mergeDirectMessageTimeline(directMessages, deliveryMessages),
    [deliveryMessages, directMessages],
  )
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
  const { visibleMessages: visibleChannelMessages, repliesByRoot } = useMemo(
    () => groupThreadReplies(channelMessages),
    [channelMessages],
  )
  const messageIndexById = useMemo(
    () => new Map(visibleChannelMessages.map((message, index) => [message.id, index] as const)),
    [visibleChannelMessages],
  )
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
    resetLayout,
  } = useVirtualScroll(virtualItems, {
    estimatedMessageHeight: 76,
    overscanPx: 500,
  })
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
  const trustMembers = useMemo(
    () => [ownAuthorId, conversation?.peerPublicKey]
      .filter((publicKey): publicKey is string => Boolean(publicKey))
      .map((publicKey) => ({ publicKey })),
    [conversation?.peerPublicKey, ownAuthorId],
  )
  const trust = useRoomTrust(activeConversationId, trustMembers)
  const peerPublicKey = conversation?.peerPublicKey
  const isLoading = (!messageLoad || messageLoad.status === 'idle' || messageLoad.status === 'loading')
    && visibleChannelMessages.length === 0
  const loadFailed = messageLoad?.status === 'failed'
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

  useEffect(() => {
    if (previousConversationIdRef.current === activeConversationId) return
    previousConversationIdRef.current = activeConversationId
    setThreadReplyRoot(null)
    setReplyingTo(null)
    setEditRequest(null)
  }, [activeConversationId])

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
        await loadMessages(conversationId)
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
      if (message.conversationId === activeConversationId) {
        addDirectMessage(message)
      }
    })
    return () => {
      unsubscribe.then((stopListening) => stopListening())
    }
  }, [activeConversationId, addDirectMessage, matrixMode])

  useEffect(() => {
    if (!matrixMode || !activeConversationId) return
    let active = true
    const retryController = new AbortController()
    let retryAttempt = 0
    const watchUpdates = async () => {
      while (active) {
        try {
          await bridge.matrixWaitForRoomUpdate(activeConversationId)
          retryAttempt = 0
          if (active) await loadMessages(activeConversationId)
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
    const replyToId = replyingTo?.id
    const threadRootId = threadReplyRoot?.id

    if (matrixMode && files.length > 0) {
      try {
        for (const [index, file] of files.entries()) {
          const message = await bridge.matrixSendDmAttachment(
            conversation.peerPublicKey,
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
          conversation.peerPublicKey,
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
    isBlocked,
    matrixMode,
    replyingTo,
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
        conversation.peerPublicKey,
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

  const handleEdit = useCallback(async (message: MessageType, content: string) => {
    if (!matrixMode || !activeConversationId) return
    await bridge.editMessage(message.id, content, activeConversationId)
    const editedAt = new Date().toISOString()
    patchDirectMessage(activeConversationId, message.id, { content, editedAt })
    useMessageStore
      .getState()
      .editMessage(activeConversationId, message.id, content, editedAt)
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

  const handleToggleBlocked = async () => {
    if (!matrixMode || !conversation || isBlockBusy) return
    setIsBlockBusy(true)
    setBlockError(null)
    try {
      const blocked = await bridge.matrixSetDmBlocked(
        conversation.peerPublicKey,
        !isBlocked,
      )
      setBlockState({ peerPublicKey: conversation.peerPublicKey, status: 'ready', blocked })
      if (blocked) {
        // Do not wait for the next Matrix poll to hide an already-rendered
        // conversation. The native projection independently enforces the same
        // account-data boundary for subsequent reads.
        useDmStore.getState().upsertBlockedAccount({ userId: conversation.peerPublicKey })
      } else {
        useDmStore.getState().removeBlockedAccount(conversation.peerPublicKey)
      }
    } catch (error) {
      console.error('Failed to update Matrix DM block state:', error)
      setBlockError(error)
    } finally {
      setIsBlockBusy(false)
    }
  }

  if (!activeConversationId || !conversation) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <EmptyState
          icon={<Icon name="messageCircle" size="lg" />}
          title="Select a conversation"
          description="Choose a private conversation from the sidebar."
        />
      </div>
    )
  }

  const peerName = conversation.peerDisplayName.trim() || 'Unknown account'

  return (
    <div className="relative flex h-full min-h-0 min-w-0 flex-1 overflow-hidden">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div
        className="mesh-conversation-header flex h-conversation-header flex-shrink-0 items-center border-b border-border-subtle px-4 py-2"
        data-tauri-drag-region
      >
        <Avatar
          color={conversation.peerAvatarColor}
          size={32}
          name={peerName}
          className="mr-3"
        />
        <span className="min-w-0">
          <h1
            className="block truncate text-sm font-semibold text-primary outline-none"
            data-mesh-route-heading
            tabIndex={-1}
          >
            {peerName}
          </h1>
          <span className="mt-0.5 block truncate text-meta text-muted">
            Private conversation
          </span>
        </span>
        <div className="ml-auto flex items-center gap-1.5">
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
              className={`flex min-h-8 items-center gap-1.5 rounded-control px-2 text-caption font-medium transition-colors ${
                safetyOpen
                  ? 'bg-surface-selected text-primary'
                  : trust.devicesNeedReview > 0 || trust.protection !== 'protected'
                    ? 'bg-status-warning/10 text-status-warning hover:bg-status-warning/20'
                    : 'text-muted hover:bg-surface-hover hover:text-primary'
              }`}
              aria-controls="mesh-dm-safety-panel"
              aria-expanded={safetyOpen}
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
        <div className="flex min-h-10 items-center gap-2 border-b border-status-warning/20 bg-status-warning/5 px-4 py-1.5 text-xs text-secondary">
          <Icon
            name="triangleAlert"
            size="sm"
            className="flex-shrink-0 text-status-warning"
          />
          <span className="min-w-0 flex-1">
            {trust.devicesNeedReview}{' '}
            {trust.devicesNeedReview === 1 ? 'device needs' : 'devices need'} review
            before it can be fully trusted.
          </span>
          <button
            type="button"
            onClick={(event) => openSecurityFrom(event.currentTarget)}
            className="min-h-8 flex-shrink-0 rounded-control px-2 font-semibold text-status-warning hover:bg-status-warning/10"
          >
            Review
          </button>
        </div>
      )}

      {markReadError?.conversationId === activeConversationId && (
        <div
          role="alert"
          className="flex flex-wrap items-center justify-between gap-2 border-b border-status-warning/20 bg-status-warning/10 px-4 py-2 text-xs text-secondary"
        >
          <span>This conversation could not be marked as read.</span>
          <button
            type="button"
            className="min-h-8 rounded-control px-2 font-semibold text-text-link hover:bg-surface-hover"
            onClick={() => void markConversationRead(activeConversationId)}
          >
            Retry read status
          </button>
        </div>
      )}

      <div
        ref={scrollContainerRef}
        onScroll={() => void handleScroll()}
        className="flex-1 overflow-y-auto bg-surface-canvas py-5"
        role="log"
        aria-live="off"
        aria-label={`Messages with ${peerName}`}
      >
        {loadFailed && visibleChannelMessages.length === 0 ? (
          <div className="flex h-full items-center justify-center px-4">
            <div
              role="alert"
              className="max-w-sm rounded-panel border border-status-warning/30 bg-status-warning/10 p-4 text-center text-sm text-secondary"
            >
              <p>Messages could not be loaded. This conversation has not been marked as read.</p>
              <button
                type="button"
                className="mt-3 min-h-8 rounded-control px-3 font-semibold text-text-link hover:bg-surface-hover"
                onClick={() => void loadMessages(activeConversationId)
                  .then(() => markConversationRead(activeConversationId))
                  .catch(() => {})}
              >
                Retry messages
              </button>
            </div>
          </div>
        ) : isLoading ? (
          <div aria-label="Loading messages">
            <AsyncStatus
              compact
              title="Bringing in this conversation"
              detail="The conversation stays in place while Mesh checks for new activity."
            />
            {Array.from({ length: 8 }).map((_, index) => (
              <MessageSkeleton key={index} />
            ))}
          </div>
        ) : visibleChannelMessages.length === 0 ? (
          <div className="flex h-full items-center justify-center">
            <EmptyState
              icon={<Icon name="messageCircle" size="lg" />}
              title="Start of conversation"
              description={`Send a message to ${peerName}.`}
            />
          </div>
        ) : (
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
                  onHeightChange={handleMeasuredHeight}
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
                      </>
                    )}
                  </DmMessageBoundary>
                </DmVirtualMessageRow>
              )
            })}
          </div>
        )}
      </div>

      {loadFailed && visibleChannelMessages.length > 0 && (
        <div
          role="alert"
          className="mx-4 mb-2 flex flex-wrap items-center justify-between gap-2 rounded-control border border-status-warning/30 bg-status-warning/10 px-3 py-2 text-xs text-secondary"
        >
          <span>Could not refresh messages. Showing the last update.</span>
          <button
            type="button"
            className="min-h-8 rounded-control px-2 font-semibold text-text-link hover:bg-surface-hover"
            onClick={() => void loadMessages(activeConversationId).catch(() => {})}
          >
            Retry
          </button>
        </div>
      )}

      {isBlocked && (
        <div className="mx-4 mb-2 rounded-panel border border-status-danger/20 bg-status-danger/5 px-3 py-2 text-xs text-status-danger">
          Messages from this user are blocked. Unblock {peerName} to send a message.
        </div>
      )}
      {blockSafetyUnavailable && (
        <div
          role={blockStatus === 'failed' ? 'alert' : 'status'}
          className="mx-4 mb-2 rounded-panel border border-status-warning/30 bg-status-warning/10 px-3 py-2 text-xs text-secondary"
        >
          {blockStatus === 'failed' ? (
            <>
              <span>Mesh couldn&apos;t check whether this account is blocked. Sending stays off until that check succeeds.</span>{' '}
              <button
                type="button"
                className="min-h-8 rounded-control px-2 font-semibold text-text-link hover:bg-surface-hover"
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
        <div className="flex items-center justify-between gap-2 border-t border-border-subtle bg-surface-sunken px-4 py-2 text-xs text-secondary">
          <span>
            {threadReplyRoot && (
              <span className="mr-1 font-semibold text-text-link">In thread ·</span>
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
            className="min-h-8 rounded-control px-2 text-muted hover:bg-surface-hover hover:text-primary"
            aria-label="Cancel reply"
          >
            Cancel
          </button>
        </div>
      )}
      <OfflineQueueSummary
        count={savedMessages.length}
        onReview={() => {
          const firstSaved = savedMessages[0]
          if (!firstSaved) return
          const row = [...document.querySelectorAll<HTMLElement>('[data-message-id]')]
            .find((candidate) => candidate.dataset.messageId === firstSaved.id)
          row?.scrollIntoView({ block: 'center' })
          if (row) {
            row.tabIndex = -1
            row.focus({ preventScroll: true })
          }
        }}
      />
      {sendingProtectionUnavailable && (
        <div
          role="status"
          className="border-t border-status-warning/30 bg-status-warning/10 px-4 py-2 text-xs text-secondary"
        >
          {trust.protection === 'checking'
            ? "Checking this conversation's protection before sending."
            : trust.protection === 'unencrypted'
              ? 'Sending is unavailable because this conversation is not protected end to end.'
              : "Sending is unavailable until this conversation's protection can be verified."}
        </div>
      )}
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
      </div>
      {(matrixMode && safetyOpen) || openThreadId ? (
        <button
          type="button"
          className="mesh-room-context-backdrop"
          aria-label={safetyOpen ? 'Dismiss Safety' : 'Dismiss thread'}
          onClick={safetyOpen ? closeSafety : closeThread}
        />
      ) : null}
      {matrixMode && safetyOpen && (
        <DmSafetyPanel
          key={activeConversationId}
          conversationId={activeConversationId}
          peerName={peerName}
          accountAddress={conversation.peerPublicKey}
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
      className="mesh-secondary-pane flex min-h-0 flex-shrink-0 flex-col overflow-hidden border-l border-border-subtle bg-surface-base"
      aria-label="Loading thread"
      aria-busy="true"
      tabIndex={-1}
    >
      <div className="flex h-conversation-header flex-shrink-0 items-center gap-3 border-b border-border-subtle bg-surface-raised px-4">
        <span className="min-w-0 flex-1 text-xs font-medium text-secondary" role="status">
          Loading thread
        </span>
        <button
          type="button"
          onClick={onClose}
          className="min-h-10 rounded-control px-2 text-xs font-medium text-muted hover:bg-surface-hover hover:text-primary"
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
