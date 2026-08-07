import { describe, expect, it } from 'vitest'
import { INTERFACE_SOUND_IDS } from '../lib/interface-sound-contract'
import { LOCAL_SETTINGS_SCHEMA_VERSION, migrateSettingsPersistence } from './settings'

describe('settings schema migration', () => {
  it('migrates a disabled legacy sound switch to eight disabled events', () => {
    const migrated = migrateSettingsPersistence({
      notifications: {
        enabled: true,
        sound: false,
        soundId: 'pulse',
        soundVolume: 0.25,
      },
      appearance: {
        theme: 'dark',
        density: 'compact',
        accent: 'ember',
        transparency: 'opaque',
      },
    }, 6)

    expect(LOCAL_SETTINGS_SCHEMA_VERSION).toBe(8)
    expect(migrated.notifications?.soundVolume).toBe(0.25)
    expect(Object.keys(migrated.notifications?.soundEvents ?? {})).toEqual(INTERFACE_SOUND_IDS)
    expect(Object.values(migrated.notifications?.soundEvents ?? {})).toEqual(
      Array.from({ length: 8 }, () => false),
    )
    expect(migrated.appearance?.reduceMotion).toBe(false)
  })

  it('uses approved defaults for an enabled legacy switch and preserves valid schema 7 values', () => {
    const enabledLegacy = migrateSettingsPersistence({
      notifications: { sound: true },
      appearance: { reduceMotion: true },
    }, 6)
    expect(Object.values(enabledLegacy.notifications?.soundEvents ?? {})).toEqual(
      Array.from({ length: 8 }, () => true),
    )
    expect(enabledLegacy.appearance?.reduceMotion).toBe(true)

    const current = migrateSettingsPersistence({
      notifications: {
        sound: true,
        soundVolume: 0.4,
        soundEvents: { 'message-direct': false },
      },
    }, 7)
    expect(current.notifications?.soundEvents['message-direct']).toBe(false)
    expect(current.notifications?.soundEvents['voice-self-join']).toBe(true)
    expect(current.notifications?.soundVolume).toBe(0.4)
  })
})
