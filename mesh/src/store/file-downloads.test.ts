import { beforeEach, describe, expect, it } from 'vitest'
import { useFileDownloadStore } from './file-downloads'

describe('Matrix file download progress', () => {
  beforeEach(() => {
    useFileDownloadStore.setState({ downloads: {} })
  })

  it('tracks typed lifecycle bytes and a terminal local path', () => {
    const store = useFileDownloadStore.getState()
    store.startDownload({
      fileHash: 'matrix-sha256:test',
      filename: 'report.pdf',
      sourcePeerId: 'matrix',
      size: 100,
      chunks: 1,
      transferId: '00000000-0000-4000-8000-000000000001',
    })
    store.updateMatrixTransferProgress({
      transferId: '00000000-0000-4000-8000-000000000001',
      direction: 'download',
      transferredBytes: 100,
      totalBytes: 100,
      state: 'completed',
      retryable: false,
      result: { localPath: 'C:\\Mesh\\report.pdf' },
    })

    expect(useFileDownloadStore.getState().downloads['matrix-sha256:test']).toMatchObject({
      status: 'completed',
      receivedBytes: 100,
      totalBytes: 100,
      localPath: 'C:\\Mesh\\report.pdf',
      matrixState: 'completed',
      retryable: false,
    })
  })

  it('labels cancellation as a restart-from-zero retry', () => {
    const store = useFileDownloadStore.getState()
    store.startDownload({
      fileHash: 'matrix-sha256:test',
      filename: 'report.pdf',
      sourcePeerId: 'matrix',
      size: 100,
      chunks: 1,
      transferId: '00000000-0000-4000-8000-000000000002',
    })
    store.updateMatrixTransferProgress({
      transferId: '00000000-0000-4000-8000-000000000002',
      direction: 'download',
      transferredBytes: 0,
      totalBytes: 100,
      state: 'cancelled',
      retryable: true,
      retryMode: 'restart-from-zero',
      error: 'Transfer cancelled. Restarting begins again from zero.',
    })

    expect(useFileDownloadStore.getState().downloads['matrix-sha256:test']).toMatchObject({
      status: 'error',
      matrixState: 'cancelled',
      retryable: true,
      retryMode: 'restart-from-zero',
      receivedBytes: 0,
    })
  })
})
