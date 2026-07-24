import { useState, useRef, useEffect, useCallback } from 'react'
import { isTauri } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { FileAttachmentPreview, type StagedFile } from './FileAttachment'
import { Tooltip } from '../ui/Tooltip'
import { showToast } from '../ui/Toast'
import * as bridge from '../../lib/bridge'
import {
  discardStagedFile,
  MAX_PENDING_ATTACHMENTS,
  stagedFileFromGrant,
  stageWebFile,
} from '../../lib/attachments'

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
}

const TYPING_THROTTLE_MS = 5000
export function MessageInput({ channelId, channelName, onSend, disableAttachments, disabled, communityId }: MessageInputProps) {
  const [value, setValue] = useState('')
  const [stagedFiles, setStagedFiles] = useState<StagedFile[]>([])
  const [isDragOver, setIsDragOver] = useState(false)
  const [isStaging, setIsStaging] = useState(false)
  const [isUploading, setIsUploading] = useState(false)
  const [attachmentError, setAttachmentError] = useState<string | null>(null)
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

  const broadcastTypingThrottled = useCallback(() => {
    const now = Date.now()
    if (now - lastTypingBroadcast.current >= TYPING_THROTTLE_MS) {
      lastTypingBroadcast.current = now
      bridge.broadcastTyping(channelId).catch(() => {})
    }
  }, [channelId])

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      void handleSubmit()
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
        bridge.setTyping(channelId, false).catch(() => {})
      }
    } catch (error) {
      console.error('Failed to send message or attachment:', error)
      if (intakeGenerationRef.current === sendGeneration) {
        setAttachmentError(
          error instanceof Error
            ? `Could not send: ${error.message}`
            : 'Could not send this attachment. It is still pending so you can retry.',
        )
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
      setAttachmentError(message)
      showToast(message, 'error')
    }
  }, [])

  const handleFilePick = useCallback(async () => {
    if (disabled || !isTauri()) return
    try {
      const intake = await bridge.pickAttachmentGrants()
      appendFiles(intake.files.map(stagedFileFromGrant), intake.errors)
    } catch (err) {
      console.error('File picker error:', err)
      setAttachmentError('The native file picker could not attach that file.')
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
          errors.push(error instanceof Error ? error.message : `${file.name || 'This file'} could not be attached.`)
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
        const message = error instanceof Error
          ? error.message
          : 'The native attachment drop expired. Drop the files again.'
        appendFiles([], [...intake.errors, message])
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
    setValue('')
  }, [channelId])

  useEffect(() => {
    if (inputRef.current) {
      inputRef.current.style.height = 'auto'
      inputRef.current.style.height = `${Math.min(inputRef.current.scrollHeight, 200)}px`
    }
  }, [value])

  return (
    <div
      ref={rootRef}
      className="mx-4 mb-6 mt-[-4px]"
      onDragOver={disabled || disableAttachments ? undefined : handleDragOver}
      onDragLeave={disabled || disableAttachments ? undefined : handleDragLeave}
      onDrop={disabled || disableAttachments ? undefined : handleDrop}
    >
      <div
        className={`rounded-lg transition-colors ${
          isDragOver
            ? 'bg-blue/10 ring-2 ring-blue/40'
            : 'bg-[#383a40]'
        }`}
      >
        {/* Drag overlay */}
        {isDragOver && (
          <div className="flex items-center justify-center gap-2 px-4 py-3">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-blue">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="17 8 12 3 7 8" />
              <line x1="12" y1="3" x2="12" y2="15" />
            </svg>
            <span className="text-sm font-medium text-blue">Drop files to attach</span>
          </div>
        )}

        {/* Staged files preview */}
        {stagedFiles.length > 0 && (
          <FileAttachmentPreview files={stagedFiles} onRemove={handleRemoveFile} />
        )}

        {attachmentError && (
          <div role="alert" className="border-b border-red/20 bg-red/5 px-4 py-2 text-xs text-red">
            {attachmentError}
          </div>
        )}

        {/* Input row */}
        <div className="flex items-end gap-0 px-1">
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
                <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M12 2.00098C6.486 2.00098 2 6.48698 2 12.001C2 17.515 6.486 22.001 12 22.001C17.514 22.001 22 17.515 22 12.001C22 6.48698 17.514 2.00098 12 2.00098ZM17 13.001H13V17.001H11V13.001H7V11.001H11V7.00098H13V11.001H17V13.001Z" />
                </svg>
              </button>
            </Tooltip>
          )}

          <textarea
            ref={inputRef}
            value={value}
            onChange={(e) => {
              setValue(e.target.value)
              if (e.target.value.trim()) {
                broadcastTypingThrottled()
              } else {
                bridge.setTyping(channelId, false).catch(() => {})
              }
            }}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            placeholder={`Message #${channelName}`}
            aria-label={`Message ${channelName}`}
            aria-describedby={stagedFiles.length > 0 ? `pending-attachments-${channelId}` : undefined}
            rows={1}
            disabled={disabled || isUploading || isStaging}
            className="w-full resize-none bg-transparent px-2 py-2.5 text-sm text-primary placeholder:text-muted focus:outline-none disabled:opacity-60"
            style={{ minHeight: '44px', maxHeight: '200px' }}
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
