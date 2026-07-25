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
      formatFederatedTimestamp(
        '2026-07-25T12:34:56.000Z',
        'yyyy',
      ),
    ).toBe('2026')
    expect(
      formatFederatedTimestamp('malformed', 'HH:mm'),
    ).toBe('Time unavailable')
    expect(
      formatFederatedTimestamp('malformed', 'HH:mm', 'Unknown'),
    ).toBe('Unknown')
  })

  it('contains formatter errors instead of leaking an exception into rendering', () => {
    expect(
      formatFederatedTimestamp(
        '2026-07-25T12:34:56.000Z',
        'YYYY',
      ),
    ).toBe('Time unavailable')
  })
})
