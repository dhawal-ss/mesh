import { describe, expect, it } from 'vitest'

import {
  formatFederatedTimestamp,
  parseFederatedTimestamp,
} from './federated-time'

describe('federated timestamp safety', () => {
  it('parses valid ISO strings and finite epoch milliseconds', () => {
    expect(
      parseFederatedTimestamp('2026-07-25T12:34:56.000Z')?.toISOString(),
    ).toBe('2026-07-25T12:34:56.000Z')
    expect(parseFederatedTimestamp(0)?.toISOString()).toBe(
      '1970-01-01T00:00:00.000Z',
    )
  })

  it.each([
    null,
    undefined,
    '',
    '   ',
    'not-a-timestamp',
    Number.NaN,
    Number.POSITIVE_INFINITY,
    new Date(Number.NaN),
    {},
  ])('rejects malformed or unsupported input without throwing: %p', (value) => {
    expect(() => parseFederatedTimestamp(value)).not.toThrow()
    expect(parseFederatedTimestamp(value)).toBeNull()
  })

  it('contains hostile Date-like behavior at the parser boundary', () => {
    const hostileDate = new Date()
    hostileDate.getTime = () => {
      throw new Error('untrusted getter')
    }

    expect(() => parseFederatedTimestamp(hostileDate)).not.toThrow()
    expect(parseFederatedTimestamp(hostileDate)).toBeNull()
  })

  it('formats valid timestamps and returns honest fallback copy for invalid values', () => {
    expect(
      formatFederatedTimestamp(new Date(2026, 6, 25, 12, 34, 56), 'MMM d'),
    ).toBe('Jul 25')
    expect(
      formatFederatedTimestamp('malformed', 'MMM d'),
    ).toBe('Time unavailable')
    expect(
      formatFederatedTimestamp('malformed', 'MMM d', 'Unknown'),
    ).toBe('Unknown')
  })

  it('reads the date and the clock together for the timeline pattern', () => {
    // The clock half follows the reader's 12/24-hour preference, so this
    // asserts the parts rather than one hard-coded shape.
    const reading = formatFederatedTimestamp(
      new Date(2026, 6, 25, 13, 34, 56),
      'MMM d, HH:mm',
    )
    expect(reading).toContain('Jul 25')
    expect(reading).toMatch(/\d{1,2}:34/)
  })

  it('contains unsupported patterns instead of leaking them into rendering', () => {
    expect(
      formatFederatedTimestamp(new Date(2026, 6, 25, 12, 34, 56), 'YYYY'),
    ).toBe('Time unavailable')
    expect(
      formatFederatedTimestamp(new Date(2026, 6, 25, 12, 34, 56), 'MMM d, HH:mm:ss', 'Unknown'),
    ).toBe('Unknown')
  })
})
