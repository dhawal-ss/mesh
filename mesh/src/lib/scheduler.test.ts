import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  __resetPollSchedulerForTests,
  getBackoffDelay,
  registerPoll,
} from './scheduler'

function setVisibility(state: DocumentVisibilityState) {
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    value: state,
  })
  document.dispatchEvent(new Event('visibilitychange'))
}

describe('poll scheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.spyOn(Math, 'random').mockReturnValue(0.5)
    setVisibility('visible')
  })

  afterEach(() => {
    __resetPollSchedulerForTests()
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('runs immediately and then at the configured interval', async () => {
    const run = vi.fn(async () => {})
    const unregister = registerPoll({
      key: 'interval',
      intervalMs: 5_000,
      run,
    })

    await vi.advanceTimersByTimeAsync(0)
    expect(run).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(4_999)
    expect(run).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(1)
    expect(run).toHaveBeenCalledTimes(2)
    unregister()
  })

  it('does not overlap a poll that is still running', async () => {
    let finishFirstRun!: () => void
    const firstRun = new Promise<void>((resolve) => {
      finishFirstRun = resolve
    })
    const run = vi.fn()
      .mockReturnValueOnce(firstRun)
      .mockResolvedValue(undefined)
    const unregister = registerPoll({
      key: 'non-overlap',
      intervalMs: 1_000,
      run,
    })

    await vi.advanceTimersByTimeAsync(0)
    expect(run).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(10_000)
    expect(run).toHaveBeenCalledTimes(1)

    finishFirstRun()
    await Promise.resolve()
    await vi.advanceTimersByTimeAsync(999)
    expect(run).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(run).toHaveBeenCalledTimes(2)
    unregister()
  })

  it('pauses while hidden and resumes every paused poll immediately on focus', async () => {
    const run = vi.fn(async () => {})
    const unregister = registerPoll({
      key: 'visibility',
      intervalMs: 5_000,
      pauseWhenHidden: true,
      run,
    })

    await vi.advanceTimersByTimeAsync(0)
    expect(run).toHaveBeenCalledTimes(1)

    setVisibility('hidden')
    await vi.advanceTimersByTimeAsync(60_000)
    expect(run).toHaveBeenCalledTimes(1)

    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: 'visible',
    })
    window.dispatchEvent(new Event('focus'))
    await vi.advanceTimersByTimeAsync(0)
    expect(run).toHaveBeenCalledTimes(2)
    unregister()
  })

  it('backs off exponentially after failures and resets after success', async () => {
    const run = vi.fn()
      .mockRejectedValueOnce(new Error('first failure'))
      .mockRejectedValueOnce(new Error('second failure'))
      .mockResolvedValue(undefined)
    const unregister = registerPoll({
      key: 'backoff',
      intervalMs: 1_000,
      backoffOnError: true,
      run,
    })

    await vi.advanceTimersByTimeAsync(0)
    expect(run).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(1_999)
    expect(run).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(run).toHaveBeenCalledTimes(2)

    await vi.advanceTimersByTimeAsync(3_999)
    expect(run).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(run).toHaveBeenCalledTimes(3)

    await vi.advanceTimersByTimeAsync(999)
    expect(run).toHaveBeenCalledTimes(3)
    await vi.advanceTimersByTimeAsync(1)
    expect(run).toHaveBeenCalledTimes(4)
    unregister()
  })
})

describe('getBackoffDelay', () => {
  it('applies bounded jitter and never exceeds the cap', () => {
    expect(getBackoffDelay(0, {
      baseMs: 1_000,
      maxMs: 30_000,
      jitterRatio: 0.2,
      random: () => 0,
    })).toBe(800)
    expect(getBackoffDelay(10, {
      baseMs: 1_000,
      maxMs: 30_000,
      jitterRatio: 0.2,
      random: () => 1,
    })).toBe(30_000)
  })
})
