export type SequenceCardPosition = 'single' | 'first' | 'middle' | 'last'

export function sequenceCardPosition(
  index: number,
  total: number,
): SequenceCardPosition {
  if (total <= 1) return 'single'
  if (index <= 0) return 'first'
  if (index >= total - 1) return 'last'
  return 'middle'
}

export function sequenceCardPositionFromNeighbors(
  hasPrevious: boolean,
  hasNext: boolean,
): SequenceCardPosition {
  if (!hasPrevious && !hasNext) return 'single'
  if (!hasPrevious) return 'first'
  if (!hasNext) return 'last'
  return 'middle'
}

export function sequenceCardProps(position: SequenceCardPosition) {
  return {
    className: 'sequence-card',
    'data-sequence-position': position,
  } as const
}
