import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import * as bridge from '../../lib/bridge'
import { EncryptedAttachmentPreview } from './EncryptedAttachmentPreview'

describe('EncryptedAttachmentPreview', () => {
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

  it('keeps received encrypted thumbnails outside renderer IPC', async () => {
    const loadThumbnail = vi.spyOn(bridge, 'matrixLoadAttachmentThumbnail')
    const createObjectURL = vi.fn()
    vi.stubGlobal('URL', { createObjectURL, revokeObjectURL: vi.fn() })

    await act(async () => {
      root.render(
        <EncryptedAttachmentPreview
          filename="private-image.png"
          roomId="!private:example.org"
          eventId="$image:example.org"
          attachmentIndex={0}
          thumbnail={{
            fileHash: 'matrix-sha256:thumbnail',
            size: 8,
            width: 320,
            height: 180,
            contentType: 'image/png',
          }}
        />,
      )
    })

    expect(container.querySelector('[role="status"]')?.textContent).toContain(
      'Encrypted preview stays protected',
    )
    expect(container.textContent).toContain('does not decrypt received thumbnails')
    expect(container.querySelector('img')).toBeNull()
    expect(loadThumbnail).not.toHaveBeenCalled()
    expect(createObjectURL).not.toHaveBeenCalled()
  })
})
