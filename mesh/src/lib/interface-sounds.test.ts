import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { playInterfaceSound, resetInterfaceSoundPolicyForTest } from './interface-sounds'
import { useSettingsStore } from '../store/settings'
import { DEFAULT_INTERFACE_SOUND_EVENTS } from './interface-sound-contract'

const audio = vi.hoisted(() => ({
  instances: [] as Array<{ src: string; preload: string; volume: number; play: ReturnType<typeof vi.fn> }>,
}))

class FakeAudio {
  preload = ''
  volume = 1
  play = vi.fn(async () => {})

  constructor(public src: string) {
    audio.instances.push(this)
  }
}

describe('interface sound playback', () => {
  beforeEach(() => {
    resetInterfaceSoundPolicyForTest()
    audio.instances = []
    vi.stubGlobal('Audio', FakeAudio)
    vi.setSystemTime(new Date('2026-08-02T00:00:00.000Z'))
    useSettingsStore.setState((state) => ({
      notifications: {
        ...state.notifications,
        enabled: true,
        sound: true,
        soundVolume: 1,
        soundEvents: { ...DEFAULT_INTERFACE_SOUND_EVENTS },
        doNotDisturb: false,
        quietHours: { enabled: false, start: '22:00', end: '08:00' },
      },
    }))
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('uses bundled assets and applies bounded relative volume', async () => {
    expect(await playInterfaceSound('voice-self-join', 0.5)).toBe(true)
    expect(audio.instances).toHaveLength(1)
    expect(audio.instances[0].src).toContain('voice-self-join.wav')
    expect(audio.instances[0].preload).toBe('auto')
    expect(audio.instances[0].volume).toBeCloseTo(0.355)
  })

  it('coalesces party churn and rate-limits recovery cues', async () => {
    vi.useFakeTimers()
    expect(await playInterfaceSound('voice-peer-join')).toBe(true)
    expect(await playInterfaceSound('voice-peer-leave')).toBe(false)
    vi.advanceTimersByTime(750)
    expect(await playInterfaceSound('voice-peer-leave')).toBe(true)
    vi.advanceTimersByTime(750)
    expect(await playInterfaceSound('voice-peer-join')).toBe(false)

    expect(await playInterfaceSound('connection-recovered', { disruptionDurationMs: 3_000 })).toBe(true)
    vi.advanceTimersByTime(29_999)
    expect(await playInterfaceSound('connection-recovered', { disruptionDurationMs: 3_000 })).toBe(false)
    vi.advanceTimersByTime(1)
    expect(await playInterfaceSound('connection-recovered', { disruptionDurationMs: 3_000 })).toBe(true)
  })

  it('coalesces a burst of failed-message cues without hiding later failures', async () => {
    vi.useFakeTimers()
    expect(await playInterfaceSound('message-failed')).toBe(true)
    expect(await playInterfaceSound('message-failed')).toBe(false)
    vi.advanceTimersByTime(750)
    expect(await playInterfaceSound('message-failed')).toBe(true)
  })

  it('suppresses focused or quiet message activity and coalesces each destination', async () => {
    vi.useFakeTimers()
    expect(await playInterfaceSound('message-mention', {
      contextKey: '!room:example.org',
      focused: true,
    })).toBe(false)

    useSettingsStore.setState((state) => ({
      notifications: { ...state.notifications, doNotDisturb: true },
    }))
    expect(await playInterfaceSound('message-direct', { contextKey: '!dm:example.org' })).toBe(false)

    useSettingsStore.setState((state) => ({
      notifications: { ...state.notifications, doNotDisturb: false },
    }))
    expect(await playInterfaceSound('message-direct', { contextKey: '!dm:example.org' })).toBe(true)
    expect(await playInterfaceSound('message-direct', { contextKey: '!dm:example.org' })).toBe(false)
    expect(await playInterfaceSound('message-direct', { contextKey: '!other:example.org' })).toBe(true)
  })

  it('lets an explicit preview use current volume without toggling an event on', async () => {
    useSettingsStore.setState((state) => ({
      notifications: {
        ...state.notifications,
        sound: false,
        soundVolume: 0.4,
        soundEvents: { ...state.notifications.soundEvents, 'message-direct': false },
      },
    }))

    expect(await playInterfaceSound('message-direct', { preview: true })).toBe(true)
    expect(audio.instances[audio.instances.length - 1]?.volume).toBeCloseTo(0.4)
    expect(useSettingsStore.getState().notifications.soundEvents['message-direct']).toBe(false)
  })

  it('fails silently when autoplay is blocked', async () => {
    vi.stubGlobal('Audio', class extends FakeAudio {
      override play = vi.fn(async () => { throw new Error('blocked') })
    })
    expect(await playInterfaceSound('voice-self-leave')).toBe(false)
  })
})
