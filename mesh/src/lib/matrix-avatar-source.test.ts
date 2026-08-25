import { describe, expect, it } from 'vitest'

import {
  admitAvatar,
  isMxcUri,
  MAX_CACHED_AVATARS,
  touchAvatar,
} from './matrix-avatar-source'

describe('isMxcUri', () => {
  it('recognizes an MXC URI', () => {
    expect(isMxcUri('mxc://example.org/abc123')).toBe(true)
  })

  it('leaves every source a caller could already render alone', () => {
    // These are what existing callers pass: a bundled asset path, an object URL
    // the caller made itself, and an inline image. Rewriting any of them would
    // change what a working call site renders.
    expect(isMxcUri('/assets/lantern-guild.png')).toBe(false)
    expect(isMxcUri('blob:http://localhost/abc')).toBe(false)
    expect(isMxcUri('data:image/png;base64,AAAA')).toBe(false)
    expect(isMxcUri(null)).toBe(false)
    expect(isMxcUri(undefined)).toBe(false)
    expect(isMxcUri('')).toBe(false)
  })

  it('does not treat an MXC mention inside another URL as an MXC URI', () => {
    expect(isMxcUri('https://example.org/redirect?to=mxc://evil/1')).toBe(false)
  })
})

describe('admitAvatar', () => {
  it('puts the newest entry first', () => {
    const { recency, evicted } = admitAvatar(['b', 'c'], 'a', 8)
    expect(recency).toEqual(['a', 'b', 'c'])
    expect(evicted).toEqual([])
  })

  it('promotes rather than duplicates an entry it already holds', () => {
    const { recency, evicted } = admitAvatar(['a', 'b', 'c'], 'c', 8)
    expect(recency).toEqual(['c', 'a', 'b'])
    expect(evicted).toEqual([])
  })

  it('reports the least recently used entries once the cap is passed', () => {
    const { recency, evicted } = admitAvatar(['b', 'c', 'd'], 'a', 3)
    expect(recency).toEqual(['a', 'b', 'c'])
    expect(evicted).toEqual(['d'])
  })

  it('holds a member page and the surfaces beside it at the same time', () => {
    // matrix_list_members pages at 100, and that page is not alone on screen:
    // the timeline behind it has its own authors, and the community rail,
    // direct message list and voice rows have theirs.
    expect(MAX_CACHED_AVATARS).toBeGreaterThan(200)
  })

  it('evicts everything when the cache is disabled', () => {
    const { recency, evicted } = admitAvatar(['b'], 'a', 0)
    expect(recency).toEqual([])
    expect(evicted).toEqual(['a', 'b'])
  })

  it('keeps a picture that is on screen instead of the cap taking it', () => {
    // 'd' is the oldest entry, so the cap would take it next, but something is
    // showing it. Evicting it would revoke the object URL that element is using
    // and leave a generated mark in its place.
    const { recency, evicted } = admitAvatar(['b', 'c', 'd'], 'a', 3, new Set(['d']))
    expect(recency).toEqual(['a', 'b', 'c', 'd'])
    expect(evicted).toEqual([])
  })

  it('still ages out the oldest entry nothing is showing', () => {
    const { recency, evicted } = admitAvatar(['b', 'c', 'd'], 'a', 2, new Set(['d']))
    expect(recency).toEqual(['a', 'b', 'd'])
    expect(evicted).toEqual(['c'])
  })

  it('goes over the cap rather than blank a screen that is over it by itself', () => {
    const onScreen = ['b', 'c', 'd']
    const { recency, evicted } = admitAvatar(onScreen, 'a', 1, new Set(onScreen))
    expect(recency).toEqual(['a', 'b', 'c', 'd'])
    expect(evicted).toEqual([])
  })
})

describe('touchAvatar', () => {
  it('promotes an entry it holds', () => {
    expect(touchAvatar(['a', 'b', 'c'], 'c')).toEqual(['c', 'a', 'b'])
  })

  it('returns the same order when the entry is already newest', () => {
    const recency = ['a', 'b']
    expect(touchAvatar(recency, 'a')).toBe(recency)
  })

  it('does not admit an entry the cache does not hold', () => {
    // Admission is admitAvatar's job, and it is the only one that can report an
    // eviction. Adding a key here would grow the cache past its cap unrevoked.
    expect(touchAvatar(['a'], 'b')).toEqual(['a'])
  })
})
