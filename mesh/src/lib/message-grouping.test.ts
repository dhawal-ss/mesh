import { describe, expect, it } from 'vitest'

import { shouldGroupMessage, type GroupableMessage } from './message-grouping'

function message(patch: Partial<GroupableMessage> = {}): GroupableMessage {
  return {
    authorPublicKey: '@alice:example.org',
    timestamp: '2026-07-30T12:00:00.000Z',
    ...patch,
  }
}

describe('shouldGroupMessage', () => {
  it('groups consecutive same-author messages within five minutes', () => {
    expect(shouldGroupMessage(
      message({ timestamp: '2026-07-30T12:04:59.000Z' }),
      message(),
    )).toBe(true)
  })

  it('starts a new group for replies, delivery boundaries, and a new day', () => {
    expect(shouldGroupMessage(message({ replyToId: '$root' }), message())).toBe(false)
    expect(shouldGroupMessage(message(), message({ deliveryStatus: 'failed' }))).toBe(false)
    expect(shouldGroupMessage(
      message({ timestamp: '2026-07-31T05:01:00.000Z' }),
      message({ timestamp: '2026-07-31T04:59:00.000Z' }),
    )).toBe(false)
  })
})
