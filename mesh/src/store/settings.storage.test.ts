import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetMatrixAccountPreferences, useSettingsStore } from './settings'

describe('settings storage resilience', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    window.localStorage.clear()
    resetMatrixAccountPreferences()
    useSettingsStore.setState({
      appearance: {
        theme: 'dark',
        density: 'default',
        accent: 'violet',
        transparency: 'readable',
        reduceMotion: false,
      },
      signalCheckEnabled: false,
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
    window.localStorage.clear()
  })

  it('keeps in-memory settings usable when persistence exceeds quota', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('quota', 'QuotaExceededError')
    })

    expect(() => useSettingsStore.getState().setAppearanceTheme('light')).not.toThrow()
    expect(() => useSettingsStore.getState().setNotificationsEnabled(false)).not.toThrow()
    expect(useSettingsStore.getState().appearance.theme).toBe('light')
    expect(useSettingsStore.getState().notifications.enabled).toBe(false)
  })

  it('keeps account preference reset non-fatal when persistence is denied', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('denied', 'SecurityError')
    })

    expect(() => resetMatrixAccountPreferences()).not.toThrow()
    expect(useSettingsStore.getState().notifications.mutedChannels).toEqual([])
    expect(useSettingsStore.getState().privacy.conversationPrivacy).toEqual({})
  })

  it('treats denied reads and removals as an unavailable optional cache', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('denied', 'SecurityError')
    })
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
      throw new DOMException('denied', 'SecurityError')
    })

    await expect(useSettingsStore.persist.rehydrate()).resolves.toBeUndefined()
    expect(() => useSettingsStore.persist.clearStorage()).not.toThrow()
    expect(useSettingsStore.getState().appearance.theme).toBe('dark')
  })

  it('stores Signal Check as an explicit per-device choice', () => {
    useSettingsStore.getState().setSignalCheckEnabled(true)

    const stored = window.localStorage.getItem('mesh-settings')
    expect(stored).toContain('"signalCheckEnabled":true')
    expect(useSettingsStore.getState().signalCheckEnabled).toBe(true)
  })
})
