import { useEffect, useMemo, useState } from 'react'
import { useTypingStore } from '../../store/typing'

interface TypingIndicatorProps {
  channelId: string
}

const EMPTY_TYPING_USERS: never[] = []

export function TypingIndicator({ channelId }: TypingIndicatorProps) {
  const typingEntries = useTypingStore(
    (state) => state.typingByChannel[channelId] ?? EMPTY_TYPING_USERS,
  )
  const pruneExpired = useTypingStore((state) => state.pruneExpired)
  const [clock, setClock] = useState(() => Date.now())
  const typingUsers = useMemo(() => {
    return typingEntries
      .filter((user) => user.expiresAt > clock)
      .map((user) => user.displayName)
  }, [clock, typingEntries])

  // Periodically prune expired typing indicators
  useEffect(() => {
    let interval: number | null = null
    const refresh = () => {
      pruneExpired(channelId)
      setClock(Date.now())
    }
    const pause = () => {
      if (interval !== null) window.clearInterval(interval)
      interval = null
    }
    const resume = () => {
      pause()
      if (document.hidden) return
      refresh()
      interval = window.setInterval(refresh, 2_000)
    }
    const handleVisibilityChange = () => {
      if (document.hidden) pause()
      else resume()
    }
    document.addEventListener('visibilitychange', handleVisibilityChange)
    resume()
    return () => {
      pause()
      document.removeEventListener('visibilitychange', handleVisibilityChange)
    }
  }, [channelId, pruneExpired])

  const text = typingUsers.length > 0 ? formatTypingText(typingUsers) : ''

  return (
    <div
      className="flex h-6 items-center gap-1.5 px-4 text-xs text-muted"
      role="status"
      aria-live="polite"
      aria-atomic="true"
    >
      {text && <TypingDots />}
      <span>{text}</span>
    </div>
  )
}

function formatTypingText(names: string[]): string {
  if (names.length === 1) {
    return `${names[0]} is typing...`
  }
  if (names.length === 2) {
    return `${names[0]} and ${names[1]} are typing...`
  }
  if (names.length === 3) {
    return `${names[0]}, ${names[1]}, and ${names[2]} are typing...`
  }
  return 'Several people are typing...'
}

function TypingDots() {
  return (
    <span className="inline-flex items-center gap-0.5" aria-hidden="true">
      <span className="h-1 w-1 animate-bounce rounded-full bg-muted [animation-delay:0ms]" />
      <span className="h-1 w-1 animate-bounce rounded-full bg-muted [animation-delay:150ms]" />
      <span className="h-1 w-1 animate-bounce rounded-full bg-muted [animation-delay:300ms]" />
    </span>
  )
}
