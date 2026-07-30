import { describe, expect, it } from 'vitest'
import {
  dayIndex,
  formatDayLabel,
  isSameDay,
  isoTimestamp,
  formatClockTime,
} from './message-time'
import { INVALID_FEDERATED_TIME_LABEL } from './federated-time'

describe('message-time', () => {
  describe('dayIndex', () => {
    it('returns null for unusable timestamps', () => {
      expect(dayIndex(undefined)).toBeNull()
      expect(dayIndex('not a date')).toBeNull()
      expect(dayIndex(Number.NaN)).toBeNull()
    })

    it('gives the same index for two moments on the same local day', () => {
      const morning = new Date(2026, 4, 5, 1, 0, 0)
      const night = new Date(2026, 4, 5, 23, 59, 0)
      expect(dayIndex(morning)).toBe(dayIndex(night))
    })

    it('separates moments minutes apart across local midnight', () => {
      const before = new Date(2026, 4, 5, 23, 58, 0)
      const after = new Date(2026, 4, 6, 0, 2, 0)
      expect(dayIndex(before)).not.toBe(dayIndex(after))
    })
  })

  describe('isSameDay', () => {
    it('breaks grouping across midnight even for a four-minute gap', () => {
      const before = new Date(2026, 4, 5, 23, 58, 0)
      const after = new Date(2026, 4, 6, 0, 2, 0)
      expect(after.getTime() - before.getTime()).toBeLessThan(5 * 60 * 1000)
      expect(isSameDay(before, after)).toBe(false)
    })

    it('is false when either side is unusable', () => {
      expect(isSameDay(new Date(), 'nope')).toBe(false)
      expect(isSameDay(null, null)).toBe(false)
    })
  })

  describe('isoTimestamp', () => {
    it('emits a machine-readable value for <time dateTime>', () => {
      expect(isoTimestamp(new Date(Date.UTC(2026, 4, 5, 12, 0, 0)))).toBe(
        '2026-05-05T12:00:00.000Z',
      )
    })

    it('is undefined rather than throwing on bad input', () => {
      expect(isoTimestamp('garbage')).toBeUndefined()
    })
  })

  describe('formatDayLabel', () => {
    const now = new Date(2026, 6, 30, 12, 0, 0)

    it('names today and yesterday relatively', () => {
      expect(formatDayLabel(new Date(2026, 6, 30, 9, 0, 0), now)).toBe('Today')
      expect(formatDayLabel(new Date(2026, 6, 29, 9, 0, 0), now)).toBe('Yesterday')
    })

    it('uses a weekday name inside the last week', () => {
      expect(formatDayLabel(new Date(2026, 6, 27, 9, 0, 0), now)).toBe('Monday')
    })

    it('falls back to an absolute date beyond a week', () => {
      const label = formatDayLabel(new Date(2026, 5, 1, 9, 0, 0), now)
      expect(label).not.toBe('Today')
      expect(label).not.toBe('Yesterday')
      expect(label).toContain('1')
    })

    it('degrades safely on unusable input', () => {
      expect(formatDayLabel('garbage', now)).toBe(INVALID_FEDERATED_TIME_LABEL)
    })
  })

  describe('formatClockTime', () => {
    it('degrades safely on unusable input', () => {
      expect(formatClockTime(undefined)).toBe(INVALID_FEDERATED_TIME_LABEL)
    })

    it('produces a non-empty reading for a valid time', () => {
      expect(formatClockTime(new Date(2026, 4, 5, 15, 14, 0))).toMatch(/\d/)
    })
  })
})
