import { useState, useEffect } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { Icon } from '../ui/Icon'

interface CommunityFile {
  fileHash: string
  filename: string
  size: number
  seederCount: number
  lastSeen: string
}

interface FileBrowserProps {
  communityId: string
  isOpen: boolean
  onClose: () => void
}

export function FileBrowser({ communityId, isOpen, onClose }: FileBrowserProps) {
  const [files, setFiles] = useState<CommunityFile[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!isOpen) return
    setLoading(true)
    invoke<CommunityFile[]>('get_community_files', { communityId })
      .then(setFiles)
      .catch(() => setFiles([]))
      .finally(() => setLoading(false))
  }, [communityId, isOpen])

  if (!isOpen) return null

  return (
    <div className="fixed inset-0 z-modal flex items-center justify-center bg-scrim">
      <div className="flex max-h-file-browser w-file-browser flex-col rounded-lg bg-bg-secondary shadow-lg">
        <div className="flex items-center justify-between p-4 border-b border-border">
          <h2 className="text-lg font-semibold text-text-primary">Server files</h2>
          <button
            onClick={onClose}
            aria-label="Close server files"
            className="text-text-muted hover:text-text-primary"
          >
            <Icon name="x" size="sm" />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-4">
          {loading ? (
            <div className="text-center text-text-muted py-8">Loading files...</div>
          ) : files.length === 0 ? (
            <div className="text-center text-text-muted py-8">No files shared in this server yet.</div>
          ) : (
            <div className="space-y-2">
              {files.map((file) => (
                <div key={file.fileHash} className="flex items-center justify-between p-3 rounded-lg bg-bg-primary hover:bg-bg-tertiary">
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium text-text-primary truncate">{file.filename}</div>
                    <div className="text-xs text-text-muted">
                      {formatSize(file.size)} · {file.seederCount} seeder{file.seederCount !== 1 ? 's' : ''}
                    </div>
                  </div>
                  <button
                    className="ml-3 rounded bg-accent px-3 py-1 text-xs text-content-on-accent hover:bg-accent-bright"
                    onClick={() => invoke('request_file', { fileHash: file.fileHash, communityId })}
                  >
                    Download
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`
}
