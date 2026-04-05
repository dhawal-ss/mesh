interface AvatarProps {
  color: string
  size?: number
  name?: string
  className?: string
}

export function Avatar({ color, size = 32, name, className }: AvatarProps) {
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
      className={`flex items-center justify-center rounded-full flex-shrink-0 no-select ${className ?? ''}`}
      style={{
        width: size,
        height: size,
        backgroundColor: color,
        fontSize: size * 0.35,
        lineHeight: 1,
        color: '#0a0a0a',
        fontWeight: 600,
      }}
    >
      {initials}
    </div>
  )
}
