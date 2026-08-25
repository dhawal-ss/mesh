/*
 * Shared timeline machinery for the channel and direct-message stores.
 *
 * These two stores model the same thing twice: a bounded, ordered, normalized
 * window of messages per conversation, with an LRU over conversations. They
 * were written separately and drifted, so several fixes had to be applied
 * twice and one of them was missed. Everything here is the part that is
 * genuinely identical, extracted once so a fix lands in one place.
 *
 * Deliberately not extracted: the merge policy for a single message. Channels
 * protect a `sent` echo from being regressed by a late `pending` one, and DMs
 * have their own rules, so that decision stays with each store and is passed in.
 */

/** Whether two id orders are the same, so an unchanged order keeps identity. */
export function sameOrder(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index])
}

/** Drop every entry in a conversation-scoped record for the evicted ids. */
export function withoutScopes<T>(
  values: Record<string, T>,
  scopeIds: readonly string[],
): Record<string, T> {
  let next = values
  for (const scopeId of scopeIds) {
    // hasOwnProperty rather than `in`: a scope id is never a prototype key in
    // practice, but the DM store already took the careful form and there is no
    // reason for the shared one to be the looser of the two.
    if (!Object.prototype.hasOwnProperty.call(next, scopeId)) continue
    next = { ...next }
    delete next[scopeId]
  }
  return next
}

/**
 * Keep only the newest `size` messages.
 *
 * Returns the input untouched when it already fits, so the common case costs
 * no allocation and every entity in it keeps its identity.
 */
export function boundLatestWindow<T>(items: T[], size: number): T[] {
  if (items.length <= size) return items
  return items.slice(-size)
}

/**
 * Keep the oldest `size` messages while browsing history, and report how many
 * newer ones were dropped so the store can show a gap rather than pretend the
 * timeline is continuous.
 */
export function boundOlderWindow<T>(
  items: T[],
  size: number,
): { items: T[]; trimmedNewerCount: number } {
  if (items.length <= size) return { items, trimmedNewerCount: 0 }
  return { items: items.slice(0, size), trimmedNewerCount: items.length - size }
}

/**
 * Touch `scopeId` in the LRU, evict past `limit`, and prune every scoped record.
 *
 * `patch` wins over `state` per key, so a caller can hand in the records it has
 * already rebuilt and let the untouched ones come from state.
 */
export function retainScope<S extends object>(
  state: S,
  patch: Partial<S>,
  options: {
    scopeId: string
    recencyKey: keyof S & string
    scopedKeys: readonly (keyof S & string)[]
    limit: number
  },
): Partial<S> {
  const { scopeId, recencyKey, scopedKeys, limit } = options
  const current = state[recencyKey] as readonly string[]
  const recency = [...current.filter((cached) => cached !== scopeId), scopeId]
  const evicted = recency.slice(0, -limit)

  const next: Record<string, unknown> = { [recencyKey]: recency.slice(-limit) }
  for (const key of scopedKeys) {
    const source = (patch[key] ?? state[key]) as Record<string, unknown>
    next[key] = withoutScopes(source, evicted)
  }
  return next as Partial<S>
}

/**
 * Merge `incoming` into an already sorted `existing`, preserving identity.
 *
 * One pass builds an alias index, so this is O(n + m) rather than a scan per
 * incoming message. A message can be known by more than one id at once (a
 * renderer request id, a transaction id, and a server event id all name the
 * same send), which is why identity is a list of aliases rather than one key:
 * code that keys on a single id treats an acknowledgement as a second arrival.
 *
 * `existing` is returned unchanged when nothing moved, so the ordered
 * projection and every entity in it keep their identity and no consumer
 * re-renders.
 */
export function mergeTimeline<T>(
  existing: T[],
  incoming: readonly T[],
  policy: {
    aliases: (item: T) => string[]
    merge: (existing: T, incoming: T) => T
    compare: (left: T, right: T) => number
  },
): T[] {
  if (incoming.length === 0) return existing

  const merged = [...existing]
  const slotAliases: string[][] = []
  const aliasSlots = new Map<string, number>()

  const indexSlot = (slot: number, item: T) => {
    const aliases = policy.aliases(item)
    slotAliases[slot] = aliases
    for (const alias of aliases) {
      if (!aliasSlots.has(alias)) aliasSlots.set(alias, slot)
    }
  }

  for (let slot = 0; slot < merged.length; slot += 1) indexSlot(slot, merged[slot])

  let dirty = false
  for (const item of incoming) {
    // The lowest matching slot wins, matching the original findIndex scan.
    let slot = -1
    for (const alias of policy.aliases(item)) {
      const candidate = aliasSlots.get(alias)
      if (candidate !== undefined && (slot < 0 || candidate < slot)) slot = candidate
    }

    if (slot < 0) {
      indexSlot(merged.length, item)
      merged.push(item)
      dirty = true
      continue
    }

    const next = policy.merge(merged[slot], item)
    if (next === merged[slot]) continue
    merged[slot] = next
    dirty = true
    // A reconciled echo can swap its event id, so retire the aliases this slot
    // owned before publishing the new ones.
    for (const alias of slotAliases[slot]) {
      if (aliasSlots.get(alias) === slot) aliasSlots.delete(alias)
    }
    indexSlot(slot, next)
  }

  if (!dirty) return existing
  return merged.sort(policy.compare)
}
