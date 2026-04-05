import { useState, useRef, useEffect, useCallback } from 'react'
import { open } from '@tauri-apps/plugin-dialog'
import { isTauri } from '@tauri-apps/api/core'
import { FileAttachmentPreview, type StagedFile } from './FileAttachment'
import { Tooltip } from '../ui/Tooltip'
import { showToast } from '../ui/Toast'
import * as bridge from '../../lib/bridge'

interface MessageInputProps {
  channelId: string
  channelName: string
  onSend: (content: string) => void
  disableAttachments?: boolean
}

const MAX_FILE_SIZE = 100 * 1024 * 1024
const BLOCKED_EXTENSIONS = new Set([
  'exe', 'bat', 'cmd', 'com', 'msi', 'scr', 'pif', 'vbs', 'vbe',
  'js', 'jse', 'wsf', 'wsh', 'ps1', 'dll', 'sys',
])

function validateFile(name: string, size: number): string | null {
  if (size > MAX_FILE_SIZE) {
    return `${name} is too large (${(size / 1024 / 1024).toFixed(1)} MB). Max: 100 MB.`
  }
  const ext = name.split('.').pop()?.toLowerCase()
  if (ext && BLOCKED_EXTENSIONS.has(ext)) {
    return `File type '.${ext}' is blocked for security reasons.`
  }
  return null
}

export function MessageInput({ channelId, channelName, onSend, disableAttachments }: MessageInputProps) {
  const [value, setValue] = useState('')
  const [stagedFiles, setStagedFiles] = useState<StagedFile[]>([])
  const [isDragOver, setIsDragOver] = useState(false)
  const [isUploading, setIsUploading] = useState(false)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [channelId])

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSubmit()
    }
  }

  const handleSubmit = async () => {
    const content = value.trim()
    if (!content && stagedFiles.length === 0) return

    if (stagedFiles.length > 0) {
      setIsUploading(true)
      for (const file of stagedFiles) {
        try {
          await bridge.uploadFile(channelId, file.path)
        } catch (err) {
          console.error('Failed to upload file:', err)
        }
      }
      setStagedFiles([])
      setIsUploading(false)
    }

    if (content) {
      onSend(content)
      setValue('')
    }
  }

  const handleFilePick = useCallback(async () => {
    if (!isTauri()) return
    try {
      const result = await open({ multiple: true, title: 'Attach files' })
      if (result) {
        const files = Array.isArray(result) ? result : [result]
        const newFiles: StagedFile[] = []
        for (const f of files) {
          const name = (f as string).split(/[\\/]/).pop() ?? 'file'
          const error = validateFile(name, 0)
          if (error) { showToast(error, 'error'); continue }
          newFiles.push({ name, size: 0, path: f as string })
        }
        if (newFiles.length > 0) setStagedFiles((prev) => [...prev, ...newFiles])
      }
    } catch (err) {
      console.error('File picker error:', err)
    }
  }, [])

  const handleRemoveFile = (index: number) => {
    setStagedFiles((prev) => prev.filter((_, i) => i !== index))
  }

  const handleDragOver = (e: React.DragEvent) => { e.preventDefault(); e.stopPropagation(); setIsDragOver(true) }
  const handleDragLeave = (e: React.DragEvent) => { e.preventDefault(); e.stopPropagation(); setIsDragOver(false) }
  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault(); e.stopPropagation(); setIsDragOver(false)
    const files = Array.from(e.dataTransfer.files)
    if (files.length > 0) {
      const newFiles: StagedFile[] = []
      for (const f of files) {
        const error = validateFile(f.name, f.size)
        if (error) { showToast(error, 'error'); continue }
        newFiles.push({ name: f.name, size: f.size, path: (f as any).path ?? f.name })
      }
      if (newFiles.length > 0) setStagedFiles((prev) => [...prev, ...newFiles])
    }
  }

  useEffect(() => {
    if (inputRef.current) {
      inputRef.current.style.height = 'auto'
      inputRef.current.style.height = `${Math.min(inputRef.current.scrollHeight, 200)}px`
    }
  }, [value])

  return (
    <div
      className="mx-4 mb-6 mt-[-4px]"
      onDragOver={disableAttachments ? undefined : handleDragOver}
      onDragLeave={disableAttachments ? undefined : handleDragLeave}
      onDrop={disableAttachments ? undefined : handleDrop}
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

        {/* Input row */}
        <div className="flex items-end gap-0 px-1">
          {/* Attachment button */}
          {!disableAttachments && (
            <Tooltip content="Attach file" side="top">
              <button
                onClick={handleFilePick}
                disabled={isUploading}
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
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={`Message #${channelName}`}
            aria-label={`Message ${channelName}`}
            rows={1}
            disabled={isUploading}
            className="w-full resize-none bg-transparent px-2 py-2.5 text-sm text-primary placeholder:text-muted focus:outline-none disabled:opacity-60"
            style={{ minHeight: '44px', maxHeight: '200px' }}
          />
        </div>
      </div>
    </div>
  )
}
