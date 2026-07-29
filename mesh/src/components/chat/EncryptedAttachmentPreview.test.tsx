import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import * as bridge from '../../lib/bridge'
import { EncryptedAttachmentPreview } from './EncryptedAttachmentPreview'

describe('EncryptedAttachmentPreview', () => {
  let container: HTMLDivElement
  let root: Root
  let intersectionCallback: IntersectionObserverCallback | undefined

  beforeEach(() => {
    class TestIntersectionObserver {
      readonly root = null
      readonly rootMargin = '160px 0px'
      readonly thresholds = [0]
      constructor(callback: IntersectionObserverCallback) {
        intersectionCallback = callback
      }
      disconnect() {}
      observe() {}
      takeRecords(): IntersectionObserverEntry[] {
        return []
      }
      unobserve() {}
    }

    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    vi.stubGlobal('IntersectionObserver', TestIntersectionObserver)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    intersectionCallback = undefined
  })

  it('shows compact loading and semantic failure states, retries, and cleans up its URL', async () => {
    let rejectLoad: ((reason?: unknown) => void) | undefined
    const revokeObjectURL = vi.fn()
    vi.stubGlobal('URL', {
      createObjectURL: vi.fn(() => 'blob:retried-thumbnail'),
      revokeObjectURL,
    })
    vi.spyOn(bridge, 'matrixLoadAttachmentThumbnail')
      .mockImplementationOnce(() => new Promise((_, reject) => {
        rejectLoad = reject
      }))
      .mockResolvedValueOnce(new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]))

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

    await act(async () => {
      intersectionCallback?.(
        [{ isIntersecting: true } as IntersectionObserverEntry],
        {} as IntersectionObserver,
      )
      await Promise.resolve()
    })

    const loadingStatus = container.querySelector('[role="status"]')
    expect(loadingStatus?.textContent).toContain('Loading protected preview')
    expect(loadingStatus?.querySelector('.animate-spin')).not.toBeNull()

    await act(async () => {
      rejectLoad?.(new Error('secret transport detail'))
      await Promise.resolve()
    })

    const failure = container.querySelector('[role="alert"]')
    expect(failure?.textContent).toBe('Protected preview unavailable.')
    expect(failure?.className).toContain('text-status-warning')
    expect(failure?.querySelector('svg')).not.toBeNull()
    expect(container.textContent).not.toContain('secret transport detail')

    const retry = [...container.querySelectorAll('button')].find(
      (button) => button.textContent === 'Retry preview',
    )
    expect(retry).toBeDefined()

    await act(async () => {
      retry?.click()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(bridge.matrixLoadAttachmentThumbnail).toHaveBeenCalledTimes(2)
    expect(container.querySelector('img')?.getAttribute('src')).toBe('blob:retried-thumbnail')

    await act(async () => root.render(<div />))
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:retried-thumbnail')
  })
})
