import { useState, useCallback, useRef, useEffect } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import type { Message } from '../../types/ipc'
import * as bridge from '../../lib/bridge'
import { useCommunityStore } from '../../store/communities'
import { useChannelStore } from '../../store/channels'
import { formatFederatedTimestamp } from '../../lib/federated-time'
import { variants } from '../../lib/motion'
import { Icon } from '../ui/Icon'
import { EmptyState } from '../ui/Primitives'

interface SearchBarProps {
  onNavigateToMessage: (message: Message) => void
  label?: string
}

export function SearchBar({ onNavigateToMessage, label }: SearchBarProps) {
  const [isOpen, setIsOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<Message[]>([])
  const [isSearching, setIsSearching] = useState(false)
  const [searchFailed, setSearchFailed] = useState(false)
  const [activeResultIndex, setActiveResultIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined)
  const searchGenerationRef = useRef(0)
  const activeCommunityId = useCommunityStore((s) => s.activeCommunityId)
  const activeCommunityRef = useRef(activeCommunityId)
  const channels = useChannelStore((s) => s.channels)

  const performSearch = useCallback(
    async (searchQuery: string) => {
      const generation = ++searchGenerationRef.current
      const normalizedQuery = searchQuery.trim()
      if (!normalizedQuery || !activeCommunityId) {
        if (activeCommunityId) void bridge.cancelMessageSearch(activeCommunityId)
        setResults([])
        setIsSearching(false)
        setSearchFailed(false)
        return
      }
      setIsSearching(true)
      setSearchFailed(false)
      try {
        const found = await bridge.searchMessages(normalizedQuery, activeCommunityId, 20)
        if (generation !== searchGenerationRef.current) return
        setResults(found)
        setActiveResultIndex(0)
        setSearchFailed(false)
      } catch {
        if (generation !== searchGenerationRef.current) return
        setResults([])
        setActiveResultIndex(0)
        setSearchFailed(true)
      } finally {
        if (generation === searchGenerationRef.current) setIsSearching(false)
      }
    },
    [activeCommunityId],
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
    const previousCommunityId = activeCommunityRef.current
    activeCommunityRef.current = activeCommunityId
    clearTimeout(debounceRef.current)
    searchGenerationRef.current += 1
    if (previousCommunityId) void bridge.cancelMessageSearch(previousCommunityId)
    const frame = window.requestAnimationFrame(() => {
      setResults([])
      setActiveResultIndex(0)
      setIsSearching(false)
      setSearchFailed(false)
    })
    return () => window.cancelAnimationFrame(frame)
  }, [activeCommunityId])

  useEffect(() => {
    return () => {
      clearTimeout(debounceRef.current)
      const communityId = useCommunityStore.getState().activeCommunityId
      if (communityId) void bridge.cancelMessageSearch(communityId)
    }
  }, [])

  const handleResultClick = (message: Message) => {
    onNavigateToMessage(message)
    setIsOpen(false)
    setQuery('')
    setResults([])
    setActiveResultIndex(0)
    setSearchFailed(false)
  }

  const closeSearch = useCallback((restoreFocus = true) => {
    if (activeCommunityId) void bridge.cancelMessageSearch(activeCommunityId)
    setIsOpen(false)
    setQuery('')
    setResults([])
    setActiveResultIndex(0)
    setSearchFailed(false)
    if (restoreFocus) triggerRef.current?.focus()
  }, [activeCommunityId])

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
        className={`flex h-8 items-center justify-center gap-1.5 rounded-control text-muted transition-colors hover:bg-surface-hover hover:text-secondary ${
          label ? 'px-2' : 'w-8'
        }`}
        title="Search messages"
        aria-label="Search messages"
        aria-expanded={isOpen}
        aria-controls={isOpen ? 'message-search-popover' : undefined}
      >
        <Icon name="search" size="sm" />
        {label && <span className="hidden text-xs font-medium md:inline">{label}</span>}
      </button>

      <AnimatePresence>
        {isOpen && (
          <motion.div
            id="message-search-popover"
            variants={variants.popover}
            initial="initial"
            animate="animate"
            exit="exit"
            className="mesh-search-popover absolute right-0 top-full z-popover mt-1 overflow-hidden rounded-panel border border-border-subtle bg-surface-overlay shadow-overlay"
          >
            {/* Search input */}
            <div className="flex items-center gap-2 border-b border-border-subtle px-3 py-2">
              <Icon name="search" size="sm" className="flex-shrink-0 text-muted" />
              <input
                ref={inputRef}
                type="text"
                value={query}
                onChange={(e) => handleInputChange(e.target.value)}
                placeholder="Search messages…"
                aria-label="Search messages"
                aria-autocomplete="list"
                aria-controls="search-results"
                aria-activedescendant={
                  results[activeResultIndex] ? `search-result-${results[activeResultIndex].id}` : undefined
                }
                className="min-w-0 flex-1 bg-transparent text-sm text-primary outline-none placeholder:text-muted focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
                onKeyDown={(e) => {
                  if (e.key === 'ArrowDown' && results.length > 0) {
                    e.preventDefault()
                    setActiveResultIndex((current) => (current + 1) % results.length)
                    return
                  }
                  if (e.key === 'ArrowUp' && results.length > 0) {
                    e.preventDefault()
                    setActiveResultIndex((current) => (current - 1 + results.length) % results.length)
                    return
                  }
                  if (e.key === 'Enter' && results[activeResultIndex]) {
                    e.preventDefault()
                    handleResultClick(results[activeResultIndex])
                    return
                  }
                  if (e.key === 'Escape') {
                    closeSearch()
                  }
                }}
              />
              {isSearching && (
                <div
                  className="h-3 w-3 flex-shrink-0 animate-spin rounded-full border border-muted border-t-primary"
                  role="status"
                  aria-label="Searching messages"
                />
              )}
              <button
                type="button"
                onClick={() => closeSearch()}
                className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-control text-muted hover:bg-surface-hover hover:text-primary"
                aria-label="Close message search"
              >
                <Icon name="x" size="sm" />
              </button>
            </div>

            {/* Results */}
            <div id="search-results" className="max-h-80 overflow-y-auto" role="listbox" aria-label="Search results">
              {query.trim() && searchFailed && !isSearching && (
                <div className="px-4 py-6 text-center">
                  <Icon name="triangleAlert" size="sm" className="mx-auto mb-2 text-status-warning" />
                  <p className="text-sm font-medium text-secondary">Search is temporarily unavailable</p>
                  <p className="mt-1 text-xs text-muted">Check your connection, then try again.</p>
                  <button
                    type="button"
                    onClick={() => void performSearch(query)}
                    className="mt-3 min-h-8 rounded-control border border-border-subtle px-3 text-xs font-semibold text-secondary hover:bg-surface-hover hover:text-primary"
                  >
                    Try again
                  </button>
                </div>
              )}

              {query.trim() && results.length === 0 && !isSearching && !searchFailed && (
                <EmptyState
                  variant="compact"
                  icon={<Icon name="search" size="lg" />}
                  title="No messages found"
                  description="Try another word or phrase."
                />
              )}

              {results.map((message, index) => (
                <button
                  key={message.id}
                  id={`search-result-${message.id}`}
                  role="option"
                  aria-selected={index === activeResultIndex}
                  onClick={() => handleResultClick(message)}
                  className={`flex w-full flex-col gap-0.5 px-3 py-2 text-left transition-colors hover:bg-surface-hover ${index === activeResultIndex ? 'bg-surface-hover' : ''}`}
                >
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-primary">{message.authorDisplayName}</span>
                    <span className="text-xs text-muted">in #{getChannelName(message.channelId)}</span>
                    <span className="tnum ml-auto text-xs text-muted">
                      {formatFederatedTimestamp(message.timestamp, 'MMM d, HH:mm')}
                    </span>
                  </div>
                  <p className="truncate text-sm text-secondary">{message.content.slice(0, 120)}</p>
                </button>
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
