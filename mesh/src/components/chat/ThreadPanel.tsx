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
      className="mesh-secondary-pane flex min-h-0 flex-shrink-0 flex-col overflow-hidden border-l border-outline-variant bg-surface"
      aria-label={`Thread in ${title}`}
      tabIndex={-1}
    >
      <div className="flex h-conversation-header flex-shrink-0 items-center gap-3 border-b border-outline-variant bg-surface-container px-4">
        <Icon name="reply" size="sm" className="text-primary" />
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-body-md font-semibold text-on-surface">Thread</h2>
          <p className="truncate text-label-sm text-on-surface-variant">{title}</p>
        </div>
        {root?.id.startsWith('$') && (
          <button
            type="button"
            onClick={() => {
              void copyText(matrixEventPermalink(root.channelId, root.id))
                .then(() => showToast('Thread link copied.', 'success'))
                .catch(() => showToast('Could not copy this thread link.', 'error'))
            }}
            className="flex min-h-10 min-w-10 items-center justify-center rounded-full text-on-surface-variant hover:bg-state-hover hover:text-on-surface"
            aria-label="Copy thread link"
          >
            <Icon name="messageCircle" size="sm" />
          </button>
        )}
        <button
          type="button"
          onClick={onClose}
          className="flex min-h-10 min-w-10 items-center justify-center rounded-full text-on-surface-variant hover:bg-state-hover hover:text-on-surface"
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
            className={`m-3 overflow-hidden rounded-xl border border-outline-variant py-2 ${
              highlightedMessageId === root.id ? 'bg-surface-container-high' : 'bg-surface-container'
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
          <div className="flex min-h-10 flex-shrink-0 items-center justify-between border-y border-outline-variant bg-surface-container-lowest px-4 text-label-sm text-on-surface-variant">
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
                <> &middot; Unread counts unavailable</>
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
              className="min-h-8 rounded-full px-2 font-semibold text-primary hover:bg-state-hover"
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
                className={highlightedMessageId === reply.id ? 'bg-surface-container-high' : undefined}
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
                {/* The instruction, without the feature describing itself to
                    somebody who has already opened it. */}
                <p className="text-body-md font-medium text-on-surface">Reply to start this thread</p>
              </div>
            )}
          </div>
        </>
      ) : (
        <div className="flex flex-1 items-center justify-center px-6 text-center">
          <div>
            <p className="text-body-md font-medium text-on-surface">
              {loadState === 'loading'
                ? 'Loading thread'
                : loadState === 'failed'
                  ? 'Could not load this thread'
                  : 'Thread unavailable'}
            </p>
            {loadState === 'failed' && (
              <p className="mt-1 text-label-sm text-on-surface-variant">Check your connection.</p>
            )}
            {loadState === 'failed' && onRetry && (
              <button
                type="button"
                onClick={onRetry}
                className="mt-3 min-h-8 rounded-full px-2 font-semibold text-primary hover:bg-state-hover"
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
