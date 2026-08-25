import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  isBackupReminderDue,
  migrateSettingsPersistence,
  useSettingsStore,
} from './settings'

describe('backup reminders', () => {
  beforeEach(() => {
    localStorage.clear()
    useSettingsStore.setState({
      backup: {
        configured: false,
        reminderPending: false,
        dismissedAt: null,
      },
      backupAccountId: null,
      backupByAccount: {},
    })
    useSettingsStore.getState().activateBackupAccount('@alice:example.org')
  })

  afterEach(() => {
    vi.useRealTimers()
    localStorage.clear()
  })

  it('persists a skipped setup and makes its warning due immediately', () => {
    useSettingsStore.getState().scheduleBackupReminder()

    expect(isBackupReminderDue(useSettingsStore.getState().backup)).toBe(true)
    const persisted = JSON.parse(localStorage.getItem('mesh-settings') ?? '{}') as {
      state?: { backupByAccount?: Record<string, unknown> }
    }
    expect(persisted.state?.backupByAccount?.['@alice:example.org']).toEqual({
      configured: false,
      reminderPending: true,
      dismissedAt: null,
    })
  })

  it('allows a dismissal but brings the warning back after seven days', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-25T12:00:00.000Z'))
    useSettingsStore.getState().scheduleBackupReminder()
    useSettingsStore.getState().dismissBackupReminder()

    expect(isBackupReminderDue(useSettingsStore.getState().backup)).toBe(false)

    vi.setSystemTime(new Date('2026-08-01T12:00:01.000Z'))
    expect(isBackupReminderDue(useSettingsStore.getState().backup)).toBe(true)
  })

  it('clears all warnings once the code is confirmed', () => {
    useSettingsStore.getState().scheduleBackupReminder()
    useSettingsStore.getState().setBackupConfigured(true)

    expect(useSettingsStore.getState().backup).toEqual({
      configured: true,
      reminderPending: false,
      dismissedAt: null,
    })
    expect(isBackupReminderDue(useSettingsStore.getState().backup)).toBe(false)
  })

  it('keeps configured and dismissed state isolated when accounts switch', () => {
    useSettingsStore.getState().setBackupConfigured(true)
    useSettingsStore.getState().activateBackupAccount('@bob:example.org')
    expect(useSettingsStore.getState().backup).toEqual({
      configured: false,
      reminderPending: false,
      dismissedAt: null,
    })

    useSettingsStore.getState().scheduleBackupReminder()
    useSettingsStore.getState().dismissBackupReminder()
    const bobDismissedAt = useSettingsStore.getState().backup.dismissedAt

    useSettingsStore.getState().activateBackupAccount('@alice:example.org')
    expect(useSettingsStore.getState().backup).toEqual({
      configured: true,
      reminderPending: false,
      dismissedAt: null,
    })

    useSettingsStore.getState().activateBackupAccount('@bob:example.org')
    expect(useSettingsStore.getState().backup).toEqual({
      configured: false,
      reminderPending: true,
      dismissedAt: bobDismissedAt,
    })
  })

  it('preserves legacy unscoped evidence without assigning it to an account', () => {
    const migrated = migrateSettingsPersistence({
      backup: {
        configured: true,
        reminderPending: false,
        dismissedAt: null,
      },
    }, 7)

    expect(migrated.backup).toEqual({
      configured: false,
      reminderPending: false,
      dismissedAt: null,
    })
    expect(migrated.backupAccountId).toBeNull()
    expect(migrated.backupByAccount).toEqual({
      __legacy_unscoped__: {
        configured: true,
        reminderPending: false,
        dismissedAt: null,
      },
    })
  })

  it('bounds account-scoped reminder retention during live account switching', () => {
    for (let index = 0; index < 20; index += 1) {
      useSettingsStore.getState().activateBackupAccount(`@player-${index}:example.org`)
      useSettingsStore.getState().scheduleBackupReminder()
    }

    const accountIds = Object.keys(useSettingsStore.getState().backupByAccount)
    expect(accountIds).toHaveLength(16)
    expect(accountIds).not.toContain('@player-0:example.org')
    expect(accountIds).toContain('@player-19:example.org')
  })

  it('does not persist a reminder while no account scope is active', () => {
    useSettingsStore.getState().activateBackupAccount(null)
    useSettingsStore.getState().scheduleBackupReminder()

    expect(useSettingsStore.getState().backup.reminderPending).toBe(true)
    expect(useSettingsStore.getState().backupByAccount).toEqual({})
  })
})
