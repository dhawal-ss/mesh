import { describe, expect, it } from 'vitest'
import type { BackendStatus } from './bridge'
import {
  canStartLegacyVoice,
  canStartMatrixVoice,
  isPermissionDeniedError,
  isPushToTalkInteractiveTarget,
  resolveVoiceStatusIndicator,
  shouldActivateVoiceSession,
  shouldExposeVoiceRoutes,
  shouldPublishInitialMicrophone,
  shouldReleasePushToTalk,
  PRIVATE_VOICE_FAILURE_MESSAGE,
  voiceConnectionLabel,
  voiceConnectionUserMessage,
  voiceMediaErrorMessage,
  voiceServiceUserMessage,
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
      mediaE2eeReady: false,
      reason: 'Experimental legacy transport',
    },
    authenticated: false,
    userId: null,
    deviceId: null,
    homeserver: null,
    syncRunning: false,
    durableHistory: false,
      supportsE2ee: true,
      sessionE2eeReady: true,
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
        mediaE2eeReady: true,
      },
    })

    expect(canStartMatrixVoice(ready)).toBe(true)
    expect(
      canStartMatrixVoice({
        ...ready,
        voiceService: { ...ready.voiceService, mediaE2eeReady: false },
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

  it('maps camera denial to a plain system-settings action', () => {
    const denied = Object.assign(new Error('raw browser failure'), {
      name: 'NotAllowedError',
    })
    expect(voiceMediaErrorMessage(denied, 'camera')).toBe(
      'Mesh cannot use your camera. Allow camera access in system settings.',
    )
  })

  it('never exposes arbitrary camera runtime errors', () => {
    expect(voiceMediaErrorMessage(new Error('NotReadableError: raw camera device ID'), 'camera')).toBe(
      'Mesh could not change your camera. Check it is connected and free.',
    )
  })

  it('maps screen-picker denial or cancellation to a safe recovery action', () => {
    const denied = Object.assign(new Error('raw browser failure'), {
      name: 'NotAllowedError',
    })
    expect(voiceMediaErrorMessage(denied, 'screen-share')).toBe(
      'Screen sharing did not start. Allow screen access in system settings.',
    )
  })

  it('never exposes arbitrary screen-sharing runtime errors', () => {
    expect(voiceMediaErrorMessage(new Error('access_token=secret'), 'screen-share')).toBe(
      'Mesh could not change screen sharing. Choose the window again.',
    )
  })
})

describe('private voice failure copy', () => {
  it.each([
    'Private media encryption failed',
    'Private media key distribution failed',
    'A private media key update had invalid activation metadata',
    'MatrixRTC publication lease renewal timed out',
  ])('maps %s to one stable recovery message', (reason) => {
    expect(voiceConnectionUserMessage(reason)).toBe(PRIVATE_VOICE_FAILURE_MESSAGE)
  })

  it('preserves already actionable non-security guidance', () => {
    expect(voiceConnectionUserMessage('Check your internet connection and try again.')).toBe(
      'Check your internet connection and try again.',
    )
    expect(voiceConnectionUserMessage(null)).toBeNull()
  })
})

describe('calling availability copy', () => {
  it.each([
    ['not-configured', 'Calling is not available for this account yet. You can keep using messages.'],
    ['invalid-configuration', 'Calling needs attention from the account service. You can keep using messages.'],
    ['client-unavailable', 'Calling is unavailable in this version of Mesh. You can keep using messages.'],
    ['ready', 'Calling is unavailable right now. Try again.'],
  ] as const)('maps %s without exposing a service reason', (availability, message) => {
    expect(voiceServiceUserMessage(availability)).toBe(message)
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
  const readyMatrixStatus = status({
    kind: 'matrix',
    voiceService: {
      ...status().voiceService,
      provider: 'matrix-rtc',
      availability: 'ready',
      mediaE2eeReady: true,
    },
  })

  it('exposes Matrix voice routes only when both the frontend and service are ready', () => {
    expect(shouldExposeVoiceRoutes(true, readyMatrixStatus, false)).toBe(false)
    expect(shouldExposeVoiceRoutes(true, readyMatrixStatus, true)).toBe(true)
    expect(shouldExposeVoiceRoutes(true, null, true)).toBe(false)
    expect(shouldExposeVoiceRoutes(false, null, false)).toBe(true)
  })

  it('does not create a Matrix voice session unless the route boundary is ready', () => {
    expect(shouldActivateVoiceSession(true, false)).toBe(false)
    expect(shouldActivateVoiceSession(true, true)).toBe(true)
    expect(shouldActivateVoiceSession(false, false)).toBe(true)
  })
})

describe('voice status indicator', () => {
  const base = {
    lifecycle: 'connected' as const,
    microphonePermission: 'granted' as const,
    isMuted: false,
    isDeafened: false,
    quality: 'unknown' as const,
  }

  it('lets a denied microphone outrank every other state, including reconnecting', () => {
    expect(resolveVoiceStatusIndicator({
      ...base,
      lifecycle: 'reconnecting',
      microphonePermission: 'denied',
    })).toEqual({ label: 'Microphone blocked', tone: 'danger', icon: 'micOff' })
  })

  it('names reconnecting and failed states instead of silently disappearing', () => {
    expect(resolveVoiceStatusIndicator({ ...base, lifecycle: 'requesting' }))
      .toEqual({ label: 'Joining…', tone: 'neutral', icon: 'mic' })
    expect(resolveVoiceStatusIndicator({ ...base, lifecycle: 'reconnect-grace' }))
      .toEqual({ label: 'Reconnecting…', tone: 'warning', icon: 'refresh' })
    expect(resolveVoiceStatusIndicator({ ...base, lifecycle: 'reconnecting' }))
      .toEqual({ label: 'Reconnecting…', tone: 'warning', icon: 'refresh' })
    expect(resolveVoiceStatusIndicator({ ...base, lifecycle: 'failed' }))
      .toEqual({ label: 'Voice could not connect', tone: 'danger', icon: 'phoneOff' })
    expect(resolveVoiceStatusIndicator({ ...base, lifecycle: 'leaving' }))
      .toEqual({ label: 'Leaving…', tone: 'neutral', icon: 'phoneOff' })
  })

  it('surfaces mute and deafen while connected, deafened taking priority over muted', () => {
    expect(resolveVoiceStatusIndicator({ ...base, isMuted: true }))
      .toEqual({ label: 'Muted', tone: 'neutral', icon: 'micOff' })
    expect(resolveVoiceStatusIndicator({ ...base, isDeafened: true }))
      .toEqual({ label: 'Deafened', tone: 'warning', icon: 'headphoneOff' })
    expect(resolveVoiceStatusIndicator({ ...base, isMuted: true, isDeafened: true }))
      .toEqual({ label: 'Muted and deafened', tone: 'warning', icon: 'headphoneOff' })
  })

  it('reports connection quality only once unmuted, undeafened, and permitted', () => {
    expect(resolveVoiceStatusIndicator({ ...base, quality: 'excellent' }))
      .toEqual({ label: 'Excellent connection', tone: 'success', icon: 'mic' })
    expect(resolveVoiceStatusIndicator({ ...base, quality: 'good' }))
      .toEqual({ label: 'Good connection', tone: 'success', icon: 'mic' })
    expect(resolveVoiceStatusIndicator({ ...base, quality: 'poor' }))
      .toEqual({ label: 'Poor connection', tone: 'warning', icon: 'triangleAlert' })
    expect(resolveVoiceStatusIndicator({ ...base, quality: 'unknown' }))
      .toEqual({ label: 'Voice connected', tone: 'neutral', icon: 'mic' })
  })
})
