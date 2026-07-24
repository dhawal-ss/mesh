/**
 * Unit tests for the pure voice policy functions.
 *
 * These tests validate the relay election, transition detection, reconnect
 * backoff, and debouncer state machine — all without touching SimplePeer
 * or any browser WebRTC stack.
 */
import { describe, it, expect } from 'vitest'
import {
  electRelay,
  detectRelayTransition,
  reconnectDelayMs,
  shouldExecuteRelayRebuild,
  debouncerInit,
  debouncerRequest,
  debouncerShouldFire,
  VOICE_RELAY_THRESHOLD,
  RECONNECT_BASE_DELAY_MS,
  RECONNECT_MAX_DELAY_MS,
  RELAY_REBUILD_DEBOUNCE_MS,
  RELAY_REBUILD_MAX_DELAY_MS,
} from './voice-policy'
import type { VoiceMemberSnapshot } from '../types/ipc'

// Helper: build a minimal voice member snapshot
function member(publicKey: string): VoiceMemberSnapshot {
  return {
    publicKey,
    joinedAt: '2024-01-01T00:00:00Z',
    lastSeenAt: '2024-01-01T00:00:00Z',
    isLocal: false,
  }
}

// ─── electRelay ─────────────────────────────────────

describe('electRelay', () => {
  it('returns null for empty sessions', () => {
    expect(electRelay([])).toBeNull()
  })

  it('returns null when below the relay threshold', () => {
    const members = Array.from({ length: VOICE_RELAY_THRESHOLD }, (_, i) =>
      member(`key-${i}`),
    )
    expect(electRelay(members)).toBeNull()
  })

  it('elects the lexicographically lowest key when above threshold', () => {
    const members = [
      member('zzz'),
      member('aaa'),
      member('mmm'),
      member('bbb'),
      member('ccc'),
      member('ddd'),
      member('eee'),
      member('fff'),
      member('ggg'), // 9 members > threshold of 8
    ]
    expect(electRelay(members)).toBe('aaa')
  })

  it('is deterministic regardless of input order', () => {
    const keys = ['alice', 'bob', 'carol', 'dave', 'eve', 'frank', 'gina', 'hal', 'ian']
    const scenario1 = electRelay(keys.map(member))
    const scenario2 = electRelay([...keys].reverse().map(member))
    expect(scenario1).toBe(scenario2)
    expect(scenario1).toBe('alice')
  })

  it('skips empty public keys', () => {
    const members = [
      member(''),
      member('bbb'),
      member('aaa'),
      member('ccc'),
      member('ddd'),
      member('eee'),
      member('fff'),
      member('ggg'),
      member('hhh'),
    ]
    expect(electRelay(members)).toBe('aaa')
  })
})

// ─── detectRelayTransition ──────────────────────────

describe('detectRelayTransition', () => {
  const manyMembers = (count: number, prefix: string) =>
    Array.from({ length: count }, (_, i) => member(`${prefix}-${i.toString().padStart(3, '0')}`))

  it('reports unchanged when both are below threshold', () => {
    const prev = manyMembers(5, 'p')
    const curr = manyMembers(6, 'p')
    expect(detectRelayTransition(prev, curr)).toBe('unchanged')
  })

  it('reports elected when the session crosses the threshold', () => {
    const prev = manyMembers(VOICE_RELAY_THRESHOLD, 'p')
    const curr = manyMembers(VOICE_RELAY_THRESHOLD + 1, 'p')
    expect(detectRelayTransition(prev, curr)).toBe('elected')
  })

  it('reports dissolved when the session shrinks below threshold', () => {
    const prev = manyMembers(VOICE_RELAY_THRESHOLD + 2, 'p')
    const curr = manyMembers(VOICE_RELAY_THRESHOLD, 'p')
    expect(detectRelayTransition(prev, curr)).toBe('dissolved')
  })

  it('reports changed when the relay peer rotates', () => {
    // Prev: 9 members, lowest key is p-000
    // Curr: p-000 leaves, now lowest is p-001
    const prev = manyMembers(9, 'p')
    const curr = prev.slice(1) // remove p-000
    // Still 8 members which equals threshold — at exactly threshold no relay
    // needed, so this should be 'dissolved'
    expect(curr.length).toBe(VOICE_RELAY_THRESHOLD)
    expect(detectRelayTransition(prev, curr)).toBe('dissolved')
  })

  it('reports changed when the relay peer rotates within large sessions', () => {
    const prev = manyMembers(10, 'p')
    // Remove p-000 (the current relay), but add p-100 so we stay above threshold
    const curr = [...prev.slice(1), member('p-100')]
    expect(curr.length).toBeGreaterThan(VOICE_RELAY_THRESHOLD)
    expect(detectRelayTransition(prev, curr)).toBe('changed')
  })

  it('reports unchanged when the relay peer stays the same', () => {
    const prev = manyMembers(10, 'p')
    // Remove a non-relay member; relay (p-000) stays
    const curr = prev.filter((m) => m.publicKey !== 'p-005')
    expect(detectRelayTransition(prev, curr)).toBe('unchanged')
  })
})

// ─── reconnectDelayMs ───────────────────────────────

describe('reconnectDelayMs', () => {
  it('returns the base delay for the first attempt', () => {
    expect(reconnectDelayMs(1)).toBe(RECONNECT_BASE_DELAY_MS)
  })

  it('doubles each attempt up to the max', () => {
    expect(reconnectDelayMs(1)).toBe(500)
    expect(reconnectDelayMs(2)).toBe(1000)
    expect(reconnectDelayMs(3)).toBe(2000)
    expect(reconnectDelayMs(4)).toBe(4000)
    expect(reconnectDelayMs(5)).toBe(8000)
  })

  it('caps at the maximum delay', () => {
    expect(reconnectDelayMs(10)).toBe(RECONNECT_MAX_DELAY_MS)
    expect(reconnectDelayMs(100)).toBe(RECONNECT_MAX_DELAY_MS)
  })

  it('applies jitter proportionally', () => {
    // Jitter of 0.5 should add 10% of the delay
    const delay = reconnectDelayMs(2, 0.5) // base = 1000
    expect(delay).toBeGreaterThanOrEqual(1000)
    expect(delay).toBeLessThanOrEqual(1200) // 1000 + 20% max
  })

  it('handles zero and negative attempts safely', () => {
    expect(reconnectDelayMs(0)).toBe(RECONNECT_BASE_DELAY_MS)
    expect(reconnectDelayMs(-1)).toBe(RECONNECT_BASE_DELAY_MS)
  })
})

// ─── shouldExecuteRelayRebuild ──────────────────────

describe('shouldExecuteRelayRebuild', () => {
  it('skips rebuild when both states are null', () => {
    expect(shouldExecuteRelayRebuild(null, null)).toBe(false)
  })

  it('skips rebuild when the relay key is unchanged', () => {
    expect(shouldExecuteRelayRebuild('alice', 'alice')).toBe(false)
  })

  it('rebuilds when the relay key changes', () => {
    expect(shouldExecuteRelayRebuild('alice', 'bob')).toBe(true)
  })

  it('rebuilds when a relay is newly elected', () => {
    expect(shouldExecuteRelayRebuild(null, 'alice')).toBe(true)
  })

  it('rebuilds when the relay role dissolves', () => {
    expect(shouldExecuteRelayRebuild('alice', null)).toBe(true)
  })
})

// ─── Rebuild debouncer ──────────────────────────────

describe('rebuild debouncer', () => {
  it('starts in a non-pending state', () => {
    const s = debouncerInit()
    expect(s.pending).toBe(false)
    expect(debouncerShouldFire(s, 1000)).toBe(false)
  })

  it('transitions to pending on first request', () => {
    const s = debouncerRequest(debouncerInit(), 100)
    expect(s.pending).toBe(true)
    expect(s.firstRequestAt).toBe(100)
    expect(s.lastRequestAt).toBe(100)
  })

  it('updates lastRequestAt on subsequent requests', () => {
    let s = debouncerRequest(debouncerInit(), 100)
    s = debouncerRequest(s, 150)
    s = debouncerRequest(s, 200)
    expect(s.firstRequestAt).toBe(100)
    expect(s.lastRequestAt).toBe(200)
  })

  it('does not fire before debounce window', () => {
    const s = debouncerRequest(debouncerInit(), 100)
    expect(debouncerShouldFire(s, 100 + RELAY_REBUILD_DEBOUNCE_MS - 1)).toBe(false)
  })

  it('fires after debounce window elapses since last request', () => {
    const s = debouncerRequest(debouncerInit(), 100)
    expect(debouncerShouldFire(s, 100 + RELAY_REBUILD_DEBOUNCE_MS)).toBe(true)
  })

  it('fires after max delay even under sustained churn', () => {
    let s = debouncerRequest(debouncerInit(), 100)
    // Request again every 100ms, never letting the debounce window expire
    for (let t = 200; t < 100 + RELAY_REBUILD_MAX_DELAY_MS; t += 100) {
      s = debouncerRequest(s, t)
      expect(debouncerShouldFire(s, t)).toBe(false)
    }
    // At max delay, it must fire regardless of recent requests
    expect(debouncerShouldFire(s, 100 + RELAY_REBUILD_MAX_DELAY_MS)).toBe(true)
  })

  it('handles rapid churn scenario (5 departures in 50ms)', () => {
    let s = debouncerInit()
    for (let t = 100; t < 150; t += 10) {
      s = debouncerRequest(s, t)
    }
    // Should not fire during the burst
    expect(debouncerShouldFire(s, 145)).toBe(false)
    // Should fire after debounce window since last request (t=140)
    expect(debouncerShouldFire(s, 140 + RELAY_REBUILD_DEBOUNCE_MS)).toBe(true)
  })
})
