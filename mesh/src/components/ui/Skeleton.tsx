import clsx from 'clsx'

interface SkeletonProps {
  className?: string
  width?: string | number
  height?: string | number
  rounded?: boolean
}

export function Skeleton({ className, width, height, rounded = false }: SkeletonProps) {
  return (
    <div
      className={clsx(
        'animate-pulse bg-bg-tertiary',
        rounded ? 'rounded-full' : 'rounded',
        className
      )}
      style={{ width, height }}
    />
  )
}

export function MessageSkeleton() {
  return (
    <div className="flex gap-3 px-4 py-2">
      <Skeleton width={40} height={40} rounded />
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
  return (
    <div className="space-y-1 px-2">
      {Array.from({ length: 8 }).map((_, i) => (
        <div key={i} className="flex items-center gap-2 px-2 py-1.5">
          <Skeleton width={16} height={16} />
          <Skeleton width={80 + Math.random() * 60} height={14} />
        </div>
      ))}
    </div>
  )
}

export function MemberListSkeleton() {
  return (
    <div className="space-y-1 px-2">
      {Array.from({ length: 6 }).map((_, i) => (
        <div key={i} className="flex items-center gap-2 px-2 py-1.5">
          <Skeleton width={32} height={32} rounded />
          <Skeleton width={60 + Math.random() * 40} height={14} />
        </div>
      ))}
    </div>
  )
}
