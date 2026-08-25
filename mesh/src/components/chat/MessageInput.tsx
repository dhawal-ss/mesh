import { useState, useRef, useEffect, useLayoutEffect, useCallback, useMemo } from 'react'
import { isTauri } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { FileAttachmentPreview, type StagedFile } from './FileAttachment'
import { Tooltip } from '../ui/Tooltip'
import { showToast } from '../ui/Toast'
import { ErrorState } from '../ui/ErrorState'
import * as bridge from '../../lib/bridge'
import { AppError, describeError } from '../../lib/errors'
import type { MatrixTransferProgress } from '../../types/ipc'
import {
  discardStagedFile,
  MAX_PENDING_ATTACHMENTS,
  stagedFileFromGrant,
  stageWebFile,
} from '../../lib/attachments'
import { ScopedErrorBoundary } from '../ui/ScopedErrorBoundary'
import { Icon } from '../ui/Icon'
import { Popover } from '../ui/InteractivePrimitives'
import type { MemberRecord } from '../../store/membership'
import { draftByteLength, MAX_DRAFT_BYTES, truncateDraft, useDraftStore } from '../../store/drafts'

/** Start showing remaining space at 80% of the cap, not only at the cap. */
const DRAFT_WARNING_BYTES = MAX_DRAFT_BYTES * 0.8
import { useDurableDraft } from '../../hooks/useDurableDraft'
import {
  expandSlashCommand,
  getSlashCommandContext,
  getSlashCommandSuggestions,
  toggleMarkdownFormat,
  type MarkdownFormat,
} from '../../lib/composer'
import { ReactionPicker } from './ReactionPicker'
import { useServerEmoji } from '../../store/custom-emoji'
import {
  mentionDisplayToken,
  parseStructuredMentionDraft,
  reconcileStructuredMentions,
  serializeStructuredMentionDraft,
  structuredMentionUserIds,
  type StructuredMention,
} from '../../lib/structured-mentions'
import type { ComposerDraftDto } from '../../types/ipc'
import { memberDisambiguationHandle } from '../../lib/member-handle'

interface MessageInputProps {
  channelId: string
  channelName: string
  placeholder?: string
  onSend: (
    content: string,
    files?: StagedFile[],
    onAttachmentSent?: (file: StagedFile, contentConsumed: boolean) => void | Promise<void>,
    mentionUserIds?: readonly string[],
    mentionsRoom?: boolean,
  ) => void | Promise<void>
  disableAttachments?: boolean
  disabled?: boolean
  communityId?: string
  members?: readonly MemberRecord[]
  /**
   * Whether this account is believed to be allowed to notify the whole room.
   *
   * A hint for the affordance only. The backend re-checks the power level at
   * send time and refuses if it has changed, because a role read when the
   * composer rendered is not a fact about when the message is sent.
   */
  canNotifyRoom?: boolean
  onEditLastMessage?: () => void
  onComposerFocus?: () => void
}

const TYPING_THROTTLE_MS = 5000
const MAX_MENTION_SUGGESTIONS = 6

/**
 * Each glyph is styled as the thing it does: the bold control is bold, the
 * italic control is italic, and so on. A letter that does not demonstrate its
 * own effect is just a letter.
 */
const FORMAT_CONTROLS = [
  ['bold', 'Bold', 'B', 'font-semibold'],
  ['italic', 'Italic', 'I', 'italic font-medium'],
  ['strike', 'Strikethrough', 'S', 'font-medium line-through'],
  ['code', 'Inline code', '<>', 'font-mono font-medium'],
] as const satisfies readonly (readonly [MarkdownFormat, string, string, string])[]

interface MentionContext {
  start: number
  end: number
  query: string
}

/**
 * `@room` sits in the same list as the members so it is discoverable in the
 * one place people already look, but it is not a member: it has no user id and
 * never joins `m.mentions.user_ids`.
 */
type MentionSuggestion =
  | { kind: 'member'; member: MemberRecord }
  | { kind: 'room' }

/**
 * `@everyone` is accepted alongside `@room` because it is what people arriving
 * from other chat applications type, and both set the single room-wide flag
 * Matrix carries. `@here` is not here: it would promise an online-only
 * audience that `m.mentions` cannot express.
 */
const ROOM_MENTION_TOKENS = ['room', 'everyone'] as const

/**
 * Whether a drafted body asks to notify the whole room.
 *
 * This matches inside inline code too, so a message explaining the feature
 * notifies the room while rendering the token as code. That is visible before
 * it happens rather than after: the composer states what send will do.
 */
export function bodyMentionsRoom(body: string): boolean {
  return /(?<![\w@])@(?:room|everyone)\b/u.test(body)
}

function getMentionContext(value: string, cursor: number): MentionContext | null {
  const beforeCursor = value.slice(0, cursor)
  const match = beforeCursor.match(/(?:^|\s)@([^\s@]*)$/)
  if (!match) return null

  const token = match[0]
  const tokenOffset = token.startsWith('@') ? 0 : 1
  return {
    start: cursor - token.length + tokenOffset,
    end: cursor,
    query: match[1],
  }
}

function isMatrixUserId(value: string) {
  return /^@[^\s:@]+:[^\s]+$/.test(value)
}

export function MessageInput(props: MessageInputProps) {
  return (
    <ScopedErrorBoundary
      name="Message composer"
      description="The message composer could not be displayed. Retry it without leaving this conversation."
      className="mx-4 mb-4"
      resetKey={props.channelId}
    >
      <MessageInputContent {...props} />
    </ScopedErrorBoundary>
  )
}

function MessageInputContent({
  channelId,
  channelName,
  placeholder,
  onSend,
  disableAttachments,
  disabled,
  communityId,
  members = [],
  canNotifyRoom = false,
  onEditLastMessage,
  onComposerFocus,
}: MessageInputProps) {
  const [value, setValue] = useState(() => useDraftStore.getState().drafts[channelId] ?? '')
  const [structuredMentions, setStructuredMentions] = useState<StructuredMention[]>([])
  const setDraft = useDraftStore((state) => state.setDraft)
  const customEmoji = useServerEmoji(communityId)
  const clearDraft = useDraftStore((state) => state.clearDraft)
  const applyLoadedDraft = useCallback((loadedDraft: ComposerDraftDto) => {
    const normalized = truncateDraft(loadedDraft.body)
    setValue(normalized)
    setDraft(channelId, normalized)
    setStructuredMentions(parseStructuredMentionDraft(
      normalized,
      normalized === loadedDraft.body ? loadedDraft.formattedBody : null,
    ))
  }, [channelId, setDraft])
  const formattedDraftBody = useMemo(
    () => serializeStructuredMentionDraft(value, structuredMentions),
    [structuredMentions, value],
  )
  const {
    status: draftSyncStatus,
    markChanged: markDraftChanged,
    clear: clearDurableDraft,
    retry: retryDraftSync,
  } = useDurableDraft(channelId, {
    body: value,
    formattedBody: formattedDraftBody,
  }, applyLoadedDraft)
  const updateDraftValue = useCallback((
    nextValue: string,
    nextMentions = reconcileStructuredMentions(value, nextValue, structuredMentions),
  ) => {
    setValue(nextValue)
    setStructuredMentions(nextMentions)
    setDraft(channelId, nextValue)
    markDraftChanged()
  }, [channelId, markDraftChanged, setDraft, structuredMentions, value])
  const clearCurrentDraft = useCallback(() => {
    setStructuredMentions([])
    clearDraft(channelId)
    clearDurableDraft()
  }, [channelId, clearDraft, clearDurableDraft])
  const [mentionCursor, setMentionCursor] = useState(0)
  const [mentionIndex, setMentionIndex] = useState(0)
  // Roving tabindex: the formatting toolbar is one tab stop, and the arrow
  // keys move within it, so Tab still reaches the composer in two presses.
  const [formatFocusIndex, setFormatFocusIndex] = useState(0)
  /*
    Whether the composer holds a non-collapsed selection.

    This gates the formatting toolbar. Resting chrome that announces a
    capability nobody is using is exactly what this system spends nothing on,
    and the controls are meaningless without something selected to apply them
    to.
  */
  const [hasSelection, setHasSelection] = useState(false)
  const syncSelection = useCallback((element: HTMLTextAreaElement) => {
    setHasSelection(element.selectionEnd > element.selectionStart)
  }, [])
  const formatButtonsRef = useRef<(HTMLButtonElement | null)[]>([])
  const [mentionsDismissed, setMentionsDismissed] = useState(false)
  const [slashIndex, setSlashIndex] = useState(0)
  const [slashDismissed, setSlashDismissed] = useState(false)
  const [emojiPickerOpen, setEmojiPickerOpen] = useState(false)
  const [stagedFiles, setStagedFiles] = useState<StagedFile[]>([])
  const [isDragOver, setIsDragOver] = useState(false)
  const [isStaging, setIsStaging] = useState(false)
  const [isUploading, setIsUploading] = useState(false)
  const [attachmentError, setAttachmentError] = useState<unknown | null>(null)
  const [attachmentGuidance, setAttachmentGuidance] = useState<string | null>(null)
  const [matrixTransfers, setMatrixTransfers] = useState<Record<string, MatrixTransferProgress>>({})
  const rootRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const compositionActiveRef = useRef(false)
  const stagedFilesRef = useRef(stagedFiles)
  const stagingCountRef = useRef(0)
  const intakeGenerationRef = useRef(0)
  const pendingNativeDropsRef = useRef(new Map<string, {
    inputGeneration: number
    accountGeneration: number
  }>())
  const sendingFilesRef = useRef(new Set<StagedFile>())
  const mountedRef = useRef(true)
  const lastTypingBroadcast = useRef<number>(0)
  const pendingSelectionRef = useRef<{ start: number; end: number } | null>(null)

  // Focus the composer when it first appears, but do not steal focus back from
  // the room list when a keyboard user switches rooms.
  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  useEffect(() => {
    return () => {
      bridge.setTyping(channelId, false).catch(() => {})
    }
  }, [channelId])

  useEffect(() => {
    if (!isTauri() || !bridge.isMatrixBackend()) return
    let active = true
    let unlisten: (() => void) | undefined
    void bridge.onMatrixTransferProgress((transfer) => {
      if (!active || transfer.direction !== 'upload') return
      setMatrixTransfers((current) => ({
        ...current,
        [transfer.transferId]: transfer,
      }))
    }).then((stopListening) => {
      if (active) unlisten = stopListening
      else stopListening()
    }).catch((error) => {
      console.warn('Failed to register the attachment progress listener:', error)
    })
    return () => {
      active = false
      unlisten?.()
    }
  }, [])

  const broadcastTypingThrottled = useCallback(() => {
    const now = Date.now()
    if (now - lastTypingBroadcast.current >= TYPING_THROTTLE_MS) {
      lastTypingBroadcast.current = now
      bridge.broadcastTyping(channelId).catch(() => {})
    }
  }, [channelId])

  const mentionContext = !mentionsDismissed && communityId && bridge.isMatrixBackend()
    ? getMentionContext(value, mentionCursor)
    : null
  const roomMentionQuery = mentionContext?.query.toLocaleLowerCase() ?? ''
  const roomMentionOffered = Boolean(mentionContext)
    && canNotifyRoom
    && ROOM_MENTION_TOKENS.some((token) => token.startsWith(roomMentionQuery))
  const mentionSuggestions: MentionSuggestion[] = mentionContext
    ? [
      // First, because it is the entry a person is looking for when they have
      // something everyone needs to see, and because it is the one nobody
      // knows to type.
      ...(roomMentionOffered ? [{ kind: 'room' } as const] : []),
      ...members
        .filter((member) => (
          member.joinStatus === 'joined'
          && member.banStatus === 'none'
          && isMatrixUserId(member.publicKey)
        ))
        .filter((member) => (
          member.displayName.toLocaleLowerCase().includes(roomMentionQuery)
        ))
        .slice(0, MAX_MENTION_SUGGESTIONS)
        .map((member) => ({ kind: 'member', member }) as const),
    ]
    : []
  const activeMentionIndex = Math.min(mentionIndex, Math.max(mentionSuggestions.length - 1, 0))
  const slashContext = !slashDismissed ? getSlashCommandContext(value, mentionCursor) : null
  const slashSuggestions = slashContext ? getSlashCommandSuggestions(slashContext.query) : []
  const activeSlashIndex = Math.min(slashIndex, Math.max(slashSuggestions.length - 1, 0))

  const selectMention = (suggestion: MentionSuggestion) => {
    if (!mentionContext) return
    const token = suggestion.kind === 'room'
      ? '@room'
      : mentionDisplayToken(suggestion.member.displayName)
    const nextValue = truncateDraft(
      `${value.slice(0, mentionContext.start)}${token} ${value.slice(mentionContext.end)}`,
    )
    const nextCursor = Math.min(
      mentionContext.start + token.length + 1,
      nextValue.length,
    )
    const reconciledMentions = reconcileStructuredMentions(value, nextValue, structuredMentions)
    const tokenEnd = Math.min(mentionContext.start + token.length, nextValue.length)
    // A room-wide mention records no structured entry: it names nobody, and
    // the flag it sets is decided from the body at send time.
    const nextMentions = suggestion.kind === 'member'
      && tokenEnd - mentionContext.start === token.length
      ? [...reconciledMentions, {
          start: mentionContext.start,
          end: tokenEnd,
          userId: suggestion.member.publicKey,
        }]
      : reconciledMentions
    updateDraftValue(nextValue, nextMentions)
    setMentionCursor(nextCursor)
    setMentionsDismissed(true)
    setSlashDismissed(true)
    requestAnimationFrame(() => {
      inputRef.current?.focus()
      inputRef.current?.setSelectionRange(nextCursor, nextCursor)
    })
  }

  const insertEmoji = (emoji: string) => {
    const input = inputRef.current
    const start = input?.selectionStart ?? mentionCursor
    const end = input?.selectionEnd ?? start
    const nextValue = truncateDraft(`${value.slice(0, start)}${emoji}${value.slice(end)}`)
    const nextCursor = Math.min(start + emoji.length, nextValue.length)
    updateDraftValue(nextValue)
    setMentionCursor(nextCursor)
    setMentionIndex(0)
    setMentionsDismissed(true)
    setSlashDismissed(true)
    pendingSelectionRef.current = { start: nextCursor, end: nextCursor }
    requestAnimationFrame(() => inputRef.current?.focus())
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (
      compositionActiveRef.current
      || e.nativeEvent.isComposing
      || e.nativeEvent.keyCode === 229
    ) return

    if (mentionSuggestions.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setMentionIndex((current) => (
          (Math.min(current, mentionSuggestions.length - 1) + 1) % mentionSuggestions.length
        ))
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setMentionIndex((current) => (
          (Math.min(current, mentionSuggestions.length - 1) - 1 + mentionSuggestions.length)
            % mentionSuggestions.length
        ))
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        setMentionsDismissed(true)
        return
      }
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        selectMention(mentionSuggestions[activeMentionIndex])
        return
      }
    }

    if (slashSuggestions.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setSlashIndex((current) => (
          (Math.min(current, slashSuggestions.length - 1) + 1) % slashSuggestions.length
        ))
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setSlashIndex((current) => (
          (Math.min(current, slashSuggestions.length - 1) - 1 + slashSuggestions.length)
            % slashSuggestions.length
        ))
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        setSlashDismissed(true)
        return
      }
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        const command = slashSuggestions[activeSlashIndex]
        if (slashContext && command) {
          const nextValue = truncateDraft(
            `${value.slice(0, slashContext.start)}${command.command} ${value.slice(slashContext.end)}`,
          )
          const nextCursor = Math.min(
            slashContext.start + command.command.length + 1,
            nextValue.length,
          )
          updateDraftValue(nextValue)
          setMentionCursor(nextCursor)
          setSlashDismissed(true)
          pendingSelectionRef.current = { start: nextCursor, end: nextCursor }
        }
        return
      }
    }

    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      void handleSubmit()
    } else if (e.key === 'ArrowUp' && !value && stagedFiles.length === 0 && onEditLastMessage) {
      e.preventDefault()
      onEditLastMessage()
    } else if (e.key === 'Escape' && !value && stagedFiles.length > 0) {
      e.preventDefault()
      void handleRemoveFile(stagedFiles.length - 1)
    }
  }

  // Say what pressing send will actually do. The attachment branch matters
  // most: the encrypted-media path carries no room-wide flag, so without this
  // the mention would be dropped on the way out and nobody would be told.
  const draftMentionsRoom = canNotifyRoom && bodyMentionsRoom(value)
  const roomNotifyNotice = !draftMentionsRoom
    ? null
    : stagedFiles.length > 0
      ? `Send the message without attachments to notify ${channelName}.`
      : `This will notify everyone in ${channelName}.`

  const draftBytesUsed = draftByteLength(value)
  const draftAtLimit = draftBytesUsed >= MAX_DRAFT_BYTES
  const canSend =
    !disabled
    && !isUploading
    && !isStaging
    && (value.trim().length > 0 || stagedFiles.length > 0)

  const handleSubmit = async () => {
    if (disabled || isUploading || isStaging) return
    const content = expandSlashCommand(value.trim())
    const submittedMentions = reconcileStructuredMentions(value, content, structuredMentions)
    const mentionUserIds = structuredMentionUserIds(content, submittedMentions)
    // Read from the body rather than from what was clicked, so somebody who
    // types `@room` out of habit gets the same result as somebody who picked
    // it from the list. The backend still decides whether it is allowed.
    const mentionsRoom = canNotifyRoom && bodyMentionsRoom(content)
    if (!content && stagedFiles.length === 0) return

    const sendGeneration = intakeGenerationRef.current
    const filesAtStart = [...stagedFiles]
    if (bridge.isMatrixBackend()) {
      // A file keeps the transfer id it was staged with across retries, so a
      // resend of an unresolved attachment reuses the same Matrix transaction
      // id rather than risking a duplicate message on the server.
      for (const file of filesAtStart) file.transferId ??= bridge.createMatrixTransferId()
      setStagedFiles([...filesAtStart])
    }
    for (const file of filesAtStart) sendingFilesRef.current.add(file)
    if (filesAtStart.length > 0) setIsUploading(true)
    setAttachmentError(null)
    setAttachmentGuidance(null)
    try {
      if (stagedFiles.length > 0 && bridge.isMatrixBackend() && !disableAttachments) {
        const pendingAtStart = filesAtStart
        const acknowledged = new Set<StagedFile>()
        await onSend(content, pendingAtStart, async (file, contentConsumed) => {
          acknowledged.add(file)
          sendingFilesRef.current.delete(file)
          await discardStagedFile(file).catch((error) => {
            console.error('Failed to discard sent attachment staging file:', error)
          })
          if (intakeGenerationRef.current === sendGeneration) {
            const next = stagedFilesRef.current.filter((candidate) => candidate !== file)
            stagedFilesRef.current = next
            setStagedFiles(next)
            if (contentConsumed) {
              setValue('')
              clearCurrentDraft()
            }
          }
        }, mentionUserIds)
        // Backward-compatible cleanup for callers that completed the whole send
        // without reporting per-file progress.
        const unacknowledged = pendingAtStart.filter((file) => !acknowledged.has(file))
        await Promise.allSettled(unacknowledged.map(discardStagedFile))
        for (const file of unacknowledged) sendingFilesRef.current.delete(file)
        if (intakeGenerationRef.current === sendGeneration) {
          stagedFilesRef.current = stagedFilesRef.current.filter(
            (candidate) => !unacknowledged.includes(candidate),
          )
          setStagedFiles(stagedFilesRef.current)
          setValue('')
          clearCurrentDraft()
          bridge.setTyping(channelId, false).catch(() => {})
        }
        return
      }

      if (filesAtStart.length > 0) {
        for (const file of filesAtStart) {
          if (!file.path) {
            throw new Error('This attachment has no legacy file access grant. Choose it again.')
          }
          if (communityId) {
            await bridge.uploadFile(channelId, file.path)
          } else {
            await bridge.uploadDmFile(channelId, file.path)
          }
          sendingFilesRef.current.delete(file)
          if (intakeGenerationRef.current === sendGeneration) {
            const remaining = stagedFilesRef.current.filter((candidate) => candidate !== file)
            stagedFilesRef.current = remaining
            setStagedFiles(remaining)
          }
        }
      }

      if (content && filesAtStart.length === 0) {
        // Clear visually before awaiting a text-only send so the composer
        // remains available, but keep the durable draft until delivery is
        // acknowledged. A newer draft must never be erased by the old send.
        setValue('')
        bridge.setTyping(channelId, false).catch(() => {})
        await (mentionUserIds.length > 0 || mentionsRoom
          ? onSend(content, undefined, undefined, mentionUserIds, mentionsRoom)
          : onSend(content))
        if (useDraftStore.getState().drafts[channelId] === value) {
          clearCurrentDraft()
        }
        return
      }
      if (content) {
        await (mentionUserIds.length > 0 || mentionsRoom
          ? onSend(content, undefined, undefined, mentionUserIds, mentionsRoom)
          : onSend(content))
      }
      if (intakeGenerationRef.current === sendGeneration) {
        setValue('')
        clearCurrentDraft()
        bridge.setTyping(channelId, false).catch(() => {})
      }
    } catch (error) {
      console.error('Failed to send message or attachment:', error)
      if (
        filesAtStart.length === 0
        && content
        && useDraftStore.getState().drafts[channelId] === value
      ) {
        setValue(value)
      }
      if (filesAtStart.length > 0 && intakeGenerationRef.current === sendGeneration) {
        setAttachmentError(error)
        setAttachmentGuidance(null)
      } else {
        await Promise.allSettled(filesAtStart.map(discardStagedFile))
      }
    } finally {
      for (const file of filesAtStart) sendingFilesRef.current.delete(file)
      if (filesAtStart.length > 0 && intakeGenerationRef.current === sendGeneration) {
        setIsUploading(false)
      }
    }
  }

  const handleFormattingKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const last = FORMAT_CONTROLS.length - 1
    let next: number | null = null
    if (event.key === 'ArrowRight') next = formatFocusIndex >= last ? 0 : formatFocusIndex + 1
    else if (event.key === 'ArrowLeft') next = formatFocusIndex <= 0 ? last : formatFocusIndex - 1
    else if (event.key === 'Home') next = 0
    else if (event.key === 'End') next = last
    if (next === null) return
    event.preventDefault()
    setFormatFocusIndex(next)
    formatButtonsRef.current[next]?.focus()
  }

  const applyFormatting = (format: MarkdownFormat) => {
    const textarea = inputRef.current
    if (!textarea || disabled || isUploading || isStaging) return
    const result = toggleMarkdownFormat(
      value,
      textarea.selectionStart,
      textarea.selectionEnd,
      format,
    )
    const nextValue = truncateDraft(result.value)
    const selectionStart = Math.min(result.selectionStart, nextValue.length)
    const selectionEnd = Math.min(result.selectionEnd, nextValue.length)
    updateDraftValue(nextValue)
    setMentionCursor(selectionEnd)
    setMentionsDismissed(true)
    setSlashDismissed(true)
    pendingSelectionRef.current = {
      start: selectionStart,
      end: selectionEnd,
    }
  }

  const appendFiles = useCallback((files: StagedFile[], errors: string[] = []) => {
    const existing = stagedFilesRef.current
    const available = Math.max(0, MAX_PENDING_ATTACHMENTS - existing.length)
    const candidates: StagedFile[] = []
    const rejected: StagedFile[] = []
    for (const file of files) {
      const duplicate = [...existing, ...candidates].some((candidate) => (
        candidate.grant === file.grant
      ))
      if (duplicate) rejected.push(file)
      else candidates.push(file)
    }
    const accepted = candidates.slice(0, available)
    rejected.push(...candidates.slice(available))
    if (candidates.length > available) {
      errors.push(`Mesh allows up to ${MAX_PENDING_ATTACHMENTS} pending attachments at once.`)
    }
    for (const file of rejected) {
      void discardStagedFile(file)
    }
    if (accepted.length > 0) {
      const next = [...existing, ...accepted]
      stagedFilesRef.current = next
      setStagedFiles(next)
      setAttachmentError(null)
      setAttachmentGuidance(null)
    }
    if (errors.length > 0) {
      const message = errors.join(' ')
      const error = new AppError('invalid_input', message, false)
      const description = describeError(error, { operation: 'attach the selected file' })
      setAttachmentError(error)
      setAttachmentGuidance(message)
      showToast(`${description.title}. ${description.body}`, 'error')
    }
  }, [])

  const cancelMatrixUpload = useCallback((transferId: string) => {
    void bridge.matrixCancelAttachmentUpload(transferId).catch((error) => {
      setAttachmentError(error)
      setAttachmentGuidance(null)
    })
  }, [])

  const handleFilePick = useCallback(async () => {
    if (disabled || !isTauri()) return
    try {
      const startingAccount = await bridge.getBackendStatus()
      const intake = await bridge.pickAttachmentGrants()
      const currentAccount = await bridge.getBackendStatus()
      if (
        !attachmentScopeMatchesStatus(intake.accountScope, startingAccount)
        || !attachmentScopeMatchesStatus(intake.accountScope, currentAccount)
      ) {
        for (const file of intake.files) void bridge.discardAttachmentGrant(file.grant)
        const message = 'Your account changed while choosing the files. Choose them again.'
        setAttachmentError(new Error(message))
        setAttachmentGuidance(message)
        return
      }
      appendFiles(intake.files.map(stagedFileFromGrant), intake.errors)
    } catch (err) {
      console.error('File picker error:', err)
      setAttachmentError(err)
      setAttachmentGuidance(null)
    }
  }, [appendFiles, disabled])

  const handleRemoveFile = async (index: number) => {
    const file = stagedFilesRef.current[index]
    if (!file) return
    const next = stagedFilesRef.current.filter((_, candidateIndex) => candidateIndex !== index)
    stagedFilesRef.current = next
    setStagedFiles(next)
    setAttachmentError(null)
    setAttachmentGuidance(null)
    await discardStagedFile(file).catch((error) => {
      console.error('Failed to discard staged attachment:', error)
    })
    inputRef.current?.focus()
  }

  const handleDragOver = (e: React.DragEvent) => { e.preventDefault(); e.stopPropagation(); setIsDragOver(true) }
  const handleDragLeave = (e: React.DragEvent) => { e.preventDefault(); e.stopPropagation(); setIsDragOver(false) }
  const stageBrowserFiles = useCallback(async (files: File[]) => {
    if (files.length === 0) return
    if (isTauri()) {
      appendFiles([], [
        'Use the attachment button or drop the file from your operating system instead.',
      ])
      return
    }
    if (!bridge.isMatrixBackend()) {
      appendFiles([], [
        'Use the attachment button to choose a file instead.',
      ])
      return
    }
    const generation = intakeGenerationRef.current
    const available = Math.max(
      0,
      MAX_PENDING_ATTACHMENTS - stagedFilesRef.current.length - stagingCountRef.current,
    )
    const selected = files.slice(0, available)
    const errors: string[] = []
    if (selected.length < files.length) {
      errors.push(`Mesh allows up to ${MAX_PENDING_ATTACHMENTS} pending attachments at once.`)
    }
    if (selected.length === 0) {
      appendFiles([], errors)
      return
    }
    stagingCountRef.current += selected.length
    setIsStaging(true)
    const accepted: StagedFile[] = []
    for (const file of selected) {
      try {
        const staged = await stageWebFile(file)
        if (!mountedRef.current || intakeGenerationRef.current !== generation) {
          await discardStagedFile(staged).catch(() => {})
        } else {
          accepted.push(staged)
        }
      } catch (error) {
        if (mountedRef.current && intakeGenerationRef.current === generation) {
          console.error(`Failed to stage attachment ${file.name || '(unnamed)'}:`, error)
          errors.push(`${file.name || 'This file'} could not be attached.`)
        }
      }
    }
    if (intakeGenerationRef.current === generation) {
      stagingCountRef.current = Math.max(0, stagingCountRef.current - selected.length)
    }
    if (mountedRef.current && intakeGenerationRef.current === generation) {
      appendFiles(accepted, errors)
      if (stagingCountRef.current === 0) setIsStaging(false)
    } else {
      await Promise.allSettled(accepted.map(discardStagedFile))
    }
  }, [appendFiles])

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault(); e.stopPropagation(); setIsDragOver(false)
    const files = Array.from(e.dataTransfer.files)
    void stageBrowserFiles(files)
  }

  const handlePaste = (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
    if (disabled || disableAttachments) return
    const files = Array.from(event.clipboardData.files)
    if (files.length === 0) return
    event.preventDefault()
    void stageBrowserFiles(files)
  }

  // Rust observes native OS drops and emits opaque grants. Raw filesystem
  // paths from the renderer are never accepted by Matrix upload commands.
  useEffect(() => {
    if (!isTauri()) return
    let active = true
    let unlistenStart: (() => void) | undefined
    let unlistenComplete: (() => void) | undefined
    const pendingNativeDrops = pendingNativeDropsRef.current
    const containsPosition = (position: { x: number; y: number }) => {
      const rect = rootRef.current?.getBoundingClientRect()
      if (!rect) return false
      const scale = window.devicePixelRatio || 1
      const x = position.x / scale
      const y = position.y / scale
      return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom
    }

    void listen<{
      dropId: string
      position: { x: number; y: number }
      accountGeneration: number
    }>('mesh-native-attachment-drop-start', (event) => {
      const start = event.payload
      if (
        active
        && !disabled
        && !disableAttachments
        && containsPosition(start.position)
      ) {
        pendingNativeDrops.set(
          start.dropId,
          {
            inputGeneration: intakeGenerationRef.current,
            accountGeneration: start.accountGeneration,
          },
        )
      }
    }).then((dispose) => {
      if (active) unlistenStart = dispose
      else dispose()
    }).catch((error) => {
      console.error('Failed to register native attachment drop start handling:', error)
    })

    void listen<{
      dropId: string
      position: { x: number; y: number }
      files: bridge.NativeAttachmentGrant[]
      errors: string[]
      accountScope: bridge.NativeAttachmentAccountScope | null
    }>('mesh-native-attachment-drop', (event) => {
      const intake = event.payload
      const grants = intake.files.map((file) => file.grant)
      const dropScope = pendingNativeDrops.get(intake.dropId)
      pendingNativeDrops.delete(intake.dropId)
      const boundToCurrentInput = active
        && dropScope !== undefined
        && dropScope.inputGeneration === intakeGenerationRef.current
        && intake.accountScope?.accountGeneration === dropScope.accountGeneration
        && !disabled
        && !disableAttachments
      setIsDragOver(false)
      if (!boundToCurrentInput || !dropScope) {
        for (const grant of grants) void bridge.discardAttachmentGrant(grant)
        if (
          !intake.accountScope
          && dropScope?.inputGeneration === intakeGenerationRef.current
          && intake.errors.length > 0
        ) appendFiles([], intake.errors)
        return
      }
      void (async () => {
        const accountScope = intake.accountScope
        if (!accountScope) return
        const beforeAccept = await bridge.getBackendStatus()
        if (!attachmentScopeMatchesStatus(accountScope, beforeAccept)) return
        await bridge.acceptAttachmentDropGrants(grants)
        const afterAccept = await bridge.getBackendStatus()
        if (
          !active
          || dropScope.inputGeneration !== intakeGenerationRef.current
          || !attachmentScopeMatchesStatus(accountScope, afterAccept)
        ) return
        appendFiles(intake.files.map(stagedFileFromGrant), intake.errors)
        return true
      })().then((accepted) => {
        if (accepted) return
        for (const grant of grants) void bridge.discardAttachmentGrant(grant)
      }).catch((error) => {
        for (const grant of grants) void bridge.discardAttachmentGrant(grant)
        console.error('Failed to accept secure native attachment drop:', error)
        appendFiles([], [...intake.errors, 'The file drop expired. Drop the files again.'])
      })
    }).then((dispose) => {
      if (active) unlistenComplete = dispose
      else dispose()
    }).catch((error) => {
      console.error('Failed to register secure native attachment drop handling:', error)
    })

    return () => {
      active = false
      pendingNativeDrops.clear()
      unlistenStart?.()
      unlistenComplete?.()
    }
  }, [appendFiles, disableAttachments, disabled])

  useEffect(() => {
    // StrictMode intentionally runs setup -> cleanup -> setup in development.
    const pendingNativeDrops = pendingNativeDropsRef.current
    const sendingFiles = sendingFilesRef.current
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      intakeGenerationRef.current += 1
      pendingNativeDrops.clear()
      for (const file of stagedFilesRef.current) {
        if (!sendingFiles.has(file)) void discardStagedFile(file)
      }
    }
  }, [])

  const previousChannelId = useRef(channelId)
  useEffect(() => {
    if (previousChannelId.current === channelId) return
    previousChannelId.current = channelId
    intakeGenerationRef.current += 1
    pendingNativeDropsRef.current.clear()
    stagingCountRef.current = 0
    setIsStaging(false)
    setIsUploading(false)
    for (const file of stagedFilesRef.current) {
      if (!sendingFilesRef.current.has(file)) void discardStagedFile(file)
    }
    stagedFilesRef.current = []
    setStagedFiles([])
    setAttachmentError(null)
    setAttachmentGuidance(null)
    setValue(useDraftStore.getState().drafts[channelId] ?? '')
    setStructuredMentions([])
    setMentionCursor(0)
    setMentionsDismissed(false)
    setSlashIndex(0)
    setSlashDismissed(false)
  }, [channelId, clearDraft])

  useEffect(() => {
    if (inputRef.current) {
      inputRef.current.style.height = 'auto'
      // design-token-exception: height follows measured content; CSS owns the max-height token.
      inputRef.current.style.height = `${inputRef.current.scrollHeight}px`
    }
  }, [value])

  useLayoutEffect(() => {
    const pending = pendingSelectionRef.current
    if (!pending || !inputRef.current) return
    pendingSelectionRef.current = null
    inputRef.current.focus()
    inputRef.current.setSelectionRange(pending.start, pending.end)
  }, [value])

  return (
    <div
      ref={rootRef}
      className="mesh-composer-shell -mt-1 mx-3 mb-4 min-w-0 max-w-full sm:mx-5"
      onDragOver={disabled || disableAttachments ? undefined : handleDragOver}
      onDragLeave={disabled || disableAttachments ? undefined : handleDragLeave}
      onDrop={disabled || disableAttachments ? undefined : handleDrop}
    >
      <div
        className={`mesh-composer min-w-0 overflow-hidden rounded-control border border-rule border-border-control transition-colors ${
          isDragOver
            ? 'bg-container-accent ring-2 ring-container-accent-line'
            : 'bg-surface-raised'
        }`}
      >
        {/* Drag overlay */}
        {isDragOver && (
          <div className="flex items-center justify-center gap-2 px-4 py-3">
            <Icon name="upload" size="sm" className="text-accent" />
            <span className="text-sm font-medium text-accent">Drop files to attach</span>
          </div>
        )}

        {/* Staged files preview */}
        {stagedFiles.length > 0 && (
          <FileAttachmentPreview
            files={stagedFiles}
            onRemove={handleRemoveFile}
            transfers={matrixTransfers}
            onCancelTransfer={cancelMatrixUpload}
          />
        )}

        {attachmentError != null && (
          <ErrorState
            error={attachmentError}
            userMessage={attachmentGuidance ?? undefined}
            context={{
              operation: stagedFiles.length > 0
                ? 'send this attachment'
                : 'save this message for delivery',
            }}
            className="mx-2 mb-2"
            compact
          />
        )}

        {roomNotifyNotice && (
          <p role="status" className="mx-3 mb-2 text-xs text-content-secondary">
            {roomNotifyNotice}
          </p>
        )}

        {/*
          The formatting toolbar is not part of the resting composer.

          Four glyph buttons above every empty message box is chrome that
          announces a capability nobody is using yet, and Quiet Structure spends
          nothing on the norm. The controls appear when there is a selection to
          apply them to, which is the only moment they mean anything, and
          markdown continues to work whether or not they are on screen.
        */}
        {hasSelection && <div
          className="mesh-composer-formatting flex items-center gap-1 border-b border-rule border-border-structural px-2 py-1"
          role="toolbar"
          aria-orientation="horizontal"
          aria-label="Message formatting"
          onKeyDown={handleFormattingKeyDown}
        >
          {FORMAT_CONTROLS.map(([format, label, glyph, glyphClass], index) => (
            <button
              key={format}
              type="button"
              ref={(node) => {
                formatButtonsRef.current[index] = node
              }}
              aria-label={label}
              title={label}
              tabIndex={index === formatFocusIndex ? 0 : -1}
              onFocus={() => setFormatFocusIndex(index)}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => applyFormatting(format)}
              disabled={disabled || isUploading || isStaging}
              className={`flex h-control-sm min-w-control-sm items-center justify-center rounded-control px-1.5 text-sm text-muted transition-colors hover:bg-surface-hover hover:text-secondary focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus disabled:cursor-not-allowed disabled:opacity-40 ${glyphClass}`}
            >
              {glyph}
            </button>
          ))}
        </div>}

        {/* Input row */}
        <div className="relative flex min-w-0 items-end gap-0 px-1">
          {slashSuggestions.length > 0 && (
            <div
              id={`slash-suggestions-${channelId}`}
              role="listbox"
              aria-label="Slash commands"
              className="absolute bottom-full left-1 right-1 z-dropdown mb-1 overflow-hidden rounded-panel border border-border-subtle bg-surface-overlay shadow-overlay"
            >
              {slashSuggestions.map((command, index) => (
                <button
                  key={command.command}
                  id={`slash-suggestion-${channelId}-${index}`}
                  type="button"
                  role="option"
                  aria-selected={index === activeSlashIndex}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => {
                    if (!slashContext) return
                    const nextValue = truncateDraft(
                      `${value.slice(0, slashContext.start)}${command.command} ${value.slice(slashContext.end)}`,
                    )
                    const nextCursor = Math.min(
                      slashContext.start + command.command.length + 1,
                      nextValue.length,
                    )
                    updateDraftValue(nextValue)
                    setMentionCursor(nextCursor)
                    setSlashDismissed(true)
                    pendingSelectionRef.current = { start: nextCursor, end: nextCursor }
                  }}
                  className={`flex min-h-control-md w-full items-center gap-3 px-3 py-2 text-left text-sm transition-colors ${
                    index === activeSlashIndex ? 'bg-surface-hover text-primary' : 'text-secondary hover:bg-surface-hover'
                  }`}
                >
                  <span className="font-mono font-medium">{command.command}</span>
                  <span className="truncate text-muted">{command.description}</span>
                </button>
              ))}
            </div>
          )}
          {mentionSuggestions.length > 0 && (
            <div
              id={`mention-suggestions-${channelId}`}
              role="listbox"
              aria-label="Mention suggestions"
              className="absolute bottom-full left-1 right-1 z-dropdown mb-1 overflow-hidden rounded-panel border border-border-subtle bg-surface-overlay shadow-overlay"
            >
              {mentionSuggestions.map((suggestion, index) => {
                const isRoom = suggestion.kind === 'room'
                const shortHandle = isRoom
                  ? `Notifies everyone in ${channelName}`
                  : memberDisambiguationHandle(suggestion.member, members)
                return (
                  <button
                    key={isRoom ? '@room' : suggestion.member.publicKey}
                    id={`mention-suggestion-${channelId}-${index}`}
                    type="button"
                    role="option"
                    aria-selected={index === activeMentionIndex}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => selectMention(suggestion)}
                    className={`flex min-h-control-md w-full items-center gap-3 px-3 py-2 text-left text-sm transition-colors ${
                      index === activeMentionIndex ? 'bg-surface-hover text-primary' : 'text-secondary hover:bg-surface-hover'
                    }`}
                  >
                    <span className="truncate font-medium">
                      {isRoom ? '@room' : suggestion.member.displayName}
                    </span>
                    {shortHandle && (
                      <span className="ml-auto flex-shrink-0 truncate text-xs text-muted">
                        {shortHandle}
                      </span>
                    )}
                  </button>
                )
              })}
            </div>
          )}
          {/* Attachment button */}
          {!disableAttachments && !disabled && (
            <Tooltip content="Attach file" side="top">
              <button
                onClick={handleFilePick}
                type="button"
                disabled={disabled || isUploading || isStaging}
                aria-label="Attach file"
                className="mb-1 flex h-10 w-10 flex-shrink-0 items-center justify-center rounded text-muted transition-colors hover:text-secondary disabled:opacity-40"
              >
                <Icon name="circlePlus" />
              </button>
            </Tooltip>
          )}

          <textarea
            ref={inputRef}
            value={value}
            onFocus={onComposerFocus}
            onCompositionStart={() => {
              compositionActiveRef.current = true
            }}
            onCompositionEnd={() => {
              compositionActiveRef.current = false
            }}
            onChange={(e) => {
              const nextValue = truncateDraft(e.target.value)
              updateDraftValue(nextValue)
              setMentionCursor(Math.min(e.target.selectionStart, nextValue.length))
              setMentionIndex(0)
              setMentionsDismissed(false)
              setSlashIndex(0)
              setSlashDismissed(false)
              if (nextValue.trim()) {
                broadcastTypingThrottled()
              } else {
                bridge.setTyping(channelId, false).catch(() => {})
              }
            }}
            onKeyDown={handleKeyDown}
            onSelect={(event) => {
              setMentionCursor(event.currentTarget.selectionStart)
              setMentionIndex(0)
              setMentionsDismissed(false)
              setSlashDismissed(false)
              syncSelection(event.currentTarget)
            }}
            /*
              onSelect alone is not enough. React synthesises it from a mix of
              focus, pointer and key activity rather than listening for the DOM
              `select` event, so a selection made by shift-arrowing or by
              dragging can land without it. These two read the selection from
              the element itself, which is the only thing that is always right.
            */
            onKeyUp={(event) => syncSelection(event.currentTarget)}
            onMouseUp={(event) => syncSelection(event.currentTarget)}
            onBlur={(event) => {
              /*
                The toolbar is inside the composer, so moving focus to a format
                button must not collapse the thing it is about to format. Only a
                blur that leaves the composer entirely puts the toolbar away.
              */
              if (event.currentTarget.closest('.mesh-composer')?.contains(event.relatedTarget)) {
                return
              }
              setHasSelection(false)
            }}
            onPaste={handlePaste}
            placeholder={placeholder ?? `Message #${channelName}`}
            aria-label={`Message ${channelName}`}
            aria-describedby={stagedFiles.length > 0 ? `pending-attachments-${channelId}` : undefined}
            /*
              A persistent combobox, not one that appears and disappears with
              the suggestion list: NVDA does not reliably follow
              aria-activedescendant on a plain textbox, and swapping the role
              mid-typing is worse than carrying it all the time.
            */
            role="combobox"
            aria-expanded={mentionSuggestions.length > 0 || slashSuggestions.length > 0}
            aria-haspopup="listbox"
            aria-autocomplete="list"
            aria-controls={mentionSuggestions.length > 0
              ? `mention-suggestions-${channelId}`
              : slashSuggestions.length > 0
                ? `slash-suggestions-${channelId}`
                : undefined}
            aria-activedescendant={mentionSuggestions.length > 0
              ? `mention-suggestion-${channelId}-${activeMentionIndex}`
              : slashSuggestions.length > 0
                ? `slash-suggestion-${channelId}-${activeSlashIndex}`
                : undefined}
            rows={1}
            disabled={disabled || isUploading || isStaging}
            className="min-h-control-lg max-h-composer min-w-0 flex-1 resize-none bg-transparent px-2 py-2.5 text-base text-content-primary placeholder:text-muted focus:outline-none disabled:opacity-60"
          />

          <Popover
            open={emojiPickerOpen}
            onOpenChange={setEmojiPickerOpen}
            restoreFocusRef={inputRef}
            side="top"
            align="end"
            label="Emoji picker"
            description="Add emoji to your message."
            className="w-auto border-0 bg-transparent p-0 shadow-none"
            trigger={(
              <button
                type="button"
                disabled={disabled || isUploading || isStaging}
                aria-label="Open emoji picker"
                aria-expanded={emojiPickerOpen}
                className="mb-1 flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-control text-muted transition-colors hover:bg-surface-hover hover:text-secondary focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus disabled:cursor-not-allowed disabled:opacity-40"
              >
                <Icon name="smile" />
              </button>
            )}
          >
            <ReactionPicker
              label="Choose emoji"
              actionLabel="Insert"
              onSelect={insertEmoji}
              onClose={() => setEmojiPickerOpen(false)}
              customEmoji={customEmoji}
            />
          </Popover>

          {/*
            There was no Send button at all: sending was Enter-only, and the
            Enter/Shift+Enter contract was documented nowhere in the UI. That is
            fine for practised users and invisible to everyone else, especially
            on touch.
          */}
          <Tooltip content="Send message (Enter)" side="top">
            <button
              type="button"
              onClick={() => void handleSubmit()}
              disabled={!canSend}
              aria-label="Send message"
              aria-keyshortcuts="Enter"
              className="mb-1 flex h-control-sm flex-shrink-0 items-center justify-center gap-1.5 rounded-plane bg-accent px-3 font-mono text-chip font-semibold uppercase text-content-on-accent transition-colors enabled:hover:bg-accent-hover disabled:opacity-40"
            >
              <span aria-hidden="true">Send</span>
              <Icon
                name={isUploading ? 'loader' : 'send'}
                size="sm"
                className={isUploading ? 'animate-spin' : undefined}
              />
            </button>
          </Tooltip>
        </div>

        {/*
          The draft store silently discards anything past 16 KB: past the cap,
          typing and pasting simply stopped having any effect with no counter,
          no warning and no announcement.
        */}
        {draftBytesUsed > DRAFT_WARNING_BYTES && (
          <div
            className={`flex items-center justify-end gap-2 px-3 pb-1 text-caption ${
              draftAtLimit ? 'text-status-warning' : 'text-content-muted'
            }`}
          >
            {draftAtLimit && <Icon name="triangleAlert" size="xs" aria-hidden="true" />}
            <span className="tnum">
              {draftAtLimit
                ? 'Message limit reached: shorten it to keep typing'
                : `${Math.round((MAX_DRAFT_BYTES - draftBytesUsed) / 1024)} KB left`}
            </span>
          </div>
        )}
        {draftSyncStatus === 'failed' && (
          <div
            className="flex min-h-control-sm items-center justify-between gap-3 border-t border-border-subtle px-3 py-1.5 text-xs text-secondary"
          >
            <span role="status">
              Your draft is still here, but it is not saved for restart.
            </span>
            <button
              type="button"
              onClick={retryDraftSync}
              className="min-h-control-sm rounded-control px-2 font-medium text-accent transition-colors hover:bg-surface-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus"
            >
              Retry
            </button>
          </div>
        )}
        <p id={`pending-attachments-${channelId}`} className="sr-only" aria-live="polite">
          {isStaging
            ? 'Securing attachment locally.'
            : stagedFiles.length > 0
              ? `${stagedFiles.length} attachment${stagedFiles.length === 1 ? '' : 's'} pending. Press Escape with an empty message to remove the last attachment.`
              : 'No attachments pending.'}
        </p>
        <p className="sr-only" role="status" aria-live="polite">
          {draftAtLimit ? 'Message length limit reached. Shorten the message to keep typing.' : ''}
        </p>
      </div>
    </div>
  )
}

function attachmentScopeMatchesStatus(
  scope: bridge.NativeAttachmentAccountScope,
  status: bridge.BackendStatus,
): boolean {
  return status.authenticated && status.userId === scope.userId
}
