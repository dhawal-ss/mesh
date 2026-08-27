import type { Clip } from '../../lib/room-shape'
import { EncryptedAttachmentPreview } from './EncryptedAttachmentPreview'
import { EmptyState } from '../ui/Primitives'
import { Icon } from '../ui/Icon'
import { MessageTime } from './MessageTime'

/**
 * A room read as a gallery rather than a transcript.
 *
 * The same messages, the same permissions, the same composer. What changes is
 * what the surface promises: in a room people use for screenshots and art, the
 * picture is the content and the words around it are the caption. Reactions are
 * the conversation, so they are shown; replies stay one click away in the
 * conversation itself, which is where a thread belongs.
 */
export function ClipsView({
  roomId,
  channelName,
  clips,
  onOpenClip,
}: {
  roomId: string
  channelName: string
  clips: readonly Clip[]
  /** Opens the clip's own message back in the conversation surface. */
  onOpenClip: (messageId: string) => void
}) {
  if (clips.length === 0) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center p-6">
        <EmptyState
          className="w-full max-w-2xl"
          eyebrow={`#${channelName}`}
          markSeed={roomId}
          title="No clips yet"
          description="Post a screenshot or an image here."
        />
      </div>
    )
  }

  return (
    <div
      className="mesh-clips-grid min-h-0 flex-1 overflow-y-auto p-4"
      aria-label={`Clips in #${channelName}`}
    >
      {clips.map((clip) => (
        <figure key={clip.id} data-clip-id={clip.id} className="mesh-clip-tile min-w-0">
          <button
            type="button"
            onClick={() => onOpenClip(clip.id)}
            aria-label={`Open the message ${clip.authorDisplayName} posted in #${channelName}`}
            className="block w-full overflow-hidden rounded-full border border-outline-variant bg-surface-container-lowest text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus"
          >
            {clip.attachments[0]?.thumbnail ? (
              <EncryptedAttachmentPreview
                filename={clip.attachments[0].filename}
                roomId={roomId}
                eventId={clip.id}
                attachmentIndex={0}
                thumbnail={clip.attachments[0].thumbnail}
                contentType={clip.attachments[0].contentType}
                sourceBytes={clip.attachments[0].size}
              />
            ) : (
              /*
                No thumbnail means the sender's client never made one, so there
                is nothing to decrypt and nothing to show. The tile still names
                the file rather than leaving a hole in the grid.
              */
              <span className="flex items-center gap-2 px-3 py-6 text-body-md text-on-surface-variant">
                <Icon name="image" size="sm" />
                <span className="min-w-0 truncate">{clip.attachments[0]?.filename}</span>
              </span>
            )}
          </button>

          <figcaption className="mesh-clip-meta flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1 pt-2">
            <span className="min-w-0 truncate text-body-md font-medium text-on-surface">
              {clip.authorDisplayName}
            </span>
            <MessageTime value={clip.timestamp} className="text-body-sm text-on-surface-variant" />
            {clip.attachments.length > 1 && (
              <span className="text-body-sm text-on-surface-variant">
                {clip.attachments.length} images
              </span>
            )}
            {clip.reactionCount > 0 && (
              <span
                data-clip-reactions
                className="text-body-sm text-primary"
              >
                {clip.reactionCount} {clip.reactionCount === 1 ? 'reaction' : 'reactions'}
              </span>
            )}
          </figcaption>

          {clip.caption.trim() && (
            <p data-clip-caption className="mesh-clip-caption pt-1 text-body-md text-on-surface-variant">
              {clip.caption}
            </p>
          )}
        </figure>
      ))}
    </div>
  )
}
