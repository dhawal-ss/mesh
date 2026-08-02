import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { pixelColorForSeed } from './PixelMark'

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
    expect(css).toContain('clip-path: inset(100% 0 0 0)')
    expect(css).toContain('animation: mesh-pixel-reveal 1320ms steps(8, end) infinite')
    expect(css).toContain('button:focus-visible .mesh-pixel-avatar-default .mesh-pixel-mark')
    expect(css).toContain('animation: none !important')
  })
})
