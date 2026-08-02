import type { AttachmentThumbnail } from '../../types/ipc'
import { Icon } from '../ui/Icon'

export function EncryptedAttachmentPreview({
  thumbnail,
}: {
  filename: string
  roomId: string
  eventId: string
  attachmentIndex: number
  thumbnail: AttachmentThumbnail
  onOpen?: () => void
}) {
  return (
    <div
      className="relative flex w-full items-center justify-center overflow-hidden border-b border-border-subtle bg-surface-hover"
      data-design-token-exception="data-driven-thumbnail-aspect-ratio"
      style={{ aspectRatio: `${thumbnail.width} / ${thumbnail.height}` }}
      role="status"
    >
      <div className="flex max-w-sm flex-col items-center gap-2 px-4 text-center text-xs text-secondary">
        <span className="inline-flex items-center gap-1.5 font-medium text-primary">
          <Icon name="shieldCheck" size="xs" />
          Encrypted preview stays protected
        </span>
        <span>
          Save the file explicitly to inspect it. Mesh does not decrypt received thumbnails into
          the app interface.
        </span>
      </div>
    </div>
  )
}
