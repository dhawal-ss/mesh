import clsx from 'clsx'

interface SkeletonProps {
  className?: string
  width?: string | number
  height?: string | number
  shape?: 'block' | 'avatar' | 'circle' | 'plane'
}

export function Skeleton({
  className,
  width,
  height,
  shape = 'block',
}: SkeletonProps) {
  return (
    <div
      className={clsx(
        'mesh-skeleton animate-pulse bg-surface-container-high',
        // The skeleton must match the shape of the thing being loaded, or a
        // person visibly changes shape the moment their image resolves.
        shape === 'avatar' || shape === 'circle'
          ? 'rounded-round'
          // A row and a selection pill are pills while they load, exactly as
          // they are once they resolve.
          : shape === 'plane'
            ? 'rounded-full'
            : 'rounded',
        className
      )}
      style={{ width, height }}
    />
  )
}

/*
 * Loading must resemble the thing being loaded. Every measurement here mirrors
 * the real bubble in chat/Message.tsx: the same 40px mark in flow, the same
 * one-line metadata above it, the same 62% column cap, the same 4px block
 * padding and the same 12px group gap. Anything else produces two visible
 * reflows on the most-used transition in the app.
 */
const MESSAGE_BODY_WIDTHS = ['92%', '74%', '61%', '85%', '68%'] as const

export function MessageSkeleton({
  grouped = false,
  index = 0,
}: {
  grouped?: boolean
  index?: number
}) {
  const bodyWidth = MESSAGE_BODY_WIDTHS[index % MESSAGE_BODY_WIDTHS.length]
  return (
    <div
      aria-hidden="true"
      data-grouped={grouped ? 'true' : undefined}
      className={clsx(
        'mesh-message-row mesh-message-row-skeleton relative flex min-w-0 max-w-full gap-2 px-5 py-shell-message-y',
        !grouped && 'mt-message-group',
      )}
    >
      <div className="mesh-message-content flex min-w-0 flex-1 gap-2">
        <span className="mesh-message-avatar flex-none">
          {!grouped && <Skeleton width={40} height={40} shape="avatar" />}
        </span>
        <div className="mesh-message-column flex min-w-0 flex-col">
          {!grouped && (
            <div className="mb-1 flex items-center gap-2">
              <Skeleton width={index % 2 === 0 ? 104 : 132} height={11} />
            </div>
          )}
          <div className="mesh-message-bubble min-w-0">
            <Skeleton width={bodyWidth} height={16} />
            {!grouped && index % 3 === 0 && (
              <Skeleton className="mt-1" width="47%" height={16} />
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

/**
 * The realistic shape of a room: an author row, then one or two grouped
 * follow-ups, repeating. Prefer this over mapping `MessageSkeleton` so the
 * placeholder stack has the same rhythm as real conversation.
 */
export function MessageListSkeleton({ count = 6, label = 'Loading messages' }: {
  count?: number
  label?: string
}) {
  return (
    <div role="status" aria-label={label} className="mesh-message-log-skeleton">
      {Array.from({ length: count }).map((_, index) => (
        <MessageSkeleton key={index} index={index} grouped={index % 3 !== 0} />
      ))}
    </div>
  )
}

export function ChannelListSkeleton() {
  const widths = [96, 124, 88, 112, 136, 104, 120, 92]
  return (
    <div role="status" aria-label="Loading rooms" className="space-y-px">
      {Array.from({ length: 8 }).map((_, i) => (
        <div
          key={i}
          aria-hidden="true"
          className="mesh-channel-item flex items-center gap-1.5 px-2 py-density-row"
        >
          <Skeleton width={16} height={16} />
          <Skeleton width={widths[i]} height={13} />
        </div>
      ))}
    </div>
  )
}

export function MemberListSkeleton() {
  const widths = [72, 84, 68, 92, 76, 88]
  return (
    <div className="space-y-1 px-2">
      {Array.from({ length: 6 }).map((_, i) => (
        <div key={i} className="flex items-center gap-2 px-2 py-1.5">
          <Skeleton width={26} height={26} shape="avatar" />
          <Skeleton width={widths[i]} height={14} />
        </div>
      ))}
    </div>
  )
}
