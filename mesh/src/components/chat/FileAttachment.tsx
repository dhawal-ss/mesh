import { motion, AnimatePresence } from 'framer-motion'
import { transitions } from '../../lib/motion'

interface StagedFile {
  name: string
  size: number
  path: string
}

interface FileAttachmentPreviewProps {
  files: StagedFile[]
  onRemove: (index: number) => void
}

export function FileAttachmentPreview({ files, onRemove }: FileAttachmentPreviewProps) {
  if (files.length === 0) return null

  return (
    <motion.div
      initial={{ height: 0, opacity: 0 }}
      animate={{ height: 'auto', opacity: 1 }}
      exit={{ height: 0, opacity: 0 }}
      transition={transitions.softSpring}
      className="border-b border-white/8 px-4 pb-3 pt-3"
    >
      <div className="flex flex-wrap gap-2">
        <AnimatePresence>
          {files.map((file, i) => (
            <motion.div
              key={`${file.path}-${i}`}
              initial={{ opacity: 0, scale: 0.9 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.9 }}
              className="group relative flex items-center gap-2 rounded-[14px] border border-white/8 bg-white/[0.04] px-3 py-2 pr-8"
            >
              <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-[8px] bg-white/[0.06] text-muted">
                <FileIcon filename={file.name} />
              </div>
              <div className="min-w-0">
                <p className="max-w-[140px] truncate text-xs font-medium text-primary">
                  {file.name}
                </p>
                <p className="text-[10px] text-muted">{formatSize(file.size)}</p>
              </div>
              <button
                onClick={() => onRemove(i)}
                className="absolute right-1.5 top-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-white/[0.06] text-muted opacity-0 transition-opacity hover:bg-white/[0.12] hover:text-primary group-hover:opacity-100"
              >
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3">
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
    </motion.div>
  )
}

function FileIcon({ filename }: { filename: string }) {
  const ext = filename.split('.').pop()?.toLowerCase() ?? ''
  const isImage = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'].includes(ext)
  const isVideo = ['mp4', 'mov', 'avi', 'webm'].includes(ext)
  const isAudio = ['mp3', 'wav', 'ogg', 'flac'].includes(ext)
  const isCode = ['ts', 'tsx', 'js', 'jsx', 'rs', 'py', 'go', 'json', 'css', 'html'].includes(ext)

  if (isImage) {
    return (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
        <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
        <circle cx="8.5" cy="8.5" r="1.5" />
        <polyline points="21 15 16 10 5 21" />
      </svg>
    )
  }
  if (isVideo || isAudio) {
    return (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
        <polygon points="5 3 19 12 5 21 5 3" />
      </svg>
    )
  }
  if (isCode) {
    return (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
        <polyline points="16 18 22 12 16 6" />
        <polyline points="8 6 2 12 8 18" />
      </svg>
    )
  }

  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
    </svg>
  )
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

export type { StagedFile }
