import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import * as bridge from '../../lib/bridge'
import { useSettingsStore } from '../../store/settings'
import { EncryptedAttachmentPreview } from './EncryptedAttachmentPreview'

const PNG_BYTES = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])

function thumbnail() {
  return {
    fileHash: 'matrix-sha256:thumbnail',
    size: 8,
    width: 320,
    height: 180,
    contentType: 'image/png',
  }
}

/**
 * `showInlineImagePreviews` is the documented flag this component reads; it is
 * not on SettingsStore yet, so the test seeds it the same widened way.
 */
function setInlinePreviewPreference(enabled: boolean) {
  useSettingsStore.setState(
    { showInlineImagePreviews: enabled } as unknown as Partial<
      ReturnType<typeof useSettingsStore.getState>
    >,
  )
}

/**
 * Drains the load queue. A preview awaits a concurrency slot and then the
 * bridge, and the slot is handed to the next waiter on release, so several
 * microtask turns separate a render from the last image being materialized.
 */
async function flushPreviewLoads(turns = 40) {
  await act(async () => {
    for (let turn = 0; turn < turns; turn += 1) await Promise.resolve()
  })
}

/** Fresh, counting object-URL doubles, so every test can name the URLs it expects. */
function stubObjectUrls() {
  let issued = 0
  const createObjectURL = vi.fn(() => {
    issued += 1
    return `blob:preview-${issued}`
  })
  const revokeObjectURL = vi.fn()
  vi.stubGlobal('URL', { createObjectURL, revokeObjectURL })
  return { createObjectURL, revokeObjectURL }
}

describe('EncryptedAttachmentPreview', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    setInlinePreviewPreference(true)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('keeps the protected placeholder for types the image loader will not decrypt', async () => {
    const { createObjectURL } = stubObjectUrls()
    const loadThumbnail = vi.spyOn(bridge, 'matrixLoadAttachmentThumbnail')
    const loadImage = vi.spyOn(bridge, 'matrixLoadAttachmentImage')

    await act(async () => {
      root.render(
        <EncryptedAttachmentPreview
          filename="encrypted-plan.pdf"
          roomId="!private:example.org"
          eventId="$image:example.org"
          attachmentIndex={0}
          thumbnail={thumbnail()}
          contentType="application/pdf"
          sourceBytes={2048}
        />,
      )
    })

    expect(container.querySelector('[data-protected-preview="true"]')?.textContent).toContain(
      'Preview stays protected',
    )
    expect(container.textContent).toContain('Save the file to open it.')
    // Static explanatory copy, not a status change: a live region here is
    // re-announced on every virtualized scroll pass.
    expect(container.querySelector('[role="status"]')).toBeNull()
    expect(container.querySelector('img')).toBeNull()
    expect(loadThumbnail).not.toHaveBeenCalled()
    expect(loadImage).not.toHaveBeenCalled()
    expect(createObjectURL).not.toHaveBeenCalled()
  })

  it('renders a decrypted image inline, opens the viewer, and revokes on unmount', async () => {
    const { revokeObjectURL } = stubObjectUrls()
    const onOpen = vi.fn()
    const loadImage = vi.spyOn(bridge, 'matrixLoadAttachmentImage').mockResolvedValue({
      bytes: PNG_BYTES,
      contentType: 'image/png',
    })

    await act(async () => {
      root.render(
        <EncryptedAttachmentPreview
          filename="private-image.png"
          roomId="!private:example.org"
          eventId="$image:example.org"
          attachmentIndex={0}
          thumbnail={thumbnail()}
          contentType="image/png"
          sourceBytes={2048}
          onOpen={onOpen}
        />,
      )
    })

    await flushPreviewLoads()

    expect(loadImage).toHaveBeenCalledWith('!private:example.org', '$image:example.org', 0)
    const image = container.querySelector('img')
    expect(image?.getAttribute('src')).toBe('blob:preview-1')
    expect(image?.getAttribute('alt')).toBe('Preview of private-image.png')
    // No live region: the virtualized timeline re-inserts this node constantly.
    expect(container.querySelector('[role="status"]')).toBeNull()

    const open = container.querySelector<HTMLButtonElement>(
      '[aria-label="Open private-image.png at full size"]',
    )
    expect(open).not.toBeNull()
    await act(async () => open?.click())
    expect(onOpen).toHaveBeenCalledOnce()

    await act(async () => root.unmount())
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:preview-1')

    // The afterEach unmount must stay harmless after this one.
    root = createRoot(container)
  })

  it('keeps the old protected placeholder when the preference is off', async () => {
    const { createObjectURL } = stubObjectUrls()
    const loadImage = vi.spyOn(bridge, 'matrixLoadAttachmentImage').mockResolvedValue({
      bytes: PNG_BYTES,
      contentType: 'image/png',
    })
    setInlinePreviewPreference(false)

    await act(async () => {
      root.render(
        <EncryptedAttachmentPreview
          filename="private-image.png"
          roomId="!private:example.org"
          eventId="$image:example.org"
          attachmentIndex={0}
          thumbnail={thumbnail()}
          contentType="image/png"
          sourceBytes={2048}
        />,
      )
    })

    expect(container.textContent).toContain('Preview stays protected')
    expect(container.querySelector('img')).toBeNull()
    expect(loadImage).not.toHaveBeenCalled()
    expect(createObjectURL).not.toHaveBeenCalled()
  })

  it('waits for a deliberate tap before decrypting a large image', async () => {
    stubObjectUrls()
    const loadImage = vi.spyOn(bridge, 'matrixLoadAttachmentImage').mockResolvedValue({
      bytes: PNG_BYTES,
      contentType: 'image/png',
    })

    await act(async () => {
      root.render(
        <EncryptedAttachmentPreview
          filename="huge-render.png"
          roomId="!private:example.org"
          eventId="$image:example.org"
          attachmentIndex={0}
          thumbnail={thumbnail()}
          contentType="image/png"
          sourceBytes={64 * 1024 * 1024}
        />,
      )
    })

    expect(loadImage).not.toHaveBeenCalled()
    expect(container.textContent).toContain('This image is large')
    const show = container.querySelector<HTMLButtonElement>(
      '[aria-label="Show preview of huge-render.png"]',
    )
    expect(show).not.toBeNull()

    await act(async () => show?.click())
    await flushPreviewLoads()
    expect(loadImage).toHaveBeenCalledOnce()
    expect(container.querySelector('img')?.getAttribute('alt')).toBe('Preview of huge-render.png')
  })

  it('states a failed decrypt honestly and retries without a live region', async () => {
    const { createObjectURL } = stubObjectUrls()
    const loadImage = vi.spyOn(bridge, 'matrixLoadAttachmentImage')
      .mockRejectedValueOnce(new Error('decryption failed'))
      .mockResolvedValueOnce({ bytes: PNG_BYTES, contentType: 'image/png' })

    await act(async () => {
      root.render(
        <EncryptedAttachmentPreview
          filename="private-image.png"
          roomId="!private:example.org"
          eventId="$image:example.org"
          attachmentIndex={0}
          thumbnail={thumbnail()}
          contentType="image/png"
          sourceBytes={2048}
        />,
      )
    })

    await flushPreviewLoads()

    expect(container.textContent).toContain('Preview could not be opened')
    expect(container.querySelector('img')).toBeNull()
    expect(container.querySelector('[role="alert"]')).toBeNull()
    expect(container.querySelector('[role="status"]')).toBeNull()
    expect(createObjectURL).not.toHaveBeenCalled()

    const retry = container.querySelector<HTMLButtonElement>(
      '[aria-label="Try the preview of private-image.png again"]',
    )
    await act(async () => retry?.click())
    await flushPreviewLoads()
    expect(loadImage).toHaveBeenCalledTimes(2)
    expect(container.querySelector('img')?.getAttribute('src')).toBe('blob:preview-1')
  })

  it('bounds how many previews stay materialized and revokes the ones it drops', async () => {
    const { createObjectURL, revokeObjectURL } = stubObjectUrls()
    vi.spyOn(bridge, 'matrixLoadAttachmentImage').mockResolvedValue({
      bytes: PNG_BYTES,
      contentType: 'image/png',
    })
    const rows = Array.from({ length: 9 }, (_, index) => index)

    await act(async () => {
      root.render(
        <>
          {rows.map((index) => (
            <EncryptedAttachmentPreview
              key={index}
              filename={`image-${index}.png`}
              roomId="!private:example.org"
              eventId={`$image-${index}:example.org`}
              attachmentIndex={0}
              thumbnail={thumbnail()}
              contentType="image/png"
              sourceBytes={2048}
            />
          ))}
        </>,
      )
    })
    await flushPreviewLoads()

    expect(createObjectURL).toHaveBeenCalledTimes(9)
    // Nine images, an eight-preview ceiling: the oldest is revoked, and its row
    // falls back to an explicit tap rather than a broken image.
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:preview-1')
    expect(container.querySelectorAll('img')).toHaveLength(8)
    expect(container.textContent).toContain('This preview was released while you scrolled')
    expect(
      container.querySelector('[aria-label="Show preview of image-0.png"]'),
    ).not.toBeNull()
  })
})
