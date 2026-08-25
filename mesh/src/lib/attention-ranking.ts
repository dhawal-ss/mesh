/**
 * Ordering rules for the surfaces that answer "where do I go next": Home and
 * the community desk.
 *
 * Two signals are deliberately treated differently:
 *
 * - A **callout** (someone named this person through an unread mention) floats.
 *   It is a request addressed to them, not a volume measurement, so lifting it
 *   above a quieter destination is the correct answer.
 * - **Plain unread** never reorders an already-meaningful order. A firehose
 *   room with two hundred unread messages must not permanently outrank the room
 *   the person actually works in. Unread only decides placement where the
 *   alternative is an arbitrary order, such as the tail of a truncated list.
 *   An explicit "mark as unread" counts as this same signal, not a callout.
 *
 * Both helpers are stable partitions rather than sorts, so whatever order the
 * caller established, whether navigation recency or server order, survives inside each
 * band untouched.
 */

export interface AttentionTarget {
  unreadCount: number
  /** Absent on cached records that predate mention counting. */
  unreadMentions?: number
  /** The person's own explicit "mark as unread" marker, independent of unreadCount. */
  unreadMarked?: boolean
}

/**
 * Resolves whether a destination has been silenced. Silenced destinations never
 * compete for attention, however many messages they hold.
 */
export type MutedLookup<T extends AttentionTarget = AttentionTarget> = (target: T) => boolean

export function isCallout<T extends AttentionTarget>(
  target: T,
  isMuted: MutedLookup<T>,
): boolean {
  return (target.unreadMentions ?? 0) > 0 && !isMuted(target)
}

export function isUnread<T extends AttentionTarget>(
  target: T,
  isMuted: MutedLookup<T>,
): boolean {
  return (
    ((target.unreadCount ?? 0) > 0 || (target.unreadMentions ?? 0) > 0 || Boolean(target.unreadMarked))
    && !isMuted(target)
  )
}

/**
 * Lifts callouts to the front, leaving every other relative position intact.
 * Use where the incoming order already means something.
 */
export function calloutsFirst<T extends AttentionTarget>(
  targets: readonly T[],
  isMuted: MutedLookup<T>,
): T[] {
  return partition(targets, (target) => (isCallout(target, isMuted) ? 0 : 1), 2)
}

/**
 * Lifts callouts, then anything unread, leaving every other relative position
 * intact. Use where the incoming order is arbitrary.
 */
export function attentionFirst<T extends AttentionTarget>(
  targets: readonly T[],
  isMuted: MutedLookup<T>,
): T[] {
  return partition(
    targets,
    (target) => (isCallout(target, isMuted) ? 0 : isUnread(target, isMuted) ? 1 : 2),
    3,
  )
}

function partition<T>(
  targets: readonly T[],
  bandOf: (target: T) => number,
  bandCount: number,
): T[] {
  const bands: T[][] = Array.from({ length: bandCount }, () => [])
  for (const target of targets) bands[bandOf(target)].push(target)
  return bands.flat()
}
