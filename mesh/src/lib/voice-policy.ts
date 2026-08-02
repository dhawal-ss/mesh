/**
 * Pure policy functions for voice engine behavior.
 *
 * These are extracted from VoiceEngine so that relay rebuild decisions,
 * reconnect backoff, and churn handling can be unit-tested without the
 * hardcoded SimplePeer instantiation and browser WebRTC stack.
 *
 * The voice engine retains the stateful side effects (creating peer
 * connections, managing streams); the policy lives here as pure functions.
 */

import type { VoiceMemberSnapshot } from '../types/ipc'

/// Threshold at which a relay is elected for large sessions.
/// Mirrored from voice-session.ts for test isolation.
export const VOICE_RELAY_THRESHOLD = 8

/// Reconnect backoff constants (ms).
export const RECONNECT_BASE_DELAY_MS = 500
export const RECONNECT_MAX_DELAY_MS = 10_000

/// Debounce for relay rebuild when rapid churn occurs.
export const RELAY_REBUILD_DEBOUNCE_MS = 250
export const RELAY_REBUILD_MAX_DELAY_MS = 1000

/**
 * Determine the relay peer for a given set of members, or null if no relay
 * is required (session is small enough for mesh).
 *
 * Relay is deterministically elected as the member with the lexicographically
 * lowest public key among all session members, but only when the session
 * exceeds VOICE_RELAY_THRESHOLD.
 */
export function electRelay(members: VoiceMemberSnapshot[]): string | null {
  if (members.length <= VOICE_RELAY_THRESHOLD) {
    return null
  }
  const keys = members.map((m) => m.publicKey).filter((k) => k.length > 0)
  if (keys.length === 0) return null
  keys.sort((a, b) => a.localeCompare(b))
  return keys[0]
}

/**
 * Given the previous and current member lists, decide whether the relay
 * has changed and a topology rebuild is needed.
 *
 * Returns:
 *   - 'unchanged': relay is the same (or neither set needs a relay)
 *   - 'elected': a relay is now needed (was none before)
 *   - 'changed': the relay peer has rotated
 *   - 'dissolved': a relay was in use but the session shrank below threshold
 */
export type RelayTransition = 'unchanged' | 'elected' | 'changed' | 'dissolved'

export function detectRelayTransition(
  prevMembers: VoiceMemberSnapshot[],
  currMembers: VoiceMemberSnapshot[],
): RelayTransition {
  const prevRelay = electRelay(prevMembers)
  const currRelay = electRelay(currMembers)

  if (prevRelay === null && currRelay === null) return 'unchanged'
  if (prevRelay === null && currRelay !== null) return 'elected'
  if (prevRelay !== null && currRelay === null) return 'dissolved'
  if (prevRelay === currRelay) return 'unchanged'
  return 'changed'
}

/**
 * Calculate the reconnect delay for a given attempt count using bounded
 * exponential backoff with a small randomized jitter.
 *
 * Attempt 1: 500ms (+ jitter)
 * Attempt 2: 1000ms (+ jitter)
 * Attempt 3: 2000ms (+ jitter)
 * Attempt 4: 4000ms (+ jitter)
 * ...capped at RECONNECT_MAX_DELAY_MS
 *
 * The jitter parameter is injectable for deterministic tests; pass 0 for
 * zero jitter, or a fixed value in tests. In production, use Math.random().
 */
export function reconnectDelayMs(attempt: number, jitter: number = 0): number {
  if (attempt < 1) return RECONNECT_BASE_DELAY_MS
  const exponential = RECONNECT_BASE_DELAY_MS * Math.pow(2, attempt - 1)
  const capped = Math.min(exponential, RECONNECT_MAX_DELAY_MS)
  // Apply up to 20% jitter
  const jitterOffset = Math.floor(capped * 0.2 * Math.max(0, Math.min(1, jitter)))
  return capped + jitterOffset
}

/**
 * Determine whether a relay-rebuild should proceed given the current state.
 *
 * A rebuild should only execute if:
 *   - the new relay key differs from the last-applied relay key
 *   - OR the session just crossed the threshold (no previous relay)
 *
 * This prevents unnecessary topology thrash under rapid churn where the
 * relay role actually stays with the same peer.
 */
export function shouldExecuteRelayRebuild(
  lastAppliedRelayKey: string | null,
  newRelayKey: string | null,
): boolean {
  // Dissolving (no longer needs a relay) should rebuild to reset state
  if (lastAppliedRelayKey !== null && newRelayKey === null) {
    return true
  }
  // Electing a new relay where there was none
  if (lastAppliedRelayKey === null && newRelayKey !== null) {
    return true
  }
  // Both null or both equal = no rebuild
  if (lastAppliedRelayKey === newRelayKey) {
    return false
  }
  // Different relay keys = rebuild
  return true
}

/**
 * Given rapid departures, coalesce rebuild requests using debounce semantics.
 * This is a pure state machine that tracks pending rebuilds without actual
 * timers: tests can drive it by advancing a logical clock.
 */
export interface RebuildDebouncer {
  pending: boolean
  firstRequestAt: number
  lastRequestAt: number
}

export function debouncerInit(): RebuildDebouncer {
  return { pending: false, firstRequestAt: 0, lastRequestAt: 0 }
}

export function debouncerRequest(
  state: RebuildDebouncer,
  nowMs: number,
): RebuildDebouncer {
  if (!state.pending) {
    return {
      pending: true,
      firstRequestAt: nowMs,
      lastRequestAt: nowMs,
    }
  }
  return {
    ...state,
    lastRequestAt: nowMs,
  }
}

/**
 * Check whether the debouncer should fire at the given time. Returns true if:
 *   - debounce window elapsed since last request, OR
 *   - max delay exceeded since first request
 */
export function debouncerShouldFire(state: RebuildDebouncer, nowMs: number): boolean {
  if (!state.pending) return false
  const sinceFirst = nowMs - state.firstRequestAt
  const sinceLast = nowMs - state.lastRequestAt
  if (sinceFirst >= RELAY_REBUILD_MAX_DELAY_MS) return true
  if (sinceLast >= RELAY_REBUILD_DEBOUNCE_MS) return true
  return false
}

export function debouncerReset(): RebuildDebouncer {
  return debouncerInit()
}
