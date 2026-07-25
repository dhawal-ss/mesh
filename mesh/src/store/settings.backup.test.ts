import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { isBackupReminderDue, useSettingsStore } from './settings'

describe('backup reminders', () => {
  beforeEach(() => {
    localStorage.clear()
    useSettingsStore.setState({
      backup: {
        configured: false,
        reminderPending: false,
        dismissedAt: null,
      },
    })
  })

  afterEach(() => {
    vi.useRealTimers()
    localStorage.clear()
  })

  it('persists a skipped setup and makes its warning due immediately', () => {
    useSettingsStore.getState().scheduleBackupReminder()

    expect(isBackupReminderDue(useSettingsStore.getState().backup)).toBe(true)
    const persisted = JSON.parse(localStorage.getItem('mesh-settings') ?? '{}') as {
      state?: { backup?: unknown }
    }
    expect(persisted.state?.backup).toEqual({
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
})
