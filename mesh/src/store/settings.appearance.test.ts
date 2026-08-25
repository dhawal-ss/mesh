import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  resolveAppearanceTheme,
  useSettingsStore,
  watchSystemAppearance,
} from './settings'

const STORAGE_KEY = 'mesh-settings'

describe('appearance settings', () => {
  beforeEach(() => {
    localStorage.clear()
    useSettingsStore.getState().setAppearanceTheme('dark')
    useSettingsStore.getState().setAppearanceDensity('default')
    useSettingsStore.getState().setAppearanceAccent('sand')
    useSettingsStore.getState().setReduceMotion(false)
  })

  afterEach(() => {
    useSettingsStore.getState().setAppearanceTheme('dark')
    useSettingsStore.getState().setAppearanceDensity('default')
    useSettingsStore.getState().setAppearanceAccent('sand')
    useSettingsStore.getState().setReduceMotion(false)
    localStorage.clear()
  })

  it('persists typed preferences and applies every setter to the document root', () => {
    const notificationsBefore = useSettingsStore.getState().notifications

    useSettingsStore.getState().setAppearanceTheme('light')
    useSettingsStore.getState().setAppearanceDensity('comfortable')
    useSettingsStore.getState().setAppearanceAccent('rose')
    useSettingsStore.getState().setReduceMotion(true)

    expect(useSettingsStore.getState().appearance).toEqual({
      theme: 'light',
      density: 'comfortable',
      accent: 'rose',
      reduceMotion: true,
      textScale: 100,
    })
    expect(useSettingsStore.getState().notifications).toBe(notificationsBefore)
    expect(document.documentElement.dataset.theme).toBe('light')
    expect(document.documentElement.dataset.density).toBe('comfortable')
    expect(document.documentElement.dataset.accent).toBe('rose')
    expect(document.documentElement.dataset.reduceMotion).toBe('true')

    const persisted = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as {
      state?: { appearance?: unknown }
    }
    expect(persisted.state?.appearance).toEqual({
      theme: 'light',
      density: 'comfortable',
      accent: 'rose',
      reduceMotion: true,
      textScale: 100,
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
      reduceMotion: true,
      textScale: 100,
    })
    expect(document.documentElement.dataset.theme).toBe('high-contrast')
    expect(document.documentElement.dataset.density).toBe('compact')
    expect(document.documentElement.dataset.accent).toBe('forest')
    expect(document.documentElement.dataset.reduceMotion).toBe('true')
  })

  it('falls back to safe defaults for invalid persisted appearance values', async () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        state: {
          appearance: {
            // `system` used to belong in this list. It is a real preference now,
            // so this case needs a theme Mesh genuinely does not offer.
            theme: 'sepia',
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
      accent: 'ocean',
      reduceMotion: false,
      textScale: 100,
    })
    expect(document.documentElement.dataset.theme).toBe('dark')
    expect(document.documentElement.dataset.density).toBe('default')
    expect(document.documentElement.dataset.accent).toBe('ocean')
  })
})

describe('matching the operating system theme', () => {
  const originalMatchMedia = window.matchMedia
  let listeners: Array<() => void> = []
  let systemPrefersDark = false
  let systemPrefersReducedMotion = false

  function stubMatchMedia() {
    listeners = []
    window.matchMedia = ((query: string) => ({
      matches: query.includes('prefers-color-scheme: dark')
        ? systemPrefersDark
        : query.includes('prefers-reduced-motion: reduce') && systemPrefersReducedMotion,
      media: query,
      addEventListener: (_event: string, listener: () => void) => listeners.push(listener),
      removeEventListener: (_event: string, listener: () => void) => {
        listeners = listeners.filter((candidate) => candidate !== listener)
      },
      addListener: (listener: () => void) => listeners.push(listener),
      removeListener: (listener: () => void) => {
        listeners = listeners.filter((candidate) => candidate !== listener)
      },
      dispatchEvent: () => false,
      onchange: null,
    })) as unknown as typeof window.matchMedia
  }

  beforeEach(() => {
    localStorage.clear()
    systemPrefersDark = false
    systemPrefersReducedMotion = false
    stubMatchMedia()
  })

  afterEach(() => {
    window.matchMedia = originalMatchMedia
    useSettingsStore.getState().setAppearanceTheme('dark')
    useSettingsStore.getState().setReduceMotion(false)
    localStorage.clear()
  })

  it('resolves the stored preference to a theme a stylesheet can render', () => {
    systemPrefersDark = false
    expect(resolveAppearanceTheme('system')).toBe('light')
    systemPrefersDark = true
    expect(resolveAppearanceTheme('system')).toBe('dark')
  })

  it('leaves an explicit theme alone, including high contrast', () => {
    systemPrefersDark = true
    expect(resolveAppearanceTheme('light')).toBe('light')
    expect(resolveAppearanceTheme('high-contrast')).toBe('high-contrast')
  })

  it('never writes `system` to the document, so no stylesheet has to know it exists', () => {
    systemPrefersDark = false
    useSettingsStore.getState().setAppearanceTheme('system')

    expect(useSettingsStore.getState().appearance.theme).toBe('system')
    expect(document.documentElement.dataset.theme).toBe('light')
  })

  it('repaints when the operating system flips while `system` is selected', () => {
    useSettingsStore.getState().setAppearanceTheme('system')
    const stop = watchSystemAppearance()

    systemPrefersDark = true
    listeners.forEach((listener) => listener())
    expect(document.documentElement.dataset.theme).toBe('dark')

    systemPrefersDark = false
    listeners.forEach((listener) => listener())
    expect(document.documentElement.dataset.theme).toBe('light')

    stop()
    expect(listeners).toHaveLength(0)
  })

  it('ignores operating system changes once a theme is chosen explicitly', () => {
    useSettingsStore.getState().setAppearanceTheme('light')
    const stop = watchSystemAppearance()

    systemPrefersDark = true
    listeners.forEach((listener) => listener())

    expect(document.documentElement.dataset.theme).toBe('light')
    stop()
  })

  it('keeps Mesh\'s own default when the runtime cannot answer the query', () => {
    window.matchMedia = (() => {
      throw new Error('unsupported media query')
    }) as unknown as typeof window.matchMedia

    expect(resolveAppearanceTheme('system')).toBe('dark')
    expect(watchSystemAppearance()).toBeInstanceOf(Function)
  })

  /*
    The stylesheet has one reduced-motion mechanism, and it is this attribute.

    Before, the in-app toggle wrote `data-reduce-motion` while the operating
    system was honoured separately by `@media (prefers-reduced-motion: reduce)`
    blocks. The two did not behave the same: one killed transitions outright,
    the other only shortened them. So which behaviour a person got depended on
    how they had asked for reduced motion. These pin the OR that collapsed them.
  */
  it('reports reduced motion when only the operating system asks for it', () => {
    systemPrefersReducedMotion = true
    useSettingsStore.getState().setReduceMotion(false)

    expect(useSettingsStore.getState().appearance.reduceMotion).toBe(false)
    expect(document.documentElement.dataset.reduceMotion).toBe('true')
  })

  it('reports reduced motion when only the in-app toggle asks for it', () => {
    systemPrefersReducedMotion = false
    useSettingsStore.getState().setReduceMotion(true)

    expect(document.documentElement.dataset.reduceMotion).toBe('true')
  })

  it('reports normal motion only when neither asks for it', () => {
    systemPrefersReducedMotion = false
    useSettingsStore.getState().setReduceMotion(false)

    expect(document.documentElement.dataset.reduceMotion).toBe('false')
  })

  it('repaints when the operating system turns reduced motion on and off', () => {
    useSettingsStore.getState().setReduceMotion(false)
    const stop = watchSystemAppearance()

    systemPrefersReducedMotion = true
    listeners.forEach((listener) => listener())
    expect(document.documentElement.dataset.reduceMotion).toBe('true')

    systemPrefersReducedMotion = false
    listeners.forEach((listener) => listener())
    expect(document.documentElement.dataset.reduceMotion).toBe('false')

    stop()
    expect(listeners).toHaveLength(0)
  })

  it('does not impose reduced motion when the runtime cannot answer the query', () => {
    // Reduced motion is a departure from the designed interface, so a
    // preference that cannot be read must not silently switch it on.
    window.matchMedia = (() => {
      throw new Error('unsupported media query')
    }) as unknown as typeof window.matchMedia
    useSettingsStore.getState().setReduceMotion(false)

    expect(document.documentElement.dataset.reduceMotion).toBe('false')
  })
})

describe('user text scaling', () => {
  afterEach(() => {
    useSettingsStore.getState().setAppearanceTextScale(100)
    localStorage.clear()
  })

  it('multiplies the type scale on the root element', () => {
    /*
      Mesh ships fixed-pixel type and a window with zoom hotkeys off, so this
      control is the only way to enlarge text: WCAG 1.4.4 rests on it.
    */
    useSettingsStore.getState().setAppearanceTextScale(125)
    expect(document.documentElement.style.getPropertyValue('--text-scale')).toBe('1.25')
    expect(useSettingsStore.getState().appearance.textScale).toBe(125)

    useSettingsStore.getState().setAppearanceTextScale(100)
    expect(document.documentElement.style.getPropertyValue('--text-scale')).toBe('1')
  })

  it('reaches at least 150 percent, and survives a reload', () => {
    // 1.4.4 asks for 200% without loss of content; the OS zoom hotkeys now
    // enabled in tauri.conf.json compose on top of this to cover the rest.
    useSettingsStore.getState().setAppearanceTextScale(150)
    expect(document.documentElement.style.getPropertyValue('--text-scale')).toBe('1.5')

    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}')
    const persisted = stored?.state?.appearance?.textScale ?? stored?.appearance?.textScale
    expect(persisted).toBe(150)
  })

  it('falls back to the default scale when storage holds a value that is not offered', () => {
    useSettingsStore.getState().setAppearanceTextScale(110)
    useSettingsStore.setState({
      appearance: { ...useSettingsStore.getState().appearance, textScale: 999 as never },
    })
    // The sanitiser runs on load, so re-normalising must land on the default
    // rather than writing an unsupported multiplier to the root element.
    useSettingsStore.getState().setAppearanceTextScale(100)
    expect(useSettingsStore.getState().appearance.textScale).toBe(100)
  })
})
