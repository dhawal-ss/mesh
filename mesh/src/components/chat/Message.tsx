import { memo, useState, useEffect, useCallback, useRef } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import type { Message as MessageType } from '../../types/ipc'
import { Avatar } from '../ui/Avatar'
import { ReactionPicker } from './ReactionPicker'
import { MarkdownContent } from './MarkdownContent'
import { useCommunityStore } from '../../store/communities'
import { useIdentityStore } from '../../store/identity'
import { useChannelStore } from '../../store/channels'
import { useMessageStore } from '../../store/messages'
import { useCommunityMembers } from '../../store/membership'
import { useServerEmoji } from '../../store/custom-emoji'
import * as bridge from '../../lib/bridge'
import { useFileDownloadStore } from '../../store/file-downloads'
import { useRoomPinStore } from '../../store/room-pins'
import { formatFederatedTimestamp } from '../../lib/federated-time'
import { describeError } from '../../lib/errors'
import { summarizeModerationResult } from '../../lib/moderation'
import { transitions } from '../../lib/motion'
import { Icon } from '../ui/Icon'
import { showToast } from '../ui/Toast'
import { EncryptedAttachmentPreview } from './EncryptedAttachmentPreview'
import { ProtectedImageLightbox } from './ProtectedImageLightbox'
import { ContextMenu, type MenuItem } from '../ui/InteractivePrimitives'

interface MessageProps {
  message: MessageType
  isGrouped: boolean
  disableMotion?: boolean
  onReply?: (message: MessageType) => void
  onRetry?: (message: MessageType) => void
  onCancel?: (message: MessageType) => void
  replyPreview?: MessageType | null
  limitedActions?: boolean
  editRequestToken?: number
}

export const MessageComponent = memo(function MessageComponent({
  message,
  isGrouped,
  onReply,
  onRetry,
  onCancel,
  replyPreview,
  limitedActions = false,
  editRequestToken = 0,
}: MessageProps) {
  const [hovered, setHovered] = useState(false)
  const [showReactions, setShowReactions] = useState(false)
  const [contextMenuOpen, setContextMenuOpen] = useState(false)
  const [isEditing, setIsEditing] = useState(false)
  const [editContent, setEditContent] = useState('')
  const [confirmBan, setConfirmBan] = useState(false)
  const [activeImageAttachmentIndex, setActiveImageAttachmentIndex] = useState<number | null>(null)
  const rowRef = useRef<HTMLDivElement>(null)
  const reactButtonRef = useRef<HTMLButtonElement>(null)
  const matrixMode = bridge.isMatrixBackend()
  const activeCommunityId = useCommunityStore((s) => s.activeCommunityId)
  const communityMembers = useCommunityMembers(activeCommunityId)
  const customEmoji = useServerEmoji(activeCommunityId)
  const myRole = useCommunityStore((s) =>
    s.activeCommunityId ? s.communityEntities[s.activeCommunityId]?.role : undefined,
  )
  const legacyPublicKey = useIdentityStore((s) => s.identity?.publicKey)
  const myPublicKey = bridge.isMatrixBackend() ? (bridge.getMatrixUserId() ?? undefined) : legacyPublicKey
  const activeChannelId = useChannelStore((s) => s.activeChannelId)
  const updateReaction = useMessageStore((s) => s.updateReaction)
  const editMessage = useMessageStore((s) => s.editMessage)
  const deleteMessage = useMessageStore((s) => s.deleteMessage)
  const isPinned = useRoomPinStore((state) => state.roomId === message.channelId && state.eventIds.includes(message.id))
  const canManagePins = useRoomPinStore((state) => state.roomId === message.channelId && state.canManage)
  const toggleRoomPin = useRoomPinStore((state) => state.toggle)

  const isOwnMessage = myPublicKey === message.authorPublicKey
  const canModerate = myRole === 'owner' || myRole === 'admin'
  const isDeleted = !!message.deletedAt
  const isQueued = !!message.transactionId && message.deliveryStatus !== 'sent'
  const canPinMessage = matrixMode && canManagePins && message.id.startsWith('$')
  const imageAttachmentIndexes = (message.attachments ?? []).flatMap((attachment, index) =>
    attachment.thumbnail ? [index] : [],
  )
  const activeImagePosition =
    activeImageAttachmentIndex === null ? -1 : imageAttachmentIndexes.indexOf(activeImageAttachmentIndex)
  const activeImageAttachment =
    activeImagePosition < 0 ? undefined : message.attachments[imageAttachmentIndexes[activeImagePosition]]

  const handleRowKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape' && showReactions) {
      setShowReactions(false)
      reactButtonRef.current?.focus()
    }
  }

  // Tabbing focus away from the row entirely — e.g. past the last emoji
  // button to the next message — should close the picker too, not just
  // Escape/mouseleave. Only skip closing when we can prove focus landed on
  // another descendant of this row; an absent relatedTarget (e.g. focus
  // leaving the document) is treated as "left" rather than assumed safe.
  const handleRowBlur = (e: React.FocusEvent) => {
    if (!showReactions) return
    if (e.relatedTarget && e.currentTarget.contains(e.relatedTarget as Node)) return
    setShowReactions(false)
  }

  const handleBan = async () => {
    if (!activeCommunityId) return
    try {
      const result = await bridge.banUser(activeCommunityId, message.authorPublicKey)
      const summary = summarizeModerationResult(result, `${message.authorDisplayName} was banned`)
      showToast(summary.message, summary.tone)
    } catch (e) {
      console.error('Failed to ban:', e)
    }
    setContextMenuOpen(false)
    setConfirmBan(false)
  }

  const handleKick = useCallback(async () => {
    if (!activeCommunityId) return
    try {
      const result = await bridge.kickUser(activeCommunityId, message.authorPublicKey)
      const summary = summarizeModerationResult(result, `${message.authorDisplayName} was removed`)
      showToast(summary.message, summary.tone)
    } catch (e) {
      console.error('Kick failed:', e)
    }
    setContextMenuOpen(false)
  }, [activeCommunityId, message.authorDisplayName, message.authorPublicKey])

  const handleTimeout = useCallback(async () => {
    if (!activeCommunityId) return
    try {
      await bridge.timeoutUser(activeCommunityId, message.authorPublicKey, 60)
    } catch (e) {
      console.error('Timeout failed:', e)
    }
    setContextMenuOpen(false)
  }, [activeCommunityId, message.authorPublicKey])

  const handleStartEdit = useCallback(() => {
    setEditContent(message.content)
    setIsEditing(true)
    setContextMenuOpen(false)
  }, [message.content])

  useEffect(() => {
    if (editRequestToken > 0 && isOwnMessage && !isDeleted && !isQueued) {
      handleStartEdit()
    }
  }, [editRequestToken, handleStartEdit, isDeleted, isOwnMessage, isQueued])

  const handleSaveEdit = useCallback(async () => {
    const trimmed = editContent.trim()
    if (!trimmed || trimmed === message.content) {
      setIsEditing(false)
      return
    }
    try {
      const channelId = activeChannelId ?? message.channelId
      await bridge.editMessage(message.id, trimmed, channelId)
      if (channelId) {
        editMessage(channelId, message.id, trimmed, new Date().toISOString())
      }
    } catch (e) {
      console.error('Failed to edit message:', e)
    }
    setIsEditing(false)
  }, [editContent, message.content, message.id, message.channelId, activeChannelId, editMessage])

  const handleCancelEdit = useCallback(() => {
    setIsEditing(false)
    setEditContent('')
  }, [])

  const handleDelete = useCallback(async () => {
    try {
      const channelId = activeChannelId ?? message.channelId
      await bridge.deleteMessage(message.id, channelId)
      if (channelId) {
        deleteMessage(channelId, message.id)
      }
    } catch (e) {
      console.error('Failed to delete message:', e)
    }
    setContextMenuOpen(false)
    // No rowRef.current?.focus() here, unlike ban/kick/timeout: deleting
    // removes this row from the DOM, so there's nothing sensible to focus.
  }, [message.id, message.channelId, activeChannelId, deleteMessage])

  const handleEditKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        void handleSaveEdit()
      } else if (e.key === 'Escape') {
        handleCancelEdit()
      }
    },
    [handleSaveEdit, handleCancelEdit],
  )

  const handleReaction = async (emoji: string) => {
    const channelId = activeChannelId ?? message.channelId
    if (!channelId) return

    const alreadyReacted = myPublicKey ? (message.reactions[emoji] ?? []).includes(myPublicKey) : false
    const verb = alreadyReacted ? 'remove' : 'add'

    if (myPublicKey) {
      updateReaction(channelId, message.id, emoji, myPublicKey, verb as 'add' | 'remove')
    }

    try {
      await bridge.addReaction(message.id, emoji, channelId)
    } catch (e) {
      if (myPublicKey) {
        const revertVerb = verb === 'add' ? 'remove' : 'add'
        updateReaction(channelId, message.id, emoji, myPublicKey, revertVerb as 'add' | 'remove')
      }
      console.error('Failed to add reaction:', e)
    }
  }

  const handlePin = async () => {
    await toggleRoomPin(message.channelId, message)
    setContextMenuOpen(false)
  }

  const contextMenuItems: MenuItem[] = []
  if (canPinMessage && !isDeleted) {
    contextMenuItems.push({
      id: 'pin',
      label: isPinned ? 'Unpin Message' : 'Pin Message',
      onSelect: () => void handlePin(),
    })
  }
  if (isOwnMessage && !isDeleted) {
    contextMenuItems.push(
      {
        id: 'edit',
        label: 'Edit Message',
        onSelect: handleStartEdit,
      },
      {
        id: 'delete',
        label: 'Delete Message',
        tone: 'danger',
        onSelect: () => void handleDelete(),
      },
    )
  }
  if (!limitedActions && canModerate && !isOwnMessage && !isDeleted) {
    contextMenuItems.push(
      {
        id: 'remove',
        label: 'Remove Message',
        onSelect: () => void handleDelete(),
      },
      {
        id: 'kick',
        label: 'Kick User',
        onSelect: () => void handleKick(),
      },
    )
    if (!matrixMode) {
      contextMenuItems.push({
        id: 'timeout',
        label: 'Timeout (1hr)',
        onSelect: () => void handleTimeout(),
      })
    }
    contextMenuItems.push({
      id: 'ban',
      label: confirmBan ? 'Confirm Ban?' : `Ban ${message.authorDisplayName}`,
      tone: 'danger',
      onSelect: (event) => {
        if (!confirmBan) {
          event.preventDefault()
          setConfirmBan(true)
          return
        }
        void handleBan()
      },
    })
  }
  if (contextMenuItems.length === 0) {
    contextMenuItems.push({
      id: 'no-actions',
      label: 'No actions available',
      disabled: true,
    })
  }

  const deliveryLabel =
    message.deliveryStatus === 'pending'
      ? ', saved on this device and waiting to send'
      : message.deliveryStatus === 'failed'
        ? ', delivery needs attention'
        : ''
  const messageAriaLabel = `Message from ${message.authorDisplayName}, ${formatFederatedTimestamp(message.timestamp, 'MM/dd/yyyy h:mm a')}${deliveryLabel}`

  return (
    <>
      <ContextMenu
        label="Message actions"
        items={contextMenuItems}
        disabled={isQueued || (limitedActions && !isOwnMessage)}
        open={contextMenuOpen}
        onOpenChange={(open) => {
          setContextMenuOpen(open)
          if (!open) setConfirmBan(false)
        }}
      >
        <div
          ref={rowRef}
          role="group"
          aria-label={messageAriaLabel}
          tabIndex={-1}
          className={`group relative flex gap-3 py-0.5 pl-message-gutter pr-12 outline-none transition-opacity duration-fast hover:bg-surface-hover ${
            message.deliveryStatus === 'pending' ? 'opacity-60' : 'opacity-100'
          } ${!isGrouped ? 'mt-message-group' : ''}`}
          onMouseEnter={() => setHovered(true)}
          onMouseLeave={() => {
            setHovered(false)
            setShowReactions(false)
          }}
          onKeyDown={handleRowKeyDown}
          onBlur={handleRowBlur}
        >
          {/* Avatar — absolute positioned in left gutter */}
          <div className="absolute left-4 top-0.5 w-8">
            {!isGrouped ? (
              <Avatar color={message.authorAvatarColor} size={32} name={message.authorDisplayName} />
            ) : (
              <span
                className={`tnum flex h-full items-center justify-end pr-1 text-meta text-muted transition-opacity ${
                  hovered ? 'opacity-100' : 'opacity-0'
                }`}
              >
                {formatFederatedTimestamp(message.timestamp, 'HH:mm')}
              </span>
            )}
          </div>

          {/* Content */}
          <div className="min-w-0 flex-1">
            {!isGrouped && (
              <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0">
                <span className="text-sm font-semibold text-primary">{message.authorDisplayName}</span>
                {matrixMode && message.authorPublicKey.startsWith('@') && (
                  <span className="identifier max-w-full truncate font-mono text-caption text-muted">
                    {message.authorPublicKey}
                  </span>
                )}
                <span className="tnum text-meta text-muted">
                  {formatFederatedTimestamp(message.timestamp, 'MM/dd/yyyy h:mm a')}
                </span>
              </div>
            )}

            {message.deliveryStatus === 'pending' && (
              <div role="status" className="mt-1 inline-flex items-center gap-1 text-meta text-status-warning">
                <Icon name="loader" size="xs" className="animate-spin" />
                Saved on this device · Waiting to send
              </div>
            )}

            {message.deliveryStatus === 'failed' && (
              <motion.div
                role="alert"
                className="mt-1 flex flex-wrap items-center gap-2 text-meta text-status-danger"
                initial={{ x: 0 }}
                animate={{ x: [0, -2, 2, 0] }}
                transition={transitions.failure}
              >
                <span>Delivery needs attention.</span>
                <button
                  type="button"
                  onClick={() => onRetry?.(message)}
                  className="min-h-control-sm rounded-control bg-status-danger/10 px-2 font-medium transition-colors hover:bg-status-danger/20 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
                >
                  Retry
                </button>
                {onCancel && (
                  <button
                    type="button"
                    onClick={() => onCancel(message)}
                    className="min-h-control-sm rounded-control px-2 font-medium text-secondary transition-colors hover:bg-surface-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
                  >
                    Cancel
                  </button>
                )}
              </motion.div>
            )}

            {/* Reply preview */}
            {replyPreview && (
              <div className="mb-1 flex items-center gap-1.5 text-sm">
                <Icon name="reply" size="xs" className="text-muted" />
                <span className="text-xs font-medium text-secondary">{replyPreview.authorDisplayName}</span>
                <span className="truncate text-xs text-muted">{replyPreview.content.slice(0, 80)}</span>
              </div>
            )}

            {isEditing ? (
              <div className="mt-1 space-y-2">
                <textarea
                  value={editContent}
                  onChange={(e) => setEditContent(e.target.value)}
                  onKeyDown={handleEditKeyDown}
                  className="w-full resize-none rounded-control border border-border bg-surface-sunken px-3 py-2 text-sm text-primary outline-none focus:border-accent"
                  rows={Math.min(8, editContent.split('\n').length + 1)}
                  autoFocus
                />
                <div className="flex items-center gap-2 text-meta text-muted">
                  <span>
                    escape to{' '}
                    <button onClick={handleCancelEdit} className="text-text-link hover:underline">
                      cancel
                    </button>
                  </span>
                  <span>•</span>
                  <span>
                    enter to{' '}
                    <button onClick={() => void handleSaveEdit()} className="text-text-link hover:underline">
                      save
                    </button>
                  </span>
                </div>
              </div>
            ) : (
              <>
                <MarkdownContent
                  content={message.content}
                  members={communityMembers}
                  customEmoji={customEmoji}
                  ownUserId={myPublicKey ?? null}
                />
                {message.editedAt && <span className="ml-1 text-caption text-muted">(edited)</span>}
              </>
            )}

            {/* File attachments */}
            {message.attachments && message.attachments.length > 0 && (
              <div className="mt-2 flex flex-col gap-2">
                {message.attachments.map((att, attachmentIndex) => (
                  <FileAttachmentCard
                    key={att.fileHash}
                    attachment={att}
                    roomId={message.channelId}
                    eventId={message.id}
                    attachmentIndex={attachmentIndex}
                    onOpenImage={att.thumbnail ? () => setActiveImageAttachmentIndex(attachmentIndex) : undefined}
                  />
                ))}
              </div>
            )}

            {/* Reactions */}
            {Object.keys(message.reactions).length > 0 && (
              <div className="mt-1 flex flex-wrap gap-1">
                {Object.entries(message.reactions).map(([emoji, users]) => {
                  const custom = customEmoji.find((candidate) => `:${candidate.shortcode}:` === emoji)
                  return (
                    <button
                      key={emoji}
                      onClick={() => handleReaction(emoji)}
                      className={`inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-xs transition-colors ${
                        myPublicKey && users.includes(myPublicKey)
                          ? 'border-accent/40 bg-accent/10 text-accent'
                          : 'border-border bg-surface-hover text-secondary hover:border-border-light'
                      }`}
                    >
                      <motion.span initial={{ scale: 0.8 }} animate={{ scale: 1 }} transition={transitions.reaction}>
                        {custom ? (
                          <img
                            src={custom.imageUrl}
                            alt={emoji}
                            title={custom.body}
                            className="h-4 w-4 object-contain"
                          />
                        ) : (
                          emoji
                        )}
                      </motion.span>
                      <span className="badge-count text-meta">{users.length}</span>
                    </button>
                  )
                })}
              </div>
            )}
          </div>

          {/* Action bar — always mounted (not just on hover) so Tab can reach it;
            group-hover/group-focus-within reveal it visually, matching the
            volume-slider pattern in VoicePeerGrid.tsx. pointer-events-none at
            rest keeps the invisible bar from intercepting clicks meant for
            the grouped message rendered underneath it (-top-4 overlap). */}
          {!contextMenuOpen && !isEditing && !isDeleted && !isQueued && (
            <div className="mesh-message-actions pointer-events-none absolute -top-4 right-4 z-sticky flex items-center rounded-panel border border-border-subtle bg-surface-overlay opacity-0 shadow-overlay transition-opacity group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100">
              <button
                ref={reactButtonRef}
                onClick={() => setShowReactions(!showReactions)}
                className="flex h-8 w-8 items-center justify-center text-muted transition-colors hover:bg-surface-hover hover:text-secondary focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
                aria-label={`React to message from ${message.authorDisplayName}`}
                aria-expanded={showReactions}
              >
                <Icon name="smile" size="sm" />
              </button>
              {isOwnMessage && (
                <button
                  onClick={handleStartEdit}
                  className="flex h-8 w-8 items-center justify-center text-muted transition-colors hover:bg-surface-hover hover:text-secondary focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
                  aria-label="Edit message"
                >
                  <Icon name="squarePen" size="sm" />
                </button>
              )}
              {onReply && (
                <button
                  onClick={() => onReply(message)}
                  className="flex h-8 w-8 items-center justify-center text-muted transition-colors hover:bg-surface-hover hover:text-secondary focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
                  aria-label={`Reply to ${message.authorDisplayName}`}
                >
                  <Icon name="reply" size="sm" />
                </button>
              )}
              {canPinMessage && (
                <button
                  onClick={() => void handlePin()}
                  className={`flex h-8 w-8 items-center justify-center transition-colors hover:bg-surface-hover hover:text-secondary focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent ${
                    isPinned ? 'text-accent' : 'text-muted'
                  }`}
                  aria-label={isPinned ? 'Unpin message' : 'Pin message'}
                >
                  <Icon name="pin" size="sm" />
                </button>
              )}
            </div>
          )}

          {/* Reaction picker */}
          <AnimatePresence>
            {showReactions && (
              <div className="absolute -top-10 right-4 z-popover">
                <ReactionPicker
                  onSelect={handleReaction}
                  onClose={() => setShowReactions(false)}
                  customEmoji={customEmoji}
                />
              </div>
            )}
          </AnimatePresence>
        </div>
      </ContextMenu>

      {activeImageAttachment && activeImageAttachmentIndex !== null && activeImageAttachment.thumbnail && (
        <ProtectedImageLightbox
          key={`${message.id}:${activeImageAttachmentIndex}`}
          filename={activeImageAttachment.filename}
          roomId={message.channelId}
          eventId={message.id}
          attachmentIndex={activeImageAttachmentIndex}
          thumbnail={activeImageAttachment.thumbnail}
          imagePosition={activeImagePosition}
          imageCount={imageAttachmentIndexes.length}
          onPrevious={() => {
            const previousPosition =
              (activeImagePosition - 1 + imageAttachmentIndexes.length) % imageAttachmentIndexes.length
            setActiveImageAttachmentIndex(imageAttachmentIndexes[previousPosition])
          }}
          onNext={() => {
            const nextPosition = (activeImagePosition + 1) % imageAttachmentIndexes.length
            setActiveImageAttachmentIndex(imageAttachmentIndexes[nextPosition])
          }}
          onClose={() => setActiveImageAttachmentIndex(null)}
        />
      )}
    </>
  )
})

export function FileAttachmentCard({
  attachment,
  roomId,
  eventId,
  attachmentIndex,
  onOpenImage,
}: {
  attachment: MessageType['attachments'][number]
  roomId: string
  eventId: string
  attachmentIndex: number
  onOpenImage?: () => void
}) {
  const download = useFileDownloadStore((s) => s.downloads[attachment.fileHash])
  const sourcePeerId = attachment.sourcePeerId
  const matrixMode = bridge.isMatrixBackend()

  useEffect(() => {
    if (!matrixMode) return
    let active = true
    let unlisten: (() => void) | undefined
    void bridge
      .onMatrixTransferProgress((payload) => {
        if (!active || payload.direction !== 'download') return
        const current = useFileDownloadStore.getState().downloads[attachment.fileHash]
        if (current?.transferId !== payload.transferId) return
        useFileDownloadStore.getState().updateMatrixTransferProgress(payload)
      })
      .then((stopListening) => {
        if (active) unlisten = stopListening
        else stopListening()
      })
    return () => {
      active = false
      unlisten?.()
    }
  }, [attachment.fileHash, matrixMode])

  const progressPercent = (() => {
    const totalBytes = download?.totalBytes ?? attachment.size
    const receivedBytes = download?.receivedBytes ?? 0
    if (totalBytes > 0) return Math.min(100, Math.round((receivedBytes / totalBytes) * 100))
    const totalChunks = download?.totalChunks ?? attachment.chunks
    const receivedChunks = download?.receivedChunks ?? 0
    if (totalChunks > 0) return Math.min(100, Math.round((receivedChunks / totalChunks) * 100))
    return 0
  })()

  const startDownload = async () => {
    if (matrixMode) {
      const matrixSourcePeerId = sourcePeerId || 'matrix'
      const transferId = bridge.createMatrixTransferId()
      useFileDownloadStore.getState().startDownload({
        fileHash: attachment.fileHash,
        filename: attachment.filename,
        sourcePeerId: matrixSourcePeerId,
        size: attachment.size,
        chunks: attachment.chunks,
        transferId,
      })
      try {
        const localPath = await bridge.matrixDownloadAttachment(roomId, eventId, attachmentIndex, transferId)
        useFileDownloadStore.getState().markDownloadAvailable({
          fileHash: attachment.fileHash,
          localPath,
        })
      } catch (error) {
        console.error('Failed to download encrypted attachment:', error)
        useFileDownloadStore
          .getState()
          .markDownloadFailed(attachment.fileHash, attachmentErrorMessage(error, 'download this attachment'))
      }
      return
    }

    if (!sourcePeerId) {
      useFileDownloadStore
        .getState()
        .markDownloadFailed(attachment.fileHash, 'Download unavailable for this cached attachment')
      return
    }
    useFileDownloadStore.getState().startDownload({
      fileHash: attachment.fileHash,
      filename: attachment.filename,
      sourcePeerId,
      size: attachment.size,
      chunks: attachment.chunks,
    })
    try {
      await bridge.requestFile({
        fileHash: attachment.fileHash,
        sourcePeerId,
        filename: attachment.filename,
        size: attachment.size,
        chunks: attachment.chunks,
      })
    } catch (error) {
      console.error('Failed to start attachment download:', error)
      useFileDownloadStore
        .getState()
        .markDownloadFailed(attachment.fileHash, attachmentErrorMessage(error, 'start this download'))
    }
  }

  const handleOpen = async () => {
    if (!download?.localPath) return
    await bridge.openDownloadedFile(download.localPath)
  }

  const cancelDownload = async () => {
    if (!matrixMode || download?.status !== 'downloading') return
    try {
      await bridge.matrixCancelAttachmentDownload(attachment.fileHash)
    } catch (error) {
      console.error('Failed to cancel attachment download:', error)
      useFileDownloadStore
        .getState()
        .markDownloadFailed(attachment.fileHash, attachmentErrorMessage(error, 'cancel this download'))
    }
  }

  const status = download?.status ?? 'idle'
  const isDownloading = status === 'downloading'
  const isCompleted = status === 'completed'
  const isErrored = status === 'error'

  return (
    <div className="max-w-sm overflow-hidden rounded-panel border border-border-subtle bg-surface-raised">
      {matrixMode && attachment.thumbnail && (
        <EncryptedAttachmentPreview
          key={`${eventId}:${attachmentIndex}:${attachment.thumbnail.fileHash}`}
          filename={attachment.filename}
          roomId={roomId}
          eventId={eventId}
          attachmentIndex={attachmentIndex}
          thumbnail={attachment.thumbnail}
          onOpen={onOpenImage}
        />
      )}

      <div className="flex items-center gap-3 p-3">
        <div className="flex h-10 w-10 items-center justify-center rounded-panel bg-surface-hover text-muted">
          <Icon name="fileText" />
        </div>

        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium text-text-link">{attachment.filename}</div>
          <div className="text-xs text-muted">{(attachment.size / 1024 / 1024).toFixed(2)} MB</div>

          {isDownloading && (
            <div className="mt-1.5">
              <div className="h-1 overflow-hidden rounded-full bg-surface-active">
                <div
                  className="h-full rounded-full bg-accent transition-[width] duration-normal"
                  data-design-token-exception="data-driven-transfer-progress-width"
                  style={{ width: `${progressPercent}%` }}
                />
              </div>
              {download?.matrixState && (
                <div className="mt-1 text-caption capitalize text-muted">{download.matrixState}</div>
              )}
            </div>
          )}
          {isErrored && <div className="mt-1 text-xs text-status-danger">{download?.error ?? 'Download failed'}</div>}
        </div>

        <button
          onClick={isCompleted ? handleOpen : isDownloading && matrixMode ? cancelDownload : startDownload}
          disabled={isDownloading && !matrixMode}
          className={`rounded px-3 py-1.5 text-xs font-medium transition-colors ${
            isCompleted
              ? 'bg-status-success/20 text-status-success hover:bg-status-success/30'
              : isErrored
                ? 'bg-status-danger/10 text-status-danger hover:bg-status-danger/15'
                : 'bg-surface-hover text-secondary hover:bg-surface-active'
          } disabled:opacity-60`}
          aria-label={
            isCompleted
              ? `Open ${attachment.filename}`
              : isDownloading && matrixMode
                ? `Cancel download of ${attachment.filename}`
                : `Download ${attachment.filename}`
          }
        >
          {isCompleted
            ? 'Open'
            : isDownloading && matrixMode
              ? 'Cancel'
              : isDownloading
                ? `${progressPercent}%`
                : isErrored && download?.retryMode === 'restart-from-zero'
                  ? 'Restart'
                  : isErrored
                    ? 'Retry'
                    : 'Download'}
        </button>
      </div>
    </div>
  )
}

function attachmentErrorMessage(error: unknown, operation: string): string {
  const description = describeError(error, { operation })
  return `${description.title}. ${description.body}`
}
