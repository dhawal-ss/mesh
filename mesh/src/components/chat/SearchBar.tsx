import { useState, useCallback, useRef, useEffect } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import type { Message } from '../../types/ipc'
import * as bridge from '../../lib/bridge'
import { useCommunityStore } from '../../store/communities'
import { useChannelStore } from '../../store/channels'
import { format } from 'date-fns'

interface SearchBarProps {
  onNavigateToMessage?: (channelId: string, messageId: string) => void
}

export function SearchBar({ onNavigateToMessage }: SearchBarProps) {
  const [isOpen, setIsOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<Message[]>([])
  const [isSearching, setIsSearching] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined)
  const activeCommunityId = useCommunityStore((s) => s.activeCommunityId)
  const { setActiveChannel } = useChannelStore()
  const channels = useChannelStore((s) => s.channels)

  const performSearch = useCallback(
    async (searchQuery: string) => {
      if (!searchQuery.trim() || !activeCommunityId) {
        setResults([])
        return
      }
      setIsSearching(true)
      try {
        const found = await bridge.searchMessages(searchQuery.trim(), activeCommunityId, 20)
        setResults(found)
      } catch {
        setResults([])
      } finally {
        setIsSearching(false)
      }
    },
    [activeCommunityId],
  )

  const handleInputChange = useCallback(
    (value: string) => {
      setQuery(value)
      clearTimeout(debounceRef.current)
      debounceRef.current = setTimeout(() => performSearch(value), 300)
    },
    [performSearch],
  )

  useEffect(() => {
    if (isOpen && inputRef.current) inputRef.current.focus()
  }, [isOpen])

  useEffect(() => {
    return () => clearTimeout(debounceRef.current)
  }, [])

  const handleResultClick = (message: Message) => {
    setActiveChannel(message.channelId)
    onNavigateToMessage?.(message.channelId, message.id)
    setIsOpen(false)
    setQuery('')
    setResults([])
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
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <circle cx="11" cy="11" r="8" />
          <line x1="21" y1="21" x2="16.65" y2="16.65" />
        </svg>
      </button>

      <AnimatePresence>
        {isOpen && (
          <motion.div
            initial={{ opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={{ duration: 0.1 }}
            className="absolute right-0 top-full z-50 mt-1 w-96 overflow-hidden rounded-lg bg-bg-floating shadow-floating"
          >
            {/* Search input */}
            <div className="flex items-center gap-2 border-b border-border px-4 py-2.5">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="flex-shrink-0 text-muted">
                <circle cx="11" cy="11" r="8" />
                <line x1="21" y1="21" x2="16.65" y2="16.65" />
              </svg>
              <input
                ref={inputRef}
                type="text"
                value={query}
                onChange={(e) => handleInputChange(e.target.value)}
                placeholder="Search messages…"
                className="flex-1 bg-transparent text-sm text-primary outline-none placeholder:text-muted"
                onKeyDown={(e) => {
                  if (e.key === 'Escape') {
                    setIsOpen(false)
                    setQuery('')
                    setResults([])
                  }
                }}
              />
              {isSearching && (
                <div className="h-3 w-3 animate-spin rounded-full border border-muted border-t-primary" />
              )}
            </div>

            {/* Results */}
            <div className="max-h-80 overflow-y-auto">
              {query.trim() && results.length === 0 && !isSearching && (
                <div className="px-4 py-6 text-center text-sm text-muted">
                  No messages found
                </div>
              )}

              {results.map((message) => (
                <button
                  key={message.id}
                  onClick={() => handleResultClick(message)}
                  className="flex w-full flex-col gap-0.5 px-4 py-2.5 text-left transition-colors hover:bg-bg-modifier-hover"
                >
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-primary">
                      {message.authorDisplayName}
                    </span>
                    <span className="text-xs text-muted">
                      in #{getChannelName(message.channelId)}
                    </span>
                    <span className="ml-auto text-xs text-muted">
                      {format(new Date(message.timestamp), 'MMM d, HH:mm')}
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
