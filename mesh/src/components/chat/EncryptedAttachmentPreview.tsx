import { useEffect, useRef, useState } from 'react'

import type { AttachmentThumbnail } from '../../types/ipc'
import * as bridge from '../../lib/bridge'

type PreviewState =
  | { status: 'idle' | 'loading' | 'failed'; url: null; attempt: number }
  | { status: 'ready'; url: string; attempt: number }

export function EncryptedAttachmentPreview({
  filename,
  roomId,
  eventId,
  attachmentIndex,
  thumbnail,
  onOpen,
}: {
  filename: string
  roomId: string
  eventId: string
  attachmentIndex: number
  thumbnail: AttachmentThumbnail
  onOpen?: () => void
}) {
  const previewRef = useRef<HTMLDivElement>(null)
  const objectUrlRef = useRef<string | null>(null)
  const [preview, setPreview] = useState<PreviewState>({
    status: 'idle',
    url: null,
    attempt: 0,
  })
  const thumbnailHash = thumbnail.fileHash

  useEffect(() => {
    const target = previewRef.current
    if (!target || preview.status !== 'idle') return

    let active = true
    const requestPreview = () => {
      if (!active) return
      setPreview((current) => (
        current.status === 'idle'
          ? { status: 'loading', url: null, attempt: current.attempt }
          : current
      ))
    }
    if (typeof IntersectionObserver === 'undefined') return

    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return
      observer.disconnect()
      requestPreview()
    }, { rootMargin: '160px 0px' })
    observer.observe(target)
    return () => {
      active = false
      observer.disconnect()
    }
  }, [preview.status])

  useEffect(() => {
    if (preview.status !== 'loading') return

    let active = true
    let objectUrl: string | null = null
    let committed = false
    void bridge
      .matrixLoadAttachmentThumbnail(roomId, eventId, attachmentIndex)
      .then((bytes) => {
        if (!active) return
        if (!bytes?.byteLength) {
          setPreview((current) => ({
            status: 'failed',
            url: null,
            attempt: current.attempt,
          }))
          return
        }
        objectUrl = URL.createObjectURL(new Blob([bytes], { type: 'image/png' }))
        objectUrlRef.current = objectUrl
        committed = true
        setPreview((current) => ({
          status: 'ready',
          url: objectUrl as string,
          attempt: current.attempt,
        }))
      })
      .catch(() => {
        if (!active) return
        setPreview((current) => ({
          status: 'failed',
          url: null,
          attempt: current.attempt,
        }))
      })

    return () => {
      active = false
      if (objectUrl && !committed) URL.revokeObjectURL(objectUrl)
    }
  }, [attachmentIndex, eventId, preview.attempt, preview.status, roomId, thumbnailHash])

  useEffect(() => () => {
    if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current)
  }, [])

  const retry = () => {
    setPreview((current) => ({
      status: 'loading',
      url: null,
      attempt: current.attempt + 1,
    }))
  }

  const loadWithoutObserver = () => {
    setPreview((current) => ({
      status: 'loading',
      url: null,
      attempt: current.attempt,
    }))
  }

  return (
    <div
      ref={previewRef}
      className="relative flex w-full items-center justify-center overflow-hidden border-b border-border-subtle bg-bg-modifier-hover"
      data-design-token-exception="data-driven-thumbnail-aspect-ratio"
      style={{ aspectRatio: `${thumbnail.width} / ${thumbnail.height}` }}
      aria-live="polite"
    >
      {preview.status === 'ready' && (
        onOpen ? (
          <button
            type="button"
            onClick={onOpen}
            className="h-full w-full focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
            aria-label={`Open ${filename} full size`}
          >
            <img
              src={preview.url}
              alt={`Preview of ${filename}`}
              className="h-full max-h-80 w-full object-contain"
              loading="lazy"
              decoding="async"
              draggable={false}
              onError={() => {
                URL.revokeObjectURL(preview.url)
                objectUrlRef.current = null
                setPreview((current) => ({
                  status: 'failed',
                  url: null,
                  attempt: current.attempt,
                }))
              }}
            />
          </button>
        ) : (
          <img
            src={preview.url}
            alt={`Preview of ${filename}`}
            className="h-full max-h-80 w-full object-contain"
            loading="lazy"
            decoding="async"
            draggable={false}
            onError={() => {
              URL.revokeObjectURL(preview.url)
              objectUrlRef.current = null
              setPreview((current) => ({
                status: 'failed',
                url: null,
                attempt: current.attempt,
              }))
            }}
          />
        )
      )}
      {preview.status === 'loading' && (
        <span role="status" className="text-xs text-muted">
          Loading protected preview…
        </span>
      )}
      {preview.status === 'idle' && typeof IntersectionObserver === 'undefined' && (
        <button
          type="button"
          onClick={loadWithoutObserver}
          className="min-h-control-sm rounded px-3 text-xs font-medium text-secondary transition-colors hover:bg-bg-modifier-active focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
        >
          Load preview
        </button>
      )}
      {preview.status === 'failed' && (
        <button
          type="button"
          onClick={retry}
          className="min-h-control-sm rounded px-3 text-xs font-medium text-secondary transition-colors hover:bg-bg-modifier-active focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
        >
          Retry preview
        </button>
      )}
    </div>
  )
}
