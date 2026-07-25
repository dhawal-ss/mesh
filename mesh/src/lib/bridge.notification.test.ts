import { afterEach, describe, expect, it, vi } from 'vitest'

describe('notification sounds', () => {
  afterEach(() => {
    Reflect.deleteProperty(globalThis, 'AudioContext')
    vi.resetModules()
  })

  it('plays the selected built-in tone without depending on a missing asset', async () => {
    const oscillatorStart = vi.fn()
    const oscillatorStop = vi.fn()
    const createOscillator = vi.fn(() => ({
      type: 'sine' as OscillatorType,
      frequency: { setValueAtTime: vi.fn() },
      connect: vi.fn(),
      start: oscillatorStart,
      stop: oscillatorStop,
    }))
    const createGain = vi.fn(() => ({
      gain: {
        setValueAtTime: vi.fn(),
        exponentialRampToValueAtTime: vi.fn(),
      },
      connect: vi.fn(),
    }))

    class FakeAudioContext {
      state = 'running'
      currentTime = 1
      destination = {}
      createOscillator = createOscillator
      createGain = createGain
      resume = vi.fn(() => Promise.resolve())
    }

    Object.defineProperty(globalThis, 'AudioContext', {
      configurable: true,
      value: FakeAudioContext,
    })

    const { playNotificationSound } = await import('./bridge')
    playNotificationSound('pulse')

    expect(createOscillator).toHaveBeenCalledTimes(2)
    expect(createGain).toHaveBeenCalledTimes(2)
    expect(oscillatorStart).toHaveBeenCalledTimes(2)
    expect(oscillatorStop).toHaveBeenCalledTimes(2)
  })
})
