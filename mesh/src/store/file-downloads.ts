import { create } from 'zustand'
import type {
  FileDownloadProgress,
  FileTransferStatus,
  MatrixTransferProgress,
  MatrixTransferState,
} from '../types/ipc'

interface FileDownloadDetails {
  fileHash: string
  filename: string
  sourcePeerId: string
  size: number
  chunks: number
  transferId?: string
}

interface FileDownloadRecord {
  fileHash: string
  filename: string
  sourcePeerId: string
  size: number
  chunks: number
  status: FileTransferStatus
  receivedChunks: number
  totalChunks: number
  receivedBytes: number
  totalBytes: number
  localPath: string | null
  error: string | null
  transferId: string | null
  matrixState: MatrixTransferState | null
  retryable: boolean
  retryMode: 'restart-from-zero' | null
}

interface FileDownloadStore {
  downloads: Record<string, FileDownloadRecord>
  startDownload: (details: FileDownloadDetails) => void
  updateDownloadProgress: (payload: FileDownloadProgress) => void
  updateMatrixTransferProgress: (payload: MatrixTransferProgress) => void
  markDownloadAvailable: (payload: { fileHash: string; localPath: string }) => void
  markDownloadFailed: (fileHash: string, error: string) => void
  clearDownload: (fileHash: string) => void
}

function buildBaseRecord(details: FileDownloadDetails): FileDownloadRecord {
  return {
    fileHash: details.fileHash,
    filename: details.filename,
    sourcePeerId: details.sourcePeerId,
    size: details.size,
    chunks: details.chunks,
    status: 'downloading',
    receivedChunks: 0,
    totalChunks: details.chunks,
    receivedBytes: 0,
    totalBytes: details.size,
    localPath: null,
    error: null,
    transferId: details.transferId ?? null,
    matrixState: details.transferId ? 'queued' : null,
    retryable: false,
    retryMode: null,
  }
}

export const useFileDownloadStore = create<FileDownloadStore>((set) => ({
  downloads: {},

  startDownload: (details) =>
    set((state) => ({
      downloads: {
        ...state.downloads,
        [details.fileHash]: {
          ...buildBaseRecord(details),
          status: 'downloading',
        },
      },
    })),

  updateDownloadProgress: (payload) =>
    set((state) => {
      const current = state.downloads[payload.fileHash]
      const totalChunks = payload.totalChunks || current?.totalChunks || 0
      const totalBytes = payload.totalBytes || current?.totalBytes || 0

      return {
        downloads: {
          ...state.downloads,
          [payload.fileHash]: {
            fileHash: payload.fileHash,
            filename: current?.filename ?? '',
            sourcePeerId: current?.sourcePeerId ?? '',
            size: current?.size ?? totalBytes,
            chunks: current?.chunks ?? totalChunks,
            status: payload.state === 'error' ? 'error' : 'downloading',
            receivedChunks: payload.receivedChunks,
            totalChunks,
            receivedBytes: payload.receivedBytes,
            totalBytes,
            localPath: current?.localPath ?? null,
            error: payload.state === 'error' ? current?.error ?? 'Download failed' : null,
            transferId: current?.transferId ?? null,
            matrixState: current?.matrixState ?? null,
            retryable: current?.retryable ?? false,
            retryMode: current?.retryMode ?? null,
          },
        },
      }
    }),

  updateMatrixTransferProgress: (payload) =>
    set((state) => {
      if (payload.direction !== 'download') return state
      const entry = Object.entries(state.downloads).find(
        ([, record]) => record.transferId === payload.transferId,
      )
      if (!entry) return state
      const [fileHash, current] = entry
      const failed = payload.state === 'failed' || payload.state === 'cancelled'
      const completed = payload.state === 'completed'
      return {
        downloads: {
          ...state.downloads,
          [fileHash]: {
            ...current,
            status: completed ? 'completed' : failed ? 'error' : 'downloading',
            receivedBytes: payload.transferredBytes,
            totalBytes: payload.totalBytes ?? current.totalBytes,
            receivedChunks: completed ? current.totalChunks : current.receivedChunks,
            localPath: payload.result?.localPath ?? current.localPath,
            error: failed ? payload.error ?? 'Download stopped' : null,
            matrixState: payload.state,
            retryable: payload.retryable,
            retryMode: payload.retryMode ?? null,
          },
        },
      }
    }),

  markDownloadAvailable: (payload) =>
    set((state) => {
      const current = state.downloads[payload.fileHash]
      return {
        downloads: {
          ...state.downloads,
          [payload.fileHash]: {
            fileHash: payload.fileHash,
            filename: current?.filename ?? '',
            sourcePeerId: current?.sourcePeerId ?? '',
            size: current?.size ?? 0,
            chunks: current?.chunks ?? 0,
            status: 'completed',
            receivedChunks: current?.totalChunks ?? current?.receivedChunks ?? 0,
            totalChunks: current?.totalChunks ?? current?.chunks ?? 0,
            receivedBytes: current?.totalBytes ?? current?.receivedBytes ?? 0,
            totalBytes: current?.totalBytes ?? current?.size ?? 0,
            localPath: payload.localPath,
            error: null,
            transferId: current?.transferId ?? null,
            matrixState: current?.matrixState ?? null,
            retryable: false,
            retryMode: null,
          },
        },
      }
    }),

  markDownloadFailed: (fileHash, error) =>
    set((state) => {
      const current = state.downloads[fileHash]
      if (!current) {
        return {
          downloads: {
            ...state.downloads,
            [fileHash]: {
              fileHash,
              filename: '',
              sourcePeerId: '',
              size: 0,
              chunks: 0,
              status: 'error',
              receivedChunks: 0,
              totalChunks: 0,
              receivedBytes: 0,
              totalBytes: 0,
              localPath: null,
              error,
              transferId: null,
              matrixState: null,
              retryable: true,
              retryMode: null,
            },
          },
        }
      }

      return {
        downloads: {
          ...state.downloads,
          [fileHash]: {
            ...current,
            status: 'error',
            error,
          },
        },
      }
    }),

  clearDownload: (fileHash) =>
    set((state) => {
      const downloads = { ...state.downloads }
      delete downloads[fileHash]
      return { downloads }
    }),
}))
