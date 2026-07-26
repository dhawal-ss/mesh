import { useState, useRef, useEffect, useCallback } from 'react'
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
import type { MemberRecord } from '../../store/membership'
import { MAX_DRAFT_LENGTH, useDraftStore } from '../../store/drafts'

interface MessageInputProps {
  channelId: string
  channelName: string
  onSend: (
    content: string,
    files?: StagedFile[],
    onAttachmentSent?: (file: StagedFile, contentConsumed: boolean) => void | Promise<void>,
  ) => void | Promise<void>
  disableAttachments?: boolean
  disabled?: boolean
  communityId?: string
  members?: readonly MemberRecord[]
  onEditLastMessage?: () => void
}

const TYPING_THROTTLE_MS = 5000
const MAX_MENTION_SUGGESTIONS = 6

interface MentionContext {
  start: number
  end: number
  query: string
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
  onSend,
  disableAttachments,
  disabled,
  communityId,
  members = [],
  onEditLastMessage,
}: MessageInputProps) {
  const [value, setValue] = useState(() => useDraftStore.getState().drafts[channelId] ?? '')
  const setDraft = useDraftStore((state) => state.setDraft)
  const clearDraft = useDraftStore((state) => state.clearDraft)
  const [mentionCursor, setMentionCursor] = useState(0)
  const [mentionIndex, setMentionIndex] = useState(0)
  const [mentionsDismissed, setMentionsDismissed] = useState(false)
  const [stagedFiles, setStagedFiles] = useState<StagedFile[]>([])
  const [isDragOver, setIsDragOver] = useState(false)
  const [isStaging, setIsStaging] = useState(false)
  const [isUploading, setIsUploading] = useState(false)
  const [attachmentError, setAttachmentError] = useState<unknown | null>(null)
  const [matrixTransfers, setMatrixTransfers] = useState<Record<string, MatrixTransferProgress>>({})
  const rootRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const stagedFilesRef = useRef<StagedFile[]>([])
  const stagingCountRef = useRef(0)
  const intakeGenerationRef = useRef(0)
  const pendingNativeDropsRef = useRef(new Map<string, number>())
  const sendingFilesRef = useRef(new Set<StagedFile>())
  const mountedRef = useRef(true)
  const lastTypingBroadcast = useRef<number>(0)

  stagedFilesRef.current = stagedFiles

  useEffect(() => {
    inputRef.current?.focus()
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
  const mentionSuggestions = mentionContext
    ? members
      .filter((member) => (
        member.joinStatus === 'joined'
        && member.banStatus === 'none'
        && isMatrixUserId(member.publicKey)
      ))
      .filter((member) => {
        const query = mentionContext.query.toLocaleLowerCase()
        return member.displayName.toLocaleLowerCase().includes(query)
          || member.publicKey.toLocaleLowerCase().includes(query)
      })
      .slice(0, MAX_MENTION_SUGGESTIONS)
    : []
  const activeMentionIndex = Math.min(mentionIndex, Math.max(mentionSuggestions.length - 1, 0))

  const selectMention = (member: MemberRecord) => {
    if (!mentionContext) return
    const nextValue = `${value.slice(0, mentionContext.start)}${member.publicKey} ${value.slice(mentionContext.end)}`
    const nextCursor = mentionContext.start + member.publicKey.length + 1
    setValue(nextValue)
    setDraft(channelId, nextValue)
    setMentionCursor(nextCursor)
    setMentionsDismissed(true)
    requestAnimationFrame(() => {
      inputRef.current?.focus()
      inputRef.current?.setSelectionRange(nextCursor, nextCursor)
    })
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
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

  const handleSubmit = async () => {
    if (disabled || isUploading || isStaging) return
    const content = value.trim()
    if (!content && stagedFiles.length === 0) return

    const sendGeneration = intakeGenerationRef.current
    const filesAtStart = [...stagedFiles]
    if (bridge.isMatrixBackend()) {
      for (const file of filesAtStart) file.transferId = bridge.createMatrixTransferId()
      setStagedFiles([...filesAtStart])
    }
    for (const file of filesAtStart) sendingFilesRef.current.add(file)
    setIsUploading(true)
    setAttachmentError(null)
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
            if (contentConsumed) setValue('')
            if (contentConsumed) clearDraft(channelId)
          }
        })
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
          clearDraft(channelId)
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

      if (content) await onSend(content)
      if (intakeGenerationRef.current === sendGeneration) {
        setValue('')
        clearDraft(channelId)
        bridge.setTyping(channelId, false).catch(() => {})
      }
    } catch (error) {
      console.error('Failed to send message or attachment:', error)
      if (intakeGenerationRef.current === sendGeneration) {
        setAttachmentError(error)
      } else {
        await Promise.allSettled(filesAtStart.map(discardStagedFile))
      }
    } finally {
      for (const file of filesAtStart) sendingFilesRef.current.delete(file)
      if (intakeGenerationRef.current === sendGeneration) setIsUploading(false)
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
    }
    if (errors.length > 0) {
      const message = errors.join(' ')
      const error = new AppError('invalid_input', message, false)
      const description = describeError(error, { operation: 'attach the selected file' })
      setAttachmentError(error)
      showToast(`${description.title}. ${description.body}`, 'error')
    }
  }, [])

  const cancelMatrixUpload = useCallback((transferId: string) => {
    void bridge.matrixCancelAttachmentUpload(transferId).catch((error) => {
      setAttachmentError(error)
    })
  }, [])

  const handleFilePick = useCallback(async () => {
    if (disabled || !isTauri()) return
    try {
      const intake = await bridge.pickAttachmentGrants()
      appendFiles(intake.files.map(stagedFileFromGrant), intake.errors)
    } catch (err) {
      console.error('File picker error:', err)
      setAttachmentError(err)
    }
  }, [appendFiles, disabled])

  const handleRemoveFile = async (index: number) => {
    const file = stagedFilesRef.current[index]
    if (!file) return
    const next = stagedFilesRef.current.filter((_, candidateIndex) => candidateIndex !== index)
    stagedFilesRef.current = next
    setStagedFiles(next)
    setAttachmentError(null)
    await discardStagedFile(file).catch((error) => {
      console.error('Failed to discard staged attachment:', error)
    })
    inputRef.current?.focus()
  }

  const handleDragOver = (e: React.DragEvent) => { e.preventDefault(); e.stopPropagation(); setIsDragOver(true) }
  const handleDragLeave = (e: React.DragEvent) => { e.preventDefault(); e.stopPropagation(); setIsDragOver(false) }
  const stageBrowserFiles = useCallback(async (files: File[]) => {
    if (files.length === 0) return
    if (!bridge.isMatrixBackend()) {
      appendFiles([], [
        'Clipboard and browser-drop attachment copies require the encrypted Matrix backend. Use the attachment button to choose a stable local file.',
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
    }>('mesh-native-attachment-drop-start', (event) => {
      const start = event.payload
      if (
        active
        && !disabled
        && !disableAttachments
        && containsPosition(start.position)
      ) {
        pendingNativeDropsRef.current.set(
          start.dropId,
          intakeGenerationRef.current,
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
    }>('mesh-native-attachment-drop', (event) => {
      const intake = event.payload
      const grants = intake.files.map((file) => file.grant)
      const dropGeneration = pendingNativeDropsRef.current.get(intake.dropId)
      pendingNativeDropsRef.current.delete(intake.dropId)
      const boundToCurrentInput = active
        && dropGeneration !== undefined
        && dropGeneration === intakeGenerationRef.current
        && !disabled
        && !disableAttachments
      setIsDragOver(false)
      if (!boundToCurrentInput) {
        for (const grant of grants) void bridge.discardAttachmentGrant(grant)
        return
      }
      void bridge.acceptAttachmentDropGrants(grants).then(() => {
        if (!active || dropGeneration !== intakeGenerationRef.current) {
          for (const grant of grants) void bridge.discardAttachmentGrant(grant)
          return
        }
        appendFiles(intake.files.map(stagedFileFromGrant), intake.errors)
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
      pendingNativeDropsRef.current.clear()
      unlistenStart?.()
      unlistenComplete?.()
    }
  }, [appendFiles, disableAttachments, disabled])

  useEffect(() => {
    // StrictMode intentionally runs setup -> cleanup -> setup in development.
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      intakeGenerationRef.current += 1
      pendingNativeDropsRef.current.clear()
      for (const file of stagedFilesRef.current) {
        if (!sendingFilesRef.current.has(file)) void discardStagedFile(file)
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
    setValue(useDraftStore.getState().drafts[channelId] ?? '')
    setMentionCursor(0)
    setMentionsDismissed(false)
  }, [channelId, clearDraft])

  useEffect(() => {
    if (inputRef.current) {
      inputRef.current.style.height = 'auto'
      // design-token-exception: height follows measured content; CSS owns the max-height token.
      inputRef.current.style.height = `${inputRef.current.scrollHeight}px`
    }
  }, [value])

  return (
    <div
      ref={rootRef}
      className="-mt-1 mx-4 mb-6"
      onDragOver={disabled || disableAttachments ? undefined : handleDragOver}
      onDragLeave={disabled || disableAttachments ? undefined : handleDragLeave}
      onDrop={disabled || disableAttachments ? undefined : handleDrop}
    >
      <div
        className={`rounded-lg transition-colors ${
          isDragOver
            ? 'bg-blue/10 ring-2 ring-blue/40'
            : 'bg-surface-raised'
        }`}
      >
        {/* Drag overlay */}
        {isDragOver && (
          <div className="flex items-center justify-center gap-2 px-4 py-3">
            <Icon name="upload" size="sm" className="text-blue" />
            <span className="text-sm font-medium text-blue">Drop files to attach</span>
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
            context={{ operation: 'send this attachment' }}
            className="mx-2 mb-2"
            compact
          />
        )}

        {/* Input row */}
        <div className="relative flex items-end gap-0 px-1">
          {mentionSuggestions.length > 0 && (
            <div
              id={`mention-suggestions-${channelId}`}
              role="listbox"
              aria-label="Mention suggestions"
              className="absolute bottom-full left-1 right-1 z-dropdown mb-1 overflow-hidden rounded-lg border border-border-subtle bg-surface-raised shadow-lg"
            >
              {mentionSuggestions.map((member, index) => (
                <button
                  key={member.publicKey}
                  id={`mention-suggestion-${channelId}-${index}`}
                  type="button"
                  role="option"
                  aria-selected={index === activeMentionIndex}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => selectMention(member)}
                  className={`flex min-h-control-md w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm transition-colors ${
                    index === activeMentionIndex ? 'bg-bg-modifier-hover text-primary' : 'text-secondary hover:bg-bg-modifier-hover'
                  }`}
                >
                  <span className="truncate font-medium">{member.displayName}</span>
                  <span className="truncate font-mono text-xs text-muted">{member.publicKey}</span>
                </button>
              ))}
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
            onChange={(e) => {
              const nextValue = e.target.value.slice(0, MAX_DRAFT_LENGTH)
              setValue(nextValue)
              setDraft(channelId, nextValue)
              setMentionCursor(e.target.selectionStart)
              setMentionIndex(0)
              setMentionsDismissed(false)
              if (e.target.value.trim()) {
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
            }}
            onPaste={handlePaste}
            placeholder={`Message #${channelName}`}
            aria-label={`Message ${channelName}`}
            aria-describedby={stagedFiles.length > 0 ? `pending-attachments-${channelId}` : undefined}
            aria-autocomplete={communityId && bridge.isMatrixBackend() ? 'list' : undefined}
            aria-controls={mentionSuggestions.length > 0 ? `mention-suggestions-${channelId}` : undefined}
            aria-expanded={mentionSuggestions.length > 0}
            aria-activedescendant={mentionSuggestions.length > 0
              ? `mention-suggestion-${channelId}-${activeMentionIndex}`
              : undefined}
            rows={1}
            maxLength={MAX_DRAFT_LENGTH}
            disabled={disabled || isUploading || isStaging}
            className="min-h-control-lg max-h-composer w-full resize-none bg-transparent px-2 py-2.5 text-sm text-primary placeholder:text-muted focus:outline-none disabled:opacity-60"
          />
        </div>
        <p id={`pending-attachments-${channelId}`} className="sr-only" aria-live="polite">
          {isStaging
            ? 'Securing attachment locally.'
            : stagedFiles.length > 0
              ? `${stagedFiles.length} attachment${stagedFiles.length === 1 ? '' : 's'} pending. Press Escape with an empty message to remove the last attachment.`
              : 'No attachments pending.'}
        </p>
      </div>
    </div>
  )
}
