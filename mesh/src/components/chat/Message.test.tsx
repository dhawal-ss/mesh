import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../ui/Avatar', () => ({
  Avatar: ({ name }: { name: string }) => <div>{name}</div>,
}))

vi.mock('./MarkdownContent', () => ({
  MarkdownContent: ({ content }: { content: string }) => <p>{content}</p>,
}))

vi.mock('./ReactionPicker', () => ({
  ReactionPicker: () => null,
}))

vi.mock('framer-motion', () => ({
  AnimatePresence: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  motion: {
    div: ({ children, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
      <div {...props}>{children}</div>
    ),
  },
}))

import type { Message } from '../../types/ipc'
import * as bridge from '../../lib/bridge'
import { FileAttachmentCard, MessageComponent } from './Message'

function malformedMessage(): Message {
  return {
    id: 'message-1',
    channelId: 'channel-1',
    authorPublicKey: '@alice:example.org',
    authorDisplayName: 'Alice',
    authorAvatarColor: '#52b5f4',
    content: 'Federated message',
    attachments: [],
    reactions: {},
    timestamp: 'not-a-timestamp',
    signature: '',
  }
}

function previewAttachment(): Message['attachments'][number] {
  return {
    fileHash: 'matrix-sha256:file',
    filename: 'private-image.png',
    size: 1024,
    chunks: 1,
    sourcePeerId: 'matrix',
    contentType: 'image/png',
    thumbnail: {
      fileHash: 'matrix-sha256:thumbnail',
      size: 8,
      width: 320,
      height: 180,
      contentType: 'image/png',
    },
  }
}

describe('MessageComponent federated timestamps', () => {
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

  it.each([false, true])(
    'renders honest fallback copy for malformed %s-group timestamps',
    async (isGrouped) => {
      await expect(
        act(async () => {
          root.render(
            <MessageComponent
              message={malformedMessage()}
              isGrouped={isGrouped}
            />,
          )
        }),
      ).resolves.toBeUndefined()

      expect(container.textContent).toContain('Time unavailable')
      expect(container.textContent).not.toContain('Invalid Date')
    },
  )

  it.each([false, true])(
    'shows protected saved state for %s-group queued messages',
    async (isGrouped) => {
      await act(async () => {
        root.render(
          <MessageComponent
            message={{
              ...malformedMessage(),
              id: 'txn-1',
              transactionId: 'txn-1',
              deliveryStatus: 'pending',
            }}
            isGrouped={isGrouped}
          />,
        )
      })

      expect(container.querySelector('[role="status"]')?.textContent)
        .toContain('Saved on this device')
      expect(container.getAttribute('aria-label')).toBeNull()
      expect(container.querySelector('[aria-label="Edit message"]')).toBeNull()
      expect(container.querySelector('[aria-label^="React to message"]')).toBeNull()
    },
  )

  it('offers accessible retry and cancel without exposing event-only actions', async () => {
    const onRetry = vi.fn()
    const onCancel = vi.fn()
    await act(async () => {
      root.render(
        <MessageComponent
          message={{
            ...malformedMessage(),
            id: 'txn-1',
            transactionId: 'txn-1',
            deliveryStatus: 'failed',
          }}
          isGrouped
          onRetry={onRetry}
          onCancel={onCancel}
        />,
      )
    })

    const alert = container.querySelector('[role="alert"]')
    expect(alert?.textContent).toContain('Delivery needs attention')
    const [retry, cancel] = [...alert!.querySelectorAll('button')]
    await act(async () => {
      retry.click()
      cancel.click()
    })
    expect(onRetry).toHaveBeenCalledOnce()
    expect(onCancel).toHaveBeenCalledOnce()
    expect(container.querySelector('[aria-label="Edit message"]')).toBeNull()
  })

  it('loads an encrypted thumbnail only near the viewport and revokes its Blob URL', async () => {
    let intersectionCallback: IntersectionObserverCallback | undefined
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
    const createObjectURL = vi.fn(() => 'blob:protected-thumbnail')
    const revokeObjectURL = vi.fn()
    vi.stubGlobal('IntersectionObserver', TestIntersectionObserver)
    vi.stubGlobal('URL', { createObjectURL, revokeObjectURL })
    vi.spyOn(bridge, 'isMatrixBackend').mockReturnValue(true)
    vi.spyOn(bridge, 'onMatrixTransferProgress').mockResolvedValue(() => {})
    vi.spyOn(bridge, 'matrixLoadAttachmentThumbnail').mockResolvedValue(
      new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
    )

    await act(async () => {
      root.render(
        <FileAttachmentCard
          attachment={previewAttachment()}
          roomId="!private:example.org"
          eventId="$image:example.org"
          attachmentIndex={0}
        />,
      )
    })

    expect(bridge.matrixLoadAttachmentThumbnail).not.toHaveBeenCalled()
    await act(async () => {
      intersectionCallback?.(
        [{ isIntersecting: true } as IntersectionObserverEntry],
        {} as IntersectionObserver,
      )
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(bridge.matrixLoadAttachmentThumbnail).toHaveBeenCalledWith(
      '!private:example.org',
      '$image:example.org',
      0,
    )
    expect(container.querySelector('img')?.getAttribute('src')).toBe(
      'blob:protected-thumbnail',
    )

    await act(async () => root.render(<div />))
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:protected-thumbnail')
  })

  it('shows a generic retry when a protected preview cannot be loaded', async () => {
    let intersectionCallback: IntersectionObserverCallback | undefined
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
    vi.stubGlobal('IntersectionObserver', TestIntersectionObserver)
    vi.stubGlobal('URL', {
      createObjectURL: vi.fn(() => 'blob:retried-thumbnail'),
      revokeObjectURL: vi.fn(),
    })
    vi.spyOn(bridge, 'isMatrixBackend').mockReturnValue(true)
    vi.spyOn(bridge, 'onMatrixTransferProgress').mockResolvedValue(() => {})
    vi.spyOn(bridge, 'matrixLoadAttachmentThumbnail')
      .mockRejectedValueOnce(new Error('secret transport detail'))
      .mockResolvedValueOnce(new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]))

    await act(async () => {
      root.render(
        <FileAttachmentCard
          attachment={previewAttachment()}
          roomId="!private:example.org"
          eventId="$image:example.org"
          attachmentIndex={0}
        />,
      )
    })
    await act(async () => {
      intersectionCallback?.(
        [{ isIntersecting: true } as IntersectionObserverEntry],
        {} as IntersectionObserver,
      )
      await Promise.resolve()
      await Promise.resolve()
    })

    const retry = [...container.querySelectorAll('button')].find(
      (button) => button.textContent === 'Retry preview',
    )
    expect(retry).toBeDefined()
    expect(container.textContent).not.toContain('secret transport detail')

    await act(async () => {
      retry?.click()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(bridge.matrixLoadAttachmentThumbnail).toHaveBeenCalledTimes(2)
    expect(container.querySelector('img')?.getAttribute('src')).toBe(
      'blob:retried-thumbnail',
    )
  })

  it('requires explicit loading without intersection support and ignores stale completion', async () => {
    let finishLoad: ((bytes: Uint8Array | null) => void) | undefined
    const createObjectURL = vi.fn(() => 'blob:stale-thumbnail')
    vi.stubGlobal('IntersectionObserver', undefined)
    vi.stubGlobal('URL', {
      createObjectURL,
      revokeObjectURL: vi.fn(),
    })
    vi.spyOn(bridge, 'isMatrixBackend').mockReturnValue(true)
    vi.spyOn(bridge, 'onMatrixTransferProgress').mockResolvedValue(() => {})
    vi.spyOn(bridge, 'matrixLoadAttachmentThumbnail').mockImplementation(() => (
      new Promise((resolve) => {
        finishLoad = resolve
      })
    ))

    await act(async () => {
      root.render(
        <FileAttachmentCard
          attachment={previewAttachment()}
          roomId="!private:example.org"
          eventId="$image:example.org"
          attachmentIndex={0}
        />,
      )
    })
    expect(bridge.matrixLoadAttachmentThumbnail).not.toHaveBeenCalled()

    const load = [...container.querySelectorAll('button')].find(
      (button) => button.textContent === 'Load preview',
    )
    expect(load).toBeDefined()
    await act(async () => {
      load?.click()
      await Promise.resolve()
    })
    expect(bridge.matrixLoadAttachmentThumbnail).toHaveBeenCalledTimes(1)

    await act(async () => root.render(<div />))
    await act(async () => {
      finishLoad?.(new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]))
      await Promise.resolve()
    })
    expect(createObjectURL).not.toHaveBeenCalled()
  })
})
