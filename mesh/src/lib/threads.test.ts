import { describe, expect, it } from 'vitest'
import { groupThreadReplies } from './threads'

describe('groupThreadReplies', () => {
  it('keeps thread replies under a loaded root and preserves their order', () => {
    const result = groupThreadReplies([
      { id: '$root' },
      { id: '$other' },
      { id: '$reply-1', threadRootId: '$root' },
      { id: '$reply-2', threadRootId: '$root' },
    ])

    expect(result.visibleMessages.map((message) => message.id)).toEqual(['$root', '$other'])
    expect(result.repliesByRoot.get('$root')?.map((message) => message.id)).toEqual([
      '$reply-1',
      '$reply-2',
    ])
  })

  it('keeps a reply visible when the bounded window does not contain its root', () => {
    const result = groupThreadReplies([
      { id: '$reply', threadRootId: '$outside-window' },
    ])

    expect(result.visibleMessages.map((message) => message.id)).toEqual(['$reply'])
    expect(result.repliesByRoot.get('$outside-window')?.[0].id).toBe('$reply')
  })
})
