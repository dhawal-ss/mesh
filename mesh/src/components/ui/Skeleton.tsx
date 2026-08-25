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
        'mesh-skeleton animate-pulse bg-surface-active',
        // The avatar skeleton must match the avatar, or a person visibly
        // changes shape the moment their image resolves.
        shape === 'avatar' || shape === 'circle'
          ? 'rounded-round'
          // A structural mark is square while it loads, exactly as it is
          // once it resolves.
          : shape === 'plane'
            ? 'rounded-plane'
            : 'rounded',
        className
      )}
      style={{ width, height }}
    />
  )
}

/*
 * Loading must resemble the thing being loaded. Every measurement here mirrors
 * the real row in chat/Message.tsx: the same 64px gutter, the same 4px block
 * padding, the same absolutely positioned avatar column, the same 12px group
 * gap, and the same 65ch content measure. Anything else produces two visible
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
      className={clsx(
        'mesh-message-row-skeleton relative flex min-w-0 max-w-full gap-message-rail-gap px-shell-gutter py-shell-message-y',
        !grouped && 'mt-message-group',
      )}
    >
      {/*
        The same gutter a real row has: 44px of time, the 2px rail, a 20px gap,
        then a 26px mark in flow. A skeleton whose geometry differs from the row
        it stands in for makes every message visibly jump when it resolves,
        which is the one thing a loading state exists to avoid.
      */}
      <div className="flex w-message-time flex-none justify-end">
        <Skeleton width={34} height={11} />
      </div>
      <Skeleton
        className="self-stretch"
        width="var(--trust-rail-width)"
        height="100%"
        shape="plane"
      />
      <div className="mesh-message-content flex min-w-0 flex-1 gap-2">
        {!grouped && (
          <span className="flex-none">
            <Skeleton width={26} height={26} shape="avatar" />
          </span>
        )}
        <div className="min-w-0 flex-1">
          {!grouped && (
            <div className="flex items-center gap-2 py-0.5">
              <Skeleton width={index % 2 === 0 ? 104 : 132} height={14} />
            </div>
          )}
          <Skeleton className="my-0.5" width={bodyWidth} height={15} />
          {!grouped && index % 3 === 0 && (
            <Skeleton className="my-0.5" width="47%" height={15} />
          )}
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
