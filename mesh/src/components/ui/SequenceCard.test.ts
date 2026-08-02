import { describe, expect, it } from 'vitest'
import {
  sequenceCardPosition,
  sequenceCardPositionFromNeighbors,
  sequenceCardProps,
} from './SequenceCard'

describe('SequenceCard utility', () => {
  it('labels every stable position without sibling selectors', () => {
    expect(sequenceCardPosition(0, 1)).toBe('single')
    expect(sequenceCardPosition(0, 4)).toBe('first')
    expect(sequenceCardPosition(1, 4)).toBe('middle')
    expect(sequenceCardPosition(3, 4)).toBe('last')
  })

  it('preserves virtualized group edges from the complete list', () => {
    expect(sequenceCardPositionFromNeighbors(false, true)).toBe('first')
    expect(sequenceCardPositionFromNeighbors(true, true)).toBe('middle')
    expect(sequenceCardPositionFromNeighbors(true, false)).toBe('last')
    expect(sequenceCardPositionFromNeighbors(false, false)).toBe('single')
  })

  it('provides state attributes without changing DOM semantics', () => {
    expect(sequenceCardProps('middle')).toEqual({
      className: 'sequence-card',
      'data-sequence-position': 'middle',
    })
  })
})
