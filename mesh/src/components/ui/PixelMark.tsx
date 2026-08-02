export type PixelMarkVariant = 'brand' | 'community' | 'profile'

const COMMUNITY_PIXEL_COLORS = [
  'var(--avatar-violet)',
  'var(--avatar-emerald)',
  'var(--avatar-yellow)',
  'var(--avatar-red)',
  'var(--avatar-cyan)',
] as const

export function pixelColorForSeed(seed: string): string {
  const index = Array.from(seed).reduce(
    (total, character) => (total + (character.codePointAt(0) ?? 0)) % COMMUNITY_PIXEL_COLORS.length,
    0,
  )
  return COMMUNITY_PIXEL_COLORS[index] ?? COMMUNITY_PIXEL_COLORS[0]
}

export function PixelMark({
  variant,
  className,
}: {
  variant: PixelMarkVariant
  className?: string
}) {
  return (
    <span
      aria-hidden="true"
      className={`mesh-pixel-mark mesh-pixel-mark-${variant} ${className ?? ''}`}
    />
  )
}
