import { describe, expect, it } from 'vitest'
import {
  describeEverywhereSearchScope,
  describeSearchScope,
  formatRoomFilter,
  hasActiveFilters,
  isExcludedByQuery,
  parseSearchQuery,
  resolveRoomFilter,
  SEARCH_MESSAGES_PER_ROOM,
  toWireFilters,
  withoutRoomFilter,
} from './search-query'

const dayMs = (day: string) => Date.parse(`${day}T00:00:00Z`)

describe('parseSearchQuery', () => {
  it('splits plain text into independent terms when no operators are present', () => {
    expect(parseSearchQuery('launch notes')).toEqual({
      terms: ['launch', 'notes'],
      filters: {},
    })
  })

  it('extracts from: and leaves residual terms', () => {
    expect(parseSearchQuery('from:alice quarterly plan')).toEqual({
      terms: ['quarterly', 'plan'],
      filters: { from: 'alice' },
    })
  })

  it('accepts from:me and mentions:me sentinels', () => {
    expect(parseSearchQuery('from:me mentions:me hi').filters).toEqual({
      from: 'me',
      mentions: 'me',
    })
  })

  it('collects and de-duplicates known has: values, keeping unknown ones as text', () => {
    const parsed = parseSearchQuery('has:image has:image has:link has:frog report')
    expect(parsed.filters.has).toEqual(['image', 'link'])
    expect(parsed.terms).toEqual(['has:frog', 'report'])
  })

  it('parses before:/after: dates to UTC-midnight epoch ms', () => {
    const parsed = parseSearchQuery('after:2026-08-01 before:2026-08-10 vacation')
    expect(parsed.filters.afterMs).toBe(dayMs('2026-08-01'))
    expect(parsed.filters.beforeMs).toBe(dayMs('2026-08-10'))
    expect(parsed.terms).toEqual(['vacation'])
  })

  it('keeps an invalid date operator as a literal term', () => {
    const parsed = parseSearchQuery('before:someday meeting')
    expect(parsed.filters.beforeMs).toBeUndefined()
    expect(parsed.terms).toEqual(['before:someday', 'meeting'])
  })

  it('is case-insensitive on the operator key', () => {
    expect(parseSearchQuery('From:Bob').filters.from).toBe('Bob')
  })

  it('handles a fully mixed query', () => {
    const parsed = parseSearchQuery('from:alice has:image before:2026-08-02 design review')
    expect(parsed).toEqual({
      terms: ['design', 'review'],
      filters: {
        from: 'alice',
        has: ['image'],
        beforeMs: dayMs('2026-08-02'),
      },
    })
  })

  it('returns no terms and no filters for blank input', () => {
    expect(parseSearchQuery('   ')).toEqual({ terms: [], filters: {} })
  })

  it('parses in: with or without the room sigil and lowercases the value', () => {
    expect(parseSearchQuery('in:#General notes').filters.inRoom).toBe('general')
    expect(parseSearchQuery('in:playtest-notes').filters.inRoom).toBe('playtest-notes')
    expect(parseSearchQuery('IN:#general').filters.inRoom).toBe('general')
  })

  it('keeps a sigil-only in: operator as a literal term', () => {
    const parsed = parseSearchQuery('in:# hello')
    expect(parsed.filters.inRoom).toBeUndefined()
    expect(parsed.terms).toEqual(['in:#', 'hello'])
  })
})

describe('toWireFilters', () => {
  it('never sends the renderer-only room predicate to the native engine', () => {
    expect(toWireFilters(parseSearchQuery('in:#general from:alice art').filters)).toEqual({
      from: 'alice',
    })
  })

  it('carries every native predicate through unchanged', () => {
    const filters = parseSearchQuery('from:me mentions:me has:image after:2026-08-01 before:2026-08-10').filters
    expect(toWireFilters(filters)).toEqual(filters)
  })

  it('omits an empty has list', () => {
    expect(toWireFilters({ has: [] })).toEqual({})
  })
})

describe('resolveRoomFilter', () => {
  const rooms = [
    { id: '!general:example.org', name: 'general' },
    { id: '!notes:example.org', name: 'playtest-notes' },
    { id: '!general-2:example.org', name: 'general-planning' },
  ]

  it('prefers an exact room id, then an exact name', () => {
    expect(resolveRoomFilter('!notes:example.org', rooms)).toEqual(['!notes:example.org'])
    expect(resolveRoomFilter('general', rooms)).toEqual(['!general:example.org'])
  })

  it('falls back to every room whose name contains the value', () => {
    expect(resolveRoomFilter('notes', rooms)).toEqual(['!notes:example.org'])
    expect(resolveRoomFilter('plan', rooms)).toEqual(['!general-2:example.org'])
  })

  it('returns nothing when no room matches, so the caller can say so', () => {
    expect(resolveRoomFilter('archive', rooms)).toEqual([])
    expect(resolveRoomFilter('   ', rooms)).toEqual([])
  })
})

describe('describeSearchScope', () => {
  it('states the depth and the number of rooms', () => {
    expect(describeSearchScope({ rooms: 7, kind: 'community' })).toBe(
      `Searched the most recent ${SEARCH_MESSAGES_PER_ROOM} messages in each of 7 rooms.`,
    )
    expect(describeSearchScope({ rooms: 1, kind: 'community' })).toBe(
      `Searched the most recent ${SEARCH_MESSAGES_PER_ROOM} messages in 1 room.`,
    )
  })

  it('keeps the depth honest when the room count is unknown', () => {
    expect(describeSearchScope({ rooms: 0, kind: 'community' })).toBe(
      `Searched the most recent ${SEARCH_MESSAGES_PER_ROOM} messages in each room.`,
    )
  })

  it('says a direct conversation is one conversation', () => {
    expect(describeSearchScope({ rooms: 0, kind: 'conversation' })).toBe(
      `Searched the most recent ${SEARCH_MESSAGES_PER_ROOM} messages in this conversation.`,
    )
  })

  it('admits that a room filter narrows results the engine already returned', () => {
    expect(
      describeSearchScope({ rooms: 4, kind: 'community', roomFilter: formatRoomFilter('#General') }),
    ).toBe(
      `Filtered to #general after searching the most recent ${SEARCH_MESSAGES_PER_ROOM} messages in each of 4 rooms.`,
    )
  })
})

describe('describeEverywhereSearchScope', () => {
  it('states full coverage when every community was searched', () => {
    expect(describeEverywhereSearchScope({
      communitiesSearched: 3,
      communitiesTotal: 3,
      roomsSearched: 9,
      truncated: false,
    })).toBe(
      `Searched the most recent ${SEARCH_MESSAGES_PER_ROOM} messages in 9 rooms across all 3 communities.`,
    )
  })

  it('names a single community singularly', () => {
    expect(describeEverywhereSearchScope({
      communitiesSearched: 1,
      communitiesTotal: 1,
      roomsSearched: 1,
      truncated: false,
    })).toBe(
      `Searched the most recent ${SEARCH_MESSAGES_PER_ROOM} messages in 1 room across 1 community.`,
    )
  })

  it('reports partial coverage and the reason, when the deadline cut the walk short', () => {
    expect(describeEverywhereSearchScope({
      communitiesSearched: 2,
      communitiesTotal: 5,
      roomsSearched: 6,
      truncated: true,
    })).toBe(
      `Searched the most recent ${SEARCH_MESSAGES_PER_ROOM} messages in 6 rooms across 2 of 5 communities. `
      + 'The search deadline was reached first, so not every community was fully scanned.',
    )
  })
})

describe('hasActiveFilters', () => {
  it('is false for an empty filter set', () => {
    expect(hasActiveFilters({})).toBe(false)
    expect(hasActiveFilters({ has: [] })).toBe(false)
  })

  it('is true when any predicate is set', () => {
    expect(hasActiveFilters({ from: 'alice' })).toBe(true)
    expect(hasActiveFilters({ mentions: 'me' })).toBe(true)
    expect(hasActiveFilters({ afterMs: 1 })).toBe(true)
    expect(hasActiveFilters({ beforeMs: 1 })).toBe(true)
    expect(hasActiveFilters({ has: ['image'] })).toBe(true)
  })

  it('is false for a room filter alone, which the native engine cannot answer', () => {
    expect(hasActiveFilters({ inRoom: 'general' })).toBe(false)
  })
})

describe('quoted phrases and exclusions', () => {
  it('strips the quote characters instead of searching for them', () => {
    /*
      The native engine substring-matches, so leaving the quotes in the term
      searched for a body literally containing a double quote. That matches
      nothing, and it matches nothing silently: the query looks handled and the
      footer honestly reports what was searched, but the answer is wrong.
    */
    expect(parseSearchQuery('"release notes"').terms).toEqual(['release notes'])
  })

  it('keeps a quoted phrase as one exact-match term, distinct from surrounding words', () => {
    // Unquoted, "launch" and "release notes" would collapse into one required
    // substring and miss any message where they are not adjacent in that
    // exact order. Quoting keeps the phrase intact as its own AND-ed term.
    expect(parseSearchQuery('launch "release notes"').terms).toEqual(['launch', 'release notes'])
  })

  it('keeps a quoted operator as a literal term', () => {
    // The only way to search for text that would otherwise be read as syntax.
    const parsed = parseSearchQuery('"in:jokes"')
    expect(parsed.terms).toEqual(['in:jokes'])
    expect(parsed.filters.inRoom).toBeUndefined()
  })

  it('accepts a quoted operator value containing a space', () => {
    const parsed = parseSearchQuery('from:"Alice Smith" launch')
    expect(parsed.filters.from).toBe('Alice Smith')
    expect(parsed.terms).toEqual(['launch'])
  })

  it('treats an unterminated quote as closed at the end of input', () => {
    // Typing an opening quote must not make the rest of the query vanish.
    expect(parseSearchQuery('"release notes').terms).toEqual(['release notes'])
  })

  it('collects leading-hyphen terms as exclusions, not search terms', () => {
    const parsed = parseSearchQuery('deploy -staging -"dry run"')
    expect(parsed.terms).toEqual(['deploy'])
    expect(parsed.filters.excluded).toEqual(['staging', 'dry run'])
  })

  it('leaves an interior hyphen alone', () => {
    const parsed = parseSearchQuery('re-render')
    expect(parsed.terms).toEqual(['re-render'])
    expect(parsed.filters.excluded).toBeUndefined()
  })

  it('removes a result containing an excluded term, case-insensitively', () => {
    const { filters } = parseSearchQuery('deploy -Staging')
    expect(isExcludedByQuery('deploy to staging now', filters)).toBe(true)
    expect(isExcludedByQuery('deploy to production', filters)).toBe(false)
  })

  it('never sends the renderer-only predicates on the wire', () => {
    const { filters } = parseSearchQuery('in:#general -noise has:image')
    expect(toWireFilters(filters)).toEqual({ has: ['image'] })
  })
})

describe('withoutRoomFilter', () => {
  it('removes the room filter and leaves the rest of the query intact', () => {
    expect(withoutRoomFilter('in:jokes deploy notes')).toBe('deploy notes')
    expect(withoutRoomFilter('deploy in:jokes notes')).toBe('deploy notes')
    expect(withoutRoomFilter('from:maya in:jokes has:link')).toBe('from:maya has:link')
  })

  it('leaves a query that carries no room filter unchanged', () => {
    expect(withoutRoomFilter('deploy notes')).toBe('deploy notes')
  })

  it('keeps a quoted in: token, which is a search term rather than a filter', () => {
    expect(withoutRoomFilter('"in:jokes" deploy')).toBe('"in:jokes" deploy')
  })

  it('keeps a negated token and its minus', () => {
    expect(withoutRoomFilter('-draft in:jokes deploy')).toBe('-draft deploy')
  })
})
