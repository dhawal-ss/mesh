import clsx from 'clsx'

interface SkeletonProps {
  className?: string
  width?: string | number
  height?: string | number
  shape?: 'block' | 'avatar' | 'circle'
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
        'animate-pulse bg-surface-active',
        shape === 'avatar'
          ? 'rounded-control'
          : shape === 'circle'
            ? 'rounded-full'
            : 'rounded',
        className
      )}
      style={{ width, height }}
    />
  )
}

export function MessageSkeleton() {
  return (
    <div className="flex gap-3 px-4 py-2">
      <Skeleton width={40} height={40} shape="avatar" />
      <div className="flex-1 space-y-2">
        <div className="flex items-center gap-2">
          <Skeleton width={120} height={14} />
          <Skeleton width={60} height={10} />
        </div>
        <Skeleton width="80%" height={14} />
        <Skeleton width="60%" height={14} />
      </div>
    </div>
  )
}

export function ChannelListSkeleton() {
  const widths = [96, 124, 88, 112, 136, 104, 120, 92]
  return (
    <div className="space-y-1 px-2">
      {Array.from({ length: 8 }).map((_, i) => (
        <div key={i} className="flex items-center gap-2 px-2 py-1.5">
          <Skeleton width={16} height={16} />
          <Skeleton width={widths[i]} height={14} />
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
          <Skeleton width={32} height={32} shape="avatar" />
          <Skeleton width={widths[i]} height={14} />
        </div>
      ))}
    </div>
  )
}
