import { describe, expect, it } from 'vitest'
import { matrixPreferencesToNotifications } from './settings'

describe('Matrix preference projection', () => {
  it('maps portable notification settings and deduplicates room identifiers', () => {
    expect(matrixPreferencesToNotifications({
      schemaVersion: 1,
      notificationsEnabled: false,
      notificationSound: true,
      mutedChannels: ['!room:example.org', '!room:example.org'],
      mutedCommunities: ['!space:example.org', '!space:example.org'],
      updatedAt: '2026-07-22T00:00:00Z',
    })).toEqual({
      enabled: false,
      sound: true,
      mutedChannels: ['!room:example.org'],
      mutedCommunities: ['!space:example.org'],
    })
  })
})
