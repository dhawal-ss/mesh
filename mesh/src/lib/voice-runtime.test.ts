import { describe, expect, it } from 'vitest'
import type { BackendStatus } from './bridge'
import {
  canStartLegacyVoice,
  canStartMatrixVoice,
  isPermissionDeniedError,
  isPushToTalkInteractiveTarget,
  shouldActivateVoiceSession,
  shouldPublishInitialMicrophone,
  shouldReleasePushToTalk,
  voiceConnectionLabel,
  voiceMediaErrorMessage,
} from './voice-runtime'

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

describe('MatrixRTC runtime boundary', () => {
  it('requires Matrix capability, ready service, and verified media E2EE', () => {
    const ready = status({
      kind: 'matrix',
      capabilities: { ...status().capabilities, voice: true },
      voiceService: {
        ...status().voiceService,
        provider: 'matrix-rtc',
        availability: 'ready',
        mediaE2eeVerified: true,
      },
    })

    expect(canStartMatrixVoice(ready)).toBe(true)
    expect(
      canStartMatrixVoice({
        ...ready,
        voiceService: { ...ready.voiceService, mediaE2eeVerified: false },
      }),
    ).toBe(false)
    expect(
      canStartMatrixVoice({
        ...ready,
        capabilities: { ...ready.capabilities, voice: false },
      }),
    ).toBe(false)
    expect(canStartMatrixVoice(status())).toBe(false)
    expect(canStartMatrixVoice(null)).toBe(false)
  })
})

describe('voice media permission recovery', () => {
  it.each(['NotAllowedError', 'PermissionDeniedError', 'SecurityError'])(
    'recognizes the %s platform permission denial',
    (name) => {
      expect(isPermissionDeniedError({ name })).toBe(true)
    },
  )

  it('maps camera and screen denial to a plain system-settings action', () => {
    const denied = Object.assign(new Error('raw browser failure'), {
      name: 'NotAllowedError',
    })
    expect(voiceMediaErrorMessage(denied, 'camera')).toBe(
      'Mesh can’t access camera. Allow camera access for Mesh in your system settings, then try again.',
    )
    expect(voiceMediaErrorMessage(denied, 'screen')).toBe(
      'Mesh can’t access screen sharing. Allow screen sharing access for Mesh in your system settings, then try again.',
    )
  })
})

describe('push-to-talk shortcut target guard', () => {
  it.each([
    ['button', '<button><span>Mute</span></button>', 'span'],
    ['link', '<a href="/settings"><span>Settings</span></a>', 'span'],
    ['input', '<input />', 'input'],
    ['textarea', '<textarea></textarea>', 'textarea'],
    ['select', '<select><option>Device</option></select>', 'select'],
    ['summary', '<details><summary>Details</summary></details>', 'summary'],
    ['contenteditable', '<div contenteditable="true"><span>Edit</span></div>', 'span'],
    ['button role', '<div role="button"><span>Action</span></div>', 'span'],
    ['menu item role', '<div role="menuitem"><span>Action</span></div>', 'span'],
    ['option role', '<div role="option"><span>Device</span></div>', 'span'],
    ['switch role', '<div role="switch"><span>Toggle</span></div>', 'span'],
    ['slider role', '<div role="slider"><span>Volume</span></div>', 'span'],
  ])('does not claim Space from a %s', (_label, markup, targetSelector) => {
    const wrapper = document.createElement('div')
    wrapper.innerHTML = markup
    const target = wrapper.querySelector(targetSelector)

    expect(isPushToTalkInteractiveTarget(target)).toBe(true)
  })

  it('allows Space push-to-talk from non-interactive call canvas content', () => {
    const canvasLabel = document.createElement('div')
    canvasLabel.textContent = 'Voice connected'

    expect(isPushToTalkInteractiveTarget(canvasLabel)).toBe(false)
    expect(isPushToTalkInteractiveTarget(null)).toBe(false)
  })

  it('releases only a Space press that was claimed by push-to-talk', () => {
    expect(shouldReleasePushToTalk('Space', true)).toBe(true)
    expect(shouldReleasePushToTalk('Space', false)).toBe(false)
    expect(shouldReleasePushToTalk('Enter', true)).toBe(false)
  })
})

describe('initial microphone policy', () => {
  it('publishes only for unmuted voice-activity joins', () => {
    expect(shouldPublishInitialMicrophone(false, 'voice-activity')).toBe(true)
    expect(shouldPublishInitialMicrophone(true, 'voice-activity')).toBe(false)
    expect(shouldPublishInitialMicrophone(false, 'push-to-talk')).toBe(false)
    expect(shouldPublishInitialMicrophone(true, 'push-to-talk')).toBe(false)
  })
})

describe('voice connection status labels', () => {
  it('describes the actual transport state instead of always claiming a connection', () => {
    expect(voiceConnectionLabel('connecting')).toBe('Voice connecting')
    expect(voiceConnectionLabel('connected')).toBe('Voice connected')
    expect(voiceConnectionLabel('reconnecting')).toBe('Voice reconnecting')
    expect(voiceConnectionLabel('degraded')).toBe('Voice degraded')
    expect(voiceConnectionLabel('disconnected')).toBe('Voice disconnected')
    expect(voiceConnectionLabel('idle')).toBe('Voice idle')
  })
})

describe('voice channel activation', () => {
  it('keeps unavailable Matrix channels visible without creating a voice session', () => {
    expect(shouldActivateVoiceSession(true, false)).toBe(false)
    expect(shouldActivateVoiceSession(true, true)).toBe(true)
    expect(shouldActivateVoiceSession(false, false)).toBe(true)
  })
})
