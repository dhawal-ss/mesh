import { describe, expect, it } from 'vitest'
import {
  hasAuthoritativeSavedRoomSnapshot,
  hasSentConversationMessage,
} from './AppLayout'

describe('first-session recovery reminder readiness', () => {
  it('waits when a new account has joined but has not sent a message', () => {
    expect(hasSentConversationMessage('@taylor:example.org', false, false)).toBe(false)
  })

  // Which messages count is now decided where a message is admitted: the
  // message and direct-message stores each raise `hasAuthoredMessage` only for
  // a message this account authored that did not fail to send.
  it('starts after an authored room message', () => {
    expect(hasSentConversationMessage('@taylor:example.org', true, false)).toBe(true)
  })

  it('starts after an authored direct message', () => {
    expect(hasSentConversationMessage('@taylor:example.org', false, true)).toBe(true)
  })

  it.each([undefined, null, ''] as const)(
    'stays closed with no signed-in account (%p)',
    (accountId) => {
      expect(hasSentConversationMessage(accountId, true, true)).toBe(false)
    },
  )
})

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
