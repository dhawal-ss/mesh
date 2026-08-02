import { memo, useState, useEffect, useCallback, useRef } from 'react'
import { motion } from 'framer-motion'
import type { Message as MessageType } from '../../types/ipc'
import type { RoomTrustSnapshot } from '../../hooks/useRoomTrust'
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
import { formatFullTime } from '../../lib/message-time'
import { MessageTime } from './MessageTime'
import { describeError } from '../../lib/errors'
import { summarizeModerationResult } from '../../lib/moderation'
import { transitions } from '../../lib/motion'
import { Icon } from '../ui/Icon'
import { showToast } from '../ui/Toast'
import { EncryptedAttachmentPreview } from './EncryptedAttachmentPreview'
import { ProtectedImageLightbox } from './ProtectedImageLightbox'
import { ContextMenu, Popover, type MenuItem } from '../ui/InteractivePrimitives'
import { MessageReportDialog } from './MessageReportDialog'
import { useShellStore } from '../../store/shell'

interface MessageProps {
  message: MessageType
  isGrouped: boolean
  surface?: 'channel' | 'dm'
  disableMotion?: boolean
  onReply?: (message: MessageType) => void
  threadReplyCount?: number
  threadOpen?: boolean
  onToggleThread?: () => void
  onRetry?: (message: MessageType) => void
  onCancel?: (message: MessageType) => void
  replyPreview?: MessageType | null
  onJumpToReply?: (message: MessageType) => void
  limitedActions?: boolean
  editRequestToken?: number
  trust?: RoomTrustSnapshot
  onEdit?: (message: MessageType, content: string) => void | Promise<void>
  onDelete?: (message: MessageType) => void | Promise<void>
  onReact?: (message: MessageType, emoji: string) => void | Promise<void>
}

type MutationStatus = 'pending' | 'success' | 'failed' | 'retrying' | 'superseded'
type MutationState = {
  kind: 'edit' | 'reaction' | 'timeout' | 'kick' | 'ban' | 'delete' | 'pin'
  label: string
  status: MutationStatus
  error: unknown | null
  attempt: number
  retry: () => Promise<boolean>
}

export const MessageComponent = memo(function MessageComponent({
  message,
  isGrouped,
  surface = 'channel',
  disableMotion = false,
  onReply,
  threadReplyCount = 0,
  threadOpen = false,
  onToggleThread,
  onRetry,
  onCancel,
  replyPreview,
  onJumpToReply,
  limitedActions = false,
  editRequestToken = 0,
  trust,
  onEdit,
  onDelete,
  onReact,
}: MessageProps) {
  const [showReactions, setShowReactions] = useState(false)
  const [contextMenuOpen, setContextMenuOpen] = useState(false)
  const [isEditing, setIsEditing] = useState(false)
  const [editContent, setEditContent] = useState('')
  const [confirmBan, setConfirmBan] = useState(false)
  const [reportOpen, setReportOpen] = useState(false)
  const [mutation, setMutation] = useState<MutationState | null>(null)
  const [activeImageAttachmentIndex, setActiveImageAttachmentIndex] = useState<number | null>(null)
  const rowRef = useRef<HTMLDivElement>(null)
  const reactButtonRef = useRef<HTMLButtonElement>(null)
  const mutationAttemptRef = useRef(0)
  const mutationInFlightRef = useRef(false)
  const mutationMessageIdRef = useRef(message.id)
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
  const setSecurityOpen = useShellStore((s) => s.setSecurityOpen)
  const updateReaction = useMessageStore((s) => s.updateReaction)
  const editMessage = useMessageStore((s) => s.editMessage)
  const deleteMessage = useMessageStore((s) => s.deleteMessage)
  const isPinned = useRoomPinStore((state) => state.roomId === message.channelId && state.eventIds.includes(message.id))
  const canManagePins = useRoomPinStore((state) => state.roomId === message.channelId && state.canManage)
  const toggleRoomPin = useRoomPinStore((state) => state.toggle)

  const isOwnMessage = myPublicKey === message.authorPublicKey
  const canModerate = myRole === 'owner' || myRole === 'admin'
  const isDeleted = !!message.deletedAt
  const undecryptable = message.undecryptable
  const isUndecryptable = !!undecryptable
  const isQueued =
    message.deliveryStatus === 'pending' || message.deliveryStatus === 'failed'
  const mutationBusy = mutation?.status === 'pending' || mutation?.status === 'retrying'
  const canPinMessage =
    surface === 'channel'
    && matrixMode
    && canManagePins
    && message.id.startsWith('$')
    && !isUndecryptable
  const securityNeedsAttention = Boolean(
    isUndecryptable
      && trust
      && !trust.loadingAccountTrust
      && (trust.devicesNeedReview > 0 || trust.backup?.healthy === false),
  )
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
      return
    }
    if (isQueued) return
    if (e.key !== 'ContextMenu' && !(e.key === 'F10' && e.shiftKey)) return
    e.preventDefault()
    setConfirmBan(false)
    setContextMenuOpen(true)
  }

  const runMutation = async (
    kind: MutationState['kind'],
    label: string,
    operation: () => Promise<void>,
    onSuccess?: () => void,
  ): Promise<boolean> => {
    const execute = async (retrying: boolean): Promise<boolean> => {
      if (mutationInFlightRef.current) return false
      mutationInFlightRef.current = true
      const attempt = ++mutationAttemptRef.current
      const retry = () => execute(true)
      setMutation({
        kind,
        label,
        status: retrying ? 'retrying' : 'pending',
        error: null,
        attempt,
        retry,
      })
      try {
        await operation()
        if (mutationAttemptRef.current !== attempt) return false
        setMutation((current) => current?.attempt === attempt
          ? { ...current, status: 'success', error: null }
          : current)
        onSuccess?.()
        return true
      } catch (error) {
        if (mutationAttemptRef.current !== attempt) return false
        setMutation((current) => current?.attempt === attempt
          ? { ...current, status: 'failed', error }
          : current)
        return false
      } finally {
        if (mutationAttemptRef.current === attempt) {
          mutationInFlightRef.current = false
        }
      }
    }
    return execute(false)
  }

  useEffect(() => {
    if (mutationMessageIdRef.current === message.id) return
    mutationMessageIdRef.current = message.id
    if (!mutationInFlightRef.current) return
    mutationAttemptRef.current += 1
    mutationInFlightRef.current = false
    setMutation((current) => current && (
      current.status === 'pending' || current.status === 'retrying'
    ) ? { ...current, status: 'superseded' } : current)
  }, [message.id])

  useEffect(() => () => {
    mutationAttemptRef.current += 1
    mutationInFlightRef.current = false
  }, [])

  const handleBan = async () => {
    if (!activeCommunityId || mutationInFlightRef.current) return
    await runMutation('ban', `Ban ${message.authorDisplayName}`, async () => {
      const result = await bridge.banUser(activeCommunityId, message.authorPublicKey)
      const summary = summarizeModerationResult(result, `${message.authorDisplayName} was banned`)
      showToast(summary.message, summary.tone)
    })
    setContextMenuOpen(false)
    setConfirmBan(false)
  }

  const handleKick = async () => {
    if (!activeCommunityId || mutationInFlightRef.current) return
    await runMutation('kick', `Remove ${message.authorDisplayName}`, async () => {
      const result = await bridge.kickUser(activeCommunityId, message.authorPublicKey)
      const summary = summarizeModerationResult(result, `${message.authorDisplayName} was removed`)
      showToast(summary.message, summary.tone)
    })
    setContextMenuOpen(false)
  }

  const handleTimeout = async () => {
    if (!activeCommunityId || mutationInFlightRef.current) return
    await runMutation('timeout', `Timeout ${message.authorDisplayName}`, async () => {
      await bridge.timeoutUser(activeCommunityId, message.authorPublicKey, 60)
    })
    setContextMenuOpen(false)
  }

  const handleStartEdit = useCallback(() => {
    if (mutationInFlightRef.current) return
    setEditContent(message.content)
    setIsEditing(true)
    setContextMenuOpen(false)
  }, [message.content])

  useEffect(() => {
    if (editRequestToken <= 0 || !isOwnMessage || isDeleted || isQueued) return
    const frame = window.requestAnimationFrame(handleStartEdit)
    return () => window.cancelAnimationFrame(frame)
  }, [editRequestToken, handleStartEdit, isDeleted, isOwnMessage, isQueued])

  const handleSaveEdit = async () => {
    if (mutationInFlightRef.current) return
    const trimmed = editContent.trim()
    if (!trimmed || trimmed === message.content) {
      setIsEditing(false)
      return
    }
    await runMutation('edit', 'Save edit', async () => {
      if (onEdit) {
        await onEdit(message, trimmed)
        return
      }
      const channelId = activeChannelId ?? message.channelId
      await bridge.editMessage(message.id, trimmed, channelId)
      if (channelId) {
        editMessage(channelId, message.id, trimmed, new Date().toISOString())
      }
    }, () => setIsEditing(false))
  }

  const handleCancelEdit = useCallback(() => {
    setIsEditing(false)
    setEditContent('')
  }, [])

  const handleDelete = async () => {
    if (mutationInFlightRef.current) return
    const deleted = await runMutation('delete', 'Delete message', async () => {
      if (onDelete) {
        await onDelete(message)
        return
      }
      const channelId = activeChannelId ?? message.channelId
      await bridge.deleteMessage(message.id, channelId)
      if (channelId) {
        deleteMessage(channelId, message.id)
      }
    })
    setContextMenuOpen(false)
    if (!deleted) rowRef.current?.focus()
    // No rowRef.current?.focus() here, unlike ban/kick/timeout: deleting
    // removes this row from the DOM, so there's nothing sensible to focus.
  }

  const handleEditKeyDown = (e: React.KeyboardEvent) => {
    if (mutationInFlightRef.current) return
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      void handleSaveEdit()
    } else if (e.key === 'Escape') {
      handleCancelEdit()
    }
  }

  const handleReaction = async (emoji: string) => {
    if (isUndecryptable || mutationInFlightRef.current) return
    if (onReact) {
      await runMutation('reaction', `Update ${emoji} reaction`, async () => {
        await onReact(message, emoji)
      })
      return
    }
    const channelId = activeChannelId ?? message.channelId
    if (!channelId) return

    const alreadyReacted = myPublicKey ? (message.reactions[emoji] ?? []).includes(myPublicKey) : false
    const verb = alreadyReacted ? 'remove' : 'add'

    if (myPublicKey) {
      updateReaction(channelId, message.id, emoji, myPublicKey, verb as 'add' | 'remove')
    }

    await runMutation('reaction', `Update ${emoji} reaction`, async () => {
      await bridge.addReaction(message.id, emoji, channelId)
    }).then((succeeded) => {
      if (succeeded || !myPublicKey) return
      const revertVerb = verb === 'add' ? 'remove' : 'add'
      updateReaction(channelId, message.id, emoji, myPublicKey, revertVerb as 'add' | 'remove')
    })
  }

  const handlePin = async () => {
    if (mutationInFlightRef.current) return
    await runMutation('pin', isPinned ? 'Unpin message' : 'Pin message', async () => {
      const updated = await toggleRoomPin(message.channelId, message)
      if (!updated) throw new Error('The room did not accept the pin update.')
    })
    setContextMenuOpen(false)
  }

  const contextMenuItems: MenuItem[] = []
  if (canPinMessage && !isDeleted) {
    contextMenuItems.push({
      id: 'pin',
      label: isPinned ? 'Unpin message' : 'Pin message',
      onSelect: () => void handlePin(),
    })
  }
  if (isOwnMessage && !isDeleted && !isUndecryptable) {
    contextMenuItems.push({
      id: 'edit',
      label: 'Edit message',
      onSelect: handleStartEdit,
    })
    if (surface === 'channel' || onDelete) {
      contextMenuItems.push({
        id: 'delete',
        label: 'Delete message',
        tone: 'danger',
        onSelect: () => void handleDelete(),
      })
    }
  }
  if (matrixMode && !isOwnMessage && !isDeleted && message.id.startsWith('$')) {
    contextMenuItems.push({
      id: 'report',
      label: 'Report message',
      onSelect: () => {
        setContextMenuOpen(false)
        setReportOpen(true)
      },
    })
  }
  if (!limitedActions && canModerate && !isOwnMessage && !isDeleted) {
    contextMenuItems.push(
      {
        id: 'remove',
        label: 'Remove message',
        onSelect: () => void handleDelete(),
      },
      {
        id: 'kick',
        label: `Kick ${message.authorDisplayName}`,
        onSelect: () => void handleKick(),
      },
    )
    if (!matrixMode) {
      contextMenuItems.push({
        id: 'timeout',
        label: `Timeout ${message.authorDisplayName}`,
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
  const undecryptableLabel = isUndecryptable ? ', message content unavailable' : ''
  const editedLabel = message.editedAt ? ', edited' : ''
  const deletedLabel = isDeleted ? ', message deleted' : ''
  const messageAriaLabel = `Message from ${message.authorDisplayName}, ${formatFullTime(message.timestamp)}${editedLabel}${deletedLabel}${deliveryLabel}${undecryptableLabel}`

  return (
    <>
      <ContextMenu
        label="Message actions"
        items={contextMenuItems}
        disabled={isQueued || mutationBusy}
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
          className={`group relative flex min-w-0 max-w-full gap-3 py-0.5 pl-message-gutter pr-12 outline-none transition-opacity duration-fast hover:bg-surface-hover ${
            message.deliveryStatus === 'pending' ? 'opacity-60' : 'opacity-100'
          } ${!isGrouped ? 'mt-message-group' : ''}`}
          onMouseLeave={() => setShowReactions(false)}
          onKeyDown={handleRowKeyDown}
        >
          {/* Avatar: absolute positioned in left gutter */}
          <div className="absolute left-4 top-0.5 w-8">
            {!isGrouped ? (
              <Avatar color={message.authorAvatarColor} size={32} name={message.authorDisplayName} />
            ) : (
              /* Revealed by CSS group state rather than the JS `hovered` flag so
                 keyboard users (group-focus-within) and touch users (the
                 coarse-pointer rule in globals.css) can read it too. */
              <span className="mesh-message-time tnum flex h-full items-center justify-end pr-1 text-meta text-muted opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
                <MessageTime value={message.timestamp} variant="clock" />
              </span>
            )}
          </div>

          {/* Content */}
          <div className="mesh-message-content min-w-0 flex-1">
            {!isGrouped && (
              <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0">
                <span className="text-sm font-semibold text-primary">{message.authorDisplayName}</span>
                <MessageTime
                  value={message.timestamp}
                  variant="full"
                  className="tnum text-meta text-muted"
                />
              </div>
            )}

            {message.deliveryStatus === 'pending' && (
              <div role="status" className="mt-1 inline-flex items-center gap-1 text-meta text-status-warning">
                <Icon name="loader" size="xs" className="animate-spin" />
                Saved on this device · Waiting to send
              </div>
            )}

            {message.deliveryStatus === 'failed' && (
              /* `disableMotion` is set by the virtualized row: without honoring
                 it, the shake replayed every time a failed message scrolled
                 back into view, which reads as instability rather than as a
                 one-time alert. */
              <motion.div
                role="status"
                className="mt-1 flex flex-wrap items-center gap-2 text-meta text-status-danger"
                initial={disableMotion ? false : { x: 0 }}
                animate={disableMotion ? undefined : { x: [0, -2, 2, 0] }}
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

            {mutation && mutation.status !== 'success' && mutation.status !== 'superseded' && (
              <div
                role={mutation.status === 'failed' ? 'alert' : 'status'}
                className={`mt-1 flex flex-wrap items-center gap-2 text-meta ${
                  mutation.status === 'failed' ? 'text-status-danger' : 'text-status-warning'
                }`}
              >
                <span>
                  {mutation.status === 'failed'
                    ? `${mutation.label} failed. Your message and controls are unchanged.`
                    : `${mutation.label}...`}
                </span>
                {mutation.status === 'failed' && (
                  <button
                    type="button"
                    className="min-h-control-sm rounded-control bg-status-danger/10 px-2 font-medium hover:bg-status-danger/20"
                    onClick={() => void mutation.retry()}
                  >
                    Retry
                  </button>
                )}
              </div>
            )}

            {/* Reply preview: makes a reply readable as a reply. Clicking it
                jumps to the message being answered, so a conversation can be
                followed backwards without scrolling blind. */}
            {replyPreview && !isUndecryptable && !isDeleted && (
              <button
                type="button"
                onClick={onJumpToReply ? () => onJumpToReply(replyPreview) : undefined}
                disabled={!onJumpToReply}
                aria-label={`Replying to ${replyPreview.authorDisplayName}: ${replyPreview.content.slice(0, 80) || 'message unavailable'}. Go to that message.`}
                className="mb-1 flex min-h-6 w-full min-w-0 items-center gap-1.5 rounded-control text-left text-sm transition-colors enabled:hover:bg-surface-hover disabled:cursor-default"
              >
                <Icon name="reply" size="xs" className="shrink-0 text-muted" aria-hidden="true" />
                <span aria-hidden="true" className="shrink-0 text-xs font-medium text-secondary">
                  {replyPreview.authorDisplayName}
                </span>
                <span aria-hidden="true" className="truncate text-xs text-muted">
                  {replyPreview.deletedAt ? 'Message deleted' : replyPreview.content.slice(0, 80)}
                </span>
              </button>
            )}

            {isDeleted ? (
              /* A redaction clears `content`, so without this branch the row
                 rendered as an empty gap that read as a rendering bug. A
                 tombstone keeps the deletion legible and auditable. */
              <p className="mt-0.5 inline-flex items-center gap-1.5 text-sm italic text-content-muted">
                <Icon name="circleX" size="xs" aria-hidden="true" />
                Message deleted
              </p>
            ) : undecryptable ? (
              <UndecryptableMessageNotice
                reason={undecryptable.reason}
                showSecurityHelp={securityNeedsAttention}
                onOpenSecurity={() => setSecurityOpen(true)}
              />
            ) : isEditing ? (
              <div className="mt-1 space-y-2">
                <textarea
                  aria-label={`Edit message from ${message.authorDisplayName}`}
                  value={editContent}
                  disabled={mutationBusy}
                  onChange={(e) => setEditContent(e.target.value)}
                  onKeyDown={handleEditKeyDown}
                  className="w-full resize-none rounded-control border border-border bg-surface-sunken px-3 py-2 text-sm text-primary outline-none focus:border-accent"
                  rows={Math.min(8, editContent.split('\n').length + 1)}
                  autoFocus
                />
                <div className="flex items-center gap-2 text-meta text-muted">
                  <span>
                    escape to{' '}
                    <button
                      type="button"
                      disabled={mutationBusy}
                      onClick={handleCancelEdit}
                      className="text-text-link hover:underline disabled:opacity-60"
                    >
                      cancel
                    </button>
                  </span>
                  <span>•</span>
                  <span>
                    enter to{' '}
                    <button
                      type="button"
                      disabled={mutationBusy}
                      onClick={() => void handleSaveEdit()}
                      className="text-text-link hover:underline disabled:opacity-60"
                    >
                      save
                    </button>
                  </span>
                </div>
              </div>
            ) : (
              <>
                <MarkdownContent
                  content={message.content}
                  members={surface === 'dm' ? [] : communityMembers}
                  customEmoji={surface === 'dm' ? [] : customEmoji}
                  ownUserId={myPublicKey ?? null}
                />
                {import.meta.env.DEV && message.designPreviewImageUrl ? (
                  <img
                    src={message.designPreviewImageUrl}
                    alt={`${message.authorDisplayName} shared concept art`}
                    className="mt-2 max-h-44 w-full max-w-2xl rounded-panel border border-border-subtle object-cover"
                  />
                ) : null}
                {message.editedAt && (
                  <span
                    className="ml-1 text-caption text-muted"
                    title={`Edited ${formatFullTime(message.editedAt)}`}
                  >
                    (edited)
                  </span>
                )}
              </>
            )}

            {/* File attachments: a redaction removes the body, so the
                attachments that came with it must not survive it. */}
            {!isDeleted && message.attachments && message.attachments.length > 0 && (
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

            {threadReplyCount > 0 && onToggleThread && (
              <button
                type="button"
                onClick={onToggleThread}
                aria-expanded={threadOpen}
                className="mt-2 inline-flex min-h-8 items-center gap-1.5 rounded-control px-2 text-xs font-medium text-text-link transition-colors hover:bg-surface-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
              >
                <Icon name="messageCircle" size="xs" />
                {threadOpen ? 'Hide replies' : `${threadReplyCount} ${threadReplyCount === 1 ? 'reply' : 'replies'}`}
              </button>
            )}

            {/* Reactions */}
            {!isDeleted && Object.keys(message.reactions).length > 0 && (
              <div className="mt-1 flex flex-wrap gap-1">
                {Object.entries(message.reactions).map(([emoji, users]) => {
                  const custom = surface === 'dm'
                    ? undefined
                    : customEmoji.find((candidate) => `:${candidate.shortcode}:` === emoji)
                  const mine = Boolean(myPublicKey && users.includes(myPublicKey))
                  const emojiName = custom ? custom.body || custom.shortcode : emoji
                  const glyph = custom ? (
                    <img
                      src={custom.imageUrl}
                      alt=""
                      aria-hidden="true"
                      className="h-4 w-4 object-contain"
                    />
                  ) : (
                    emoji
                  )
                  return (
                    <button
                      key={emoji}
                      type="button"
                      disabled={mutationBusy}
                      onClick={() => handleReaction(emoji)}
                      aria-pressed={mine}
                      aria-label={`${emojiName}, ${users.length} ${users.length === 1 ? 'reaction' : 'reactions'}${mine ? ', you reacted' : ''}`}
                      className={`inline-flex min-h-6 items-center gap-1 rounded-md border px-1.5 py-0.5 text-xs transition-colors ${
                        mine
                          ? 'border-accent bg-accent/10 text-accent'
                          : 'border-border bg-surface-hover text-secondary hover:border-border-light'
                      }`}
                    >
                      {/* A checkmark carries the "you reacted" state independently
                          of the accent tint, which was previously the only signal. */}
                      {mine && <Icon name="check" size="xs" aria-hidden="true" />}
                      {disableMotion ? (
                        <span aria-hidden="true">{glyph}</span>
                      ) : (
                        <motion.span
                          aria-hidden="true"
                          initial={{ scale: 0.8 }}
                          animate={{ scale: 1 }}
                          transition={transitions.reaction}
                        >
                          {glyph}
                        </motion.span>
                      )}
                      <span aria-hidden="true" className="badge-count text-meta">{users.length}</span>
                    </button>
                  )
                })}
              </div>
            )}
          </div>

          {/* Action bar: always mounted (not just on hover) so Tab can reach it;
            group-hover/group-focus-within reveal it visually, matching the
            volume-slider pattern in VoicePeerGrid.tsx. pointer-events-none at
            rest keeps the invisible bar from intercepting clicks meant for
            the grouped message rendered underneath it (-top-4 overlap). */}
          {!contextMenuOpen && !isEditing && !isDeleted && !isQueued && !isUndecryptable && !mutationBusy && (
            <div className="mesh-message-actions pointer-events-none absolute -top-4 right-4 z-sticky flex items-center rounded-panel border border-border-subtle bg-surface-overlay opacity-0 shadow-overlay transition-opacity group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100">
              <Popover
                open={showReactions}
                onOpenChange={setShowReactions}
                side="top"
                align="end"
                className="w-auto border-0 bg-transparent p-0 shadow-none"
                trigger={(
                  <button
                    ref={reactButtonRef}
                    className="flex h-8 w-8 items-center justify-center text-muted transition-colors hover:bg-surface-hover hover:text-secondary focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
                    aria-label={`React to message from ${message.authorDisplayName}`}
                    aria-expanded={showReactions}
                  >
                    <Icon name="smile" size="sm" />
                  </button>
                )}
              >
                <ReactionPicker
                  onSelect={handleReaction}
                  onClose={() => setShowReactions(false)}
                  customEmoji={customEmoji}
                />
              </Popover>
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

      <MessageReportDialog
        open={reportOpen}
        roomId={message.channelId}
        eventId={message.id}
        onClose={() => setReportOpen(false)}
      />
    </>
  )
})

type UndecryptableReason = NonNullable<MessageType['undecryptable']>['reason']

function UndecryptableMessageNotice({
  reason,
  showSecurityHelp,
  onOpenSecurity,
}: {
  reason: UndecryptableReason
  showSecurityHelp: boolean
  onOpenSecurity: () => void
}) {
  const copy = undecryptableCopy(reason)

  return (
    <div
      className="mt-1 max-w-xl rounded-panel border border-status-warning/30 bg-status-warning/5 px-3 py-2 text-sm"
      data-undecryptable-message="true"
      role="note"
    >
      <div className="flex items-start gap-2">
        <Icon name="triangleAlert" size="sm" className="mt-0.5 shrink-0 text-status-warning" />
        <div className="min-w-0 space-y-1">
          <p className="font-medium text-primary">{copy.title}</p>
          <p className="text-xs leading-5 text-secondary">{copy.body}</p>
          {showSecurityHelp && (
            <button
              type="button"
              onClick={onOpenSecurity}
              className="min-h-control-sm rounded-control px-2 text-xs font-medium text-text-link transition-colors hover:bg-status-warning/10 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
            >
              Review message security
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

function undecryptableCopy(reason: UndecryptableReason) {
  switch (reason) {
    case 'sent-before-device':
      return {
        title: 'This message was sent before this device could receive it.',
        body: 'It may become available after you restore message history on this device.',
      }
    case 'keys-not-shared':
      return {
        title: 'The message keys were not shared with this device.',
        body: 'Review your device security and ask the sender to share the message again if needed.',
      }
    case 'waiting-for-keys':
      return {
        title: 'Waiting for the message keys.',
        body: 'Mesh is still syncing secure message history. This message may appear when syncing finishes.',
      }
    case 'could-not-decrypt':
    default:
      return {
        title: "Mesh couldn't decrypt this message on this device.",
        body: 'The message is still part of the conversation, but its content is not available here.',
      }
  }
}

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
