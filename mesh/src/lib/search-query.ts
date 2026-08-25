/**
 * Operator-syntax parsing for the message search box.
 *
 * A query mixes free text with `key:value` operators, e.g.
 * `from:alice has:image before:2026-08-01 launch notes`. Operators are parsed
 * into a structured filter set that the native search engine applies alongside
 * the residual free text; anything that is not a recognised operator (or that
 * carries an invalid value) is kept as a literal search term so the user's
 * intent is never silently dropped.
 *
 * Free text becomes an array of terms rather than one joined string: each
 * unquoted word is its own term (the engine ANDs them, so they can match
 * anywhere in a result, in any order), while a quoted `"multi word"` token is
 * one term whose spaces must match exactly, which is what makes it a phrase
 * search rather than two more independent words.
 *
 * Wire shape mirrors the Rust `MessageSearchFilters` (camelCase); the engine
 * ANDs every active predicate with the term match. `inRoom` is the one
 * exception: the native engine has no room predicate yet, so that operator is
 * resolved in the renderer and stripped before the call.
 */

/**
 * How deep the native search reads into each room, mirroring
 * `MAX_SEARCH_EVENTS_PER_ROOM` in `src-tauri/src/backend/matrix.rs`. The engine
 * enumerates the rooms of the searched community, pulls this many of the most
 * recent messages from each, and substring-matches locally. Anything older is
 * not looked at, which is why the results footer states the depth out loud.
 */
export const SEARCH_MESSAGES_PER_ROOM = 250

export interface SearchFilters {
  /** Author display-name / user-id substring, or the literal `me`. */
  from?: string
  /** Inclusive lower bound, epoch ms. */
  afterMs?: number
  /** Exclusive upper bound, epoch ms. */
  beforeMs?: number
  /** Content-type requirements: any of `attachment`, `file`, `image`, `link`. */
  has?: string[]
  /** Mention user-id substring, or the literal `me`. */
  mentions?: string
  /**
   * Room name or room id the results are narrowed to, with any leading `#`
   * removed. Renderer-only: the native filters carry no room predicate, so this
   * is applied to the returned results and never sent on the wire.
   */
  inRoom?: string
  /**
   * Terms that must NOT appear in a result. Renderer-only for the same reason
   * as `inRoom`: the native engine has no exclusion predicate, and a query that
   * only excludes would ask it to return everything.
   */
  excluded?: string[]
}

/** The filter shape the native search actually understands. */
export type WireSearchFilters = Omit<SearchFilters, 'inRoom' | 'excluded'>

export interface ParsedSearchQuery {
  /**
   * Free-text terms with operators removed, in the order they were typed.
   * Each entry is ANDed by the native engine: an unquoted word matches
   * anywhere, a quoted phrase must match as one contiguous substring.
   */
  terms: string[]
  filters: SearchFilters
}

/** The minimum a room needs to expose to be matched by `in:`. */
export interface SearchScopeRoom {
  id: string
  name: string
}

const OPERATOR = /^(from|before|after|has|mentions|in):(.+)$/i
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/
const KNOWN_HAS = new Set(['attachment', 'file', 'image', 'link'])

interface QueryToken {
  value: string
  /**
   * The token opened with a double quote, so the whole of it is literal text
   * and is never read as an operator. A quote that appears later belongs to an
   * operator's value instead, which is what lets `from:"Alice Smith"` work.
   */
  quoted: boolean
  /** The token was prefixed with `-`, so matches containing it are removed. */
  negated: boolean
}

/**
 * Splits a query into tokens, honouring double quotes and a leading `-`.
 *
 * Splitting on whitespace alone left the quote characters inside the search
 * text, and the native engine substring-matches, so `"release notes"` searched
 * for a body literally containing a double quote. That returns nothing, and it
 * returns nothing silently: the query looks handled, the footer reports what was
 * searched, and the result is simply wrong. Quoting a phrase is also the only
 * way to search for text that would otherwise be read as an operator.
 */
export function tokenizeSearchQuery(input: string): QueryToken[] {
  const tokens: QueryToken[] = []
  let current = ''
  let inQuotes = false
  let openedWithQuote = false
  let started = false
  let negated = false

  const push = () => {
    if (current.length > 0) {
      tokens.push({ value: current, quoted: openedWithQuote, negated })
    }
    current = ''
    openedWithQuote = false
    started = false
    negated = false
  }

  for (const character of input) {
    if (character === '"') {
      if (!started) openedWithQuote = true
      inQuotes = !inQuotes
      started = true
      continue
    }
    if (!inQuotes && /\s/u.test(character)) {
      push()
      continue
    }
    // A `-` only negates at the very start of a token; inside a word it is an
    // ordinary hyphen, as in `re-render`.
    if (!inQuotes && character === '-' && !started) {
      negated = true
      started = true
      continue
    }
    started = true
    current += character
  }
  push()
  // An unterminated quote is treated as if it were closed at the end of input,
  // so typing an opening quote never makes the query behave as though the rest
  // of what was typed does not exist.
  return tokens.filter((token) => token.value.length > 0)
}

/** Parse a `YYYY-MM-DD` day into epoch ms at UTC midnight, or null if invalid. */
function dayToMs(value: string): number | null {
  if (!ISO_DATE.test(value)) return null
  const ms = Date.parse(`${value}T00:00:00Z`)
  return Number.isNaN(ms) ? null : ms
}

/**
 * The same query with any room filter removed.
 *
 * The no-match empty state told people to "drop the filter to search every
 * room" and gave them nothing to press, so the recovery it named could only be
 * carried out by editing the query by hand. Reconstructed from the tokenizer
 * rather than by string surgery, so a quoted `"in:jokes"` stays a search term
 * and a negated token keeps its minus.
 */
export function withoutRoomFilter(input: string): string {
  return tokenizeSearchQuery(input)
    .filter((token) => {
      if (token.quoted || token.negated) return true
      const match = OPERATOR.exec(token.value)
      return !(match && match[1].toLowerCase() === 'in')
    })
    .map((token) => {
      const prefix = token.negated ? '-' : ''
      return token.quoted ? `${prefix}"${token.value}"` : `${prefix}${token.value}`
    })
    .join(' ')
}

export function parseSearchQuery(input: string): ParsedSearchQuery {
  const filters: SearchFilters = {}
  const has: string[] = []
  const terms: string[] = []
  const excluded: string[] = []

  for (const token of tokenizeSearchQuery(input)) {
    if (token.negated) {
      // Applied to the results rather than sent on the wire, for the same
      // reason as `inRoom`: the native engine has no exclusion predicate, and
      // asking it to match "not this" would ask it to return everything.
      if (!excluded.includes(token.value)) excluded.push(token.value)
      continue
    }
    // A quoted token is literal text by definition, so it never turns into an
    // operator. This is what makes `"in:jokes"` searchable as a phrase.
    const match = token.quoted ? null : OPERATOR.exec(token.value)
    if (!match) {
      terms.push(token.value)
      continue
    }
    const key = match[1].toLowerCase()
    const value = match[2]

    if (key === 'from') {
      filters.from = value
    } else if (key === 'mentions') {
      filters.mentions = value
    } else if (key === 'in') {
      const room = normalizeRoomFilter(value)
      if (room) filters.inRoom = room
      else terms.push(token.value)
    } else if (key === 'has') {
      const normalized = value.toLowerCase()
      if (KNOWN_HAS.has(normalized)) {
        if (!has.includes(normalized)) has.push(normalized)
      } else {
        terms.push(token.value)
      }
    } else {
      // before / after
      const ms = dayToMs(value)
      if (ms == null) {
        terms.push(token.value)
      } else if (key === 'before') {
        filters.beforeMs = ms
      } else {
        filters.afterMs = ms
      }
    }
  }

  if (has.length > 0) filters.has = has
  if (excluded.length > 0) filters.excluded = excluded
  return { terms, filters }
}

/**
 * True when at least one predicate the native engine understands is set.
 *
 * `inRoom` is deliberately excluded: it narrows results the engine already
 * returned, so `in:#general` on its own would ask the backend for "every
 * message, no predicate" and get nothing back. The caller treats an
 * `in:`-only query as an incomplete query instead of an empty result.
 */
export function hasActiveFilters(filters: SearchFilters): boolean {
  return (
    filters.from != null ||
    filters.mentions != null ||
    filters.afterMs != null ||
    filters.beforeMs != null ||
    (filters.has != null && filters.has.length > 0)
  )
}

/**
 * True when a result must be dropped because it contains an excluded term.
 *
 * Case-insensitive to match the native engine, which lowercases both sides.
 */
export function isExcludedByQuery(content: string, filters: SearchFilters): boolean {
  if (!filters.excluded || filters.excluded.length === 0) return false
  const haystack = content.toLowerCase()
  return filters.excluded.some((term) => haystack.includes(term.toLowerCase()))
}

/** Drop the renderer-only predicates before the native call. */
export function toWireFilters(filters: SearchFilters): WireSearchFilters {
  const wire: WireSearchFilters = {}
  if (filters.from != null) wire.from = filters.from
  if (filters.mentions != null) wire.mentions = filters.mentions
  if (filters.afterMs != null) wire.afterMs = filters.afterMs
  if (filters.beforeMs != null) wire.beforeMs = filters.beforeMs
  if (filters.has != null && filters.has.length > 0) wire.has = filters.has
  return wire
}

/** Trim an `in:` value down to a comparable room key: no `#`, no case. */
export function normalizeRoomFilter(value: string): string {
  return value.trim().replace(/^#+/, '').toLowerCase()
}

/** How an `in:` value is shown back to the user. */
export function formatRoomFilter(value: string): string {
  return `#${normalizeRoomFilter(value)}`
}

/**
 * Resolve an `in:` value against the rooms of the searched community.
 *
 * An exact room id wins, then an exact name, then names that contain the
 * value. An empty result means the room is not one this client knows about,
 * which the caller reports rather than showing an empty result list.
 */
export function resolveRoomFilter(
  value: string,
  rooms: readonly SearchScopeRoom[],
): string[] {
  const needle = normalizeRoomFilter(value)
  if (!needle) return []
  const byId = rooms.filter((room) => room.id.toLowerCase() === needle)
  if (byId.length > 0) return byId.map((room) => room.id)
  const byName = rooms.filter((room) => room.name.trim().toLowerCase() === needle)
  if (byName.length > 0) return byName.map((room) => room.id)
  return rooms
    .filter((room) => room.name.trim().toLowerCase().includes(needle))
    .map((room) => room.id)
}

/**
 * The one-line, load-bearing fact about what a completed search covered.
 *
 * Search reads a fixed, shallow window of each room, so a miss is not proof
 * that a message does not exist. The sentence states the depth and the breadth
 * without apologising for either.
 *
 * The breadth is inferred from the rooms this client has listed for the
 * community, because the native command returns messages and nothing else. It
 * is exact for ordinary communities and optimistic past roughly 200 rooms,
 * where the engine's 50,000 event budget stops the walk early. A scope report
 * from the backend (rooms visited, events scanned, whether a budget or the
 * deadline cut the walk short) would replace the inference outright.
 */
export function describeSearchScope(scope: {
  /** Rooms this client knows the search enumerated. Zero when unknown. */
  rooms: number
  /** A single conversation (a direct message) or a whole community. */
  kind: 'community' | 'conversation'
  /** The applied `in:` value, already formatted, when one narrowed the results. */
  roomFilter?: string | null
}): string {
  const depth = `the most recent ${SEARCH_MESSAGES_PER_ROOM} messages`
  const breadth = scope.kind === 'conversation'
    ? 'in this conversation'
    : scope.rooms === 1
      ? 'in 1 room'
      : scope.rooms > 1
        ? `in each of ${scope.rooms} rooms`
        : 'in each room'
  if (scope.roomFilter) {
    return `Filtered to ${scope.roomFilter} after searching ${depth} ${breadth}.`
  }
  return `Searched ${depth} ${breadth}.`
}

/**
 * The one-line, load-bearing fact about what a cross-community search
 * actually covered.
 *
 * A cross-community search shares one deadline and result budget across
 * every community it walks, so a large account can have some communities
 * fully searched and others not reached at all. This states the real,
 * backend-reported coverage rather than inferring it, and says so plainly
 * when the walk stopped before reaching every community.
 */
export function describeEverywhereSearchScope(scope: {
  communitiesSearched: number
  communitiesTotal: number
  roomsSearched: number
  truncated: boolean
}): string {
  const depth = `the most recent ${SEARCH_MESSAGES_PER_ROOM} messages`
  const rooms = scope.roomsSearched === 1 ? '1 room' : `${scope.roomsSearched} rooms`
  const communities = scope.communitiesSearched === scope.communitiesTotal
    ? (scope.communitiesTotal === 1 ? '1 community' : `all ${scope.communitiesTotal} communities`)
    : `${scope.communitiesSearched} of ${scope.communitiesTotal} communities`
  const coverage = `Searched ${depth} in ${rooms} across ${communities}.`
  return scope.truncated
    ? `${coverage} The search deadline was reached first, so not every community was fully scanned.`
    : coverage
}
