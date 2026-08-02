import { useState } from 'react'
import { PixelMark, type PixelMarkVariant } from './PixelMark'

interface AvatarProps {
  color: string
  size?: number
  name?: string
  className?: string
  imageUrl?: string | null
  variant?: Exclude<PixelMarkVariant, 'brand'>
}

export function Avatar({
  color,
  size = 32,
  name,
  className,
  imageUrl,
  variant = 'profile',
}: AvatarProps) {
  const [failedImageUrl, setFailedImageUrl] = useState<string | null>(null)
  const showImage = Boolean(imageUrl) && failedImageUrl !== imageUrl

  return (
    <div
      className={`mesh-pixel-avatar no-select flex flex-shrink-0 items-center justify-center overflow-hidden rounded-control bg-surface-sunken ${showImage ? '' : 'mesh-pixel-avatar-default'} ${className ?? ''}`}
      data-design-token-exception="Avatar color is member or community identity data."
      style={{
        width: size,
        height: size,
        color,
        lineHeight: 1,
      }}
      role={name ? 'img' : undefined}
      aria-label={name || undefined}
    >
      {showImage ? (
        <img
          src={imageUrl ?? undefined}
          alt=""
          className="h-full w-full object-cover"
          onError={() => setFailedImageUrl(imageUrl ?? null)}
        />
      ) : (
        <PixelMark variant={variant} className="h-full w-full" />
      )}
    </div>
  )
}
