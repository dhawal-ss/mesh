import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('framer-motion', () => ({
  AnimatePresence: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  motion: {
    div: ({ children, ...props }: React.HTMLAttributes<HTMLDivElement>) => <div {...props}>{children}</div>,
  },
}))

import type { MatrixTransferProgress } from '../../types/ipc'
import { FileAttachmentPreview, type StagedFile } from './FileAttachment'

describe('FileAttachmentPreview', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('keeps a failed upload card neutral while making its metadata semantic', async () => {
    const file: StagedFile = {
      name: 'private-image.png',
      size: 1024,
      grant: 'grant-1',
      source: 'native',
      transferId: 'transfer-1',
    }
    const failedTransfer: MatrixTransferProgress = {
      transferId: 'transfer-1',
      direction: 'upload',
      state: 'failed',
      transferredBytes: 512,
      totalBytes: 1024,
      retryable: true,
      retryMode: 'restart-from-zero',
      error: 'Encrypted upload failed.',
    }

    await act(async () => {
      root.render(
        <FileAttachmentPreview files={[file]} onRemove={vi.fn()} transfers={{ 'transfer-1': failedTransfer }} />,
      )
    })

    const failure = container.querySelector('[role="alert"]')
    expect(failure?.textContent).toContain('Encrypted upload failed.')
    expect(failure?.textContent).toContain('Retry restarts from zero.')
    expect(failure?.className).toContain('text-status-danger')
    expect(failure?.querySelector('svg')).not.toBeNull()

    const card = failure?.closest('.group')
    expect(card?.className).toContain('bg-surface-hover')
    expect(card?.className).toContain('border-border-subtle')
    expect(card?.className).not.toContain('bg-status-danger')
    expect(card?.className).not.toContain('border-status-danger')
  })
})
