import { describe, expect, it } from 'vitest'
import { hasAuthoritativeSavedRoomSnapshot } from './AppLayout'

describe('saved room restoration authority', () => {
  it.each(['idle', 'loading', 'refreshing', 'failed'] as const)(
    'keeps a saved DM pending while its source is %s',
    (status) => {
      expect(hasAuthoritativeSavedRoomSnapshot('dm', status)).toBe(false)
    },
  )

  it('accepts absence only from a loaded DM snapshot', () => {
    expect(hasAuthoritativeSavedRoomSnapshot('dm', 'loaded')).toBe(true)
  })

  it.each(['idle', 'loading', 'stale', 'failed', undefined] as const)(
    'keeps a saved room pending while its source is %s',
    (status) => {
      expect(hasAuthoritativeSavedRoomSnapshot('room', 'loaded', status)).toBe(false)
    },
  )

  it('accepts absence only from a loaded room snapshot', () => {
    expect(hasAuthoritativeSavedRoomSnapshot('room', 'failed', 'loaded')).toBe(true)
  })
})
