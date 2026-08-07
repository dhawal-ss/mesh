import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const sound = vi.hoisted(() => ({
  play: vi.fn(() => Promise.resolve(true)),
}))

vi.mock('../lib/interface-sounds', () => ({
  playInterfaceSound: sound.play,
}))

import {
  resetNetworkRecoveryForTest,
  resetNetworkStateForAccountTransition,
  useNetworkStore,
} from './network'

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

  it('publishes a textual recovery state and cue only after a visible disruption', () => {
    useNetworkStore.getState().setStatus({ state: 'disconnected' })
    vi.advanceTimersByTime(3_000)
    useNetworkStore.getState().setStatus({ state: 'connected' })

    expect(useNetworkStore.getState().recoveredConnection).toMatchObject({ durationMs: 3_000 })
    expect(sound.play).toHaveBeenCalledWith('connection-recovered', {
      disruptionDurationMs: 3_000,
    })

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

    // The previous account's banner timer would fire now and erase the new
    // account's recovery signal if the transition reset had not cancelled it.
    vi.advanceTimersByTime(1_000)
    expect(useNetworkStore.getState().recoveredConnection).toEqual(nextAccountRecovery)
  })
})
