import bars from '../../assets/pixel/marks/bars.png'
import blocks from '../../assets/pixel/marks/blocks.png'
import burst from '../../assets/pixel/marks/burst.png'
import checker from '../../assets/pixel/marks/checker.png'
import chevron from '../../assets/pixel/marks/chevron.png'
import corners from '../../assets/pixel/marks/corners.png'
import frame from '../../assets/pixel/marks/frame.png'
import cross from '../../assets/pixel/marks/cross.png'
import diamond from '../../assets/pixel/marks/diamond.png'
import heart from '../../assets/pixel/marks/heart.png'
import ladder from '../../assets/pixel/marks/ladder.png'
import lattice from '../../assets/pixel/marks/lattice.png'
import lens from '../../assets/pixel/marks/lens.png'
import notch from '../../assets/pixel/marks/notch.png'
import pin from '../../assets/pixel/marks/pin.png'
import ring from '../../assets/pixel/marks/ring.png'
import spark from '../../assets/pixel/marks/spark.png'
import wave from '../../assets/pixel/marks/wave.png'

export type PixelMarkVariant = 'brand' | 'community' | 'profile'

/**
 * The form vocabulary.
 *
 * Identity used to be carried by tint alone over one shared glyph, which meant
 * the sixth community looked like the first, and in the high-contrast theme,
 * where every avatar token flattens to white, every identity in the rail was
 * the same silhouette. Form is the one channel a monochrome theme cannot take
 * away, so it carries identity first and colour second.
 */
export const PIXEL_MARK_FORMS = [
  diamond, cross, lattice, heart, burst, ring,
  chevron, bars, checker, lens, wave, pin,
  corners, ladder, blocks, frame, spark, notch,
] as const

const AVATAR_TOKENS = [
  'var(--avatar-sand)',
  'var(--avatar-blue)',
  'var(--avatar-green)',
  'var(--avatar-red)',
  'var(--avatar-violet)',
  'var(--avatar-orange)',
  'var(--avatar-pink)',
  'var(--avatar-emerald)',
  'var(--avatar-yellow)',
  'var(--avatar-cyan)',
] as const

/**
 * FNV-1a.
 *
 * The previous hash was a running `(total + codePoint) % length`, which is not
 * a hash: the modulus is applied every step, so the result is dominated by the
 * last few characters. Room ids share long prefixes and differ at the end, so
 * that was the worst possible shape for this input.
 */
function hashSeed(seed: string): number {
  let hash = 2_166_136_261
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index)
    hash = Math.imul(hash, 16_777_619)
  }
  return hash >>> 0
}

/**
 * Form and colour are read from different halves of the hash, so they vary
 * independently: 12 forms against 10 colours identify far more than either
 * could, and two identities that share a colour rarely share a shape.
 */
export function pixelMaskForSeed(seed: string): string {
  return PIXEL_MARK_FORMS[hashSeed(seed) % PIXEL_MARK_FORMS.length]
}

export function pixelColorForSeed(seed: string): string {
  return AVATAR_TOKENS[(hashSeed(seed) >>> 16) % AVATAR_TOKENS.length]
}

/**
 * Solid or outlined, from a third slice of the hash.
 *
 * This is the channel that finishes the job form started. High contrast takes
 * colour away, and 18 forms still left two pairs of people in a nine-person
 * room sharing a silhouette. Fill doubles the vocabulary to 36 and costs
 * nothing: the outline is the same mask with an inset copy subtracted, so no
 * second asset exists to download.
 */
export function pixelFillForSeed(seed: string): 'solid' | 'hollow' {
  return ((hashSeed(seed) >>> 8) & 1) === 1 ? 'hollow' : 'solid'
}

export function PixelMark({
  variant,
  className,
  seed,
}: {
  variant: PixelMarkVariant
  className?: string
  /**
   * Room, conversation, or community id. The same identity always produces the
   * same form and the same tint, and the pair is stable across devices because
   * it is derived from the id rather than stored anywhere.
   *
   * Without a seed the mark falls back to the variant's own glyph, which is
   * what the brand mark and the generic placeholders want.
   */
  seed?: string
}) {
  const hollow = seed ? pixelFillForSeed(seed) === 'hollow' : false

  return (
    <span
      aria-hidden="true"
      className={`mesh-pixel-mark mesh-pixel-mark-${variant} ${hollow ? 'mesh-pixel-mark-hollow' : ''} ${className ?? ''}`}
      style={seed
        ? {
            color: pixelColorForSeed(seed),
            '--mesh-pixel-mask': `url(${pixelMaskForSeed(seed)})`,
          } as React.CSSProperties
        : undefined}
    />
  )
}
