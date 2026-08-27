import { memo, useState, useEffect, useCallback, useRef } from 'react'
import { AnimatePresence, motion } from '../../lib/lazy-motion'
import type { MatrixTransferState, Message as MessageType } from '../../types/ipc'
import type { RoomTrustSnapshot } from '../../hooks/useRoomTrust'
import { Avatar } from '../ui/Avatar'
import { ReactionPicker } from './ReactionPicker'
import { EditComposer } from './EditComposer'
import { MarkdownContent } from './MarkdownContent'
import { useCommunityStore } from '../../store/communities'
import { useServerEmoji } from '../../store/custom-emoji'
import { rememberEmoji, useRecentEmoji } from '../../store/recent-emoji'
import { DEFAULT_FREQUENT, EMOJI_BY_CHAR } from '../../lib/emoji-data'
import { useIdentityStore } from '../../store/identity'
import { useChannelStore } from '../../store/channels'
import { useMessageStore } from '../../store/messages'
import { useCommunityMembers } from '../../store/membership'
import * as bridge from '../../lib/bridge'
import { useFileDownloadStore } from '../../store/file-downloads'
import { useRoomPinStore } from '../../store/room-pins'
import { formatFullTime } from '../../lib/message-time'
import { MessageTime } from './MessageTime'
import { describeError, errorLine } from '../../lib/errors'
import { summarizeModerationResult } from '../../lib/moderation'
import { transitions, variants } from '../../lib/motion'
import { Icon } from '../ui/Icon'
import { showToast } from '../ui/Toast'
import { EncryptedAttachmentPreview } from './EncryptedAttachmentPreview'
import { ProtectedImageLightbox } from './ProtectedImageLightbox'
import { ContextMenu, Popover, type MenuItem } from '../ui/InteractivePrimitives'
import { MessageReportDialog } from './MessageReportDialog'
import { useShellStore } from '../../store/shell'
import { copyText, matrixEventPermalink } from '../../lib/notifications'
import { retainStructuredMentionUserIds } from '../../lib/structured-mentions'
import { Button } from '../ui/Button'
import { Tooltip } from '../ui/Tooltip'
import { Modal, setNextModalRestoreFocusTarget } from '../ui/Modal'
import { ExceptionLine, TrustRail } from '../ui/QuietStructure'
import { eventTrust, serverName, trustRailLabel } from '../../lib/trust'

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
  /**
   * Id applied to the author-name element so the surrounding `role="article"`
   * row can name itself with `aria-labelledby`. Owners that render the same
   * message twice (the timeline plus an open thread) must pass distinct ids.
   */
  authorNameId?: string
  onEdit?: (
    message: MessageType,
    content: string,
    mentionUserIds: readonly string[],
  ) => void | Promise<void>
  onDelete?: (message: MessageType) => void | Promise<void>
  onReact?: (message: MessageType, emoji: string) => void | Promise<void>
}

/**
 * The optimistic-send marker: a 2px accent rule inset on the row's leading
 * edge, matching the channel-selection marker. Authored as an inline shadow
 * because the token set has no inset-rule utility; the value is token-backed.
 */
const PENDING_SEND_MARKER = { boxShadow: 'inset 2px 0 0 0 var(--accent)' } as const

/*
  A send the queue gave up on for a reason retrying cannot change must not offer
  a retry. Announcement-only rooms, a mute, a kick, a ban and a replaced room all
  produce a failure that looks exactly like a dropped connection, so the person
  presses Try again forever and concludes the app is broken. Naming the reason
  and withdrawing the button is the whole fix. Copy text and Remove stay either
  way, so nobody loses what they wrote.

  An unrecognized or absent reason keeps the retry: not knowing why is not the
  same as knowing it is hopeless.
*/
const PERMANENT_SEND_FAILURES: Partial<Record<string, string>> = {
  'not-allowed': 'You are not allowed to post in this room.',
  'room-unavailable': 'This room no longer accepts messages.',
}

/**
 * How many one-tap reactions sit in the hover bar. Three is the most that fits
 * beside the existing actions without pushing the bar past the row's right
 * gutter, and the whole bar is one tab stop either way.
 */
const QUICK_REACTION_COUNT = 3

/**
 * The quick-react row, always full: the user's most recent emoji first, topped
 * up from the curated defaults. Reading straight from the recents store would
 * shrink the row to one button the moment someone reacted for the first time.
 */
function quickReactionEmoji(recent: readonly string[]): string[] {
  const chosen: string[] = []
  for (const emoji of [...recent, ...DEFAULT_FREQUENT]) {
    if (chosen.includes(emoji)) continue
    chosen.push(emoji)
    if (chosen.length === QUICK_REACTION_COUNT) break
  }
  return chosen
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

/**
 * Builds the human-readable list shown in a reaction chip's tooltip, e.g.
 * "Maya, Rohan and 3 others". Reactor ids are resolved to display names via
 * `nameByKey`; the current user's id renders as "You" (placed first). When no
 * id resolves to a name (e.g. a DM surface with no member list) it degrades to
 * a bare count ("3 people") so raw ids are never surfaced.
 */
function formatReactors(
  users: readonly string[],
  nameByKey: ReadonlyMap<string, string>,
  ownId: string | undefined,
): string {
  const mineIncluded = Boolean(ownId && users.includes(ownId))
  const namedOthers: string[] = []
  let unresolved = 0
  for (const id of users) {
    if (ownId && id === ownId) continue
    const name = nameByKey.get(id)
    if (name) namedOthers.push(name)
    else unresolved += 1
  }
  const names = mineIncluded ? ['You', ...namedOthers] : namedOthers
  if (names.length === 0) {
    const total = users.length
    return `${total} ${total === 1 ? 'person' : 'people'}`
  }
  const MAX_NAMES = 3
  const visible = names.slice(0, MAX_NAMES)
  const others = names.length - visible.length + unresolved
  const parts =
    others > 0 ? [...visible, `${others} ${others === 1 ? 'other' : 'others'}`] : visible
  if (parts.length === 1) return parts[0]
  if (parts.length === 2) return `${parts[0]} and ${parts[1]}`
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`
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
  authorNameId,
  onEdit,
  onDelete,
  onReact,
}: MessageProps) {
  const [showReactions, setShowReactions] = useState(false)
  const [contextMenuOpen, setContextMenuOpen] = useState(false)
  const [isEditing, setIsEditing] = useState(false)
  const [editContent, setEditContent] = useState('')
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [confirmBan, setConfirmBan] = useState(false)
  const [reportOpen, setReportOpen] = useState(false)
  const [mutation, setMutation] = useState<MutationState | null>(null)
  const [activeImageAttachmentIndex, setActiveImageAttachmentIndex] = useState<number | null>(null)
  const [activeActionIndex, setActiveActionIndex] = useState<number | null>(null)
  const rowRef = useRef<HTMLDivElement>(null)
  const actionsRef = useRef<HTMLDivElement>(null)
  const reactButtonRef = useRef<HTMLButtonElement>(null)
  const mutationAttemptRef = useRef(0)
  const mutationInFlightRef = useRef(false)
  const mutationMessageIdRef = useRef(message.id)
  const matrixMode = bridge.isMatrixBackend()
  const activeCommunityId = useCommunityStore((s) => s.activeCommunityId)
  const communityMembers = useCommunityMembers(activeCommunityId)
  const customEmoji = useServerEmoji(activeCommunityId)
  const recentEmoji = useRecentEmoji()
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
  const queueState = useMessageStore((state) => {
    const transactionId = message.transactionId ?? message.id
    return state.matrixQueueStates[message.channelId]?.[transactionId]?.state
  })

  const isOwnMessage = myPublicKey === message.authorPublicKey
  const canModerate = myRole === 'owner' || myRole === 'admin'
  const isDeleted = !!message.deletedAt
  const undecryptable = message.undecryptable
  const isUndecryptable = !!undecryptable
  const isQueued =
    message.deliveryStatus === 'pending' || message.deliveryStatus === 'failed'
  const isSavedForLater = message.deliveryStatus === 'pending' && queueState === 'pending'
  const mutationBusy = mutation?.status === 'pending' || mutation?.status === 'retrying'
  const canPinMessage =
    surface === 'channel'
    && matrixMode
    && canManagePins
    && message.id.startsWith('$')
    && !isUndecryptable
  /*
    The trust rail's state for this message.

    Everything the rail needs is on the event: who sent it and whether it
    decrypted. Per-event device verification is not something this surface can
    answer, so it is left undefined and eventTrust treats "we did not check" as
    the norm rather than as a failure -- the alternative paints every timeline
    vermilion and the mark stops meaning anything.
  */
  const trustTone = matrixMode
    ? eventTrust({ sender: message.authorPublicKey, undecryptable: isUndecryptable }, myPublicKey)
    : 'ok'
  const originServer = matrixMode ? serverName(message.authorPublicKey) : null

  /*
    Two different questions were being answered by one condition. Devices needing
    review or an unhealthy backup means something is wrong with the account.
    "Sent before this device could receive it" means something is wrong with this
    *message*, and its copy tells the reader to restore message history -- which
    is what this control opens. On the ordinary case for that reason, a fresh
    device with a healthy backup, neither counter fires, so the instruction
    appeared with no way to follow it.
  */
  const undecryptableReasonHasRemedy = undecryptable?.reason === 'sent-before-device'
  const securityNeedsAttention = Boolean(
    isUndecryptable
      && trust
      && !trust.loadingAccountTrust
      && (undecryptableReasonHasRemedy
        || trust.devicesNeedReview > 0
        || trust.backup?.healthy === false),
  )
  const imageAttachmentIndexes = (message.attachments ?? []).flatMap((attachment, index) =>
    attachment.thumbnail ? [index] : [],
  )
  const activeImagePosition =
    activeImageAttachmentIndex === null ? -1 : imageAttachmentIndexes.indexOf(activeImageAttachmentIndex)
  const activeImageAttachment =
    activeImagePosition < 0 ? undefined : message.attachments[imageAttachmentIndexes[activeImagePosition]]

  /*
    The hover bar is one toolbar, not a run of independent tab stops. It is
    always mounted so keyboard users can reach it, and the timeline already
    costs eight to twelve stops per message; adding three quick reactions as
    separate stops would have made the worst offender worse. Tab reaches the
    bar once, arrows move inside it, and `actionIds` is the single source of
    both the roving index and the DOM order the arrows walk.
  */
  const permanentSendFailure = message.sendFailure
    ? PERMANENT_SEND_FAILURES[message.sendFailure] ?? null
    : null
  const quickReactions = quickReactionEmoji(recentEmoji)
  const actionIds: string[] = quickReactions.map((_, index) => `quick-${index}`)
  actionIds.push('react')
  if (isOwnMessage) actionIds.push('edit')
  if (onReply) actionIds.push('reply')
  if (onToggleThread && !limitedActions) actionIds.push('thread')
  if (canPinMessage) actionIds.push('pin')
  /*
    The tab stop rests on the full picker, not on the first control. The bar
    was reachable that way before quick reactions existed, so Tab still lands
    where every keyboard user and keyboard test already expects; the quick
    reactions are one ArrowLeft away and the rest of the actions one
    ArrowRight. WAI-ARIA allows a toolbar to seed its roving index on the
    control most likely to be used rather than on the first one.
  */
  const defaultActionIndex = Math.max(0, actionIds.indexOf('react'))
  const focusedActionIndex = Math.min(
    activeActionIndex ?? defaultActionIndex,
    actionIds.length - 1,
  )

  const actionButtonProps = (id: string) => {
    const index = actionIds.indexOf(id)
    return {
      tabIndex: index === focusedActionIndex ? 0 : -1,
      onFocus: () => setActiveActionIndex(index < 0 ? defaultActionIndex : index),
    }
  }

  const handleActionsKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const count = actionIds.length
    if (count === 0) return
    let next: number
    if (event.key === 'ArrowRight') next = (focusedActionIndex + 1) % count
    else if (event.key === 'ArrowLeft') next = (focusedActionIndex - 1 + count) % count
    else if (event.key === 'Home') next = 0
    else if (event.key === 'End') next = count - 1
    else return
    event.preventDefault()
    event.stopPropagation()
    setActiveActionIndex(next)
    // Source order in the bar is `actionIds` order, so the nth button is the
    // nth action. Queried rather than keyed by id: an emoji in a selector does
    // not match in jsdom, and an index does.
    actionsRef.current?.querySelectorAll<HTMLButtonElement>('button')[next]?.focus()
  }

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
    const mentionUserIds = retainStructuredMentionUserIds(
      trimmed,
      message.mentions ?? [],
      communityMembers,
    )
    await runMutation('edit', 'Save edit', async () => {
      if (onEdit) {
        await onEdit(message, trimmed, mentionUserIds)
        return
      }
      const channelId = activeChannelId ?? message.channelId
      await bridge.editMessage(message.id, trimmed, channelId, mentionUserIds)
      if (channelId) {
        editMessage(channelId, message.id, trimmed, new Date().toISOString(), mentionUserIds)
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
  if (matrixMode && message.id.startsWith('$') && !isDeleted) {
    contextMenuItems.push({
      id: 'copy-link',
      label: 'Copy message link',
      onSelect: () => {
        setContextMenuOpen(false)
        void copyText(matrixEventPermalink(message.channelId, message.id))
      },
    })
  }
  if (onToggleThread && !limitedActions && !isDeleted && !isUndecryptable && !isQueued) {
    contextMenuItems.push({
      id: 'thread',
      label: threadOpen
        ? 'Close thread'
        : threadReplyCount > 0
          ? 'Open thread'
          : 'Start a thread',
      onSelect: () => {
        setContextMenuOpen(false)
        onToggleThread()
      },
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
        onSelect: () => {
          setNextModalRestoreFocusTarget(rowRef.current)
          setContextMenuOpen(false)
          setConfirmDelete(true)
        },
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
      label: `Ban ${message.authorDisplayName}`,
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

  const resolvedAuthorNameId = authorNameId ?? `mesh-message-author-${message.id}`

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
        {/*
          No role and no aria-label here: the surrounding timeline row already
          carries `role="article"`, so a labelled group inside it announced
          every message twice. The delivery, edited, and deleted states are all
          legible in the row's own visible content.
        */}
        <div
          ref={rowRef}
          tabIndex={-1}
          className={`mesh-message-row group relative flex min-w-0 max-w-full gap-message-rail-gap px-shell-gutter py-shell-message-y outline-none transition-colors duration-fast hover:bg-state-hover ${
            !isGrouped ? 'mt-message-group' : ''
          }`}
          /* An unacknowledged send is marked, not dimmed: the same 2px rule
             used for channel selection, so your own words stay at full
             contrast at exactly the moment you want to reread them. */
          style={message.deliveryStatus === 'pending' ? PENDING_SEND_MARKER : undefined}
          onMouseLeave={() => setShowReactions(false)}
          onKeyDown={handleRowKeyDown}
        >
          {/*
            The gutter: 44px of right-aligned mono time, then the trust rail.

            This replaces a 112px prose gutter and hands roughly 90px back to
            the conversation. The time is revealed on hover for a grouped row
            and always present for the first row of a group, so the column
            reads as a continuous edge rather than a dotted one.
          */}
          <span className="mesh-message-time tnum flex w-message-time flex-none justify-end whitespace-nowrap pt-0.5 text-label-sm text-on-surface-variant">
            <span
              className={
                isGrouped
                  ? 'opacity-0 transition-opacity duration-instant group-hover:opacity-100 group-focus-within:opacity-100'
                  : undefined
              }
            >
              <MessageTime value={message.timestamp} variant="clock" />
            </span>
          </span>

          {/*
            The rail spans this row rather than the whole group, so consecutive
            grouped rows draw a continuous column without any of them needing to
            know how long the group is. The tooltip is where the origin server
            and key state live, and the only place they appear.
          */}
          <Tooltip
            side="right"
            content={(
              <div className="space-y-1 font-normal">
                <p className="text-on-surface">{trustRailLabel(trustTone, originServer)}</p>
                {originServer && <p className="text-label-sm text-on-surface-variant">{originServer}</p>}
                {message.id.startsWith('$') && (
                  <p className="text-label-sm text-on-surface-variant">{message.id}</p>
                )}
              </div>
            )}
          >
            <TrustRail tone={trustTone} server={originServer} />
          </Tooltip>

          {/* Content */}
          <div className="mesh-message-content flex min-w-0 flex-1 gap-2">
            {!isGrouped && (
              <span className="flex-none pt-0.5">
                <Avatar
                  color={message.authorAvatarColor}
                  seed={message.authorPublicKey}
                  size={26}
                  name={message.authorDisplayName}
                  imageUrl={message.authorAvatarUrl}
                />
              </span>
            )}
            <div className="min-w-0 flex-1">
            {isGrouped && (
              /* A grouped row has no visible header, but the surrounding
                 article still needs a stable element to name itself from.
                 aria-hidden keeps it out of the reading order while leaving it
                 usable as an aria-labelledby target. */
              <span id={resolvedAuthorNameId} aria-hidden="true" className="sr-only">
                {message.authorDisplayName}
              </span>
            )}
            {!isGrouped && (
              <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0">
                {/* Identity hue lives on the avatar, which is decorative
                    surface area. Painting the name with a hashed colour put
                    roughly two in five authors below AA on the dark canvas and
                    turned a busy room into confetti. */}
                <span id={resolvedAuthorNameId} className="text-body-md font-semibold text-on-surface">
                  {message.authorDisplayName}
                </span>
                <MessageTime
                  value={message.timestamp}
                  variant="full"
                  className="tnum text-body-sm text-on-surface-variant"
                />
              </div>
            )}

            {/*
              These chips carry no live-region role. `role="status"` implies
              aria-live on the element itself, which the timeline's
              aria-live="off" cannot suppress, so every virtualized insertion
              re-announced an already-known state as the user scrolled. The
              timeline owns dedicated announcer regions driven by its tail.
            */}
            {message.deliveryStatus === 'pending' && (
              <div
                data-delivery-chip="pending"
                className="mt-1 inline-flex items-center gap-1 text-body-sm text-marker"
              >
                <Icon name="loader" size="xs" className="animate-spin" />
                {isSavedForLater ? 'Saved for later' : 'Sending'}
              </div>
            )}

            {message.deliveryStatus === 'failed' && (
              /* `disableMotion` is set by the virtualized row: without honoring
                 it, the shake replayed every time a failed message scrolled
                 back into view, which reads as instability rather than as a
                 one-time alert. */
              <motion.div
                data-delivery-chip="failed"
                className="mt-1 flex flex-wrap items-center gap-2 text-body-sm text-error"
                initial={disableMotion ? false : { x: 0 }}
                animate={disableMotion ? undefined : { x: [0, -2, 2, 0] }}
                transition={transitions.failure}
              >
                <span>{permanentSendFailure ?? 'Could not send.'}</span>
                {permanentSendFailure ? null : (
                  <button
                    type="button"
                    onClick={() => onRetry?.(message)}
                    className="min-h-control-sm rounded-full bg-error-container px-2 font-medium transition-colors hover:bg-error-container-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus"
                  >
                    Try again
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => {
                    void copyText(message.content)
                      .then(() => showToast('Message text copied.', 'success'))
                      .catch(() => showToast('Could not copy this message.', 'error'))
                  }}
                  className="min-h-control-sm rounded-full px-2 font-medium text-on-surface-variant transition-colors hover:bg-surface-container-high focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus"
                >
                  Copy text
                </button>
                {onCancel && (
                  <button
                    type="button"
                    onClick={() => onCancel(message)}
                    className="min-h-control-sm rounded-full px-2 font-medium text-on-surface-variant transition-colors hover:bg-surface-container-high focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus"
                  >
                    Remove
                  </button>
                )}
              </motion.div>
            )}

            {mutation && mutation.status !== 'success' && mutation.status !== 'superseded' && (
              <div
                role={mutation.status === 'failed' ? 'alert' : 'status'}
                className={`mt-1 flex flex-wrap items-center gap-2 text-body-sm ${
                  mutation.status === 'failed' ? 'text-error' : 'text-marker'
                }`}
              >
                <span>
                  {mutation.status === 'failed'
                    ? `${mutation.label} failed. Your message and controls are unchanged.`
                    : `${mutation.label}…`}
                </span>
                {mutation.status === 'failed' && (
                  <button
                    type="button"
                    className="min-h-control-sm rounded-full bg-error-container px-2 font-medium hover:bg-error-container-hover"
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
            {/*
                A reply whose target is not loaded still is a reply, and
                `replyToId` proves it. Rendering nothing at all made the row
                read as an ordinary message and silently lost the relationship,
                which Discord and Element both avoid with a stub.
            */}
            {!replyPreview && message.replyToId && !isUndecryptable && !isDeleted && (
              <p className="mb-0.5 truncate text-body-sm text-on-surface-variant">
                replying to an earlier message
              </p>
            )}

            {replyPreview && !isUndecryptable && !isDeleted && (
              <button
                type="button"
                onClick={onJumpToReply ? () => onJumpToReply(replyPreview) : undefined}
                disabled={!onJumpToReply}
                aria-label={`Replying to ${replyPreview.authorDisplayName}: ${replyPreview.content.slice(0, 80) || 'message unavailable'}. Go to that message.`}
                /*
                  Plain text, not a quoted block. A bordered quote above every
                  reply doubles the visual weight of the thing being answered,
                  and the answer is what the row is for. The full quote stays in
                  the accessible name and one click still jumps to it.
                */
                className="mb-0.5 block w-full min-w-0 truncate rounded-full text-left text-body-sm text-on-surface-variant transition-colors enabled:hover:text-on-surface disabled:cursor-default"
              >
                <span aria-hidden="true">
                  replying to {replyPreview.authorDisplayName}
                </span>
              </button>
            )}

            {isDeleted ? (
              /* A redaction clears `content`, so without this branch the row
                 rendered as an empty gap that read as a rendering bug. A
                 tombstone keeps the deletion legible and auditable. */
              <p className="mt-0.5 inline-flex items-center gap-1.5 text-body-lg italic text-on-surface-variant">
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
              <EditComposer
                label={`Edit message from ${message.authorDisplayName}`}
                value={editContent}
                onChange={setEditContent}
                onSave={() => void handleSaveEdit()}
                onCancel={handleCancelEdit}
                disabled={mutationBusy}
                customEmoji={surface === 'dm' ? [] : customEmoji}
              />
            ) : (
              <div className="text-body-md text-on-surface">
                {/*
                  The body role, applied where the design puts it: 14px at 1.6,
                  one ink step below a title so prose recedes from structure.
                */}
                <MarkdownContent
                  content={message.content}
                  members={surface === 'dm' ? [] : communityMembers}
                  ownUserId={myPublicKey ?? null}
                  mentionUserIds={message.mentions ?? []}
                  roomWideMentionsAllowed={message.mentionsRoom ?? false}
                  customEmoji={surface === 'dm' ? [] : customEmoji}
                />
                {import.meta.env.DEV && message.designPreviewImageUrl ? (
                  <img
                    src={message.designPreviewImageUrl}
                    alt={`${message.authorDisplayName} shared concept art`}
                    className="mesh-message-media mt-3 w-full max-w-3xl rounded-xl border border-outline-variant object-cover"
                  />
                ) : null}
                {message.editedAt && (
                  <span
                    className="ml-1 text-label-sm text-on-surface-variant"
                    title={`Edited ${formatFullTime(message.editedAt)}`}
                  >
                    (edited)
                  </span>
                )}
              </div>
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
                aria-controls="mesh-thread-panel"
                aria-label={
                  threadOpen
                    ? `Close thread for message from ${message.authorDisplayName}`
                    : `Open thread for message from ${message.authorDisplayName}, ${threadReplyCount} ${threadReplyCount === 1 ? 'reply' : 'replies'}`
                }
                className="mt-2 inline-flex min-h-8 items-center gap-1.5 rounded-full px-2 text-body-sm font-medium text-primary transition-colors hover:bg-surface-container-high focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus"
              >
                <Icon name="messageCircle" size="xs" />
                {threadOpen ? 'Close thread' : `${threadReplyCount} ${threadReplyCount === 1 ? 'reply' : 'replies'}`}
              </button>
            )}

            {/* Reactions */}
            {!isDeleted && Object.keys(message.reactions).length > 0 && (
              <div className="mt-1 flex flex-wrap gap-1">
                <AnimatePresence initial={false}>
                {(() => {
                  // Reactor ids map to member.publicKey; built lazily here so it
                  // only costs anything on messages that actually carry reactions.
                  const nameByKey = new Map<string, string>()
                  for (const member of communityMembers) nameByKey.set(member.publicKey, member.displayName)
                  const customByKey = new Map(
                    (surface === 'dm' ? [] : customEmoji).map((entry) => [`:${entry.shortcode}:`, entry]),
                  )
                  return Object.entries(message.reactions).map(([emoji, users]) => {
                    const mine = Boolean(myPublicKey && users.includes(myPublicKey))
                    const custom = customByKey.get(emoji)
                    const readableKey = custom ? custom.shortcode : emoji
                    return (
                      <motion.span key={emoji} variants={variants.listItem} initial="initial" animate="animate" exit="exit" className="inline-flex">
                      <Tooltip content={formatReactors(users, nameByKey, myPublicKey)}>
                        <button
                          type="button"
                          disabled={mutationBusy}
                          onClick={() => handleReaction(emoji)}
                          aria-pressed={mine}
                          aria-label={`${readableKey}, ${users.length} ${users.length === 1 ? 'reaction' : 'reactions'}${mine ? ', you reacted' : ''}`}
                          /*
                            A square chip inside a hairline. The reaction itself
                            is the only round thing in the row, which is the
                            radius rule doing its job: the emoji is content, the
                            chip around it is structure.
                          */
                          className={`inline-flex min-h-6 items-center gap-1 rounded-full border border-rule px-1.5 py-0.5 text-body-sm transition-colors ${
                            mine
                              ? 'border-primary bg-primary-container text-primary'
                              : 'border-outline text-on-surface-variant hover:bg-state-hover hover:text-on-surface'
                          }`}
                        >
                          {/* A checkmark carries the "you reacted" state independently
                              of the accent tint, which was previously the only signal. */}
                          {mine && <Icon name="check" size="xs" aria-hidden="true" />}
                          {custom ? (
                            <img
                              src={custom.imageUrl}
                              alt=""
                              title={custom.body}
                              className="h-4 w-4 object-contain"
                            />
                          ) : (
                            <span aria-hidden="true">{emoji}</span>
                          )}
                          <span aria-hidden="true" className="badge-count text-label-sm font-semibold">{users.length}</span>
                        </button>
                      </Tooltip>
                      </motion.span>
                    )
                  })
                })()}
                </AnimatePresence>
              </div>
            )}
            </div>
          </div>

          {/* Action bar: always mounted (not just on hover) so Tab can reach it;
            group-hover/group-focus-within reveal it visually, matching the
            volume-slider pattern in VoicePeerGrid.tsx. pointer-events-none at
            rest keeps the invisible bar from intercepting clicks meant for
            the grouped message rendered underneath it (-top-4 overlap). */}
          {!contextMenuOpen && !isEditing && !isDeleted && !isQueued && !isUndecryptable && !mutationBusy && (
            <div
              ref={actionsRef}
              role="toolbar"
              aria-label={`Actions for the message from ${message.authorDisplayName}`}
              aria-orientation="horizontal"
              onKeyDown={handleActionsKeyDown}
              className="mesh-message-actions pointer-events-none absolute -top-4 right-5 z-sticky flex items-center rounded-xl border border-outline-variant bg-surface-container-high opacity-0 shadow-elev-3 transition-opacity group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100">
              {/* One-tap quick reactions from the user's recent (or default) emoji. */}
              {quickReactions.map((emoji, quickIndex) => {
                const custom = (surface === 'dm' ? [] : customEmoji).find(
                  (candidate) => `:${candidate.shortcode}:` === emoji,
                )
                // A glyph is not a name: "React with 👍" reads as "React with"
                // followed by whatever the screen reader guesses.
                //
                // Named apart from the picker's own entries, which are plain
                // "React with ...". Both sit in the same message row, so one
                // shared name left a screen reader with two different controls
                // announcing identically and no way to tell them apart.
                const emojiName = custom
                  ? custom.shortcode
                  : (EMOJI_BY_CHAR.get(emoji)?.name ?? emoji)
                return (
                  <button
                    key={`quick-${emoji}`}
                    type="button"
                    {...actionButtonProps(`quick-${quickIndex}`)}
                    onClick={() => {
                      void handleReaction(emoji)
                      rememberEmoji(emoji)
                    }}
                    aria-label={`Quick react with ${emojiName}`}
                    className="flex h-8 w-8 items-center justify-center text-on-surface-variant transition-colors hover:bg-surface-container-high hover:text-on-surface-variant focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus motion-safe:active:scale-95"
                  >
                    {custom ? (
                      <img src={custom.imageUrl} alt="" className="h-5 w-5 object-contain" />
                    ) : (
                      <span aria-hidden="true">{emoji}</span>
                    )}
                  </button>
                )
              })}
              <Popover
                open={showReactions}
                onOpenChange={setShowReactions}
                side="top"
                align="end"
                className="w-auto border-0 bg-transparent p-0 shadow-none"
                trigger={(
                  <button
                    ref={reactButtonRef}
                    {...actionButtonProps('react')}
                    className="flex h-8 w-8 items-center justify-center text-on-surface-variant transition-colors hover:bg-surface-container-high hover:text-on-surface-variant focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus"
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
                />
              </Popover>
              {isOwnMessage && (
                <button
                  type="button"
                  {...actionButtonProps('edit')}
                  onClick={handleStartEdit}
                  className="flex h-8 w-8 items-center justify-center text-on-surface-variant transition-colors hover:bg-surface-container-high hover:text-on-surface-variant focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus"
                  aria-label="Edit message"
                >
                  <Icon name="squarePen" size="sm" />
                </button>
              )}
              {onReply && (
                <button
                  type="button"
                  {...actionButtonProps('reply')}
                  onClick={() => onReply(message)}
                  className="flex h-8 w-8 items-center justify-center text-on-surface-variant transition-colors hover:bg-surface-container-high hover:text-on-surface-variant focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus"
                  aria-label={`Reply to ${message.authorDisplayName}`}
                >
                  <Icon name="reply" size="sm" />
                </button>
              )}
              {onToggleThread && !limitedActions && (
                <button
                  type="button"
                  {...actionButtonProps('thread')}
                  onClick={onToggleThread}
                  className="flex h-8 w-8 items-center justify-center text-on-surface-variant transition-colors hover:bg-surface-container-high hover:text-on-surface-variant focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus"
                  aria-expanded={threadOpen}
                  aria-controls="mesh-thread-panel"
                  aria-label={
                    threadOpen
                      ? `Close thread for message from ${message.authorDisplayName}`
                      : threadReplyCount > 0
                        ? `Open thread for message from ${message.authorDisplayName}`
                        : `Start a thread from message by ${message.authorDisplayName}`
                  }
                >
                  <Icon name="messageCircle" size="sm" />
                </button>
              )}
              {canPinMessage && (
                <button
                  type="button"
                  {...actionButtonProps('pin')}
                  onClick={() => void handlePin()}
                  className={`flex h-8 w-8 items-center justify-center transition-colors hover:bg-surface-container-high hover:text-on-surface-variant focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus ${
                    isPinned ? 'text-primary' : 'text-on-surface-variant'
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

      <Modal
        open={confirmDelete}
        onClose={() => {
          if (!mutationBusy) setConfirmDelete(false)
        }}
        title="Delete message?"
        description="This removes the message for everyone in this conversation. This cannot be undone."
        size="sm"
      >
        <div className="flex justify-end gap-2">
          <Button variant="ghost" size="sm" disabled={mutationBusy} onClick={() => setConfirmDelete(false)}>
            Keep message
          </Button>
          <Button
            tone="danger"
            size="sm"
            disabled={mutationBusy}
            onClick={() => {
              setConfirmDelete(false)
              void handleDelete()
            }}
          >
            Delete message
          </Button>
        </div>
      </Modal>
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

  /*
    An exception speaks, but it speaks briefly.

    This used to be a bordered warning card with a title, a body sentence and a
    button, which is more chrome than the message it stands in for. Quiet
    Structure gives an exception one mono line and a dot; the sentence that
    explains it moves into the tooltip, where the rail already keeps the server
    and key detail, and the way out stays a link rather than a framed action.
  */
  return (
    <div className="mt-1 max-w-xl" data-undecryptable-message="true" role="note">
      <Tooltip side="right" content={<p className="max-w-xs font-normal">{copy.body}</p>}>
        <span className="inline-flex">
          <ExceptionLine>{copy.title}</ExceptionLine>
        </span>
      </Tooltip>
      {showSecurityHelp && (
        <button
          type="button"
          onClick={onOpenSecurity}
          className="mt-1 min-h-control-sm rounded-full text-label-md font-semibold text-on-surface-variant underline-offset-4 transition-colors hover:text-on-surface hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus"
        >
          Review security
        </button>
      )}
    </div>
  )
}

function undecryptableCopy(reason: UndecryptableReason) {
  switch (reason) {
    case 'sent-before-device':
      return {
        title: 'Sent before this device could receive it',
        body: 'It may become available after you restore message history on this device.',
      }
    case 'keys-not-shared':
      return {
        title: 'This device cannot open it yet',
        body: 'Review your signed-in devices and ask the sender to send the message again if needed.',
      }
    case 'waiting-for-keys':
      return {
        title: 'Waiting for protected history',
        body: 'Mesh is still loading message history. This message may appear when loading finishes.',
      }
    case 'could-not-decrypt':
    default:
      return {
        title: 'Not available on this device',
        body: 'The message is still part of the conversation, but its content is not available here.',
      }
  }
}

function downloadStateLabel(state: MatrixTransferState): string {
  switch (state) {
    case 'queued':
      return 'Waiting'
    case 'encrypting':
      return 'Preparing'
    case 'uploading':
      return 'Uploading'
    case 'publishing':
      return 'Opening'
    case 'downloading':
      return 'Downloading'
    case 'validating':
      return 'Checking'
    case 'writing':
      return 'Saving'
    case 'completed':
      return 'Complete'
    case 'cancelled':
      return 'Cancelled'
    case 'failed':
      return 'Failed'
  }
}

export function FileAttachmentCard({
  attachment,
  roomId,
  eventId,
  attachmentIndex,
  onOpenImage,
  compact = false,
}: {
  attachment: MessageType['attachments'][number]
  roomId: string
  eventId: string
  attachmentIndex: number
  onOpenImage?: () => void
  compact?: boolean
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
  const actionLabel = isCompleted
    ? `Open ${attachment.filename}`
    : isDownloading && matrixMode
      ? `Cancel download of ${attachment.filename}`
      : `Download ${attachment.filename}`
  const actionText = isCompleted
    ? 'Open'
    : isDownloading && matrixMode
      ? 'Cancel'
      : isDownloading
        ? `${progressPercent}%`
        : isErrored && download?.retryMode === 'restart-from-zero'
          ? 'Restart'
          : isErrored
            ? 'Retry'
            : 'Download'
  const handleAction = isCompleted ? handleOpen : isDownloading && matrixMode ? cancelDownload : startDownload

  if (compact) {
    return (
      <div className="rounded-full border border-outline-variant bg-surface-container p-2.5">
        <div className="flex min-w-0 items-center gap-2">
          <span className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-surface-container-high text-on-surface-variant">
            <Icon name="fileText" size="sm" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-body-sm font-medium text-primary">{attachment.filename}</span>
            <span className="block text-label-sm text-on-surface-variant">{(attachment.size / 1024 / 1024).toFixed(2)} MB</span>
          </span>
        </div>
        {isDownloading && (
          <div className="mt-2 h-1 overflow-hidden rounded-full bg-surface-container-highest">
            <div
              className="h-full rounded-full bg-primary transition-[width] duration-normal"
              data-design-token-exception="data-driven-transfer-progress-width"
              style={{ width: `${progressPercent}%` }}
            />
          </div>
        )}
        {isErrored && <p className="mt-2 text-label-sm text-error">Download failed. Try again to restart the download.</p>}
        <button
          type="button"
          onClick={() => void handleAction()}
          disabled={isDownloading && !matrixMode}
          className={`mt-2 min-h-9 w-full rounded-full px-3 text-body-sm font-semibold transition-colors ${
            isCompleted
              ? 'bg-primary-container text-primary hover:bg-primary-container-hover'
              : isErrored
                ? 'bg-error-container text-error hover:bg-error-container-hover'
                : 'bg-surface-container-high text-on-surface-variant hover:bg-surface-container-highest'
          } disabled:opacity-60`}
          aria-label={actionLabel}
        >
          {actionText}
        </button>
      </div>
    )
  }

  return (
    <div className="max-w-sm overflow-hidden rounded-xl border border-outline-variant bg-surface-container">
      {matrixMode && attachment.thumbnail && (
        <EncryptedAttachmentPreview
          key={`${eventId}:${attachmentIndex}:${attachment.thumbnail.fileHash}`}
          filename={attachment.filename}
          roomId={roomId}
          eventId={eventId}
          attachmentIndex={attachmentIndex}
          thumbnail={attachment.thumbnail}
          contentType={attachment.contentType}
          sourceBytes={attachment.size}
          onOpen={onOpenImage}
        />
      )}

      <div className="flex items-center gap-3 p-3">
        <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-surface-container-high text-on-surface-variant">
          <Icon name="fileText" />
        </div>

        <div className="min-w-0 flex-1">
          <div className="truncate text-body-md font-medium text-primary">{attachment.filename}</div>
          <div className="text-body-sm text-on-surface-variant">{(attachment.size / 1024 / 1024).toFixed(2)} MB</div>

          {isDownloading && (
            <div className="mt-1.5">
              <div className="h-1 overflow-hidden rounded-full bg-surface-container-highest">
                <div
                  className="h-full rounded-full bg-primary transition-[width] duration-normal"
                  data-design-token-exception="data-driven-transfer-progress-width"
                  style={{ width: `${progressPercent}%` }}
                />
              </div>
              {download?.matrixState && (
                <div className="mt-1 text-label-sm text-on-surface-variant">{downloadStateLabel(download.matrixState)}</div>
              )}
            </div>
          )}
          {isErrored && <div className="mt-1 text-body-sm text-error">Download failed. Try again to restart the download.</div>}
        </div>

        <button
          onClick={handleAction}
          disabled={isDownloading && !matrixMode}
          className={`rounded px-3 py-1.5 text-body-sm font-medium transition-colors ${
            isCompleted
              ? 'bg-primary-container text-primary hover:bg-primary-container-hover'
              : isErrored
                ? 'bg-error-container text-error hover:bg-error-container-hover'
                : 'bg-surface-container-high text-on-surface-variant hover:bg-surface-container-highest'
          } disabled:opacity-60`}
          aria-label={actionLabel}
        >
          {actionText}
        </button>
      </div>
    </div>
  )
}

function attachmentErrorMessage(error: unknown, operation: string): string {
  const description = describeError(error, { operation })
  return errorLine(description)
}
