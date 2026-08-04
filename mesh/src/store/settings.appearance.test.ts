import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { useSettingsStore } from './settings'

const STORAGE_KEY = 'mesh-settings'

describe('appearance settings', () => {
  beforeEach(() => {
    localStorage.clear()
    useSettingsStore.getState().setAppearanceTheme('dark')
    useSettingsStore.getState().setAppearanceDensity('default')
    useSettingsStore.getState().setAppearanceAccent('sand')
    useSettingsStore.getState().setAppearanceTransparency('readable')
    useSettingsStore.getState().setReduceMotion(false)
  })

  afterEach(() => {
    useSettingsStore.getState().setAppearanceTheme('dark')
    useSettingsStore.getState().setAppearanceDensity('default')
    useSettingsStore.getState().setAppearanceAccent('sand')
    useSettingsStore.getState().setAppearanceTransparency('readable')
    useSettingsStore.getState().setReduceMotion(false)
    localStorage.clear()
  })

  it('persists typed preferences and applies every setter to the document root', () => {
    const notificationsBefore = useSettingsStore.getState().notifications

    useSettingsStore.getState().setAppearanceTheme('light')
    useSettingsStore.getState().setAppearanceDensity('comfortable')
    useSettingsStore.getState().setAppearanceAccent('rose')
    useSettingsStore.getState().setAppearanceTransparency('opaque')
    useSettingsStore.getState().setReduceMotion(true)

    expect(useSettingsStore.getState().appearance).toEqual({
      theme: 'light',
      density: 'comfortable',
      accent: 'rose',
      transparency: 'opaque',
      reduceMotion: true,
    })
    expect(useSettingsStore.getState().notifications).toBe(notificationsBefore)
    expect(document.documentElement.dataset.theme).toBe('light')
    expect(document.documentElement.dataset.density).toBe('comfortable')
    expect(document.documentElement.dataset.accent).toBe('rose')
    expect(document.documentElement.dataset.transparency).toBe('opaque')
    expect(document.documentElement.dataset.reduceMotion).toBe('true')

    const persisted = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as {
      state?: { appearance?: unknown }
    }
    expect(persisted.state?.appearance).toEqual({
      theme: 'light',
      density: 'comfortable',
      accent: 'rose',
      transparency: 'opaque',
      reduceMotion: true,
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
            transparency: 'opaque',
            reduceMotion: true,
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
      transparency: 'opaque',
      reduceMotion: true,
    })
    expect(document.documentElement.dataset.theme).toBe('high-contrast')
    expect(document.documentElement.dataset.density).toBe('compact')
    expect(document.documentElement.dataset.accent).toBe('forest')
    expect(document.documentElement.dataset.transparency).toBe('opaque')
    expect(document.documentElement.dataset.reduceMotion).toBe('true')
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
            transparency: 'invisible',
            reduceMotion: 'sometimes',
          },
        },
        version: 0,
      }),
    )

    await useSettingsStore.persist.rehydrate()

    expect(useSettingsStore.getState().appearance).toEqual({
      theme: 'dark',
      density: 'default',
      accent: 'ember',
      transparency: 'opaque',
      reduceMotion: false,
    })
    expect(document.documentElement.dataset.theme).toBe('dark')
    expect(document.documentElement.dataset.density).toBe('default')
    expect(document.documentElement.dataset.accent).toBe('ember')
    expect(document.documentElement.dataset.transparency).toBe('opaque')
  })
})
