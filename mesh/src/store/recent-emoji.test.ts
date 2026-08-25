import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { rememberEmoji } from './recent-emoji'

const RECENTS_KEY = 'mesh:emoji:recent'
const stored = () => JSON.parse(window.localStorage.getItem(RECENTS_KEY) ?? '[]') as string[]

describe('recent-emoji store', () => {
  beforeEach(() => window.localStorage.clear())
  afterEach(() => window.localStorage.clear())

  it('keeps the most recent first, deduped', () => {
    rememberEmoji('👍')
    rememberEmoji('❤️')
    rememberEmoji('👍')
    expect(stored()).toEqual(['👍', '❤️'])
  })

  it('remembers custom emoji shortcodes alongside unicode glyphs', () => {
    rememberEmoji('👍')
    rememberEmoji(':party_parrot:')
    expect(stored()).toEqual([':party_parrot:', '👍'])
  })

  it('caps the history at 24 entries', () => {
    for (let index = 0; index < 30; index += 1) rememberEmoji(`:e${index}:`)
    expect(stored()).toHaveLength(24)
    expect(stored()[0]).toBe(':e29:')
  })
})
