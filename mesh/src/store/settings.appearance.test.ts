import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { useSettingsStore } from './settings'

const STORAGE_KEY = 'mesh-settings'

describe('appearance settings', () => {
  beforeEach(() => {
    localStorage.clear()
    useSettingsStore.getState().setAppearanceTheme('dark')
    useSettingsStore.getState().setAppearanceDensity('default')
    useSettingsStore.getState().setAppearanceAccent('sand')
  })

  afterEach(() => {
    useSettingsStore.getState().setAppearanceTheme('dark')
    useSettingsStore.getState().setAppearanceDensity('default')
    useSettingsStore.getState().setAppearanceAccent('sand')
    localStorage.clear()
  })

  it('persists typed preferences and applies every setter to the document root', () => {
    const notificationsBefore = useSettingsStore.getState().notifications

    useSettingsStore.getState().setAppearanceTheme('light')
    useSettingsStore.getState().setAppearanceDensity('comfortable')
    useSettingsStore.getState().setAppearanceAccent('rose')

    expect(useSettingsStore.getState().appearance).toEqual({
      theme: 'light',
      density: 'comfortable',
      accent: 'rose',
    })
    expect(useSettingsStore.getState().notifications).toBe(notificationsBefore)
    expect(document.documentElement.dataset.theme).toBe('light')
    expect(document.documentElement.dataset.density).toBe('comfortable')
    expect(document.documentElement.dataset.accent).toBe('rose')

    const persisted = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as {
      state?: { appearance?: unknown }
    }
    expect(persisted.state?.appearance).toEqual({
      theme: 'light',
      density: 'comfortable',
      accent: 'rose',
    })
  })

  it('applies persisted preferences when the store rehydrates', async () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        state: {
          appearance: {
            theme: 'high-contrast',
            density: 'compact',
            accent: 'forest',
          },
        },
        version: 0,
      }),
    )

    await useSettingsStore.persist.rehydrate()

    expect(useSettingsStore.getState().appearance).toEqual({
      theme: 'high-contrast',
      density: 'compact',
      accent: 'forest',
    })
    expect(document.documentElement.dataset.theme).toBe('high-contrast')
    expect(document.documentElement.dataset.density).toBe('compact')
    expect(document.documentElement.dataset.accent).toBe('forest')
  })

  it('falls back to safe defaults for invalid persisted appearance values', async () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        state: {
          appearance: {
            theme: 'system',
            density: 'tiny',
            accent: 'neon',
          },
        },
        version: 0,
      }),
    )

    await useSettingsStore.persist.rehydrate()

    expect(useSettingsStore.getState().appearance).toEqual({
      theme: 'dark',
      density: 'default',
      accent: 'sand',
    })
    expect(document.documentElement.dataset.theme).toBe('dark')
    expect(document.documentElement.dataset.density).toBe('default')
    expect(document.documentElement.dataset.accent).toBe('sand')
  })
})
