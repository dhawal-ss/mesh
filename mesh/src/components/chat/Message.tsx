import { memo, useState, useEffect, useCallback } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import type { Message as MessageType } from '../../types/ipc'
import { Avatar } from '../ui/Avatar'
import { ReactionPicker } from './ReactionPicker'
import { MarkdownContent } from './MarkdownContent'
import { format } from 'date-fns'
import { useCommunityStore } from '../../store/communities'
import { useIdentityStore } from '../../store/identity'
import { useChannelStore } from '../../store/channels'
import { useMessageStore } from '../../store/messages'
import * as bridge from '../../lib/bridge'
import { useFileDownloadStore } from '../../store/file-downloads'

interface MessageProps {
  message: MessageType
  isGrouped: boolean
  disableMotion?: boolean
  onReply?: (message: MessageType) => void
  onRetry?: (message: MessageType) => void
  replyPreview?: MessageType | null
}

export const MessageComponent = memo(function MessageComponent({
  message,
  isGrouped,
  onReply,
  onRetry,
  replyPreview,
}: MessageProps) {
  const [hovered, setHovered] = useState(false)
  const [showReactions, setShowReactions] = useState(false)
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null)
  const [isEditing, setIsEditing] = useState(false)
  const [editContent, setEditContent] = useState('')
  const [confirmBan, setConfirmBan] = useState(false)
  const activeCommunityId = useCommunityStore((s) => s.activeCommunityId)
  const activeCommunity = useCommunityStore((s) =>
    s.communities.find((c) => c.id === s.activeCommunityId),
  )
  const myPublicKey = useIdentityStore((s) => s.identity?.publicKey)
  const activeChannelId = useChannelStore((s) => s.activeChannelId)
  const updateReaction = useMessageStore((s) => s.updateReaction)
  const editMessage = useMessageStore((s) => s.editMessage)
  const deleteMessage = useMessageStore((s) => s.deleteMessage)

  const isOwnMessage = myPublicKey === message.authorPublicKey
  const myRole = activeCommunity?.role
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

  const handleStartEdit = useCallback(() => {
    setEditContent(message.content)
    setIsEditing(true)
    setContextMenu(null)
  }, [message.content])

  const handleSaveEdit = useCallback(async () => {
    const trimmed = editContent.trim()
    if (!trimmed || trimmed === message.content) {
      setIsEditing(false)
      return
    }
    try {
      await bridge.editMessage(message.id, trimmed)
      const channelId = activeChannelId ?? message.channelId
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
      await bridge.deleteMessage(message.id)
      const channelId = activeChannelId ?? message.channelId
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
      await bridge.addReaction(message.id, emoji)
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
        className={`group relative flex gap-4 py-0.5 pl-[72px] pr-12 hover:bg-bg-modifier-hover ${
          !isGrouped ? 'mt-[17px]' : ''
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
              className={`flex h-full items-center justify-end pr-1 text-[11px] text-muted transition-opacity ${
                hovered ? 'opacity-100' : 'opacity-0'
              }`}
            >
              {format(new Date(message.timestamp), 'HH:mm')}
            </span>
          )}
        </div>

        {/* Content */}
        <div className="min-w-0 flex-1">
          {!isGrouped && (
            <div className="flex items-baseline gap-2">
              <span className="text-sm font-medium text-primary hover:underline cursor-pointer">
                {message.authorDisplayName}
              </span>
              <span className="text-[11px] text-muted">
                {format(new Date(message.timestamp), 'MM/dd/yyyy h:mm a')}
              </span>
              {message.deliveryStatus && message.deliveryStatus !== 'sent' && (
                <span
                  className={`ml-1 inline-flex items-center gap-1 text-[11px] ${
                    message.deliveryStatus === 'pending'
                      ? 'text-yellow'
                      : 'text-red'
                  }`}
                >
                  {message.deliveryStatus === 'pending' ? (
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="animate-spin">
                      <circle cx="12" cy="12" r="9" strokeDasharray="28" strokeDashoffset="10" />
                    </svg>
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
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-muted">
                <polyline points="9 17 4 12 9 7" />
                <path d="M20 18v-2a4 4 0 0 0-4-4H4" />
              </svg>
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
                className="w-full resize-none rounded-lg bg-[#383a40] px-3 py-2 text-sm text-primary outline-none"
                rows={Math.min(8, editContent.split('\n').length + 1)}
                autoFocus
              />
              <div className="flex items-center gap-2 text-[11px] text-muted">
                <span>escape to <button onClick={handleCancelEdit} className="text-text-link hover:underline">cancel</button></span>
                <span>•</span>
                <span>enter to <button onClick={() => void handleSaveEdit()} className="text-text-link hover:underline">save</button></span>
              </div>
            </div>
          ) : (
            <>
              <MarkdownContent content={message.content} />
              {message.editedAt && (
                <span className="ml-1 text-[10px] text-muted">(edited)</span>
              )}
            </>
          )}

          {/* Retry button for failed messages */}
          {message.deliveryStatus === 'failed' && (
            <button
              onClick={() => { if (onRetry) onRetry(message) }}
              className="mt-1 inline-flex items-center gap-1 rounded bg-red/10 px-2 py-1 text-[11px] font-medium text-red transition-colors hover:bg-red/20"
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v6h6M20 20v-6h-6M5 19a9 9 0 0114-14M19 5a9 9 0 00-14 14" />
              </svg>
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
                  <span className="text-[11px]">{users.length}</span>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Hover action bar */}
        {hovered && !contextMenu && !isEditing && !isDeleted && (
          <div
            className="absolute -top-4 right-4 z-10 flex items-center rounded-md border border-border bg-bg-secondary shadow-elevation-high"
          >
            <button
              onClick={() => setShowReactions(!showReactions)}
              className="flex h-8 w-8 items-center justify-center text-muted transition-colors hover:bg-bg-modifier-hover hover:text-secondary"
              aria-label="Add reaction"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="12" cy="12" r="10" />
                <path d="M8 14s1.5 2 4 2 4-2 4-2" />
                <line x1="9" y1="9" x2="9.01" y2="9" />
                <line x1="15" y1="9" x2="15.01" y2="9" />
              </svg>
            </button>
            {isOwnMessage && (
              <button
                onClick={handleStartEdit}
                className="flex h-8 w-8 items-center justify-center text-muted transition-colors hover:bg-bg-modifier-hover hover:text-secondary"
                aria-label="Edit message"
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                  <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
                </svg>
              </button>
            )}
            {onReply && (
              <button
                onClick={() => onReply(message)}
                className="flex h-8 w-8 items-center justify-center text-muted transition-colors hover:bg-bg-modifier-hover hover:text-secondary"
                aria-label="Reply"
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <polyline points="9 17 4 12 9 7" />
                  <path d="M20 18v-2a4 4 0 0 0-4-4H4" />
                </svg>
              </button>
            )}
          </div>
        )}

        {/* Reaction picker */}
        <AnimatePresence>
          {showReactions && (
            <div className="absolute -top-10 right-4 z-20">
              <ReactionPicker onSelect={handleReaction} onClose={() => setShowReactions(false)} />
            </div>
          )}
        </AnimatePresence>
      </div>

      {/* Context menu */}
      <AnimatePresence>
        {contextMenu && (
          <motion.div
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.95 }}
            transition={{ duration: 0.1 }}
            className="fixed z-50 w-48 rounded-lg border border-black/20 bg-bg-floating py-1.5 text-sm shadow-floating"
            style={{ left: contextMenu.x, top: contextMenu.y }}
            onClick={(e) => e.stopPropagation()}
          >
            {isOwnMessage && !isDeleted && (
              <>
                <button
                  onClick={handleStartEdit}
                  className="w-full px-2 py-1.5 text-left text-secondary rounded-sm mx-1 transition-colors hover:bg-blue hover:text-white"
                  style={{ width: 'calc(100% - 8px)' }}
                  aria-label="Edit message"
                >
                  Edit Message
                </button>
                <button
                  onClick={() => void handleDelete()}
                  className="w-full px-2 py-1.5 text-left text-red rounded-sm mx-1 transition-colors hover:bg-red hover:text-white"
                  style={{ width: 'calc(100% - 8px)' }}
                  aria-label="Delete message"
                >
                  Delete Message
                </button>
              </>
            )}
            {canModerate && !isOwnMessage && !isDeleted && (
              <>
                <button
                  onClick={() => void handleDelete()}
                  className="w-full px-2 py-1.5 text-left text-secondary rounded-sm mx-1 transition-colors hover:bg-blue hover:text-white"
                  style={{ width: 'calc(100% - 8px)' }}
                  aria-label="Remove message"
                >
                  Remove Message
                </button>
                <button
                  onClick={handleBan}
                  className="w-full px-2 py-1.5 text-left text-red rounded-sm mx-1 transition-colors hover:bg-red hover:text-white"
                  style={{ width: 'calc(100% - 8px)' }}
                  aria-label={`Ban ${message.authorDisplayName}`}
                >
                  {confirmBan ? 'Confirm Ban?' : `Ban ${message.authorDisplayName}`}
                </button>
              </>
            )}
            {!isOwnMessage && !canModerate && (
              <div className="px-3 py-2 text-muted">No actions available</div>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </>
  )
})

function FileAttachmentCard({
  attachment,
}: {
  attachment: MessageType['attachments'][number]
}) {
  const download = useFileDownloadStore((s) => s.downloads[attachment.fileHash])
  const sourcePeerId = attachment.sourcePeerId

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
      useFileDownloadStore.getState().markDownloadFailed(
        attachment.fileHash,
        error instanceof Error ? error.message : 'Failed to start download',
      )
    }
  }

  const handleOpen = async () => {
    if (!download?.localPath) return
    await bridge.openDownloadedFile(download.localPath)
  }

  const status = download?.status ?? 'idle'
  const isDownloading = status === 'downloading'
  const isCompleted = status === 'completed'
  const isErrored = status === 'error'

  return (
    <div className="flex max-w-sm items-center gap-3 rounded-lg border border-border bg-bg-secondary p-3">
      <div className="flex h-10 w-10 items-center justify-center rounded bg-bg-modifier-hover text-muted">
        <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
        </svg>
      </div>

      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium text-text-link hover:underline cursor-pointer">{attachment.filename}</div>
        <div className="text-xs text-muted">{(attachment.size / 1024 / 1024).toFixed(2)} MB</div>

        {isDownloading && (
          <div className="mt-1.5">
            <div className="h-1 overflow-hidden rounded-full bg-bg-modifier-hover">
              <div className="h-full rounded-full bg-blue transition-[width] duration-300" style={{ width: `${progressPercent}%` }} />
            </div>
          </div>
        )}
        {isErrored && <div className="mt-1 text-xs text-red">{download?.error ?? 'Download failed'}</div>}
      </div>

      <button
        onClick={isCompleted ? handleOpen : startDownload}
        disabled={isDownloading}
        className={`rounded px-3 py-1.5 text-xs font-medium transition-colors ${
          isCompleted
            ? 'bg-green/20 text-green hover:bg-green/30'
            : isErrored
              ? 'bg-red/10 text-red hover:bg-red/15'
              : 'bg-bg-modifier-hover text-secondary hover:bg-bg-modifier-active'
        } disabled:opacity-60`}
        aria-label={isCompleted ? `Open ${attachment.filename}` : `Download ${attachment.filename}`}
      >
        {isCompleted ? 'Open' : isDownloading ? `${progressPercent}%` : isErrored ? 'Retry' : 'Download'}
      </button>
    </div>
  )
}
