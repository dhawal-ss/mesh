/**
 * Where each store says how to forget the account that just signed out.
 *
 * This module imports nothing, and that is the point. Every store can reach it
 * without creating an import edge back into the store graph, so registration
 * costs the startup chunk nothing and cannot introduce a cycle.
 *
 * The problem it replaces: `account-transition.ts` inlined the initial-state
 * literal of nine stores, spread across four different mechanisms -- inline
 * `setState` blobs, module functions, a lazy registry, and caller-side clears.
 * The shape of a store lived in two places, one of them a file the store's
 * author had no reason to open, so any new field silently survived an account
 * switch. `useThreadListStore` had already been missed that way, leaving one
 * account's thread list on screen for the next.
 *
 * Now the reset lives beside the state it resets, and the lint rule in
 * `eslint.config.js` fails any `src/store/*.ts` that creates a store without
 * registering one.
 */

/** `null` when the account that went away could not be identified. */
export type AccountResetHandler = (removedAccountId?: string | null) => void

const handlers = new Map<string, AccountResetHandler>()

/**
 * Declare how a store forgets an account. Call at module scope, beside the
 * `create<>()` whose state it resets.
 *
 * Keyed by name so a module evaluated twice -- which vitest does routinely --
 * replaces its handler rather than accumulating duplicates.
 */
export function registerAccountReset(name: string, reset: AccountResetHandler): void {
  handlers.set(name, reset)
}

/**
 * Run every registered reset.
 *
 * One store failing must not strand the rest: the account has already gone and
 * whatever is left behind belongs to it, so the remaining stores are cleared
 * and the first failure is re-thrown once the sweep is complete.
 */
export function resetAllAccountState(removedAccountId?: string | null): void {
  let firstFailure: unknown = null
  for (const reset of handlers.values()) {
    try {
      reset(removedAccountId)
    } catch (error) {
      firstFailure ??= error
    }
  }
  if (firstFailure !== null) throw firstFailure
}

/** The stores that have declared a reset. Exported for the coverage test. */
export function registeredAccountResets(): readonly string[] {
  return [...handlers.keys()]
}
