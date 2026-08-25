import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useTypingStore } from './typing'

describe('typing store snapshots', () => {
  beforeEach(() => {
    useTypingStore.setState({ typingByChannel: {} })
    vi.spyOn(Date, 'now').mockReturnValue(1_000)
  })

  it('replaces the native typing snapshot and clears stopped users immediately', () => {
    const store = useTypingStore.getState()
    store.setTyping('!room:example.org', '@old:example.org', 'Old user')

    store.setTypingUsers('!room:example.org', [
      { author: '@alice:example.org', displayName: 'Alice' },
      { author: '@bob:example.org', displayName: 'Bob' },
    ])
    expect(useTypingStore.getState().getTypingUsers('!room:example.org')).toEqual([
      'Alice',
      'Bob',
    ])

    useTypingStore.getState().setTypingUsers('!room:example.org', [])
    expect(useTypingStore.getState().getTypingUsers('!room:example.org')).toEqual([])
  })
})
