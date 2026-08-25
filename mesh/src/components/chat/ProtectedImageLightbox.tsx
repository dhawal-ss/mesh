import { useEffect, useRef, useState } from 'react'

import type { AttachmentThumbnail } from '../../types/ipc'
import * as bridge from '../../lib/bridge'
import { Button } from '../ui/Button'
import { Icon } from '../ui/Icon'
import { Modal } from '../ui/Modal'
import { Spinner } from '../ui/Spinner'

type ImageState =
  | { status: 'loading'; url: null; attempt: number }
  | { status: 'ready'; url: string; attempt: number }
  | { status: 'failed'; url: null; attempt: number }

const MIN_ZOOM = 0.5
const MAX_ZOOM = 3
const ZOOM_STEP = 0.25
const PAN_STEP = 32

export function ProtectedImageLightbox({
  filename,
  roomId,
  eventId,
  attachmentIndex,
  thumbnail,
  imagePosition,
  imageCount,
  onPrevious,
  onNext,
  onClose,
}: {
  filename: string
  roomId: string
  eventId: string
  attachmentIndex: number
  thumbnail: AttachmentThumbnail
  imagePosition: number
  imageCount: number
  onPrevious: () => void
  onNext: () => void
  onClose: () => void
}) {
  const objectUrlRef = useRef<string | null>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const [image, setImage] = useState<ImageState>({
    status: 'loading',
    url: null,
    attempt: 0,
  })
  const [zoom, setZoom] = useState(1)
  const [offset, setOffset] = useState({ x: 0, y: 0 })

  useEffect(() => {
    let active = true
    void bridge
      .matrixLoadAttachmentImage(roomId, eventId, attachmentIndex)
      .then((result) => {
        if (!active || !result) return
        const objectUrl = URL.createObjectURL(new Blob([result.bytes], { type: result.contentType }))
        if (!active) {
          URL.revokeObjectURL(objectUrl)
          return
        }
        objectUrlRef.current = objectUrl
        setImage((current) => ({
          status: 'ready',
          url: objectUrl,
          attempt: current.attempt,
        }))
      })
      .catch(() => {
        if (!active) return
        setImage((current) => ({
          status: 'failed',
          url: null,
          attempt: current.attempt,
        }))
      })
    return () => {
      active = false
      if (objectUrlRef.current) {
        URL.revokeObjectURL(objectUrlRef.current)
        objectUrlRef.current = null
      }
    }
  }, [attachmentIndex, eventId, image.attempt, roomId])

  /*
    Scoped to the dialog, not to `window`. A global listener that called
    preventDefault() unconditionally competed with the visible Pan buttons and
    swallowed the arrow keys for everything else on the page while the lightbox
    was open. Text entry and sliders keep their own arrow-key behavior.
  */
  useEffect(() => {
    if (imageCount < 2) return
    const content = contentRef.current
    const scope = (content?.closest('[role="dialog"]') ?? content) as HTMLElement | null
    if (!scope) return
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
      const target = event.target
      if (target instanceof HTMLElement) {
        const tag = target.tagName
        if (
          tag === 'INPUT'
          || tag === 'TEXTAREA'
          || tag === 'SELECT'
          || target.isContentEditable
          || target.getAttribute('role') === 'slider'
        ) return
      }
      event.preventDefault()
      if (event.key === 'ArrowLeft') onPrevious()
      else onNext()
    }
    scope.addEventListener('keydown', handleKeyDown)
    return () => scope.removeEventListener('keydown', handleKeyDown)
  }, [imageCount, onNext, onPrevious])

  const retry = () => {
    setImage((current) => ({
      status: 'loading',
      url: null,
      attempt: current.attempt + 1,
    }))
  }

  const resetView = () => {
    setZoom(1)
    setOffset({ x: 0, y: 0 })
  }

  const pan = (x: number, y: number) => {
    setOffset((current) => ({ x: current.x + x, y: current.y + y }))
  }

  const viewStyle = {
    aspectRatio: `${thumbnail.width} / ${thumbnail.height}`,
  }

  return (
    <Modal open onClose={onClose} title={filename} description="Protected image">
      <div ref={contentRef} className="space-y-3">
        <div
          className="relative flex min-h-64 w-full items-center justify-center overflow-hidden rounded-control border border-border-subtle bg-surface-hover"
          data-design-token-exception="data-driven-thumbnail-aspect-ratio"
          style={viewStyle}
        >
          {image.status === 'loading' && (
            <span role="status" className="inline-flex items-center gap-2 text-sm text-muted">
              <Spinner size={16} />
              Loading protected image…
            </span>
          )}
          {image.status === 'failed' && (
            <div className="flex flex-col items-center gap-2 px-4 text-center">
              <div className="flex h-8 w-8 items-center justify-center rounded-control bg-container-danger text-status-danger">
                <Icon name="triangleAlert" size="sm" />
              </div>
              <p role="alert" className="text-sm font-medium text-status-danger">
                The full image could not be loaded.
              </p>
              <Button type="button" variant="secondary" size="sm" onClick={retry}>
                Retry image
              </Button>
            </div>
          )}
          {image.status === 'ready' && (
            <img
              src={image.url}
              alt={filename}
              className="max-h-screen max-w-full select-none object-contain"
              draggable={false}
              style={{
                transform: `translate(${offset.x}px, ${offset.y}px) scale(${zoom})`,
              }}
              onError={() => {
                URL.revokeObjectURL(image.url)
                objectUrlRef.current = null
                setImage((current) => ({
                  status: 'failed',
                  url: null,
                  attempt: current.attempt,
                }))
              }}
            />
          )}
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2 text-sm text-muted">
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={onPrevious}
              disabled={imageCount < 2}
              aria-keyshortcuts={imageCount < 2 ? undefined : 'ArrowLeft'}
              className="min-h-control-sm rounded-control px-2 font-medium text-secondary transition-colors hover:bg-surface-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus disabled:cursor-not-allowed disabled:opacity-50"
            >
              Previous image
            </button>
            <span role="status" aria-live="polite" aria-atomic="true" className="tnum">
              {imagePosition + 1} of {imageCount}
            </span>
            <button
              type="button"
              onClick={onNext}
              disabled={imageCount < 2}
              aria-keyshortcuts={imageCount < 2 ? undefined : 'ArrowRight'}
              className="min-h-control-sm rounded-control px-2 font-medium text-secondary transition-colors hover:bg-surface-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus disabled:cursor-not-allowed disabled:opacity-50"
            >
              Next image
            </button>
          </div>
          <div className="flex flex-wrap items-center gap-1">
            <button
              type="button"
              onClick={() => setZoom((current) => Math.max(MIN_ZOOM, current - ZOOM_STEP))}
              disabled={zoom <= MIN_ZOOM}
              className="min-h-control-sm rounded-control px-2 font-medium text-secondary transition-colors hover:bg-surface-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus disabled:cursor-not-allowed disabled:opacity-50"
            >
              Zoom out
            </button>
            <button
              type="button"
              onClick={() => setZoom((current) => Math.min(MAX_ZOOM, current + ZOOM_STEP))}
              disabled={zoom >= MAX_ZOOM}
              className="min-h-control-sm rounded-control px-2 font-medium text-secondary transition-colors hover:bg-surface-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus disabled:cursor-not-allowed disabled:opacity-50"
            >
              Zoom in
            </button>
            <button
              type="button"
              onClick={() => pan(-PAN_STEP, 0)}
              className="min-h-control-sm rounded-control px-2 font-medium text-secondary transition-colors hover:bg-surface-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus"
            >
              Pan left
            </button>
            <button
              type="button"
              onClick={() => pan(PAN_STEP, 0)}
              className="min-h-control-sm rounded-control px-2 font-medium text-secondary transition-colors hover:bg-surface-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus"
            >
              Pan right
            </button>
            <button
              type="button"
              onClick={() => pan(0, -PAN_STEP)}
              className="min-h-control-sm rounded-control px-2 font-medium text-secondary transition-colors hover:bg-surface-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus"
            >
              Pan up
            </button>
            <button
              type="button"
              onClick={() => pan(0, PAN_STEP)}
              className="min-h-control-sm rounded-control px-2 font-medium text-secondary transition-colors hover:bg-surface-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus"
            >
              Pan down
            </button>
            <button
              type="button"
              onClick={resetView}
              className="min-h-control-sm rounded-control px-2 font-medium text-secondary transition-colors hover:bg-surface-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus"
            >
              Reset view
            </button>
          </div>
        </div>
      </div>
    </Modal>
  )
}
