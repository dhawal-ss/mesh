import { useEffect, useId, useState, type ReactNode } from 'react'

import type { AttachmentThumbnail } from '../../types/ipc'
import * as bridge from '../../lib/bridge'
import { useSettingsStore } from '../../store/settings'
import { Icon } from '../ui/Icon'
import { Skeleton } from '../ui/Skeleton'

/*
  Inline previews for received encrypted images.

  The bytes come from `matrixLoadAttachmentImage`, the same Rust command the
  full-size viewer uses: it resolves the encrypted file, enforces the declared
  image type, decrypts under a byte budget, and hands back validated bytes.
  `matrixLoadAttachmentThumbnail` is still a stub that returns null without
  touching IPC, so there is no separate thumbnail path to call; a preview is a
  bounded rendering of the full image, not a second decrypt route.

  Three limits keep that honest. Only the types Rust will decrypt are attempted
  (`image/jpeg`, `image/png`, `image/webp`), anything larger than
  MAX_AUTOLOAD_BYTES waits for a deliberate tap, and at most
  MAX_MATERIALIZED_PREVIEWS object URLs exist across the whole timeline at once.
*/

/** Exactly the set `MatrixBackend::thumbnail_image_format` will decode. */
const PREVIEWABLE_CONTENT_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp'])

/**
 * Larger images load on request. Rust serializes protected image loads behind a
 * one-permit semaphore, so an auto-loading timeline of large files would queue
 * behind itself and each row would spend its IPC deadline waiting.
 */
const MAX_AUTOLOAD_BYTES = 4 * 1024 * 1024

/**
 * Live object URLs, across every mounted row. The timeline is virtualized, so
 * unmount already revokes; this is the second bound, for the case where enough
 * image rows are mounted at once to hold a lot of decrypted bytes in memory.
 */
const MAX_MATERIALIZED_PREVIEWS = 8

/** Renderer-side gate so a scroll burst cannot open dozens of 60s IPC calls. */
const MAX_CONCURRENT_PREVIEW_LOADS = 2

/**
 * Widest and narrowest frame a preview may claim. Clamping the ratio (rather
 * than the height alone) keeps the skeleton the same shape as the loaded image,
 * so nothing below it moves when the bytes arrive.
 */
const MIN_ASPECT_RATIO = 0.6
const MAX_ASPECT_RATIO = 2.5

interface LivePreview {
  url: string
  /** Tells the owning row it no longer has a materialized preview. */
  release: () => void
}

/*
  Insertion-ordered, so the first key is the oldest materialized preview.
  Entries are deleted before their URL is revoked, which makes a double revoke
  impossible: whichever of eviction, unmount, or image error runs first is the
  only one that sees the entry.
*/
const livePreviews = new Map<string, LivePreview>()

function retainPreview(id: string, url: string, release: () => void): void {
  releasePreview(id)
  livePreviews.set(id, { url, release })
  while (livePreviews.size > MAX_MATERIALIZED_PREVIEWS) {
    const oldestId: string | undefined = livePreviews.keys().next().value
    if (oldestId === undefined) break
    const evicted = livePreviews.get(oldestId)
    livePreviews.delete(oldestId)
    if (!evicted) continue
    URL.revokeObjectURL(evicted.url)
    evicted.release()
  }
}

function releasePreview(id: string): void {
  const entry = livePreviews.get(id)
  if (!entry) return
  livePreviews.delete(id)
  URL.revokeObjectURL(entry.url)
}

let activePreviewLoads = 0
const waitingPreviewLoads: Array<() => void> = []

function acquirePreviewSlot(): Promise<void> {
  if (activePreviewLoads < MAX_CONCURRENT_PREVIEW_LOADS) {
    activePreviewLoads += 1
    return Promise.resolve()
  }
  return new Promise<void>((resolve) => {
    waitingPreviewLoads.push(() => {
      activePreviewLoads += 1
      resolve()
    })
  })
}

function releasePreviewSlot(): void {
  activePreviewLoads = Math.max(0, activePreviewLoads - 1)
  waitingPreviewLoads.shift()?.()
}

/**
 * Frontend contract for a preference that does not exist in the settings store
 * yet: `showInlineImagePreviews`, a device-local boolean alongside
 * `signalCheckEnabled`. Absent means on, so the default is previews, and the
 * moment the field lands the toggle works with no change here.
 */
interface InlinePreviewSetting {
  showInlineImagePreviews?: boolean
}

function readInlinePreviewSetting(state: unknown): boolean {
  return (state as InlinePreviewSetting).showInlineImagePreviews !== false
}

function clampAspectRatio(width: number, height: number): number {
  if (!(width > 0) || !(height > 0)) return 16 / 9
  return Math.min(MAX_ASPECT_RATIO, Math.max(MIN_ASPECT_RATIO, width / height))
}

/** Shared by the two notices that offer a load, so the strings live once. */
const NOTICE_BUTTON_CLASS =
  'inline-flex min-h-control-sm items-center gap-1.5 rounded-full bg-surface-container-highest px-2 font-medium text-on-surface transition-colors hover:bg-surface-container-high focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus'

type PreviewPhase = 'loading' | 'ready' | 'failed'
/** Why a preview is waiting for a tap instead of loading on its own. */
type HeldReason = 'size' | 'released'

export function EncryptedAttachmentPreview({
  filename,
  roomId,
  eventId,
  attachmentIndex,
  thumbnail,
  contentType,
  sourceBytes = 0,
  onOpen,
}: {
  filename: string
  roomId: string
  eventId: string
  attachmentIndex: number
  thumbnail: AttachmentThumbnail
  /** The attachment's own media type, not the thumbnail's. */
  contentType?: string | null
  /** The attachment's own size in bytes, used for the auto-load budget. */
  sourceBytes?: number
  onOpen?: () => void
}) {
  const previewId = useId()
  const previewsEnabled = useSettingsStore(readInlinePreviewSetting)
  const previewable = PREVIEWABLE_CONTENT_TYPES.has((contentType ?? '').trim().toLowerCase())
  const [held, setHeld] = useState<HeldReason | null>(
    sourceBytes > MAX_AUTOLOAD_BYTES ? 'size' : null,
  )
  const [attempt, setAttempt] = useState(0)
  const [phase, setPhase] = useState<PreviewPhase>('loading')
  const [url, setUrl] = useState<string | null>(null)

  const wantsImage = previewsEnabled && previewable && held === null

  useEffect(() => {
    /*
      Clearing the URL here is what makes turning the preference off, or being
      evicted, safe: the state that renders <img> is dropped in the same pass
      that revokes the blob, so a revoked URL is never handed back to the DOM.
    */
    setUrl(null)
    setPhase('loading')
    if (!wantsImage) return

    let cancelled = false
    let slotHeld = false
    void (async () => {
      await acquirePreviewSlot()
      slotHeld = true
      if (cancelled) {
        releasePreviewSlot()
        slotHeld = false
        return
      }
      try {
        const image = await bridge.matrixLoadAttachmentImage(roomId, eventId, attachmentIndex)
        if (cancelled) return
        if (!image) {
          setPhase('failed')
          return
        }
        const objectUrl = URL.createObjectURL(new Blob([image.bytes], { type: image.contentType }))
        if (cancelled) {
          URL.revokeObjectURL(objectUrl)
          return
        }
        retainPreview(previewId, objectUrl, () => setHeld('released'))
        setUrl(objectUrl)
        setPhase('ready')
      } catch {
        if (!cancelled) setPhase('failed')
      } finally {
        if (slotHeld) {
          releasePreviewSlot()
          slotHeld = false
        }
      }
    })()

    return () => {
      cancelled = true
      // Covers unmount (virtualized scroll), attachment change, and preference
      // change. A no-op when this row was already evicted.
      releasePreview(previewId)
    }
  }, [attachmentIndex, attempt, eventId, previewId, roomId, wantsImage])

  const frameStyle = { aspectRatio: `${clampAspectRatio(thumbnail.width, thumbnail.height)}` }

  const showPreview = () => {
    setHeld(null)
    setAttempt((current) => current + 1)
  }

  /*
    No `role="status"` anywhere in this component: the implicit aria-live it
    carries is not suppressed by the timeline's aria-live="off", and because the
    timeline is virtualized every scroll pass re-inserts these nodes and would
    re-announce them once per attachment.
  */
  if (!previewsEnabled || !previewable) {
    return (
      <PreviewNotice style={frameStyle}>
        <span className="inline-flex items-center gap-1.5 font-medium text-on-surface">
          <Icon name="shieldCheck" size="xs" />
          Preview stays protected
        </span>
        <span>Save the file to open it.</span>
      </PreviewNotice>
    )
  }

  if (held !== null) {
    return (
      <PreviewNotice style={frameStyle}>
        <span>
          {held === 'size'
            ? 'This image is large, so it loads only when you ask.'
            : 'This preview was released while you scrolled.'}
        </span>
        <button
          type="button"
          onClick={showPreview}
          aria-label={`Show preview of ${filename}`}
          className={NOTICE_BUTTON_CLASS}
        >
          <Icon name="image" size="xs" aria-hidden="true" />
          Show preview
        </button>
      </PreviewNotice>
    )
  }

  if (phase === 'failed') {
    return (
      <PreviewNotice style={frameStyle}>
        <span className="inline-flex items-center gap-1.5 font-medium text-error">
          <Icon name="triangleAlert" size="xs" aria-hidden="true" />
          Preview could not be opened
        </span>
        <span>Download the file instead.</span>
        <button
          type="button"
          onClick={() => setAttempt((current) => current + 1)}
          aria-label={`Try the preview of ${filename} again`}
          className={NOTICE_BUTTON_CLASS}
        >
          Try again
        </button>
      </PreviewNotice>
    )
  }

  if (phase !== 'ready' || url === null) {
    return (
      <PreviewFrame style={frameStyle}>
        {/* Same shape as the loaded image, so nothing below it moves. */}
        <Skeleton className="h-full w-full" />
      </PreviewFrame>
    )
  }

  const image = (
    <img
      src={url}
      alt={`Preview of ${filename}`}
      draggable={false}
      className="h-full w-full select-none object-contain"
      onError={() => {
        releasePreview(previewId)
        setUrl(null)
        setPhase('failed')
      }}
    />
  )

  return (
    <PreviewFrame style={frameStyle}>
      {onOpen ? (
        <button
          type="button"
          onClick={onOpen}
          aria-label={`Open ${filename} at full size`}
          className="flex h-full w-full items-center justify-center transition-opacity duration-fast hover:opacity-90 focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus"
        >
          {image}
        </button>
      ) : (
        image
      )}
    </PreviewFrame>
  )
}

function PreviewNotice({
  children,
  style,
}: {
  children: ReactNode
  style: { aspectRatio: string }
}) {
  return (
    <PreviewFrame style={style}>
      <div className="flex max-w-sm flex-col items-center gap-2 px-4 text-center text-body-sm text-on-surface-variant">
        {children}
      </div>
    </PreviewFrame>
  )
}

function PreviewFrame({
  children,
  style,
}: {
  children: ReactNode
  style: { aspectRatio: string }
}) {
  return (
    <div
      className="relative flex max-h-shell-media w-full items-center justify-center overflow-hidden border-b border-outline-variant bg-surface-container-high"
      data-design-token-exception="data-driven-thumbnail-aspect-ratio"
      data-protected-preview="true"
      style={style}
    >
      {children}
    </div>
  )
}
