import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { RoomTrustSnapshot } from '../../hooks/useRoomTrust'
import { formatFederatedTimestamp } from '../../lib/federated-time'
import { copyText, matrixEventPermalink } from '../../lib/notifications'
import type { Message } from '../../types/ipc'
import type { MatrixThreadContextStatus } from '../../hooks/useMatrixThreadContext'
import { Icon } from '../ui/Icon'
import { showToast } from '../ui/Toast'
import { MessageComponent } from './Message'

interface ThreadPanelProps {
  title: string
  root: Message | null
  replies: Message[]
  surface?: 'channel' | 'dm'
  trust?: RoomTrustSnapshot
  onReply: (root: Message, target?: Message) => void
  onClose: () => void
  onMarkRead?: (rootEventId: string, eventId: string) => Promise<void>
  targetMessageId?: string
  targetRequestId?: number
  onNavigationComplete?: (requestId: number) => void
  loadState?: MatrixThreadContextStatus
  unreadCount?: number
  unreadMentions?: number
  unreadStateAvailable?: boolean
  hasMore?: boolean
  onRetry?: () => void
}

export function ThreadPanel({
  title,
  root,
  replies,
  surface = 'channel',
  trust,
  onReply,
  onClose,
  onMarkRead,
  targetMessageId,
  targetRequestId,
  onNavigationComplete,
  loadState = 'ready',
  unreadCount = 0,
  unreadMentions = 0,
  unreadStateAvailable = false,
  hasMore = false,
  onRetry,
}: ThreadPanelProps) {
  const panelRef = useRef<HTMLElement>(null)
  const markedReadKeyRef = useRef<string | null>(null)
  const highlightTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined)
  const [highlightedMessageId, setHighlightedMessageId] = useState<string | null>(null)
  const latestReply = replies[replies.length - 1] ?? null
  const latestReceiptReply = useMemo(
    () => [...replies].reverse().find((reply) => (
      reply.id.startsWith('$')
      && reply.deliveryStatus !== 'pending'
      && reply.deliveryStatus !== 'failed'
    )) ?? null,
    [replies],
  )

  useEffect(() => {
    if (loadState === 'loading' || !root || !latestReceiptReply || !onMarkRead) return
    const key = `${root.id}:${latestReceiptReply.id}`
    if (markedReadKeyRef.current === key) return
    markedReadKeyRef.current = key
    void onMarkRead(root.id, latestReceiptReply.id).catch((error) => {
      if (markedReadKeyRef.current === key) markedReadKeyRef.current = null
      console.error('Could not mark the thread as read:', error)
    })
  }, [latestReceiptReply, loadState, onMarkRead, root])

  useLayoutEffect(() => {
    if (!targetMessageId || targetRequestId == null) return
    const target = [...panelRef.current?.querySelectorAll<HTMLElement>('[data-thread-message-id]') ?? []]
      .find((candidate) => candidate.dataset.threadMessageId === targetMessageId)
    if (!target) return
    target.scrollIntoView({ block: 'center' })
    target.tabIndex = -1
    target.focus({ preventScroll: true })
    setHighlightedMessageId(targetMessageId)
    clearTimeout(highlightTimerRef.current)
    highlightTimerRef.current = setTimeout(() => setHighlightedMessageId(null), 2_000)
    onNavigationComplete?.(targetRequestId)
  }, [onNavigationComplete, replies, root, targetMessageId, targetRequestId])

  useEffect(() => () => clearTimeout(highlightTimerRef.current), [])

  return (
    <aside
      ref={panelRef}
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
        {root?.id.startsWith('$') && (
          <button
            type="button"
            onClick={() => {
              void copyText(matrixEventPermalink(root.channelId, root.id))
                .then(() => showToast('Thread link copied.', 'success'))
                .catch(() => showToast('Could not copy this thread link.', 'error'))
            }}
            className="flex min-h-10 min-w-10 items-center justify-center rounded-control text-muted hover:bg-surface-hover hover:text-primary"
            aria-label="Copy thread link"
          >
            <Icon name="messageCircle" size="sm" />
          </button>
        )}
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
          <div
            data-thread-message-id={root.id}
            aria-current={highlightedMessageId === root.id ? 'true' : undefined}
            className={`m-3 overflow-hidden rounded-panel border border-border-subtle py-2 ${
              highlightedMessageId === root.id ? 'bg-surface-hover' : 'bg-surface-raised'
            }`}
          >
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
            <span>
              {replies.length} {replies.length === 1 ? 'reply' : 'replies'}
              {latestReply && (
                <> &middot; Last reply {formatFederatedTimestamp(latestReply.timestamp, 'MMM d, HH:mm')}</>
              )}
              {unreadStateAvailable && unreadCount > 0 && (
                <> &middot; {unreadCount} unread</>
              )}
              {unreadStateAvailable && unreadMentions > 0 && (
                <> &middot; {unreadMentions} {unreadMentions === 1 ? 'mention' : 'mentions'}</>
              )}
              {!unreadStateAvailable && loadState === 'ready' && (
                <> &middot; Unread sync off</>
              )}
              {hasMore && (
                <> &middot; Latest {replies.length} shown</>
              )}
              {loadState === 'loading' && (
                <> &middot; Refreshing</>
              )}
            </span>
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
              <div
                key={reply.id}
                data-thread-message-id={reply.id}
                aria-current={highlightedMessageId === reply.id ? 'true' : undefined}
                className={highlightedMessageId === reply.id ? 'bg-surface-hover' : undefined}
              >
                <MessageComponent
                  message={reply}
                  isGrouped={false}
                  surface={surface}
                  disableMotion
                  limitedActions
                  trust={trust}
                  onReply={() => onReply(root, reply)}
                />
              </div>
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
            <p className="text-sm font-medium text-primary">
              {loadState === 'loading'
                ? 'Loading thread'
                : loadState === 'failed'
                  ? 'Could not load this thread'
                  : 'Thread unavailable'}
            </p>
            <p className="mt-1 text-caption leading-5 text-muted">
              {loadState === 'loading'
                ? 'Bringing the first message and its replies into view.'
                : loadState === 'failed'
                  ? 'Check your connection and try again.'
                  : 'This thread may no longer be available on the service.'}
            </p>
            {loadState === 'failed' && onRetry && (
              <button
                type="button"
                onClick={onRetry}
                className="mt-3 min-h-8 rounded-control px-2 font-semibold text-text-link hover:bg-surface-hover"
              >
                Try again
              </button>
            )}
          </div>
        </div>
      )}
    </aside>
  )
}
