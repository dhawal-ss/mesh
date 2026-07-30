import { useState, useRef, useEffect, useCallback, useMemo, useLayoutEffect, type ReactNode } from 'react'
import { useDmConversation, useDmStore } from '../../store/dms'
import { useIdentityStore } from '../../store/identity'
import { MessageInput } from './MessageInput'
import { FileAttachmentCard } from './Message'
import { ReactionPicker } from './ReactionPicker'
import type { StagedFile } from './FileAttachment'
import type { DirectMessage } from '../../types/ipc'
import * as bridge from '../../lib/bridge'
import {
  federatedTimestampMilliseconds,
  formatFederatedTimestamp,
} from '../../lib/federated-time'
import { getBackoffDelay, waitForDelay } from '../../lib/scheduler'
import { ErrorBoundary } from '../ui/ErrorBoundary'
import { useRoomTrust } from '../../hooks/useRoomTrust'
import { useShellStore } from '../../store/shell'
import { DmTrustSummary } from './DmTrustSummary'
import { Icon } from '../ui/Icon'
import { MessageSkeleton } from '../ui/Skeleton'
import { EmptyState } from '../ui/Primitives'
import { MessageReportDialog } from './MessageReportDialog'
import { useVirtualScroll, type VirtualItem } from '../../hooks/useVirtualScroll'

const EMPTY_DIRECT_MESSAGES: DirectMessage[] = []

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
        <div className="mx-4 my-1 flex items-center gap-2 rounded-panel bg-status-danger/5 px-3 py-2" role="alert">
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

  return <div ref={rowRef}>{children}</div>
}

export function DmView() {
  const activeConversationId = useDmStore((state) => state.activeConversationId)
  const conversation = useDmConversation(activeConversationId)
  const channelMessages = useDmStore((state) =>
    state.activeConversationId
      ? (state.messages[state.activeConversationId] ?? EMPTY_DIRECT_MESSAGES)
      : EMPTY_DIRECT_MESSAGES,
  )
  const loadMessages = useDmStore((state) => state.loadMessages)
  const addMessage = useDmStore((state) => state.addMessage)
  const patchMessage = useDmStore((state) => state.patchMessage)
  const updateReaction = useDmStore((state) => state.updateReaction)
  const identity = useIdentityStore((s) => s.identity)
  const setSecurityOpen = useShellStore((state) => state.setSecurityOpen)
  const matrixMode = bridge.isMatrixBackend()
  const ownAuthorId = matrixMode ? bridge.getMatrixUserId() : identity?.publicKey
  const [loadingConversationId, setLoadingConversationId] = useState<string | null>(null)
  const [blockState, setBlockState] = useState<{ peerPublicKey: string; blocked: boolean } | null>(
    null,
  )
  const [isBlockBusy, setIsBlockBusy] = useState(false)
  const [reactionTargetId, setReactionTargetId] = useState<string | null>(null)
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null)
  const [reportMessageId, setReportMessageId] = useState<string | null>(null)
  const [editValue, setEditValue] = useState('')
  const [replyingTo, setReplyingTo] = useState<DirectMessage | null>(null)
  const trustMembers = useMemo(
    () => [ownAuthorId, conversation?.peerPublicKey]
      .filter((publicKey): publicKey is string => Boolean(publicKey))
      .map((publicKey) => ({ publicKey })),
    [conversation?.peerPublicKey, ownAuthorId],
  )
  const trust = useRoomTrust(activeConversationId, trustMembers)
  const peerPublicKey = conversation?.peerPublicKey
  const isLoading = loadingConversationId === activeConversationId
  const isBlocked =
    Boolean(peerPublicKey)
    && blockState?.peerPublicKey === peerPublicKey
    && Boolean(blockState?.blocked)
  const virtualItems = useMemo<VirtualItem[]>(() => channelMessages.map((message) => ({
    key: message.id,
    type: 'message',
    height:
      52
      + Math.min(160, Math.max(1, Math.ceil(message.content.length / 80)) * 20)
      + ((message.attachments?.length ?? 0) > 0 ? 96 : 0),
  })), [channelMessages])
  const messageIndexById = useMemo(
    () => new Map(channelMessages.map((message, index) => [message.id, index] as const)),
    [channelMessages],
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
  const visibleMessages = useMemo(() => (
    virtualItems.length === 0
      ? []
      : virtualItems
          .slice(visibleRange.start, visibleRange.end + 1)
          .map((item) => {
            const index = messageIndexById.get(item.key) ?? -1
            return index >= 0 ? { message: channelMessages[index], index } : null
          })
          .filter((entry): entry is { message: DirectMessage; index: number } => entry !== null)
  ), [channelMessages, messageIndexById, virtualItems, visibleRange.end, visibleRange.start])

  useEffect(() => {
    if (!matrixMode || !peerPublicKey) return
    let active = true
    void bridge.matrixDmBlocked(peerPublicKey)
      .then((blocked) => {
        if (active) setBlockState({ peerPublicKey, blocked })
      })
      .catch((error) => {
        if (active) console.error('Failed to load Matrix DM block state:', error)
      })
    return () => {
      active = false
    }
  }, [matrixMode, peerPublicKey])

  useEffect(() => {
    if (!activeConversationId) return
    let active = true
    const conversationId = activeConversationId
    void Promise.resolve().then(async () => {
      if (!active) return
      setLoadingConversationId(conversationId)
      try {
        await loadMessages(conversationId)
      } catch (error) {
        if (active) console.error('Failed to load direct messages:', error)
      } finally {
        if (active) setLoadingConversationId(null)
      }
    })
    return () => {
      active = false
    }
  }, [activeConversationId, loadMessages])

  useEffect(() => {
    resetLayout()
  }, [activeConversationId, resetLayout])

  useEffect(() => {
    if (matrixMode) return
    const unsub = bridge.onDmReceived((msg) => {
      if (msg.conversationId === activeConversationId) {
        addMessage(msg)
      }
    })
    return () => { unsub.then((fn) => fn()) }
  }, [activeConversationId, addMessage, matrixMode])

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
          if (active) {
            await loadMessages(activeConversationId)
          }
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
    onAttachmentSent?: (file: StagedFile, contentConsumed: boolean) => void | Promise<void>,
  ) => {
    if (!conversation) return
    const replyToId = replyingTo?.id
    try {
      if (matrixMode && files.length > 0) {
        for (const [index, file] of files.entries()) {
          const msg = await bridge.matrixSendDmAttachment(
            conversation.peerPublicKey,
            file.grant,
            file.transferId ?? bridge.createMatrixTransferId(),
            index === 0 ? content : '',
            index === 0 ? replyToId : undefined,
          )
          addMessage(msg)
          if (index === 0) setReplyingTo(null)
          await onAttachmentSent?.(file, index === 0 && content.length > 0)
        }
        return
      }
      const msg = await bridge.sendDm(
        conversation.peerPublicKey,
        content,
        replyToId,
        bridge.createMatrixTransactionId(),
      )
      addMessage(msg)
      setReplyingTo(null)
    } catch (err) {
      console.error('Failed to send DM:', err)
      throw err
    }
  }, [conversation, addMessage, matrixMode, replyingTo])

  const handleReaction = async (message: DirectMessage, emoji: string) => {
    if (!matrixMode || !activeConversationId || !ownAuthorId) return
    const currentUsers = message.reactions?.[emoji] ?? []
    const verb = currentUsers.includes(ownAuthorId) ? 'remove' : 'add'
    updateReaction(activeConversationId, message.id, emoji, ownAuthorId, verb)
    try {
      await bridge.addReaction(message.id, emoji, activeConversationId)
    } catch (error) {
      updateReaction(activeConversationId, message.id, emoji, ownAuthorId, verb === 'add' ? 'remove' : 'add')
      console.error('Failed to update DM reaction:', error)
    }
  }

  // Mirrors Message.tsx's handleRowKeyDown: the picker is rendered inside
  // this same row, so its keydowns bubble here. DmView has no context menu,
  // so (unlike Message.tsx) there's no ContextMenu/Shift+F10 branch to port.
  const handleMessageRowKeyDown = (event: React.KeyboardEvent<HTMLDivElement>, messageId: string) => {
    if (event.key !== 'Escape' || reactionTargetId !== messageId) return
    setReactionTargetId(null)
    event.currentTarget.querySelector<HTMLButtonElement>('[aria-label="Add reaction"]')?.focus()
  }

  // Mirrors Message.tsx's handleRowBlur: Tabbing focus off the row entirely
  // (e.g. past the last action-bar button) should close the picker too, not
  // just Escape/mouseleave.
  const handleMessageRowBlur = (event: React.FocusEvent<HTMLDivElement>, messageId: string) => {
    if (reactionTargetId !== messageId) return
    if (event.relatedTarget && event.currentTarget.contains(event.relatedTarget as Node)) return
    setReactionTargetId(null)
  }

  const handleSaveEdit = async () => {
    const trimmed = editValue.trim()
    if (!matrixMode || !activeConversationId || !editingMessageId || !trimmed) {
      setEditingMessageId(null)
      return
    }
    try {
      await bridge.editMessage(editingMessageId, trimmed, activeConversationId)
      patchMessage(activeConversationId, editingMessageId, {
        content: trimmed,
        editedAt: new Date().toISOString(),
      })
    } catch (error) {
      console.error('Failed to edit Matrix DM:', error)
    } finally {
      setEditingMessageId(null)
      setEditValue('')
    }
  }

  const handleToggleBlocked = async () => {
    if (!matrixMode || !conversation || isBlockBusy) return
    setIsBlockBusy(true)
    try {
      const blocked = await bridge.matrixSetDmBlocked(conversation.peerPublicKey, !isBlocked)
      setBlockState({ peerPublicKey: conversation.peerPublicKey, blocked })
    } catch (error) {
      console.error('Failed to update Matrix DM block state:', error)
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

  const peerName = conversation.peerDisplayName || conversation.peerPublicKey.slice(0, 8)

  return (
    <div className="flex h-full flex-1 flex-col">
      {/* Header */}
      <div
        className="mesh-conversation-header flex h-conversation-header flex-shrink-0 items-center border-b border-border-subtle px-4 py-2"
        data-tauri-drag-region
      >
        <div
          className="mr-2 flex h-6 w-6 items-center justify-center rounded-control text-micro font-semibold text-content-on-avatar/90"
          data-design-token-exception="data-driven-federated-avatar-color"
          style={{ backgroundColor: conversation.peerAvatarColor }}
        >
          {peerName[0]?.toUpperCase() ?? '?'}
        </div>
        <span className="min-w-0">
          <span className="block truncate text-sm font-medium text-primary">{peerName}</span>
          {conversation.peerPublicKey.startsWith('@') && (
            <span className="identifier block truncate font-mono text-caption text-muted">
              {conversation.peerPublicKey}
            </span>
          )}
        </span>
        <div className="ml-auto flex items-center gap-1.5">
          {matrixMode && (
            <DmTrustSummary
              trust={trust}
              peerName={peerName}
              onReviewDevices={() => setSecurityOpen(true)}
            />
          )}
          {matrixMode && (
            <button
              type="button"
              onClick={() => void handleToggleBlocked()}
              disabled={isBlockBusy}
              className="min-h-8 rounded-control px-2 text-caption font-medium text-muted transition-colors hover:bg-status-danger/10 hover:text-status-danger disabled:opacity-50"
              aria-label={isBlocked ? `Unblock ${peerName}` : `Block ${peerName}`}
            >
              {isBlockBusy ? 'Saving…' : isBlocked ? 'Unblock' : 'Block'}
            </button>
          )}
        </div>
      </div>

      {matrixMode && !trust.loadingAccountTrust && trust.devicesNeedReview > 0 && (
        <div className="flex min-h-10 items-center gap-2 border-b border-status-warning/20 bg-status-warning/5 px-4 py-1.5 text-xs text-secondary">
          <Icon name="triangleAlert" size="sm" className="flex-shrink-0 text-status-warning" />
          <span className="min-w-0 flex-1">
            {trust.devicesNeedReview} {trust.devicesNeedReview === 1 ? 'device needs' : 'devices need'} review before it can be fully trusted.
          </span>
          <button
            type="button"
            onClick={() => setSecurityOpen(true)}
            className="min-h-8 flex-shrink-0 rounded-control px-2 font-semibold text-status-warning hover:bg-status-warning/10"
          >
            Review
          </button>
        </div>
      )}

      {/* Messages */}
      <div
        ref={scrollContainerRef}
        onScroll={() => void handleScroll()}
        className="flex-1 overflow-y-auto py-4"
        role="log"
        aria-live="polite"
        aria-label={`Messages with ${peerName}`}
      >
        {isLoading ? (
          <div aria-label="Loading messages" role="status">
            {Array.from({ length: 8 }).map((_, index) => (
              <MessageSkeleton key={index} />
            ))}
          </div>
        ) : channelMessages.length === 0 ? (
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
            {visibleMessages.map(({ message: msg, index }) => (
              <DmVirtualMessageRow
                key={msg?.id ?? `malformed-message-${index}`}
                rowKey={msg?.id ?? `malformed-message-${index}`}
                onHeightChange={handleMeasuredHeight}
              >
                <DmMessageBoundary messageId={msg?.id ?? `malformed-message-${index}`}>
                {() => {
                  const prev = channelMessages[index - 1]
                  const timestamp = federatedTimestampMilliseconds(msg.timestamp)
                  const previousTimestamp = federatedTimestampMilliseconds(prev?.timestamp)
                  const isGrouped = prev &&
                    prev.authorPublicKey === msg.authorPublicKey &&
                    timestamp !== null &&
                    previousTimestamp !== null &&
                    timestamp - previousTimestamp < 5 * 60 * 1000

                  const isOwnMessage = msg.authorPublicKey === ownAuthorId

                  return (
                <div
                  role="group"
                  aria-label={`Message from ${msg.authorDisplayName}, ${formatFederatedTimestamp(msg.timestamp, 'MM/dd/yyyy h:mm a')}`}
                  tabIndex={-1}
                  className={`group relative px-4 outline-none ${!isGrouped ? 'pt-2' : 'pt-0.5'}`}
                  onMouseLeave={() => setReactionTargetId(null)}
                  onKeyDown={(event) => handleMessageRowKeyDown(event, msg.id)}
                  onBlur={(event) => handleMessageRowBlur(event, msg.id)}
                >
                  {!isGrouped && (
                    <div className="mb-0.5 flex flex-wrap items-center gap-x-2 gap-y-0">
                      <div
                        className="flex h-6 w-6 items-center justify-center rounded-control text-micro font-semibold text-content-on-avatar/90"
                        data-design-token-exception="data-driven-federated-avatar-color"
                        style={{ backgroundColor: msg.authorAvatarColor }}
                      >
                        {msg.authorDisplayName[0]?.toUpperCase() ?? '?'}
                      </div>
                      <span className={`text-base font-semibold ${isOwnMessage ? 'text-accent' : 'text-primary'}`}>
                        {isOwnMessage ? 'You' : msg.authorDisplayName}
                      </span>
                      {matrixMode && msg.authorPublicKey.startsWith('@') && (
                        <span className="identifier max-w-full truncate font-mono text-caption text-muted">
                          {msg.authorPublicKey}
                        </span>
                      )}
                      <span className="tnum text-2xs text-muted">
                        {formatFederatedTimestamp(msg.timestamp, 'HH:mm')}
                      </span>
                    </div>
                  )}
                  <div className={!isGrouped ? 'pl-8' : 'pl-8'}>
                    {msg.replyToId && (
                      <div className="mb-1 flex items-center gap-1.5 text-xs text-muted">
                        <span aria-hidden>↪</span>
                        <span>Replying to {channelMessages.find((candidate) => candidate.id === msg.replyToId)?.authorDisplayName ?? 'a message'}</span>
                      </div>
                    )}
                    {editingMessageId === msg.id ? (
                      <div className="space-y-1.5">
                        <textarea
                          value={editValue}
                          onChange={(event) => setEditValue(event.target.value)}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter' && !event.shiftKey) {
                              event.preventDefault()
                              void handleSaveEdit()
                            }
                            if (event.key === 'Escape') setEditingMessageId(null)
                          }}
                          className="min-h-control-md w-full resize-none rounded-control border border-border bg-surface-sunken px-2 py-1.5 text-sm text-primary outline-none focus:border-accent"
                          rows={Math.min(6, editValue.split('\n').length + 1)}
                          autoFocus
                        />
                        <div className="flex gap-1.5 text-caption">
                          <button
                            type="button"
                            onClick={() => void handleSaveEdit()}
                            className="min-h-8 rounded-control bg-accent px-2 font-semibold text-content-on-accent hover:bg-accent-hover"
                          >
                            Save
                          </button>
                          <button
                            type="button"
                            onClick={() => setEditingMessageId(null)}
                            className="min-h-8 rounded-control px-2 text-muted hover:bg-surface-hover hover:text-primary"
                          >
                            Cancel
                          </button>
                        </div>
                      </div>
                    ) : (
                      <p className="text-sm text-secondary whitespace-pre-wrap break-words">
                        {msg.content}
                        {msg.editedAt && <span className="ml-1 text-caption text-muted">(edited)</span>}
                      </p>
                    )}
                    {(msg.attachments ?? []).map((attachment, attachmentIndex) => (
                      <FileAttachmentCard
                        key={attachment.fileHash}
                        attachment={attachment}
                        roomId={msg.conversationId}
                        eventId={msg.id}
                        attachmentIndex={attachmentIndex}
                      />
                    ))}
                    {Object.keys(msg.reactions ?? {}).length > 0 && (
                      <div className="mt-1 flex flex-wrap gap-1">
                        {Object.entries(msg.reactions ?? {}).map(([emoji, users]) => (
                          <button
                            key={emoji}
                            onClick={() => void handleReaction(msg, emoji)}
                            className={`min-h-8 rounded-control border px-2 text-xs ${ownAuthorId && users.includes(ownAuthorId) ? 'border-accent/40 bg-accent/10 text-accent' : 'border-border bg-surface-hover text-secondary'}`}
                          >
                            {emoji} {users.length}
                          </button>
                        ))}
                      </div>
                    )}
                    {isOwnMessage && (msg.seenBy?.length ?? 0) > 0 && (
                      <p
                        className="mt-1 text-2xs text-muted"
                        aria-label={`Seen by ${msg.seenBy?.map((receipt) => receipt.displayName).join(', ')}`}
                      >
                        Seen by {msg.seenBy?.map((receipt) => receipt.displayName).join(', ')}
                      </p>
                    )}
                  </div>
                  {/* Action bar — always mounted (not just on hover) so Tab can
                      reach it; group-hover/group-focus-within reveal it
                      visually, matching Message.tsx's pattern. */}
                  {matrixMode && editingMessageId !== msg.id && (
                    <div className="mesh-message-actions pointer-events-none absolute -top-4 right-4 z-sticky flex items-center rounded-panel border border-border-subtle bg-surface-overlay opacity-0 shadow-overlay transition-opacity group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100">
                      <button
                        type="button"
                        onClick={() => setReplyingTo(msg)}
                        className="flex h-8 w-8 items-center justify-center text-muted transition-colors hover:bg-surface-hover hover:text-secondary focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
                        aria-label="Reply to message"
                      ><Icon name="reply" size="sm" /></button>
                      <button
                        type="button"
                        onClick={() => setReactionTargetId(reactionTargetId === msg.id ? null : msg.id)}
                        className="flex h-8 w-8 items-center justify-center text-muted transition-colors hover:bg-surface-hover hover:text-secondary focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
                        aria-label="Add reaction"
                        aria-expanded={reactionTargetId === msg.id}
                      ><Icon name="smile" size="sm" /></button>
                      {isOwnMessage && (
                        <button
                          type="button"
                          onClick={() => {
                            setEditingMessageId(msg.id)
                            setEditValue(msg.content)
                          }}
                          className="flex h-8 w-8 items-center justify-center text-muted transition-colors hover:bg-surface-hover hover:text-secondary focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
                          aria-label="Edit message"
                        ><Icon name="squarePen" size="sm" /></button>
                      )}
                      {!isOwnMessage && msg.id.startsWith('$') && (
                        <button
                          type="button"
                          onClick={() => setReportMessageId(msg.id)}
                          className="flex h-8 w-8 items-center justify-center text-muted transition-colors hover:bg-surface-hover hover:text-secondary focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
                          aria-label="Report message"
                        ><Icon name="triangleAlert" size="sm" /></button>
                      )}
                    </div>
                  )}
                  {matrixMode && reactionTargetId === msg.id && (
                    <div className="absolute -top-10 right-4 z-popover">
                      <ReactionPicker onSelect={(emoji) => void handleReaction(msg, emoji)} onClose={() => setReactionTargetId(null)} />
                    </div>
                  )}
                </div>
                  )
                }}
                </DmMessageBoundary>
              </DmVirtualMessageRow>
            ))}
          </div>
        )}
      </div>

      <MessageReportDialog
        open={reportMessageId !== null}
        roomId={activeConversationId}
        eventId={reportMessageId ?? ''}
        onClose={() => setReportMessageId(null)}
      />

      {isBlocked && (
        <div className="mx-4 mb-2 rounded-panel border border-status-danger/20 bg-status-danger/5 px-3 py-2 text-xs text-status-danger">
          Messages from this user are blocked. Unblock them to resume this conversation.
        </div>
      )}
      {replyingTo && (
        <div className="flex items-center justify-between gap-2 border-t border-border-subtle bg-surface-sunken px-4 py-2 text-xs text-secondary">
          <span>Replying to {replyingTo.authorDisplayName}: {replyingTo.content.slice(0, 80)}</span>
          <button
            type="button"
            onClick={() => setReplyingTo(null)}
            className="min-h-8 rounded-control px-2 text-muted hover:bg-surface-hover hover:text-primary"
            aria-label="Cancel reply"
          >
            Cancel
          </button>
        </div>
      )}
      <MessageInput
        channelId={activeConversationId}
        channelName={peerName}
        onSend={handleSend}
        disableAttachments={false}
        disabled={matrixMode && isBlocked}
        onEditLastMessage={() => {
          const ownMessage = [...channelMessages]
            .reverse()
            .find((message) => message.authorPublicKey === ownAuthorId && !message.deletedAt)
          if (!ownMessage) return
          setEditingMessageId(ownMessage.id)
          setEditValue(ownMessage.content)
        }}
      />
    </div>
  )
}
