import { create } from 'zustand'
import type { FileDownloadProgress, FileTransferStatus } from '../types/ipc'

interface FileDownloadDetails {
  fileHash: string
  filename: string
  sourcePeerId: string
  size: number
  chunks: number
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
}

interface FileDownloadStore {
  downloads: Record<string, FileDownloadRecord>
  startDownload: (details: FileDownloadDetails) => void
  updateDownloadProgress: (payload: FileDownloadProgress) => void
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
