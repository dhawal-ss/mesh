import { useState, useRef, useEffect, useCallback, type ReactNode } from 'react'
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
import { ConversationProtection } from './ConversationProtection'

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
        <div className="mx-4 my-1 flex items-center gap-2 rounded bg-red/5 px-3 py-2" role="alert">
          <p className="min-w-0 flex-1 text-xs text-muted">
            One message could not be displayed.
          </p>
          <button
            type="button"
            onClick={resetError}
            className="text-xs font-medium text-text-link hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue"
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
  const matrixMode = bridge.isMatrixBackend()
  const ownAuthorId = matrixMode ? bridge.getMatrixUserId() : identity?.publicKey
  const scrollRef = useRef<HTMLDivElement>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [isBlocked, setIsBlocked] = useState(false)
  const [isBlockBusy, setIsBlockBusy] = useState(false)
  const [hoveredMessageId, setHoveredMessageId] = useState<string | null>(null)
  const [reactionTargetId, setReactionTargetId] = useState<string | null>(null)
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null)
  const [editValue, setEditValue] = useState('')
  const [replyingTo, setReplyingTo] = useState<DirectMessage | null>(null)

  useEffect(() => {
    if (!matrixMode || !conversation) {
      setIsBlocked(false)
      return
    }
    let active = true
    void bridge.matrixDmBlocked(conversation.peerPublicKey)
      .then((blocked) => {
        if (active) setIsBlocked(blocked)
      })
      .catch((error) => {
        if (active) console.error('Failed to load Matrix DM block state:', error)
      })
    return () => {
      active = false
    }
  }, [conversation?.peerPublicKey, matrixMode])

  useEffect(() => {
    if (!activeConversationId) return
    let active = true
    setIsLoading(true)
    loadMessages(activeConversationId).finally(() => {
      if (!active) return
      setIsLoading(false)
      requestAnimationFrame(() => {
        if (!active) return
        const el = scrollRef.current
        if (el) el.scrollTop = el.scrollHeight
      })
    })
    return () => {
      active = false
    }
  }, [activeConversationId, loadMessages])

  useEffect(() => {
    if (matrixMode) return
    const unsub = bridge.onDmReceived((msg) => {
      if (msg.conversationId === activeConversationId) {
        addMessage(msg)
        requestAnimationFrame(() => {
          const el = scrollRef.current
          if (el) el.scrollTop = el.scrollHeight
        })
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
      requestAnimationFrame(() => {
        const el = scrollRef.current
        if (el) el.scrollTop = el.scrollHeight
      })
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
      setIsBlocked(blocked)
    } catch (error) {
      console.error('Failed to update Matrix DM block state:', error)
    } finally {
      setIsBlockBusy(false)
    }
  }

  if (!activeConversationId || !conversation) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <div className="rounded-panel border border-border-subtle bg-surface-raised/50 px-8 py-7 text-center shadow-pane backdrop-blur-xl">
          <p className="mb-1 text-sm text-secondary">Select a conversation</p>
          <p className="text-2xs text-muted">Choose a DM from the sidebar</p>
        </div>
      </div>
    )
  }

  const peerName = conversation.peerDisplayName || conversation.peerPublicKey.slice(0, 8)

  return (
    <div className="flex h-full flex-1 flex-col bg-pane-tint">
      {/* Header */}
      <div
        className="flex h-12 flex-shrink-0 items-center border-b border-border-subtle px-4 backdrop-blur-xl"
        data-tauri-drag-region
      >
        <div
          className="mr-2 flex h-6 w-6 items-center justify-center rounded-full text-micro font-semibold text-content-on-status/90"
          data-design-token-exception="data-driven-federated-avatar-color"
          style={{ backgroundColor: conversation.peerAvatarColor }}
        >
          {peerName[0]?.toUpperCase() ?? '?'}
        </div>
        <span className="text-sm font-medium text-primary">{peerName}</span>
        {matrixMode && (
          <span className="ml-2">
            <ConversationProtection roomId={activeConversationId} />
          </span>
        )}
        {matrixMode && (
          <button
            onClick={() => void handleToggleBlocked()}
            disabled={isBlockBusy}
            className="ml-auto rounded px-2 py-1 text-meta font-medium text-muted transition-colors hover:bg-red/10 hover:text-red disabled:opacity-50"
            aria-label={isBlocked ? `Unblock ${peerName}` : `Block ${peerName}`}
          >
            {isBlockBusy ? 'Saving…' : isBlocked ? 'Unblock' : 'Block'}
          </button>
        )}
      </div>

      {/* Messages */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto py-4">
        {isLoading ? (
          <div className="flex h-full items-center justify-center">
            <p className="text-sm text-muted">Loading messages...</p>
          </div>
        ) : channelMessages.length === 0 ? (
          <div className="flex h-full items-center justify-center">
            <div className="rounded-panel border border-border-subtle bg-surface-raised/50 px-8 py-7 text-center shadow-pane backdrop-blur-xl">
              <p className="mb-1 text-sm text-secondary">Start of conversation</p>
              <p className="text-2xs text-muted">Send a message to {peerName}</p>
            </div>
          </div>
        ) : (
          <div className="space-y-0.5">
            {channelMessages.map((msg, index) => (
              <DmMessageBoundary
                key={msg?.id ?? `malformed-message-${index}`}
                messageId={msg?.id ?? `malformed-message-${index}`}
              >
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
                  className={`group relative px-4 ${!isGrouped ? 'pt-2' : 'pt-0.5'}`}
                  onMouseEnter={() => setHoveredMessageId(msg.id)}
                  onMouseLeave={() => {
                    setHoveredMessageId(null)
                    setReactionTargetId(null)
                  }}
                >
                  {!isGrouped && (
                    <div className="mb-0.5 flex items-center gap-2">
                      <div
                        className="flex h-6 w-6 items-center justify-center rounded-full text-micro font-semibold text-content-on-status/90"
                        data-design-token-exception="data-driven-federated-avatar-color"
                        style={{ backgroundColor: msg.authorAvatarColor }}
                      >
                        {msg.authorDisplayName[0]?.toUpperCase() ?? '?'}
                      </div>
                      <span className={`text-xs font-medium ${isOwnMessage ? 'text-accent' : 'text-primary'}`}>
                        {isOwnMessage ? 'You' : msg.authorDisplayName}
                      </span>
                      <span className="font-mono text-2xs text-muted">
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
                          className="w-full resize-none rounded bg-bg-modifier-hover px-2 py-1.5 text-sm text-primary outline-none"
                          rows={Math.min(6, editValue.split('\n').length + 1)}
                          autoFocus
                        />
                        <div className="flex gap-2 text-meta text-muted">
                          <button onClick={() => void handleSaveEdit()} className="text-blue hover:underline">Save</button>
                          <button onClick={() => setEditingMessageId(null)} className="hover:underline">Cancel</button>
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
                            className={`rounded border px-1.5 py-0.5 text-xs ${ownAuthorId && users.includes(ownAuthorId) ? 'border-blue/40 bg-blue/10 text-blue' : 'border-border bg-bg-modifier-hover text-secondary'}`}
                          >
                            {emoji} {users.length}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                  {matrixMode && hoveredMessageId === msg.id && editingMessageId !== msg.id && (
                    <div className="absolute right-4 top-0 z-sticky flex items-center gap-1 rounded border border-border bg-bg-secondary px-1 py-1 shadow-elevation-high">
                      <button
                        onClick={() => setReplyingTo(msg)}
                        className="rounded px-1.5 py-1 text-meta text-muted hover:bg-bg-modifier-hover hover:text-secondary"
                        aria-label="Reply to message"
                      >Reply</button>
                      <button
                        onClick={() => setReactionTargetId(reactionTargetId === msg.id ? null : msg.id)}
                        className="rounded px-1.5 py-1 text-meta text-muted hover:bg-bg-modifier-hover hover:text-secondary"
                        aria-label="Add reaction"
                      >React</button>
                      {isOwnMessage && (
                        <button
                          onClick={() => {
                            setEditingMessageId(msg.id)
                            setEditValue(msg.content)
                          }}
                          className="rounded px-1.5 py-1 text-meta text-muted hover:bg-bg-modifier-hover hover:text-secondary"
                          aria-label="Edit message"
                        >Edit</button>
                      )}
                    </div>
                  )}
                  {matrixMode && reactionTargetId === msg.id && (
                    <div className="absolute right-4 top-8 z-dropdown">
                      <ReactionPicker onSelect={(emoji) => void handleReaction(msg, emoji)} onClose={() => setReactionTargetId(null)} />
                    </div>
                  )}
                </div>
                  )
                }}
              </DmMessageBoundary>
            ))}
          </div>
        )}
      </div>

      {isBlocked && (
        <div className="mx-4 mb-2 rounded border border-red/20 bg-red/5 px-3 py-2 text-xs text-red">
          Messages from this user are blocked. Unblock them to resume this conversation.
        </div>
      )}
      {replyingTo && (
        <div className="mx-4 mb-2 flex items-center justify-between rounded border border-blue/20 bg-blue/5 px-3 py-2 text-xs text-secondary">
          <span>Replying to {replyingTo.authorDisplayName}: {replyingTo.content.slice(0, 80)}</span>
          <button onClick={() => setReplyingTo(null)} className="text-muted hover:text-primary" aria-label="Cancel reply">Cancel</button>
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
