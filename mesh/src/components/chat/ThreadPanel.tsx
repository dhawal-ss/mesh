import type { RoomTrustSnapshot } from '../../hooks/useRoomTrust'
import type { Message } from '../../types/ipc'
import { Icon } from '../ui/Icon'
import { MessageComponent } from './Message'

interface ThreadPanelProps {
  title: string
  root: Message | null
  replies: Message[]
  surface?: 'channel' | 'dm'
  trust?: RoomTrustSnapshot
  onReply: (root: Message, target?: Message) => void
  onClose: () => void
}

export function ThreadPanel({
  title,
  root,
  replies,
  surface = 'channel',
  trust,
  onReply,
  onClose,
}: ThreadPanelProps) {
  return (
    <aside
      id="mesh-thread-panel"
      className="mesh-secondary-pane flex min-h-0 flex-shrink-0 flex-col overflow-hidden border-l border-border-subtle bg-surface-base"
      aria-label={`Thread in ${title}`}
      tabIndex={-1}
    >
      <div className="flex h-conversation-header flex-shrink-0 items-center gap-3 border-b border-border-subtle bg-surface-raised px-4">
        <Icon name="reply" size="sm" className="text-accent" />
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-sm font-semibold text-primary">Thread</h2>
          <p className="truncate text-caption text-muted">{title}</p>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="flex min-h-10 min-w-10 items-center justify-center rounded-control text-muted hover:bg-surface-hover hover:text-primary"
          aria-label="Close thread"
        >
          <Icon name="x" size="sm" />
        </button>
      </div>

      {root ? (
        <>
          <div className="m-3 overflow-hidden rounded-panel border border-border-subtle bg-surface-raised py-2">
            <MessageComponent
              message={root}
              isGrouped={false}
              surface={surface}
              disableMotion
              limitedActions
              trust={trust}
              onReply={() => onReply(root)}
            />
          </div>
          <div className="flex min-h-10 flex-shrink-0 items-center justify-between border-y border-border-subtle bg-surface-sunken px-4 text-caption text-muted">
            <span>{replies.length} {replies.length === 1 ? 'reply' : 'replies'}</span>
            <button
              type="button"
              onClick={() => onReply(root)}
              className="min-h-8 rounded-control px-2 font-semibold text-text-link hover:bg-surface-hover"
            >
              Reply in thread
            </button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto py-3" aria-label="Thread replies">
            {replies.length > 0 ? replies.map((reply) => (
              <MessageComponent
                key={reply.id}
                message={reply}
                isGrouped={false}
                surface={surface}
                disableMotion
                limitedActions
                trust={trust}
                onReply={() => onReply(root, reply)}
              />
            )) : (
              <div className="px-4 py-8 text-center">
                <p className="text-sm font-medium text-primary">No replies yet</p>
                <p className="mt-1 text-caption leading-5 text-muted">
                  Keep the side quest here without splitting the main conversation.
                </p>
              </div>
            )}
          </div>
        </>
      ) : (
        <div className="flex flex-1 items-center justify-center px-6 text-center">
          <div>
            <p className="text-sm font-medium text-primary">Thread unavailable</p>
            <p className="mt-1 text-caption leading-5 text-muted">
              Load more history to bring this thread back into view.
            </p>
          </div>
        </div>
      )}
    </aside>
  )
}
