import { describe, expect, it } from 'vitest'
import { createMatrixSupportBundle, serializeSupportBundle } from './support-bundle'
import type { BackendStatus } from '../types/ipc'

describe('support bundle privacy boundary', () => {
  it('exports only allowlisted aggregate health fields', () => {
    const status = {
      kind: 'matrix',
      authenticated: true,
      userId: '@private:example.org',
      deviceId: 'SECRET-DEVICE',
      homeserver: 'https://private.example.org',
      syncRunning: true,
      endToEndEncryption: true,
      durableHistory: true,
      warnings: ['Room !private:example.org failed with access_token=secret'],
      voiceService: {
        availability: 'not-configured',
        mediaE2eeVerified: false,
      },
    } as BackendStatus

    const serialized = serializeSupportBundle(
      createMatrixSupportBundle(status, new Date('2026-08-02T05:00:00Z')),
    )
    for (const secret of [
      '@private:example.org',
      'SECRET-DEVICE',
      'private.example.org',
      '!private:example.org',
      'access_token',
    ]) {
      expect(serialized).not.toContain(secret)
    }
    expect(serialized).toContain('"warningCount": 1')
    expect(serialized).toContain('"automaticUpload": false')
  })
})
