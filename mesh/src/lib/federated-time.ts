import { formatShortDate, formatShortDateTime } from './message-time'

export const INVALID_FEDERATED_TIME_LABEL = 'Time unavailable'

/**
 * Parse an untrusted timestamp without allowing malformed federated data to
 * create an Invalid Date or throw during rendering.
 */
export function parseFederatedTimestamp(value: unknown): Date | null {
  try {
    let epochMilliseconds: number

    if (value instanceof Date) {
      epochMilliseconds = value.getTime()
    } else if (typeof value === 'number') {
      epochMilliseconds = value
    } else if (typeof value === 'string') {
      const normalized = value.trim()
      if (!normalized) return null
      epochMilliseconds = Date.parse(normalized)
    } else {
      return null
    }

    if (!Number.isFinite(epochMilliseconds)) return null

    const parsed = new Date(epochMilliseconds)
    return Number.isFinite(parsed.getTime()) ? parsed : null
  } catch {
    return null
  }
}

export function federatedTimestampMilliseconds(value: unknown): number | null {
  return parseFederatedTimestamp(value)?.getTime() ?? null
}

/**
 * The reader-facing patterns Mesh actually renders. Each one is produced by
 * `Intl.DateTimeFormat` through message-time, so the result follows the
 * reader's locale and 12/24-hour preference instead of a hard-coded shape.
 * Anything outside this table is treated exactly like an unusable timestamp:
 * the call site gets the fallback rather than a broken message tree.
 */
const SUPPORTED_TIMESTAMP_PATTERNS = new Map<string, (value: Date) => string>([
  ['MMM d', formatShortDate],
  ['MMM d, HH:mm', formatShortDateTime],
])

/**
 * Format an untrusted timestamp with a stable reader-facing fallback. The
 * pattern guard also contains an unsupported pattern at the call site instead
 * of breaking the message tree.
 */
export function formatFederatedTimestamp(
  value: unknown,
  pattern: string,
  fallback = INVALID_FEDERATED_TIME_LABEL,
): string {
  const parsed = parseFederatedTimestamp(value)
  if (!parsed) return fallback

  const formatPattern = SUPPORTED_TIMESTAMP_PATTERNS.get(pattern)
  if (!formatPattern) return fallback

  const formatted = formatPattern(parsed)
  // A runtime without the requested formatter degrades to the caller's own
  // fallback copy rather than the generic label.
  return formatted === INVALID_FEDERATED_TIME_LABEL ? fallback : formatted
}
