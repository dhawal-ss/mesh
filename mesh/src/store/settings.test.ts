import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MatrixUserPreferences } from '../types/ipc'
import {
  getEffectiveChannelNotificationLevel,
  isQuietHoursActive,
  matrixPreferencesToNotifications,
  useSettingsStore,
} from './settings'

const matrixPreferences = {
  schemaVersion: 1,
  notificationsEnabled: false,
  notificationSound: true,
  mutedChannels: ['!room:example.org', '!room:example.org'],
  mutedCommunities: ['!space:example.org', '!space:example.org'],
  updatedAt: '2026-07-22T00:00:00Z',
} as unknown as MatrixUserPreferences

describe('Matrix preference projection', () => {
  it('maps portable notification settings and deduplicates room identifiers', () => {
    expect(matrixPreferencesToNotifications(matrixPreferences)).toEqual({
      enabled: false,
      sound: true,
      soundId: 'mesh',
      doNotDisturb: false,
      quietHours: {
        enabled: false,
        start: '22:00',
        end: '08:00',
      },
      mutedChannels: ['!room:example.org'],
      mutedCommunities: ['!space:example.org'],
      channelMuteUntil: { '!room:example.org': null },
      communityMuteUntil: { '!space:example.org': null },
      channelNotificationLevels: {},
    })
  })

  it('maps the extended portable fields while ignoring invalid level values', () => {
    const projected = matrixPreferencesToNotifications({
      ...matrixPreferences,
      notificationSoundId: 'pulse',
      doNotDisturb: true,
      quietHoursEnabled: true,
      quietHoursStart: '21:30',
      quietHoursEnd: '07:15',
      channelNotificationLevels: {
        '!room:example.org': 'mentions',
        '!invalid:example.org': 'sometimes',
      },
    } as unknown as MatrixUserPreferences & Record<string, unknown>)

    expect(projected.soundId).toBe('pulse')
    expect(projected.doNotDisturb).toBe(true)
    expect(projected.quietHours).toEqual({
      enabled: true,
      start: '21:30',
      end: '07:15',
    })
    expect(projected.channelNotificationLevels).toEqual({
      '!room:example.org': 'mentions',
    })
  })
})

describe('notification policy', () => {
  it('handles both overnight and same-day quiet-hour windows', () => {
    expect(
      isQuietHoursActive(
        { enabled: true, start: '22:00', end: '08:00' },
        new Date(2026, 6, 25, 23, 30),
      ),
    ).toBe(true)
    expect(
      isQuietHoursActive(
        { enabled: true, start: '22:00', end: '08:00' },
        new Date(2026, 6, 25, 12, 0),
      ),
    ).toBe(false)
    expect(
      isQuietHoursActive(
        { enabled: true, start: '09:00', end: '17:00' },
        new Date(2026, 6, 25, 12, 0),
      ),
    ).toBe(true)
  })

  it('combines channel levels with master, DND, quiet-hour, and mute suppression', () => {
    const notifications = matrixPreferencesToNotifications({
      ...matrixPreferences,
      notificationsEnabled: true,
      mutedChannels: [],
      mutedCommunities: [],
      channelNotificationLevels: { '!room:example.org': 'mentions' },
    } as MatrixUserPreferences & Record<string, unknown>)
    const noon = new Date(2026, 6, 25, 12, 0)

    expect(
      getEffectiveChannelNotificationLevel(
        notifications,
        '!room:example.org',
        '!space:example.org',
        noon,
      ),
    ).toBe('mentions')
    expect(
      getEffectiveChannelNotificationLevel(
        { ...notifications, doNotDisturb: true },
        '!room:example.org',
        null,
        noon,
      ),
    ).toBe('nothing')
  })
})

describe('notification settings actions', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-25T12:00:00Z'))
    useSettingsStore.setState({
      notifications: matrixPreferencesToNotifications({
        ...matrixPreferences,
        notificationsEnabled: true,
        mutedChannels: [],
        mutedCommunities: [],
      }),
    })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('persists timed and indefinite mutes and treats expired records as inactive', () => {
    const store = useSettingsStore.getState()
    store.muteChannelFor('!timed:example.org', 15 * 60 * 1000)
    store.muteCommunityFor('!forever:example.org', null)

    expect(useSettingsStore.getState().isChannelMuted('!timed:example.org')).toBe(true)
    expect(useSettingsStore.getState().isCommunityMuted('!forever:example.org')).toBe(true)
    expect(
      useSettingsStore.getState().notifications.channelMuteUntil['!timed:example.org'],
    ).toBe('2026-07-25T12:15:00.000Z')
    expect(
      useSettingsStore.getState().notifications.communityMuteUntil['!forever:example.org'],
    ).toBeNull()

    vi.setSystemTime(new Date('2026-07-25T12:16:00Z'))
    expect(useSettingsStore.getState().isChannelMuted('!timed:example.org')).toBe(false)
    // Reads stay pure so an expiry observed while rendering never mutates Zustand.
    expect(useSettingsStore.getState().notifications.mutedChannels).toContain('!timed:example.org')

    vi.advanceTimersByTime(15 * 60 * 1000)
    expect(useSettingsStore.getState().notifications.mutedChannels).not.toContain(
      '!timed:example.org',
    )
  })

  it('uses all as the sparse default for per-channel notification levels', () => {
    useSettingsStore.getState().setChannelNotificationLevel('!room:example.org', 'nothing')
    expect(useSettingsStore.getState().getChannelNotificationLevel('!room:example.org')).toBe(
      'nothing',
    )

    useSettingsStore.getState().setChannelNotificationLevel('!room:example.org', 'all')
    expect(useSettingsStore.getState().notifications.channelNotificationLevels).toEqual({})
  })
})
