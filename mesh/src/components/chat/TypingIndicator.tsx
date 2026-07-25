import { useEffect, useMemo } from 'react'
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
  const typingUsers = useMemo(() => {
    const now = Date.now()
    return typingEntries
      .filter((user) => user.expiresAt > now)
      .map((user) => user.displayName)
  }, [typingEntries])

  // Periodically prune expired typing indicators
  useEffect(() => {
    const interval = setInterval(() => {
      pruneExpired(channelId)
    }, 2000)
    return () => clearInterval(interval)
  }, [channelId, pruneExpired])

  if (typingUsers.length === 0) {
    return <div className="h-6" />
  }

  const text = formatTypingText(typingUsers)

  return (
    <div className="flex h-6 items-center gap-1.5 px-4 text-xs text-muted">
      <TypingDots />
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
    <span className="inline-flex items-center gap-0.5">
      <span className="h-1 w-1 animate-bounce rounded-full bg-muted [animation-delay:0ms]" />
      <span className="h-1 w-1 animate-bounce rounded-full bg-muted [animation-delay:150ms]" />
      <span className="h-1 w-1 animate-bounce rounded-full bg-muted [animation-delay:300ms]" />
    </span>
  )
}
