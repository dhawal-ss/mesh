import { federatedTimestampMilliseconds } from './federated-time'

/**
 * Depth ceiling for structural comparison.
 *
 * The deepest renderer DTO is a message: `attachments` (array) -> attachment
 * (object) -> `thumbnail` (object) -> leaves. Four levels covers every shape
 * the IPC layer produces. Exhausting the budget reports "changed", which is
 * the conservative answer and matches the previous reference-only behaviour.
 */
const MAX_COMPARISON_DEPTH = 4

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false
  const prototype: unknown = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function sameValue(left: unknown, right: unknown, depth: number): boolean {
  if (Object.is(left, right)) return true
  if (depth <= 0) return false

  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right)) return false
    if (left.length !== right.length) return false
    return left.every((entry, index) => sameValue(entry, right[index], depth - 1))
  }

  if (!isPlainObject(left) || !isPlainObject(right)) return false
  const leftKeys = Object.keys(left)
  if (leftKeys.length !== Object.keys(right).length) return false
  return leftKeys.every(
    (key) =>
      Object.prototype.hasOwnProperty.call(right, key)
      && sameValue(left[key], right[key], depth - 1),
  )
}

/**
 * Report whether `patch` actually differs from `current`.
 *
 * Reference equality alone is not usable here: every IPC response is freshly
 * JSON-deserialized, so a message's `attachments` array and `reactions` record
 * are new objects on every poll even when nothing changed. A per-key
 * `Object.is` therefore always reported a change and disabled entity identity
 * preservation across all four normalized stores.
 */
export function patchChanges<T extends object>(current: T, patch: Partial<T>): boolean {
  return (Object.keys(patch) as Array<keyof T>).some(
    (key) => !sameValue(current[key], patch[key], MAX_COMPARISON_DEPTH),
  )
}

const timelineEpochCache = new WeakMap<object, number>()

/**
 * Memoized sort key for timeline entities.
 *
 * Timeline comparators run O(n log n) times per merge, and parsing the ISO
 * timestamp inside the comparator allocated two `Date` objects per comparison.
 * The value is cached by entity identity, so each message object is parsed
 * once and nothing is written onto the DTO that could travel back over IPC.
 *
 * An unparseable federated timestamp keeps the previous `?? 0` fallback so
 * ordering stays total.
 */
export function timelineEpochMilliseconds(entity: { readonly timestamp: string }): number {
  const cached = timelineEpochCache.get(entity)
  if (cached !== undefined) return cached
  const epoch = federatedTimestampMilliseconds(entity.timestamp) ?? 0
  timelineEpochCache.set(entity, epoch)
  return epoch
}
