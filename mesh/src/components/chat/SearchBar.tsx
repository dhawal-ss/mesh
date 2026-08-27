import { useState, useCallback, useMemo, useRef, useEffect } from 'react'
import { AnimatePresence, motion } from '../../lib/lazy-motion'
import type { MatrixSearchScopeDto, Message } from '../../types/ipc'
import * as bridge from '../../lib/bridge'
import { useCommunityStore } from '../../store/communities'
import { useChannelStore } from '../../store/channels'
import { formatFederatedTimestamp } from '../../lib/federated-time'
import { variants } from '../../lib/motion'
import { Icon } from '../ui/Icon'
import { EmptyState } from '../ui/Primitives'
import { Button } from '../ui/Button'
import {
  describeEverywhereSearchScope,
  describeSearchScope,
  formatRoomFilter,
  withoutRoomFilter,
  hasActiveFilters,
  isExcludedByQuery,
  parseSearchQuery,
  resolveRoomFilter,
  toWireFilters,
  type ParsedSearchQuery,
} from '../../lib/search-query'
import { classifySearchResultKind, type SearchResultKind } from '../../lib/search-result-kind'

interface SearchBarProps {
  onNavigateToMessage: (message: Message) => void
  scopeId?: string
  resultLocationLabel?: string
}

/** Results kept on screen. The native engine sorts newest first. */
const MAX_RESULTS = 20
/**
 * `in:` is resolved in the renderer, so a room-scoped query has to ask for a
 * deeper slice than it shows: the engine ranks across every room, and a narrow
 * request would hand back twenty messages that mostly belong elsewhere.
 */
const ROOM_FILTER_FETCH_LIMIT = 200

/**
 * The operator grammar is worth nothing if it is invisible. These chips are the
 * whole affordance: one tap writes the operator, the user types the value.
 */
const FILTER_HINTS: Array<{ token: string; label: string; roomsOnly?: boolean }> = [
  { token: 'from:', label: 'Filter by author' },
  { token: 'mentions:', label: 'Filter by mention' },
  { token: 'in:', label: 'Filter by room', roomsOnly: true },
  { token: 'has:image', label: 'Only messages with an image' },
  { token: 'has:link', label: 'Only messages with a link' },
  { token: 'before:', label: 'Only messages before a date' },
  { token: 'after:', label: 'Only messages after a date' },
]

type ResultTab = 'all' | SearchResultKind

/**
 * Client-side narrowing views over the already-fetched result set. "All" is
 * the full set and stays first and selected by default: the other three are
 * disjoint subsets of it, so defaulting to one of them would silently hide
 * most of what a search actually found.
 */
const RESULT_TABS: Array<{ key: ResultTab; label: string }> = [
  { key: 'all', label: 'All' },
  { key: 'media', label: 'Media' },
  { key: 'file', label: 'Files' },
  { key: 'link', label: 'Links' },
]

export function SearchBar({
  onNavigateToMessage,
  scopeId,
  resultLocationLabel,
}: SearchBarProps) {
  const [isOpen, setIsOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<Message[]>([])
  const [isSearching, setIsSearching] = useState(false)
  const [searchFailed, setSearchFailed] = useState(false)
  const [activeResultIndex, setActiveResultIndex] = useState(0)
  /** The query behind the results on screen, so the scope line stays truthful. */
  const [completedQuery, setCompletedQuery] = useState<ParsedSearchQuery | null>(null)
  /** Non-null exactly when the results on screen came from a cross-community search. */
  const [scopeReport, setScopeReport] = useState<MatrixSearchScopeDto | null>(null)
  const [everywhere, setEverywhere] = useState(false)
  const [resultTab, setResultTab] = useState<ResultTab>('all')
  const inputRef = useRef<HTMLInputElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined)
  const searchGenerationRef = useRef(0)
  const activeCommunityId = useCommunityStore((s) => s.activeCommunityId)
  const communities = useCommunityStore((s) => s.communities)
  const communityEntities = useCommunityStore((s) => s.communityEntities)
  const activeSearchScopeId = scopeId ?? activeCommunityId
  const activeSearchScopeRef = useRef(activeSearchScopeId)
  // Read inside performSearch instead of the `everywhere` state directly, so
  // toggling the checkbox and re-searching in the same handler is never
  // fighting a stale closure from before the state update lands.
  const everywhereRef = useRef(everywhere)
  const channels = useChannelStore((s) => s.channels)
  // An explicit scope id is a single conversation; otherwise the engine walks
  // every room of the active community.
  const isDirectScope = scopeId != null
  const scopeRooms = useMemo(
    () => (isDirectScope
      ? []
      : channels
        .filter((channel) => channel.communityId === activeSearchScopeId)
        .map((channel) => ({ id: channel.id, name: channel.name }))),
    [activeSearchScopeId, channels, isDirectScope],
  )

  const performSearch = useCallback(
    async (searchQuery: string) => {
      const generation = ++searchGenerationRef.current
      const parsed = parseSearchQuery(searchQuery)
      const { terms, filters } = parsed
      // The community list can be briefly empty right after launch; searching
      // "everywhere" against zero communities would report a hollow "0 of 0"
      // scope instead of just falling back to the active-community search.
      const searchEverywhere = everywhereRef.current && !isDirectScope && communities.length > 0
      // A search needs either free text or at least one active filter; a
      // filter-only query (e.g. `has:image`) is valid on its own. `in:` alone
      // is not: it narrows results rather than selecting any.
      if ((terms.length === 0 && !hasActiveFilters(filters)) || !activeSearchScopeId) {
        if (activeSearchScopeId) void bridge.cancelMessageSearch(activeSearchScopeId)
        void bridge.cancelMessageSearchEverywhere()
        setResults([])
        setCompletedQuery(null)
        setScopeReport(null)
        setIsSearching(false)
        setSearchFailed(false)
        return
      }
      // `in:` has no cross-community predicate to resolve against yet (it
      // would need every joined community's channels, not just the active
      // one), so it is left unapplied and reported as such in the footer.
      const roomIds = filters.inRoom != null && !isDirectScope && !searchEverywhere
        ? new Set(resolveRoomFilter(filters.inRoom, scopeRooms))
        : null
      setIsSearching(true)
      setSearchFailed(false)
      try {
        let found: Message[]
        let scope: MatrixSearchScopeDto | null = null
        if (searchEverywhere) {
          const response = await bridge.searchMessagesEverywhere(
            terms,
            communities.map((community) => community.id),
            filters.excluded ? ROOM_FILTER_FETCH_LIMIT : MAX_RESULTS,
            toWireFilters(filters),
          )
          found = response.results
          scope = response.scope
        } else {
          found = await bridge.searchMessages(
            terms,
            activeSearchScopeId,
            // Over-fetch whenever a renderer-side predicate will remove
            // results, otherwise narrowing a full page silently returns a
            // short one.
            roomIds || filters.excluded ? ROOM_FILTER_FETCH_LIMIT : MAX_RESULTS,
            toWireFilters(filters),
          )
        }
        if (generation !== searchGenerationRef.current) return
        // Both narrowing predicates are applied here rather than on the wire,
        // because the native engine has neither a room nor an exclusion
        // predicate. See the notes on SearchFilters.
        const narrowed = roomIds
          ? found.filter((message) => roomIds.has(message.channelId))
          : found
        const kept = filters.excluded
          ? narrowed.filter((message) => !isExcludedByQuery(message.content, filters))
          : narrowed
        setResults(kept.slice(0, MAX_RESULTS))
        setCompletedQuery(parsed)
        setScopeReport(scope)
        setResultTab('all')
        setActiveResultIndex(0)
        setSearchFailed(false)
      } catch {
        if (generation !== searchGenerationRef.current) return
        setResults([])
        setCompletedQuery(null)
        setScopeReport(null)
        setActiveResultIndex(0)
        setSearchFailed(true)
      } finally {
        if (generation === searchGenerationRef.current) setIsSearching(false)
      }
    },
    [activeSearchScopeId, communities, isDirectScope, scopeRooms],
  )

  const handleInputChange = useCallback(
    (value: string) => {
      setQuery(value)
      setActiveResultIndex(0)
      setSearchFailed(false)
      clearTimeout(debounceRef.current)
      debounceRef.current = setTimeout(() => performSearch(value), 300)
    },
    [performSearch],
  )

  useEffect(() => {
    if (isOpen && inputRef.current) inputRef.current.focus()
  }, [isOpen])

  useEffect(() => {
    everywhereRef.current = everywhere
  }, [everywhere])

  useEffect(() => {
    const previousSearchScopeId = activeSearchScopeRef.current
    activeSearchScopeRef.current = activeSearchScopeId
    clearTimeout(debounceRef.current)
    searchGenerationRef.current += 1
    if (previousSearchScopeId) void bridge.cancelMessageSearch(previousSearchScopeId)
    void bridge.cancelMessageSearchEverywhere()
    const frame = window.requestAnimationFrame(() => {
      setResults([])
      setCompletedQuery(null)
      setScopeReport(null)
      setResultTab('all')
      setActiveResultIndex(0)
      setIsSearching(false)
      setSearchFailed(false)
    })
    return () => window.cancelAnimationFrame(frame)
  }, [activeSearchScopeId])

  useEffect(() => {
    return () => {
      clearTimeout(debounceRef.current)
      const currentScopeId = activeSearchScopeRef.current
      if (currentScopeId) void bridge.cancelMessageSearch(currentScopeId)
      void bridge.cancelMessageSearchEverywhere()
    }
  }, [])

  const handleResultClick = (message: Message) => {
    onNavigateToMessage(message)
    setIsOpen(false)
    setQuery('')
    setResults([])
    setCompletedQuery(null)
    setScopeReport(null)
    setResultTab('all')
    setActiveResultIndex(0)
    setSearchFailed(false)
  }

  const closeSearch = useCallback((restoreFocus = true) => {
    if (activeSearchScopeId) void bridge.cancelMessageSearch(activeSearchScopeId)
    void bridge.cancelMessageSearchEverywhere()
    setIsOpen(false)
    setQuery('')
    setResults([])
    setCompletedQuery(null)
    setScopeReport(null)
    setResultTab('all')
    setActiveResultIndex(0)
    setSearchFailed(false)
    if (restoreFocus) triggerRef.current?.focus()
  }, [activeSearchScopeId])

  useEffect(() => {
    if (!isOpen) return
    const handleOutsidePointerDown = (event: PointerEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) closeSearch(false)
    }
    document.addEventListener('pointerdown', handleOutsidePointerDown)
    return () => document.removeEventListener('pointerdown', handleOutsidePointerDown)
  }, [closeSearch, isOpen])

  const getChannelName = (channelId: string) => {
    return channels.find((c) => c.id === channelId)?.name ?? 'unknown'
  }

  const getCommunityName = (channelId: string) => {
    const communityId = channels.find((c) => c.id === channelId)?.communityId
    return communityId ? communityEntities[communityId]?.name : undefined
  }

  const getResultLocation = (channelId: string) => {
    const roomLabel = resultLocationLabel ?? `#${getChannelName(channelId)}`
    // Cross-community results need the community named too, or two rooms
    // with the same name in different communities read as one place.
    if (scopeReport == null) return roomLabel
    const communityName = getCommunityName(channelId)
    return communityName ? `${communityName} · ${roomLabel}` : roomLabel
  }

  /** Write an operator into the box and let the person supply the value. */
  const applyFilterHint = (token: string) => {
    setQuery(token)
    setSearchFailed(false)
    clearTimeout(debounceRef.current)
    inputRef.current?.focus()
  }

  const requestedRoomFilter = completedQuery?.filters.inRoom ?? null
  const roomFilterApplies = requestedRoomFilter != null && !isDirectScope && scopeReport == null
  const resolvedRoomIds = useMemo(
    () => (roomFilterApplies && requestedRoomFilter != null
      ? resolveRoomFilter(requestedRoomFilter, scopeRooms)
      : []),
    [requestedRoomFilter, roomFilterApplies, scopeRooms],
  )
  const roomFilterMissed = roomFilterApplies && resolvedRoomIds.length === 0
  const scopeSummary = completedQuery && !searchFailed
    ? scopeReport
      ? `${describeEverywhereSearchScope(scopeReport)}${
        requestedRoomFilter != null ? ' A room filter has nothing to narrow here.' : ''
      }`
      : `${describeSearchScope({
        rooms: scopeRooms.length,
        kind: isDirectScope ? 'conversation' : 'community',
        roomFilter: roomFilterApplies && !roomFilterMissed && requestedRoomFilter != null
          ? formatRoomFilter(requestedRoomFilter)
          : null,
      })}${requestedRoomFilter != null && isDirectScope
        ? ' A room filter has nothing to narrow here.'
        : ''}`
    : null
  const liveFilters = parseSearchQuery(query).filters
  const roomFilterHintLabel = liveFilters.inRoom != null
    ? formatRoomFilter(liveFilters.inRoom)
    : null
  const resultCounts = useMemo(() => {
    const counts: Record<ResultTab, number> = { all: results.length, message: 0, media: 0, file: 0, link: 0 }
    for (const message of results) counts[classifySearchResultKind(message)] += 1
    return counts
  }, [results])
  const visibleResults = useMemo(
    () => (resultTab === 'all'
      ? results
      : results.filter((message) => classifySearchResultKind(message) === resultTab)),
    [results, resultTab],
  )
  const selectTab = (tab: ResultTab) => {
    setResultTab(tab)
    setActiveResultIndex(0)
  }

  return (
    <div ref={containerRef} className="relative">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => {
          if (isOpen) {
            closeSearch(false)
          } else {
            setIsOpen(true)
          }
        }}
        className="mesh-icon-button flex h-control-md w-control-md items-center justify-center rounded-full text-on-surface-variant transition-colors hover:bg-state-hover hover:text-on-surface focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus"
        title="Search messages"
        aria-label="Search messages"
        aria-expanded={isOpen}
        /*
          A disclosure for the popover, not a second controller of the results
          list: the input inside owns the combobox relationship, so only one
          element claims aria-controls over the listbox.
        */
        aria-haspopup="dialog"
      >
        <Icon name="search" />
      </button>

      <AnimatePresence>
        {isOpen && (
          <motion.div
            id="message-search-popover"
            variants={variants.popover}
            initial="initial"
            animate="animate"
            exit="exit"
            className="mesh-search-popover absolute right-0 top-full z-popover mt-1 overflow-hidden rounded-xl border border-outline-variant bg-surface-container-high shadow-elev-3"
            /*
              Escape closes from the filter chips too, not only from the input
              that owns its own key handling.
            */
            onKeyDown={(event) => {
              if (event.key === 'Escape' && event.target !== inputRef.current) closeSearch()
            }}
          >
            {/* Search input */}
            <div className="flex items-center gap-2 border-b border-outline-variant px-3 py-2">
              <Icon name="search" size="sm" className="flex-shrink-0 text-on-surface-variant" />
              <input
                ref={inputRef}
                type="text"
                value={query}
                onChange={(e) => handleInputChange(e.target.value)}
                placeholder="Search messages…"
                aria-label="Search messages"
                /*
                  A real combobox. NVDA does not reliably follow
                  aria-activedescendant on a plain textbox, so arrowing through
                  results moved the highlight in silence.
                */
                role="combobox"
                aria-expanded={visibleResults.length > 0}
                aria-haspopup="listbox"
                aria-autocomplete="list"
                aria-controls="search-results"
                aria-describedby={scopeSummary ? 'message-search-scope' : undefined}
                aria-activedescendant={
                  visibleResults[activeResultIndex]
                    ? `search-result-${visibleResults[activeResultIndex].id}`
                    : undefined
                }
                className="min-w-0 flex-1 bg-transparent text-body-md text-on-surface outline-none placeholder:text-on-surface-variant focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus"
                onKeyDown={(e) => {
                  if (e.key === 'ArrowDown' && visibleResults.length > 0) {
                    e.preventDefault()
                    setActiveResultIndex((current) => (current + 1) % visibleResults.length)
                    return
                  }
                  if (e.key === 'ArrowUp' && visibleResults.length > 0) {
                    e.preventDefault()
                    setActiveResultIndex((current) => (current - 1 + visibleResults.length) % visibleResults.length)
                    return
                  }
                  if (e.key === 'Enter' && visibleResults[activeResultIndex]) {
                    e.preventDefault()
                    handleResultClick(visibleResults[activeResultIndex])
                    return
                  }
                  if (e.key === 'Escape') {
                    closeSearch()
                  }
                }}
              />
              {isSearching && (
                <div
                  className="h-3 w-3 flex-shrink-0 animate-spin rounded-round border border-on-surface-variant border-t-on-surface"
                  role="status"
                  aria-label="Searching messages"
                />
              )}
              <button
                type="button"
                onClick={() => closeSearch()}
                className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full text-on-surface-variant hover:bg-state-hover hover:text-on-surface"
                aria-label="Close message search"
              >
                <Icon name="x" size="sm" />
              </button>
            </div>

            {!isDirectScope && (
              <label className="flex items-center gap-2 border-b border-outline-variant px-3 py-2 text-body-sm text-on-surface-variant">
                <input
                  type="checkbox"
                  checked={everywhere}
                  onChange={(e) => {
                    const checked = e.target.checked
                    everywhereRef.current = checked
                    setEverywhere(checked)
                    setSearchFailed(false)
                    clearTimeout(debounceRef.current)
                    if (query.trim()) {
                      void performSearch(query)
                    } else {
                      setResults([])
                      setCompletedQuery(null)
                      setScopeReport(null)
                    }
                  }}
                  className="h-3.5 w-3.5 rounded-full border-outline-variant accent-primary"
                />
                Search all communities
              </label>
            )}

            {completedQuery && results.length > 0 && !isSearching && !searchFailed && (
              <div role="group" aria-label="Filter results by type" className="flex flex-wrap gap-1 border-b border-outline-variant px-3 py-1.5">
                {RESULT_TABS.map((tab) => (
                  <button
                    key={tab.key}
                    type="button"
                    aria-pressed={resultTab === tab.key}
                    onClick={() => selectTab(tab.key)}
                    className={`min-h-7 rounded-full border-b-bar px-2 text-body-sm font-medium transition-colors ${
                      resultTab === tab.key
                        ? 'border-primary bg-secondary-container text-on-secondary-container'
                        : 'border-transparent text-on-surface-variant hover:bg-state-hover hover:text-on-surface-variant'
                    }`}
                  >
                    {tab.label} ({resultCounts[tab.key]})
                  </button>
                ))}
              </div>
            )}

            {/* Results */}
            <div className="max-h-80 overflow-y-auto">
              {!query.trim() && (
                <div className="px-3 py-3">
                  <p className="mb-2 text-body-sm font-medium text-on-surface-variant">Filter your search</p>
                  <div className="flex flex-wrap gap-1.5">
                    {FILTER_HINTS
                      .filter((hint) => !hint.roomsOnly || (!isDirectScope && !everywhere))
                      .map((hint) => (
                        <button
                          key={hint.token}
                          type="button"
                          aria-label={hint.label}
                          onClick={() => applyFilterHint(hint.token)}
                          className="min-h-8 rounded-full border border-outline-variant px-2 text-body-sm text-on-surface-variant transition-colors hover:bg-state-hover hover:text-on-surface focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus"
                        >
                          {hint.token}
                        </button>
                      ))}
                  </div>
                  <p className="mt-2 text-body-sm text-on-surface-variant">
                    {isDirectScope
                      ? 'Example: from:me has:link'
                      : 'Example: from:me in:#general launch notes'}
                  </p>
                </div>
              )}

              {query.trim() && searchFailed && !isSearching && (
                <div className="px-4 py-6 text-center">
                  <Icon name="triangleAlert" size="sm" className="mx-auto mb-2 text-marker" />
                  <p className="text-body-md font-medium text-on-surface-variant">Search is temporarily unavailable</p>
                  <p className="mt-1 text-body-sm text-on-surface-variant">Check your connection.</p>
                  <button
                    type="button"
                    onClick={() => void performSearch(query)}
                    className="mt-3 min-h-8 rounded-full border border-outline-variant px-3 text-body-sm font-semibold text-on-surface-variant hover:bg-state-hover hover:text-on-surface"
                  >
                    Try again
                  </button>
                </div>
              )}

              {/*
                Nothing has been searched yet: an operator with no value, or the
                pause before the debounce fires. Saying so beats an empty result
                list that reads like an answer.
              */}
              {query.trim() && !completedQuery && !isSearching && !searchFailed && (
                <p className="px-3 py-3 text-body-sm text-on-surface-variant">
                  {roomFilterHintLabel
                    ? `Add a word or another filter to search ${roomFilterHintLabel}.`
                    : 'Keep typing to search.'}
                </p>
              )}

              {completedQuery && results.length === 0 && !isSearching && !searchFailed && (
                roomFilterMissed && requestedRoomFilter != null ? (
                  <EmptyState
                    variant="compact"
                    icon={<Icon name="search" size="lg" />}
                    title={`No room named ${formatRoomFilter(requestedRoomFilter)} here`}
                    description="Check the room name."
                    action={(
                      <Button
                        variant="secondary"
                        size="sm"
                        /*
                          Through handleInputChange, not setQuery. The search is
                          driven by the input's change handler rather than by an
                          effect watching the query, so setting the text alone
                          would rewrite the box and leave this same empty state
                          on screen -- a button that looks like it worked.
                        */
                        onClick={() => handleInputChange(withoutRoomFilter(query))}
                      >
                        Search every room
                      </Button>
                    )}
                  />
                ) : (
                  <EmptyState
                    variant="compact"
                    icon={<Icon name="search" size="lg" />}
                    title="No matches in recent messages"
                    description="Older messages were not searched."
                  />
                )
              )}

              {completedQuery && results.length > 0 && visibleResults.length === 0 && !isSearching && !searchFailed && (
                <EmptyState
                  variant="compact"
                  icon={<Icon name="search" size="lg" />}
                  title={`No ${RESULT_TABS.find((tab) => tab.key === resultTab)?.label.toLowerCase()} in these results`}
                  description="Try a different tab to see the rest of what matched."
                />
              )}

              <div id="search-results" role="listbox" aria-label="Search results">
                {visibleResults.map((message, index) => (
                  <button
                    key={message.id}
                    id={`search-result-${message.id}`}
                    role="option"
                    aria-selected={index === activeResultIndex}
                    onClick={() => handleResultClick(message)}
                    className={`flex w-full flex-col gap-0.5 px-3 py-2 text-left transition-colors hover:bg-state-hover ${index === activeResultIndex ? 'bg-surface-container-high' : ''}`}
                  >
                    <div className="flex items-center gap-2">
                      <span className="text-body-md font-medium text-on-surface">{message.authorDisplayName}</span>
                      <span className="text-body-sm text-on-surface-variant">in {getResultLocation(message.channelId)}</span>
                      {message.threadRootId && (
                        <span className="rounded-full bg-surface-container-lowest px-1.5 py-0.5 text-body-sm font-medium text-on-surface-variant">
                          Thread reply
                        </span>
                      )}
                      <span className="tnum ml-auto text-body-sm text-on-surface-variant">
                        {formatFederatedTimestamp(message.timestamp, 'MMM d, HH:mm')}
                      </span>
                    </div>
                    <p className="truncate text-body-md text-on-surface-variant">{message.content.slice(0, 120)}</p>
                  </button>
                ))}
              </div>
            </div>

            {/*
              What was actually searched, stated once, quietly. Search reads a
              fixed window of each room, so silence about the depth lets a miss
              masquerade as proof that the message never existed.
            */}
            {scopeSummary && (
              <p
                id="message-search-scope"
                className="border-t border-outline-variant px-3 py-2 text-body-sm text-on-surface-variant"
              >
                {scopeSummary}
              </p>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
