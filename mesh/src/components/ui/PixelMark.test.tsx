import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  PIXEL_MARK_FORMS,
  pixelColorForSeed,
  pixelFillForSeed,
  pixelMaskForSeed,
} from './PixelMark'

describe('pixelColorForSeed', () => {
  it('returns a stable design-token color for the same identity', () => {
    expect(pixelColorForSeed('!lantern:mesh.test')).toBe(
      pixelColorForSeed('!lantern:mesh.test'),
    )
    expect(pixelColorForSeed('!lantern:mesh.test')).toMatch(/^var\(--avatar-/)
  })

  it('reveals default marks from top to bottom on hover and keyboard focus', () => {
    const css = readFileSync(resolve(process.cwd(), 'src/styles/globals.css'), 'utf8')

    expect(css).toContain('@keyframes mesh-pixel-reveal')
    expect(css).toContain('clip-path: inset(0 0 100% 0)')
    expect(css).toContain('clip-path: inset(0)')
    expect(css).toContain('animation: mesh-pixel-reveal var(--motion-dur-fast) steps(8, end) 1')
    expect(css).toContain('button:focus-visible .mesh-pixel-avatar-default .mesh-pixel-mark')
    expect(css).toContain('animation: none !important')
  })
})

describe('pixelMaskForSeed', () => {
  it('gives the same identity the same form every time', () => {
    expect(pixelMaskForSeed('!lantern:mesh.test')).toBe(pixelMaskForSeed('!lantern:mesh.test'))
  })

  it('draws from the whole vocabulary rather than one shared glyph', () => {
    const seeds = Array.from({ length: 200 }, (_, index) => `!room-${index}:mesh.test`)
    const forms = new Set(seeds.map(pixelMaskForSeed))

    expect(forms.size).toBe(PIXEL_MARK_FORMS.length)
  })

  /*
   * The reason the vocabulary exists. High contrast flattens every avatar token
   * to white, so colour cannot separate two identities there. Form is the only
   * channel that survives, which means two identities must differ in form often
   * enough to be worth reading.
   */
  it('separates most identities by form alone, which is what high contrast has left', () => {
    const seeds = Array.from({ length: 8 }, (_, index) => `!rail-${index}:mesh.test`)
    const forms = new Set(seeds.map(pixelMaskForSeed))

    expect(forms.size).toBeGreaterThan(5)
  })

  it('uses every avatar token, not the five it used to', () => {
    const seeds = Array.from({ length: 300 }, (_, index) => `!c-${index}:mesh.test`)
    const colors = new Set(seeds.map(pixelColorForSeed))

    expect(colors.size).toBeGreaterThan(5)
  })

  it('varies form independently of colour, so the pair identifies more than either', () => {
    const seeds = Array.from({ length: 300 }, (_, index) => `!p-${index}:mesh.test`)
    const pairs = new Set(seeds.map((seed) => `${pixelMaskForSeed(seed)}|${pixelColorForSeed(seed)}`))

    expect(pairs.size).toBeGreaterThan(60)
  })
})

describe('pixelFillForSeed', () => {
  const room = [
    '@maya:mesh.test', '@rohan:mesh.test', '@ari:mesh.test',
    '@devon:mesh.test', '@kira:mesh.test', '@pixelpanda:mesh.test',
    '@sam:mesh.test', '@taylor:mesh.test', '@zoe:mesh.test',
  ]

  it('gives the same identity the same fill every time', () => {
    expect(pixelFillForSeed('@maya:mesh.test')).toBe(pixelFillForSeed('@maya:mesh.test'))
  })

  it('uses both fills rather than settling on one', () => {
    const fills = new Set(room.map(pixelFillForSeed))

    expect(fills).toEqual(new Set(['solid', 'hollow']))
  })

  /*
   * The whole point of the second channel. Form alone left two pairs of people
   * in this room sharing a silhouette, and in high contrast, where colour is
   * gone, a shared silhouette is a shared identity.
   */
  it('separates a whole room without any help from colour', () => {
    const marks = new Set(room.map((seed) => `${pixelMaskForSeed(seed)}|${pixelFillForSeed(seed)}`))

    expect(marks.size).toBe(room.length)
  })

  it('varies fill independently of form', () => {
    const seeds = Array.from({ length: 200 }, (_, index) => `!x-${index}:mesh.test`)
    const solidForms = new Set(
      seeds.filter((seed) => pixelFillForSeed(seed) === 'solid').map(pixelMaskForSeed),
    )

    expect(solidForms.size).toBeGreaterThan(10)
  })

  it('draws the hollow variant by subtracting an inset copy of the same mask', () => {
    const css = readFileSync(resolve(process.cwd(), 'src/styles/globals.css'), 'utf8')

    expect(css).toContain('.mesh-pixel-mark-hollow')
    expect(css).toContain('mask-composite: exclude')
    expect(css).toContain('-webkit-mask-composite: xor')
  })
})
