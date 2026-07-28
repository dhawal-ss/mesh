import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../ui/Modal', () => ({
  Modal: ({
    children,
    title,
  }: {
    children: React.ReactNode
    title: string
  }) => (
    <section role="dialog" aria-label={title}>
      {children}
    </section>
  ),
}))

import * as bridge from '../../lib/bridge'
import { ProtectedImageLightbox } from './ProtectedImageLightbox'

describe('ProtectedImageLightbox', () => {
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

  it('loads validated bytes, supports arrow navigation, and revokes its object URL', async () => {
    const createObjectURL = vi.fn(() => 'blob:protected-image')
    const revokeObjectURL = vi.fn()
    const onPrevious = vi.fn()
    const onNext = vi.fn()
    vi.stubGlobal('URL', { createObjectURL, revokeObjectURL })
    vi.spyOn(bridge, 'matrixLoadAttachmentImage').mockResolvedValue({
      bytes: new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
      contentType: 'image/png',
    })

    await act(async () => {
      root.render(
        <ProtectedImageLightbox
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
          imagePosition={0}
          imageCount={2}
          onPrevious={onPrevious}
          onNext={onNext}
          onClose={vi.fn()}
        />,
      )
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(bridge.matrixLoadAttachmentImage).toHaveBeenCalledWith(
      '!private:example.org',
      '$image:example.org',
      0,
    )
    expect(container.querySelector('img')?.getAttribute('src')).toBe(
      'blob:protected-image',
    )
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight' }))
    })
    expect(onNext).toHaveBeenCalledOnce()

    await act(async () => root.render(<div />))
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:protected-image')
  })
})
