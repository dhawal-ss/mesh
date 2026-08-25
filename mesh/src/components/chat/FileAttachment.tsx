import { motion, AnimatePresence } from '../../lib/lazy-motion'
import { motionOffsets, motionScales, transitions } from '../../lib/motion'
import type { MatrixTransferProgress } from '../../types/ipc'
import { Icon } from '../ui/Icon'

interface StagedFile {
  name: string
  size: number | null
  grant: string
  path?: string
  contentType?: string
  source: 'native' | 'temporary'
  stagingToken?: string
  transferId?: string
}

interface FileAttachmentPreviewProps {
  files: StagedFile[]
  onRemove: (index: number) => void
  transfers?: Record<string, MatrixTransferProgress>
  onCancelTransfer?: (transferId: string) => void
}

export function FileAttachmentPreview({
  files,
  onRemove,
  transfers = {},
  onCancelTransfer,
}: FileAttachmentPreviewProps) {
  if (files.length === 0) return null

  return (
    <motion.div
      initial={{ opacity: 0, y: -motionOffsets.tight }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -motionOffsets.tight }}
      transition={transitions.enter}
      className="border-b border-border-subtle px-4 pb-3 pt-3"
    >
      <div className="flex flex-wrap gap-2">
        <AnimatePresence>
          {files.map((file, i) => {
            const transfer = file.transferId ? transfers[file.transferId] : undefined
            const transferActive = transfer && !['completed', 'cancelled', 'failed'].includes(transfer.state)
            const transferCancellable = transfer && ['queued', 'encrypting', 'uploading'].includes(transfer.state)
            const transferFailed = transfer?.state === 'failed'
            const progressPercent = transfer?.totalBytes
              ? Math.min(100, Math.round((transfer.transferredBytes / transfer.totalBytes) * 100))
              : 0
            return (
              <motion.div
                key={`${file.grant}-${i}`}
                initial={{ opacity: 0, scale: motionScales.recede }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: motionScales.recede }}
                className="group relative flex items-center gap-2 rounded-control border border-border-subtle bg-surface-hover px-3 py-2 pr-8"
              >
                <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-control bg-surface-active text-muted">
                  <FileIcon filename={file.name} />
                </div>
                <div className="min-w-0">
                  <p className="max-w-attachment-name truncate text-xs font-medium text-primary">{file.name}</p>
                  {transferFailed ? (
                    <p role="alert" className="file-size flex items-start gap-1 text-caption text-status-danger">
                      <Icon name="triangleAlert" size="xs" className="mt-px flex-shrink-0" />
                      <span>Upload failed.</span>
                    </p>
                  ) : (
                    <p className="file-size text-caption text-muted">
                      {transfer
                        ? transfer.state === 'cancelled'
                          ? 'Upload cancelled.'
                          : `${uploadStateLabel(transfer.state)} · ${progressPercent}%`
                        : file.size === null
                          ? 'Size checked securely when sent'
                          : formatSize(file.size)}
                    </p>
                  )}
                  {transferActive && (
                    <div className="mt-1 h-1 overflow-hidden rounded-panel bg-surface-active">
                      <div
                        className="h-full rounded-panel bg-accent transition-[width] duration-normal"
                        data-design-token-exception="data-driven-transfer-progress-width"
                        style={{ width: `${progressPercent}%` }}
                      />
                    </div>
                  )}
                </div>
                <button
                  type="button"
                  onClick={() => {
                    if (transferCancellable && file.transferId) onCancelTransfer?.(file.transferId)
                    else onRemove(i)
                  }}
                  disabled={Boolean(transferActive && !transferCancellable)}
                  aria-label={
                    transferCancellable
                      ? `Cancel upload of ${file.name}`
                      : transferActive
                        ? `Publishing ${file.name}`
                        : `Remove ${file.name}`
                  }
                  className="absolute right-1.5 top-1.5 flex h-8 w-8 items-center justify-center rounded-control bg-surface-hover text-muted transition-colors hover:bg-surface-active hover:text-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus"
                >
                  <Icon name="x" size="xs" />
                </button>
              </motion.div>
            )
          })}
        </AnimatePresence>
      </div>
    </motion.div>
  )
}

function uploadStateLabel(state: MatrixTransferProgress['state']): string {
  switch (state) {
    case 'queued':
      return 'Waiting'
    case 'encrypting':
      return 'Preparing'
    case 'uploading':
      return 'Uploading'
    case 'publishing':
      return 'Sending'
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

function FileIcon({ filename }: { filename: string }) {
  const ext = filename.split('.').pop()?.toLowerCase() ?? ''
  const isImage = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'].includes(ext)
  const isVideo = ['mp4', 'mov', 'avi', 'webm'].includes(ext)
  const isAudio = ['mp3', 'wav', 'ogg', 'flac'].includes(ext)
  const isCode = ['ts', 'tsx', 'js', 'jsx', 'rs', 'py', 'go', 'json', 'css', 'html'].includes(ext)

  if (isImage) {
    return <Icon name="image" size="xs" />
  }
  if (isVideo || isAudio) {
    return <Icon name="play" size="xs" />
  }
  if (isCode) {
    return <Icon name="code" size="xs" />
  }

  return <Icon name="file" size="xs" />
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

export type { StagedFile }
