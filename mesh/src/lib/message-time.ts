import { parseFederatedTimestamp, INVALID_FEDERATED_TIME_LABEL } from './federated-time'

/**
 * Reader-facing time formatting for the message timeline.
 *
 * Two problems this fixes over calling `formatFederatedTimestamp` directly:
 *
 * 1. The timeline hard-coded `MM/dd/yyyy h:mm a` and `HH:mm`, which is wrong
 *    for most of the world and inconsistent between the two call sites in the
 *    same row. Everything here goes through `Intl` so it follows the user's
 *    locale and 12/24-hour preference.
 * 2. Nothing emitted a machine-readable value, so assistive technology and
 *    copy/paste got a display string with no date attached. `isoTimestamp`
 *    feeds `<time dateTime>`.
 */

function formatter(options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat | null {
  try {
    return new Intl.DateTimeFormat(undefined, options)
  } catch {
    return null
  }
}

const clockFormatter = formatter({ hour: 'numeric', minute: '2-digit' })
const fullFormatter = formatter({ dateStyle: 'long', timeStyle: 'short' })
const weekdayFormatter = formatter({ weekday: 'long' })
const dayFormatter = formatter({ weekday: 'long', month: 'long', day: 'numeric' })
const dayWithYearFormatter = formatter({ year: 'numeric', month: 'long', day: 'numeric' })

/** Local-midnight day index. Used both for dividers and for group breaking. */
export function dayIndex(value: unknown): number | null {
  const parsed = parseFederatedTimestamp(value)
  if (!parsed) return null
  return Math.floor(
    (parsed.getTime() - parsed.getTimezoneOffset() * 60_000) / 86_400_000,
  )
}

export function isSameDay(a: unknown, b: unknown): boolean {
  const left = dayIndex(a)
  const right = dayIndex(b)
  if (left === null || right === null) return false
  return left === right
}

/** ISO-8601 for `<time dateTime>`; null when the timestamp is unusable. */
export function isoTimestamp(value: unknown): string | undefined {
  const parsed = parseFederatedTimestamp(value)
  if (!parsed) return undefined
  try {
    return parsed.toISOString()
  } catch {
    return undefined
  }
}

/** Short clock reading for the grouped-message gutter, e.g. "3:14 PM". */
export function formatClockTime(value: unknown): string {
  const parsed = parseFederatedTimestamp(value)
  if (!parsed) return INVALID_FEDERATED_TIME_LABEL
  return clockFormatter?.format(parsed) ?? INVALID_FEDERATED_TIME_LABEL
}

/** Full absolute reading used for titles and accessible names. */
export function formatFullTime(value: unknown): string {
  const parsed = parseFederatedTimestamp(value)
  if (!parsed) return INVALID_FEDERATED_TIME_LABEL
  return fullFormatter?.format(parsed) ?? INVALID_FEDERATED_TIME_LABEL
}

/**
 * Day-divider label. Recent days get a relative name because that is how people
 * actually refer to them; anything older than a week gets an absolute date so
 * the label stays unambiguous.
 */
export function formatDayLabel(value: unknown, now: Date = new Date()): string {
  const parsed = parseFederatedTimestamp(value)
  if (!parsed) return INVALID_FEDERATED_TIME_LABEL

  const target = dayIndex(parsed)
  const today = dayIndex(now)
  if (target === null || today === null) return INVALID_FEDERATED_TIME_LABEL

  const delta = today - target
  if (delta === 0) return 'Today'
  if (delta === 1) return 'Yesterday'
  if (delta > 1 && delta < 7) {
    return weekdayFormatter?.format(parsed) ?? INVALID_FEDERATED_TIME_LABEL
  }
  if (parsed.getFullYear() === now.getFullYear()) {
    return dayFormatter?.format(parsed) ?? INVALID_FEDERATED_TIME_LABEL
  }
  return dayWithYearFormatter?.format(parsed) ?? INVALID_FEDERATED_TIME_LABEL
}
