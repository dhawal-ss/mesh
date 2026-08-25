import { useState } from 'react'
import { useResolvedAvatarImage } from '../../store/matrix-avatars'
import { PixelMark, type PixelMarkVariant } from './PixelMark'

interface AvatarProps {
  color: string
  size?: number
  name?: string
  className?: string
  /**
   * Any image source, including a raw Matrix `mxc://` URI straight off a DTO.
   *
   * Resolution happens here rather than at each call site because the call
   * sites are what got this wrong: an MXC URI in an `img src` is refused by the
   * content security policy and lands in the error handler below, which is
   * indistinguishable from "no picture set". Every reader of an `avatarUrl`
   * field passed one through, so every avatar in Mesh was a generated mark. One
   * resolution point means a new caller cannot reintroduce that.
   */
  imageUrl?: string | null
  variant?: Exclude<PixelMarkVariant, 'brand'>
  /**
   * The identity this avatar stands for: a user id, room id, or community id.
   *
   * Without it the generated mark falls back to the variant's shared glyph,
   * which is what made every image-less person in a room look identical. Pass
   * it wherever the caller knows who this is.
   */
  seed?: string
}

export function Avatar({
  color,
  size = 32,
  name,
  className,
  imageUrl: requestedImageUrl,
  variant = 'profile',
  seed,
}: AvatarProps) {
  const imageUrl = useResolvedAvatarImage(requestedImageUrl)
  const [failedImageUrl, setFailedImageUrl] = useState<string | null>(null)
  const showImage = Boolean(imageUrl) && failedImageUrl !== imageUrl

  return (
    <div
      /*
        Shape is meaning, so it is decided here rather than by whoever happens
        to render the avatar. A person is a circle; a community is a plane and
        stays square. This used to be inverted: the default was square, and the
        three call sites that wanted a person had to force it with
        `!rounded-full`, which meant every other person in the product was
        drawn as a tile.
      */
      className={`mesh-pixel-avatar no-select flex flex-shrink-0 items-center justify-center overflow-hidden ${variant === 'community' ? 'rounded-panel' : 'rounded-round'} bg-surface-sunken ${showImage ? '' : 'mesh-pixel-avatar-default'} ${className ?? ''}`}
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
        <PixelMark variant={variant} seed={seed} className="h-full w-full" />
      )}
    </div>
  )
}
