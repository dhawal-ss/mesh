import { describe, expect, it } from 'vitest'
import {
  matrixDisplayName,
  matrixIdentity,
  matrixProfileIdentity,
  resolveSenderIdentity,
} from './matrixIdentity'

describe('Matrix identity presentation', () => {
  it('derives a friendly name while retaining the full Matrix user ID', () => {
    expect(matrixDisplayName('@alice:example.org')).toBe('alice')
    expect(matrixIdentity('@alice:example.org')).toMatchObject({
      publicKey: '@alice:example.org',
      displayName: 'alice',
    })
  })

  it('uses a stable non-empty avatar color', () => {
    const first = matrixIdentity('@alice:example.org')
    const second = matrixIdentity('@alice:example.org')

    expect(first?.avatarColor).toMatch(/^var\(--avatar-[^)]+\)$/)
    expect(second?.avatarColor).toBe(first?.avatarColor)
  })

  it('keeps an authoritative Matrix profile for optimistic messages', () => {
    const sender = resolveSenderIdentity(
      {
        publicKey: '@mesh-user:example.org',
        displayName: 'Alice Cooper',
        avatarColor: '#123456',
      },
      '@mesh-user:example.org',
    )

    expect(sender.publicKey).toBe('@mesh-user:example.org')
    expect(sender.displayName).toBe('Alice Cooper')
  })

  it('maps the server profile and retains its read-only MXC avatar URI', () => {
    expect(matrixProfileIdentity({
      userId: '@alice:example.org',
      displayName: 'Alice',
      avatarUrl: 'mxc://example.org/avatar',
    })).toMatchObject({
      publicKey: '@alice:example.org',
      displayName: 'Alice',
      avatarUrl: 'mxc://example.org/avatar',
    })
  })

  it('does not reuse a legacy identity for a Matrix sender', () => {
    const sender = resolveSenderIdentity(
      { publicKey: 'legacy-key', displayName: 'Legacy', avatarColor: '#123456' },
      '@mesh-user:example.org',
    )

    expect(sender.displayName).toBe('mesh-user')
  })

  it('falls back safely when no identity has loaded', () => {
    expect(resolveSenderIdentity(null, null)).toEqual({
      publicKey: '',
      displayName: 'You',
      avatarColor: 'var(--avatar-blue)',
    })
  })
})
