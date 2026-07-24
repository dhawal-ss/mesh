import { describe, expect, it } from 'vitest'
import type { BackendStatus } from './bridge'
import { canStartLegacyVoice } from './voice-runtime'

function status(overrides: Partial<BackendStatus> = {}): BackendStatus {
  return {
    kind: 'legacy-p2p',
    capabilities: {
      encryptedText: true,
      encryptedAttachments: true,
      directMessages: true,
      voice: true,
      durableTimeouts: true,
      deviceManagement: false,
      recovery: false,
      legacyMigration: true,
    },
    voiceService: {
      provider: 'legacy-simple-peer',
      availability: 'ready',
      discoveryKey: null,
      livekitServiceUrl: null,
      tokenEndpoint: null,
      livekitSfuUrl: null,
      cspReady: true,
      mediaE2eeVerified: false,
      reason: 'Experimental legacy transport',
    },
    authenticated: false,
    userId: null,
    deviceId: null,
    homeserver: null,
    syncRunning: false,
    durableHistory: false,
    endToEndEncryption: true,
    warnings: [],
    ...overrides,
  }
}

describe('voice runtime boundary', () => {
  it('allows SimplePeer only for an explicitly ready legacy backend', () => {
    expect(canStartLegacyVoice(status())).toBe(true)
  })

  it('blocks SimplePeer for Matrix even if a malformed response claims it is ready', () => {
    expect(canStartLegacyVoice(status({ kind: 'matrix' }))).toBe(false)
  })

  it('fails closed for inconsistent capability or provider state', () => {
    expect(
      canStartLegacyVoice(
        status({
          capabilities: { ...status().capabilities, voice: false },
        }),
      ),
    ).toBe(false)
    expect(
      canStartLegacyVoice(
        status({
          voiceService: {
            ...status().voiceService,
            provider: 'matrix-rtc',
          },
        }),
      ),
    ).toBe(false)
  })

  it('fails closed before backend status has loaded', () => {
    expect(canStartLegacyVoice(null)).toBe(false)
  })
})
