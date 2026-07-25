import { describe, expect, it, vi } from 'vitest'
import {
  copyText,
  effectiveMutedRoomIds,
  isMuteActive,
  isQuietHoursActive,
  matrixRoomPermalink,
} from './notifications'

describe('notification policy', () => {
  it('supports same-day and overnight quiet hours', () => {
    const morning = new Date(2026, 0, 1, 9, 30)
    const evening = new Date(2026, 0, 1, 22, 30)
    const afterMidnight = new Date(2026, 0, 2, 1, 30)

    expect(
      isQuietHoursActive({ enabled: true, start: '09:00', end: '17:00' }, morning),
    ).toBe(true)
    expect(
      isQuietHoursActive({ enabled: true, start: '22:00', end: '07:00' }, evening),
    ).toBe(true)
    expect(
      isQuietHoursActive({ enabled: true, start: '22:00', end: '07:00' }, afterMidnight),
    ).toBe(true)
    expect(
      isQuietHoursActive({ enabled: false, start: '00:00', end: '00:00' }, morning),
    ).toBe(false)
  })

  it('treats null as an indefinite mute and expires timestamp mutes', () => {
    const now = Date.parse('2026-01-01T12:00:00.000Z')
    expect(isMuteActive(null, now)).toBe(true)
    expect(isMuteActive(undefined, now)).toBe(false)
    expect(isMuteActive('2026-01-01T12:01:00.000Z', now)).toBe(true)
    expect(isMuteActive('2026-01-01T11:59:00.000Z', now)).toBe(false)
  })

  it('resolves room, community, and nothing-level suppression', () => {
    const now = Date.parse('2026-01-01T12:00:00.000Z')
    const channels = [
      { id: 'room-a', communityId: 'community-a' },
      { id: 'room-b', communityId: 'community-a' },
      { id: 'room-c', communityId: 'community-b' },
      { id: 'room-d', communityId: 'community-c' },
    ]

    expect(
      effectiveMutedRoomIds(
        channels,
        {
          'room-a': '2026-01-01T13:00:00.000Z',
          'room-d': '2026-01-01T11:00:00.000Z',
          'room-not-loaded': null,
        },
        { 'community-b': null },
        { 'room-b': 'nothing' },
        now,
      ),
    ).toEqual(['room-a', 'room-b', 'room-c', 'room-not-loaded'])
  })

  it('creates a working Matrix room permalink without exposing raw delimiters', () => {
    expect(matrixRoomPermalink('!abc:mesh.test')).toBe(
      'https://matrix.to/#/!abc%3Amesh.test',
    )
  })

  it('copies links through the modern clipboard API', async () => {
    const originalClipboard = navigator.clipboard
    const writeText = vi.fn<(text: string) => Promise<void>>(() => Promise.resolve())
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })

    await copyText('https://mesh.app/c/room')

    expect(writeText).toHaveBeenCalledWith('https://mesh.app/c/room')
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: originalClipboard,
    })
  })
})
