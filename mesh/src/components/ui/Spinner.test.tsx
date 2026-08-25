import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const globals = readFileSync(resolve('src/styles/globals.css'), 'utf8')

describe('Spinner motion language', () => {
  /*
   * The pixel marks already arrive in eight discrete steps. A loader that
   * sweeps smoothly is the one piece of motion in the product that could
   * belong to any application, so it advances on the same cadence.
   */
  it('advances the loader in discrete steps rather than a smooth sweep', () => {
    expect(globals).toContain('.mesh-spinner-glyph')
    expect(globals).toContain('animation-timing-function: steps(8, end)')
  })

  it('keeps the bounded three-step tick for reduced motion', () => {
    expect(globals).toContain('.mesh-spinner-steps')
    expect(globals).toContain('@keyframes mesh-progress-step')
  })
})
