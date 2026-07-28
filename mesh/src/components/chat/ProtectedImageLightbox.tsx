import { useEffect, useRef, useState } from 'react'

import type { AttachmentThumbnail } from '../../types/ipc'
import * as bridge from '../../lib/bridge'
import { Modal } from '../ui/Modal'

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
        const objectUrl = URL.createObjectURL(
          new Blob([result.bytes], { type: result.contentType }),
        )
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

  useEffect(() => {
    if (imageCount < 2) return
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'ArrowLeft') {
        event.preventDefault()
        onPrevious()
      } else if (event.key === 'ArrowRight') {
        event.preventDefault()
        onNext()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
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
    <Modal
      open
      onClose={onClose}
      title={filename}
      description="Protected image"
    >
      <div className="space-y-3">
        <div
          className="relative flex min-h-64 w-full items-center justify-center overflow-hidden rounded-control border border-border-subtle bg-bg-modifier-hover"
          data-design-token-exception="data-driven-thumbnail-aspect-ratio"
          style={viewStyle}
        >
          {image.status === 'loading' && (
            <span role="status" className="text-sm text-muted">
              Loading protected image…
            </span>
          )}
          {image.status === 'failed' && (
            <div className="flex flex-col items-center gap-2 text-center">
              <p role="alert" className="text-sm text-muted">
                The full image could not be loaded.
              </p>
              <button
                type="button"
                onClick={retry}
                className="min-h-control-sm rounded px-3 text-sm font-medium text-secondary transition-colors hover:bg-bg-modifier-active focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
              >
                Retry image
              </button>
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
              className="min-h-control-sm rounded px-2 font-medium text-secondary transition-colors hover:bg-surface-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-50"
            >
              Previous image
            </button>
            <span aria-live="polite">
              {imagePosition + 1} of {imageCount}
            </span>
            <button
              type="button"
              onClick={onNext}
              disabled={imageCount < 2}
              className="min-h-control-sm rounded px-2 font-medium text-secondary transition-colors hover:bg-surface-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-50"
            >
              Next image
            </button>
          </div>
          <div className="flex flex-wrap items-center gap-1">
            <button
              type="button"
              onClick={() =>
                setZoom((current) => Math.max(MIN_ZOOM, current - ZOOM_STEP))
              }
              disabled={zoom <= MIN_ZOOM}
              className="min-h-control-sm rounded px-2 font-medium text-secondary transition-colors hover:bg-surface-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-50"
            >
              Zoom out
            </button>
            <button
              type="button"
              onClick={() =>
                setZoom((current) => Math.min(MAX_ZOOM, current + ZOOM_STEP))
              }
              disabled={zoom >= MAX_ZOOM}
              className="min-h-control-sm rounded px-2 font-medium text-secondary transition-colors hover:bg-surface-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-50"
            >
              Zoom in
            </button>
            <button
              type="button"
              onClick={() => pan(-PAN_STEP, 0)}
              className="min-h-control-sm rounded px-2 font-medium text-secondary transition-colors hover:bg-surface-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
            >
              Pan left
            </button>
            <button
              type="button"
              onClick={() => pan(PAN_STEP, 0)}
              className="min-h-control-sm rounded px-2 font-medium text-secondary transition-colors hover:bg-surface-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
            >
              Pan right
            </button>
            <button
              type="button"
              onClick={() => pan(0, -PAN_STEP)}
              className="min-h-control-sm rounded px-2 font-medium text-secondary transition-colors hover:bg-surface-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
            >
              Pan up
            </button>
            <button
              type="button"
              onClick={() => pan(0, PAN_STEP)}
              className="min-h-control-sm rounded px-2 font-medium text-secondary transition-colors hover:bg-surface-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
            >
              Pan down
            </button>
            <button
              type="button"
              onClick={resetView}
              className="min-h-control-sm rounded px-2 font-medium text-secondary transition-colors hover:bg-surface-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
            >
              Reset view
            </button>
          </div>
        </div>
      </div>
    </Modal>
  )
}
