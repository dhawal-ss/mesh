import { memo, useState, useEffect, useCallback } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import type { Message as MessageType } from '../../types/ipc'
import { Avatar } from '../ui/Avatar'
import { ReactionPicker } from './ReactionPicker'
import { MarkdownContent } from './MarkdownContent'
import { useCommunityStore } from '../../store/communities'
import { useIdentityStore } from '../../store/identity'
import { useChannelStore } from '../../store/channels'
import { useMessageStore } from '../../store/messages'
import * as bridge from '../../lib/bridge'
import { useFileDownloadStore } from '../../store/file-downloads'
import { formatFederatedTimestamp } from '../../lib/federated-time'
import { describeError } from '../../lib/errors'
import { variants } from '../../lib/motion'
import { Icon } from '../ui/Icon'

interface MessageProps {
  message: MessageType
  isGrouped: boolean
  disableMotion?: boolean
  onReply?: (message: MessageType) => void
  onRetry?: (message: MessageType) => void
  replyPreview?: MessageType | null
  limitedActions?: boolean
  editRequestToken?: number
}

export const MessageComponent = memo(function MessageComponent({
  message,
  isGrouped,
  onReply,
  onRetry,
  replyPreview,
  limitedActions = false,
  editRequestToken = 0,
}: MessageProps) {
  const [hovered, setHovered] = useState(false)
  const [showReactions, setShowReactions] = useState(false)
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null)
  const [isEditing, setIsEditing] = useState(false)
  const [editContent, setEditContent] = useState('')
  const [confirmBan, setConfirmBan] = useState(false)
  const matrixMode = bridge.isMatrixBackend()
  const activeCommunityId = useCommunityStore((s) => s.activeCommunityId)
  const myRole = useCommunityStore((s) =>
    s.activeCommunityId ? s.communityEntities[s.activeCommunityId]?.role : undefined,
  )
  const legacyPublicKey = useIdentityStore((s) => s.identity?.publicKey)
  const myPublicKey = bridge.isMatrixBackend() ? bridge.getMatrixUserId() ?? undefined : legacyPublicKey
  const activeChannelId = useChannelStore((s) => s.activeChannelId)
  const updateReaction = useMessageStore((s) => s.updateReaction)
  const editMessage = useMessageStore((s) => s.editMessage)
  const deleteMessage = useMessageStore((s) => s.deleteMessage)

  const isOwnMessage = myPublicKey === message.authorPublicKey
  const canModerate = myRole === 'owner' || myRole === 'admin'
  const isDeleted = !!message.deletedAt

  useEffect(() => {
    if (!contextMenu) return
    const handleClick = () => {
      setContextMenu(null)
      setConfirmBan(false)
    }
    window.addEventListener('click', handleClick)
    return () => window.removeEventListener('click', handleClick)
  }, [contextMenu])

  const handleContextMenu = (e: React.MouseEvent) => {
    if (limitedActions && !isOwnMessage) return
    e.preventDefault()
    setContextMenu({ x: e.clientX, y: e.clientY })
    setConfirmBan(false)
  }

  const handleBan = async () => {
    if (!activeCommunityId) return
    if (!confirmBan) {
      setConfirmBan(true)
      return
    }
    try {
      await bridge.banUser(activeCommunityId, message.authorPublicKey)
    } catch (e) {
      console.error('Failed to ban:', e)
    }
    setContextMenu(null)
    setConfirmBan(false)
  }

  const handleKick = useCallback(async () => {
    if (!activeCommunityId) return
    try {
      await bridge.kickUser(activeCommunityId, message.authorPublicKey)
    } catch (e) {
      console.error('Kick failed:', e)
    }
    setContextMenu(null)
  }, [activeCommunityId, message.authorPublicKey])

  const handleTimeout = useCallback(async () => {
    if (!activeCommunityId) return
    try {
      await bridge.timeoutUser(activeCommunityId, message.authorPublicKey, 60)
    } catch (e) {
      console.error('Timeout failed:', e)
    }
    setContextMenu(null)
  }, [activeCommunityId, message.authorPublicKey])

  const handleStartEdit = useCallback(() => {
    setEditContent(message.content)
    setIsEditing(true)
    setContextMenu(null)
  }, [message.content])

  useEffect(() => {
    if (editRequestToken > 0 && isOwnMessage && !isDeleted) handleStartEdit()
  }, [editRequestToken, handleStartEdit, isDeleted, isOwnMessage])

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
    setContextMenu(null)
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

    const alreadyReacted = myPublicKey
      ? (message.reactions[emoji] ?? []).includes(myPublicKey)
      : false
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

  return (
    <>
      <div
        className={`group relative flex gap-4 py-0.5 pl-message-gutter pr-12 hover:bg-bg-modifier-hover ${
          !isGrouped ? 'mt-message-group' : ''
        }`}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => {
          setHovered(false)
          setShowReactions(false)
        }}
        onContextMenu={handleContextMenu}
      >
        {/* Avatar — absolute positioned in left gutter */}
        <div className="absolute left-4 top-0.5 w-10">
          {!isGrouped ? (
            <Avatar color={message.authorAvatarColor} size={40} name={message.authorDisplayName} />
          ) : (
            <span
              className={`flex h-full items-center justify-end pr-1 text-meta text-muted transition-opacity ${
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
            <div className="flex items-baseline gap-2">
              <span className="text-sm font-medium text-primary">
                {message.authorDisplayName}
              </span>
              <span className="text-meta text-muted">
                {formatFederatedTimestamp(message.timestamp, 'MM/dd/yyyy h:mm a')}
              </span>
              {message.deliveryStatus && message.deliveryStatus !== 'sent' && (
                <span
                  className={`ml-1 inline-flex items-center gap-1 text-meta ${
                    message.deliveryStatus === 'pending'
                      ? 'text-yellow'
                      : 'text-red'
                  }`}
                >
                  {message.deliveryStatus === 'pending' ? (
                    <Icon name="loader" size="xs" className="animate-spin" />
                  ) : (
                    'Failed'
                  )}
                </span>
              )}
            </div>
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
                className="w-full resize-none rounded-lg bg-surface-raised px-3 py-2 text-sm text-primary outline-none"
                rows={Math.min(8, editContent.split('\n').length + 1)}
                autoFocus
              />
              <div className="flex items-center gap-2 text-meta text-muted">
                <span>escape to <button onClick={handleCancelEdit} className="text-text-link hover:underline">cancel</button></span>
                <span>•</span>
                <span>enter to <button onClick={() => void handleSaveEdit()} className="text-text-link hover:underline">save</button></span>
              </div>
            </div>
          ) : (
            <>
              <MarkdownContent content={message.content} />
              {message.editedAt && (
                <span className="ml-1 text-caption text-muted">(edited)</span>
              )}
            </>
          )}

          {/* Retry button for failed messages */}
          {message.deliveryStatus === 'failed' && (
            <button
              onClick={() => { if (onRetry) onRetry(message) }}
              className="mt-1 inline-flex items-center gap-1 rounded bg-red/10 px-2 py-1 text-meta font-medium text-red transition-colors hover:bg-red/20"
            >
              <Icon name="refresh" size="xs" />
              Retry
            </button>
          )}

          {/* File attachments */}
          {message.attachments && message.attachments.length > 0 && (
            <div className="mt-2 flex flex-col gap-2">
              {message.attachments.map((att) => (
                <FileAttachmentCard key={att.fileHash} attachment={att} />
              ))}
            </div>
          )}

          {/* Reactions */}
          {Object.keys(message.reactions).length > 0 && (
            <div className="mt-1 flex flex-wrap gap-1">
              {Object.entries(message.reactions).map(([emoji, users]) => (
                <button
                  key={emoji}
                  onClick={() => handleReaction(emoji)}
                  className={`inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-xs transition-colors ${
                    myPublicKey && users.includes(myPublicKey)
                      ? 'border-blue/40 bg-blue/10 text-blue'
                      : 'border-border bg-bg-modifier-hover text-secondary hover:border-border-light'
                  }`}
                >
                  <span>{emoji}</span>
                  <span className="text-meta">{users.length}</span>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Hover action bar */}
        {hovered && !contextMenu && !isEditing && !isDeleted && (
          <div
            className="absolute -top-4 right-4 z-sticky flex items-center rounded-md border border-border bg-bg-secondary shadow-elevation-high"
          >
            <button
              onClick={() => setShowReactions(!showReactions)}
              className="flex h-8 w-8 items-center justify-center text-muted transition-colors hover:bg-bg-modifier-hover hover:text-secondary"
              aria-label="Add reaction"
            >
              <Icon name="smile" size="sm" />
            </button>
            {isOwnMessage && (
              <button
                onClick={handleStartEdit}
                className="flex h-8 w-8 items-center justify-center text-muted transition-colors hover:bg-bg-modifier-hover hover:text-secondary"
                aria-label="Edit message"
              >
                <Icon name="squarePen" size="sm" />
              </button>
            )}
            {onReply && (
              <button
                onClick={() => onReply(message)}
                className="flex h-8 w-8 items-center justify-center text-muted transition-colors hover:bg-bg-modifier-hover hover:text-secondary"
                aria-label="Reply"
              >
                <Icon name="reply" size="sm" />
              </button>
            )}
          </div>
        )}

        {/* Reaction picker */}
        <AnimatePresence>
          {showReactions && (
            <div className="absolute -top-10 right-4 z-dropdown">
              <ReactionPicker onSelect={handleReaction} onClose={() => setShowReactions(false)} />
            </div>
          )}
        </AnimatePresence>
      </div>

      {/* Context menu */}
      <AnimatePresence>
        {contextMenu && (
          <motion.div
            variants={variants.popover}
            initial="initial"
            animate="animate"
            exit="exit"
            className="fixed z-popover w-48 rounded-lg border border-border-subtle bg-bg-floating py-1.5 text-sm shadow-floating"
            data-design-token-exception="data-driven-pointer-position"
            style={{ left: contextMenu.x, top: contextMenu.y }}
            onClick={(e) => e.stopPropagation()}
          >
            {isOwnMessage && !isDeleted && (
              <>
                <button
                  onClick={handleStartEdit}
                  className="mx-1 w-context-action rounded-sm px-2 py-1.5 text-left text-secondary transition-colors hover:bg-status-info hover:text-content-on-status"
                  aria-label="Edit message"
                >
                  Edit Message
                </button>
                <button
                  onClick={() => void handleDelete()}
                  className="mx-1 w-context-action rounded-sm px-2 py-1.5 text-left text-red transition-colors hover:bg-status-danger hover:text-content-on-status"
                  aria-label="Delete message"
                >
                  Delete Message
                </button>
              </>
            )}
            {!limitedActions && canModerate && !isOwnMessage && !isDeleted && (
              <>
                <button
                  onClick={() => void handleDelete()}
                  className="mx-1 w-context-action rounded-sm px-2 py-1.5 text-left text-secondary transition-colors hover:bg-status-info hover:text-content-on-status"
                  aria-label="Remove message"
                >
                  Remove Message
                </button>
                <button
                  onClick={() => void handleKick()}
                  className="mx-1 w-context-action rounded-sm px-2 py-1.5 text-left text-secondary transition-colors hover:bg-status-info hover:text-content-on-status"
                  aria-label={`Kick ${message.authorDisplayName}`}
                >
                  Kick User
                </button>
                {!matrixMode && (
                  <button
                    onClick={() => void handleTimeout()}
                    className="mx-1 w-context-action rounded-sm px-2 py-1.5 text-left text-secondary transition-colors hover:bg-status-info hover:text-content-on-status"
                    aria-label={`Timeout ${message.authorDisplayName}`}
                  >
                    Timeout (1hr)
                  </button>
                )}
                <button
                  onClick={handleBan}
                  className="mx-1 w-context-action rounded-sm px-2 py-1.5 text-left text-red transition-colors hover:bg-status-danger hover:text-content-on-status"
                  aria-label={`Ban ${message.authorDisplayName}`}
                >
                  {confirmBan ? 'Confirm Ban?' : `Ban ${message.authorDisplayName}`}
                </button>
              </>
            )}
            {!isOwnMessage && (!canModerate || limitedActions) && (
              <div className="px-3 py-2 text-muted">No actions available</div>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </>
  )
})

export function FileAttachmentCard({
  attachment,
}: {
  attachment: MessageType['attachments'][number]
}) {
  const download = useFileDownloadStore((s) => s.downloads[attachment.fileHash])
  const sourcePeerId = attachment.sourcePeerId

  useEffect(() => {
    if (!bridge.isMatrixBackend() || !attachment.mediaSource) return
    let active = true
    let unlisten: (() => void) | undefined
    void bridge.onMatrixTransferProgress((payload) => {
      if (!active || payload.direction !== 'download') return
      const current = useFileDownloadStore.getState().downloads[attachment.fileHash]
      if (current?.transferId !== payload.transferId) return
      useFileDownloadStore.getState().updateMatrixTransferProgress(payload)
    }).then((stopListening) => {
      if (active) unlisten = stopListening
      else stopListening()
    })
    return () => {
      active = false
      unlisten?.()
    }
  }, [attachment.fileHash, attachment.mediaSource])

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
    if (bridge.isMatrixBackend() && attachment.mediaSource) {
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
        const localPath = await bridge.matrixDownloadAttachment(attachment, transferId)
        useFileDownloadStore.getState().markDownloadAvailable({
          fileHash: attachment.fileHash,
          localPath,
        })
      } catch (error) {
        console.error('Failed to download encrypted attachment:', error)
        useFileDownloadStore.getState().markDownloadFailed(
          attachment.fileHash,
          attachmentErrorMessage(error, 'download this attachment'),
        )
      }
      return
    }

    if (!sourcePeerId) {
      useFileDownloadStore.getState().markDownloadFailed(
        attachment.fileHash,
        'Download unavailable for this cached attachment',
      )
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
      useFileDownloadStore.getState().markDownloadFailed(
        attachment.fileHash,
        attachmentErrorMessage(error, 'start this download'),
      )
    }
  }

  const handleOpen = async () => {
    if (!download?.localPath) return
    await bridge.openDownloadedFile(download.localPath)
  }

  const cancelDownload = async () => {
    if (!bridge.isMatrixBackend() || download?.status !== 'downloading') return
    try {
      await bridge.matrixCancelAttachmentDownload(attachment.fileHash)
    } catch (error) {
      console.error('Failed to cancel attachment download:', error)
      useFileDownloadStore.getState().markDownloadFailed(
        attachment.fileHash,
        attachmentErrorMessage(error, 'cancel this download'),
      )
    }
  }

  const status = download?.status ?? 'idle'
  const isDownloading = status === 'downloading'
  const isCompleted = status === 'completed'
  const isErrored = status === 'error'

  return (
    <div className="flex max-w-sm items-center gap-3 rounded-lg border border-border bg-bg-secondary p-3">
      <div className="flex h-10 w-10 items-center justify-center rounded bg-bg-modifier-hover text-muted">
        <Icon name="fileText" />
      </div>

      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium text-text-link">{attachment.filename}</div>
        <div className="text-xs text-muted">{(attachment.size / 1024 / 1024).toFixed(2)} MB</div>

        {isDownloading && (
          <div className="mt-1.5">
            <div className="h-1 overflow-hidden rounded-full bg-bg-modifier-hover">
              <div
                className="h-full rounded-full bg-blue transition-[width] duration-normal"
                data-design-token-exception="data-driven-transfer-progress-width"
                style={{ width: `${progressPercent}%` }}
              />
            </div>
            {download?.matrixState && (
              <div className="mt-1 text-caption capitalize text-muted">
                {download.matrixState}
              </div>
            )}
          </div>
        )}
        {isErrored && <div className="mt-1 text-xs text-red">{download?.error ?? 'Download failed'}</div>}
      </div>

      <button
        onClick={isCompleted ? handleOpen : isDownloading && bridge.isMatrixBackend() ? cancelDownload : startDownload}
        disabled={isDownloading && !bridge.isMatrixBackend()}
        className={`rounded px-3 py-1.5 text-xs font-medium transition-colors ${
          isCompleted
            ? 'bg-green/20 text-green hover:bg-green/30'
            : isErrored
              ? 'bg-red/10 text-red hover:bg-red/15'
              : 'bg-bg-modifier-hover text-secondary hover:bg-bg-modifier-active'
        } disabled:opacity-60`}
        aria-label={isCompleted ? `Open ${attachment.filename}` : isDownloading && bridge.isMatrixBackend() ? `Cancel download of ${attachment.filename}` : `Download ${attachment.filename}`}
      >
        {isCompleted
          ? 'Open'
          : isDownloading && bridge.isMatrixBackend()
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
  )
}

function attachmentErrorMessage(error: unknown, operation: string): string {
  const description = describeError(error, { operation })
  return `${description.title}. ${description.body}`
}
