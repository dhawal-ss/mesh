import { format } from 'date-fns'

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
 * Format an untrusted timestamp with a stable reader-facing fallback. The
 * formatter guard also contains accidental invalid date-fns patterns at the
 * call site instead of breaking the message tree.
 */
export function formatFederatedTimestamp(
  value: unknown,
  pattern: string,
  fallback = INVALID_FEDERATED_TIME_LABEL,
): string {
  const parsed = parseFederatedTimestamp(value)
  if (!parsed) return fallback

  try {
    return format(parsed, pattern)
  } catch {
    return fallback
  }
}
