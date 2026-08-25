import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const sound = vi.hoisted(() => ({
  play: vi.fn(() => Promise.resolve(true)),
}))

vi.mock('../lib/interface-sounds', () => ({
  playInterfaceSound: sound.play,
}))

import {
  matrixLinkPhaseFor,
  resetNetworkRecoveryForTest,
  resetNetworkStateForAccountTransition,
  useNetworkStore,
} from './network'

describe('Matrix link phase', () => {
  it('separates a signed-out device from a stalled sync', () => {
    expect(matrixLinkPhaseFor({ authenticated: false, syncRunning: false })).toBe('signed-out')
    expect(matrixLinkPhaseFor({ authenticated: false, syncRunning: true })).toBe('signed-out')
    expect(matrixLinkPhaseFor({ authenticated: true, syncRunning: false })).toBe('reconnecting')
    expect(matrixLinkPhaseFor({ authenticated: true, syncRunning: true })).toBe('online')
  })

  it('publishes nothing until a backend status has been read', () => {
    resetNetworkStateForAccountTransition()
    expect(useNetworkStore.getState().matrixLink).toBeNull()
  })

  it('leaves an unchanged phase alone so a five-second poll cannot restart its clock', () => {
    resetNetworkStateForAccountTransition()
    const store = useNetworkStore.getState()
    store.setMatrixLink('reconnecting')
    const first = useNetworkStore.getState().matrixLink

    store.setMatrixLink('reconnecting')

    expect(useNetworkStore.getState().matrixLink).toBe(first)
  })

  it('records when a new phase started', () => {
    resetNetworkStateForAccountTransition()
    const store = useNetworkStore.getState()
    store.setMatrixLink('reconnecting')
    store.setMatrixLink('unreachable')

    expect(useNetworkStore.getState().matrixLink).toMatchObject({ phase: 'unreachable' })
  })

  it('clears the phase at an account boundary', () => {
    useNetworkStore.getState().setMatrixLink('reconnecting')
    resetNetworkStateForAccountTransition()

    expect(useNetworkStore.getState().matrixLink).toBeNull()
  })
})

describe('network recovery presentation', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-02T00:00:00.000Z'))
    sound.play.mockClear()
    resetNetworkRecoveryForTest()
    useNetworkStore.setState({
      status: { state: 'connected', peerCount: 0, averageLatency: 0 },
      recoveredConnection: null,
    })
  })

  afterEach(() => {
    resetNetworkRecoveryForTest()
    vi.useRealTimers()
  })

  it('publishes an internal retry signal without a visible or audible recovery cue', () => {
    useNetworkStore.getState().setStatus({ state: 'disconnected' })
    vi.advanceTimersByTime(3_000)
    useNetworkStore.getState().setStatus({ state: 'connected' })

    expect(useNetworkStore.getState().recoveredConnection).toMatchObject({ durationMs: 3_000 })
    expect(sound.play).not.toHaveBeenCalled()

    vi.advanceTimersByTime(4_000)
    expect(useNetworkStore.getState().recoveredConnection).toBeNull()
  })

  it('keeps sub-threshold reconnects quiet', () => {
    useNetworkStore.getState().setStatus({ state: 'disconnected' })
    vi.advanceTimersByTime(2_999)
    useNetworkStore.getState().setStatus({ state: 'connected' })

    expect(useNetworkStore.getState().recoveredConnection).toBeNull()
    expect(sound.play).not.toHaveBeenCalled()
  })

  it('cancels the prior account recovery clock and banner timer', () => {
    useNetworkStore.getState().setStatus({ state: 'disconnected' })
    vi.advanceTimersByTime(3_000)
    useNetworkStore.getState().setStatus({ state: 'connected' })
    expect(useNetworkStore.getState().recoveredConnection).not.toBeNull()

    resetNetworkStateForAccountTransition()
    expect(useNetworkStore.getState()).toMatchObject({
      status: { state: 'connecting', peerCount: 0, averageLatency: 0 },
      recoveredConnection: null,
    })

    useNetworkStore.getState().setStatus({ state: 'connected' })
    expect(useNetworkStore.getState().recoveredConnection).toBeNull()

    useNetworkStore.getState().setStatus({ state: 'disconnected' })
    vi.advanceTimersByTime(3_000)
    useNetworkStore.getState().setStatus({ state: 'connected' })
    const nextAccountRecovery = useNetworkStore.getState().recoveredConnection
    expect(nextAccountRecovery).not.toBeNull()

    // The previous account's retry-signal timer would fire now and erase the new
    // account's recovery signal if the transition reset had not cancelled it.
    vi.advanceTimersByTime(1_000)
    expect(useNetworkStore.getState().recoveredConnection).toEqual(nextAccountRecovery)
  })
})
