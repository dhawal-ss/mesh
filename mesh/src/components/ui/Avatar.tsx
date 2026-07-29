interface AvatarProps {
  color: string
  size?: number
  name?: string
  className?: string
  imageUrl?: string | null
}

export function Avatar({ color, size = 32, name, className, imageUrl }: AvatarProps) {
  const initials = name
    ? name
        .split(' ')
        .map((w) => w[0])
        .join('')
        .slice(0, 2)
        .toUpperCase()
    : ''

  return (
    <div
      className={`no-select flex flex-shrink-0 items-center justify-center overflow-hidden rounded-control font-semibold text-content-on-avatar ${className ?? ''}`}
      style={{
        width: size,
        height: size,
        backgroundColor: color,
        fontSize: size * 0.35,
        lineHeight: 1,
      }}
      aria-label={name || undefined}
    >
      {imageUrl ? (
        <img src={imageUrl} alt="" className="h-full w-full object-cover" />
      ) : initials}
    </div>
  )
}
