import { useState, useCallback, useRef, useEffect } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import type { Message } from '../../types/ipc'
import * as bridge from '../../lib/bridge'
import { useCommunityStore } from '../../store/communities'
import { useChannelStore } from '../../store/channels'
import { formatFederatedTimestamp } from '../../lib/federated-time'
import { variants } from '../../lib/motion'
import { Icon } from '../ui/Icon'

interface SearchBarProps {
  onNavigateToMessage: (message: Message) => void
}

export function SearchBar({ onNavigateToMessage }: SearchBarProps) {
  const [isOpen, setIsOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<Message[]>([])
  const [isSearching, setIsSearching] = useState(false)
  const [activeResultIndex, setActiveResultIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined)
  const searchGenerationRef = useRef(0)
  const activeCommunityId = useCommunityStore((s) => s.activeCommunityId)
  const channels = useChannelStore((s) => s.channels)

  const performSearch = useCallback(
    async (searchQuery: string) => {
      const generation = ++searchGenerationRef.current
      const normalizedQuery = searchQuery.trim()
      if (!normalizedQuery || !activeCommunityId) {
        setResults([])
        setIsSearching(false)
        return
      }
      setIsSearching(true)
      try {
        const found = await bridge.searchMessages(normalizedQuery, activeCommunityId, 20)
        if (generation !== searchGenerationRef.current) return
        setResults(found)
        setActiveResultIndex(0)
      } catch {
        if (generation !== searchGenerationRef.current) return
        setResults([])
        setActiveResultIndex(0)
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
      clearTimeout(debounceRef.current)
      debounceRef.current = setTimeout(() => performSearch(value), 300)
    },
    [performSearch],
  )

  useEffect(() => {
    if (isOpen && inputRef.current) inputRef.current.focus()
  }, [isOpen])

  useEffect(() => {
    clearTimeout(debounceRef.current)
    searchGenerationRef.current += 1
    setResults([])
    setActiveResultIndex(0)
    setIsSearching(false)
  }, [activeCommunityId])

  useEffect(() => {
    return () => clearTimeout(debounceRef.current)
  }, [])

  const handleResultClick = (message: Message) => {
    onNavigateToMessage(message)
    setIsOpen(false)
    setQuery('')
    setResults([])
    setActiveResultIndex(0)
  }

  const closeSearch = () => {
    setIsOpen(false)
    setQuery('')
    setResults([])
    setActiveResultIndex(0)
  }

  const getChannelName = (channelId: string) => {
    return channels.find((c) => c.id === channelId)?.name ?? 'unknown'
  }

  return (
    <>
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="flex h-6 w-6 items-center justify-center rounded text-muted transition-colors hover:text-secondary"
        title="Search messages"
        aria-label="Search messages"
      >
        <Icon name="search" size="sm" />
      </button>

      <AnimatePresence>
        {isOpen && (
          <motion.div
            variants={variants.popover}
            initial="initial"
            animate="animate"
            exit="exit"
            className="absolute right-0 top-full z-dropdown mt-1 w-96 overflow-hidden rounded-lg bg-bg-floating shadow-overlay"
          >
            {/* Search input */}
            <div className="flex items-center gap-2 border-b border-border px-4 py-2.5">
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
                aria-activedescendant={results[activeResultIndex] ? `search-result-${results[activeResultIndex].id}` : undefined}
                className="flex-1 bg-transparent text-sm text-primary outline-none placeholder:text-muted"
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
                <div className="h-3 w-3 animate-spin rounded-full border border-muted border-t-primary" />
              )}
            </div>

            {/* Results */}
            <div id="search-results" className="max-h-80 overflow-y-auto" role="listbox" aria-label="Search results">
              {query.trim() && results.length === 0 && !isSearching && (
                <div className="px-4 py-6 text-center text-sm text-muted">
                  No messages found
                </div>
              )}

              {results.map((message, index) => (
                <button
                  key={message.id}
                  id={`search-result-${message.id}`}
                  role="option"
                  aria-selected={index === activeResultIndex}
                  onClick={() => handleResultClick(message)}
                  className={`flex w-full flex-col gap-0.5 px-4 py-2.5 text-left transition-colors hover:bg-bg-modifier-hover ${index === activeResultIndex ? 'bg-bg-modifier-hover' : ''}`}
                >
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-primary">
                      {message.authorDisplayName}
                    </span>
                    <span className="text-xs text-muted">
                      in #{getChannelName(message.channelId)}
                    </span>
                    <span className="ml-auto text-xs text-muted">
                      {formatFederatedTimestamp(message.timestamp, 'MMM d, HH:mm')}
                    </span>
                  </div>
                  <p className="truncate text-sm text-secondary">
                    {message.content.slice(0, 120)}
                  </p>
                </button>
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  )
}
