import { describe, expect, it } from 'vitest'
import { fuzzySearchScore } from './InteractivePrimitives'

describe('fuzzySearchScore', () => {
  it('prefers exact and contiguous matches', () => {
    expect(fuzzySearchScore('General', 'gen')).toBeLessThan(
      fuzzySearchScore('Game Engine', 'gen') ?? Number.POSITIVE_INFINITY,
    )
  })

  it('matches ordered non-contiguous characters', () => {
    expect(fuzzySearchScore('Create server', 'crsv')).not.toBeNull()
    expect(fuzzySearchScore('Create server', 'vrc')).toBeNull()
  })

  it('is case-insensitive and rejects missing characters', () => {
    expect(fuzzySearchScore('Direct Messages', 'dm')).not.toBeNull()
    expect(fuzzySearchScore('Direct Messages', 'xyz')).toBeNull()
  })
})
