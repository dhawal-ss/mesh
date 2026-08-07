import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  MatrixRtcMediaKey,
  MatrixRtcMediaKeyPause,
} from '../lib/bridge'
import type { VoiceConnectionState } from '../types/ipc'
import { useVoiceStore } from '../store/voice'

const mocks = vi.hoisted(() => ({
  connect: vi.fn(),
  disconnect: vi.fn().mockResolvedValue(undefined),
  getStats: vi.fn().mockResolvedValue({ latencyMs: 42, quality: 'good' }),
  getDevices: vi.fn().mockResolvedValue([]),
  matrixRtcJoin: vi.fn(),
  matrixRtcLeave: vi.fn().mockResolvedValue(undefined),
  matrixRtcRenewMediaKeyLease: vi.fn(),
  matrixRtcAckMediaKeyPause: vi.fn(),
  matrixRtcAckMediaKey: vi.fn().mockResolvedValue(undefined),
  applyMediaKey: vi.fn().mockResolvedValue(undefined),
  updatePublicationLease: vi.fn().mockReturnValue(true),
  pausePublisherForActivation: vi.fn().mockResolvedValue('paused'),
  installLocalActivationKey: vi.fn().mockResolvedValue(undefined),
  resumePublisherAfterActivation: vi.fn().mockResolvedValue(true),
  failClosedMediaEncryption: vi.fn().mockResolvedValue(undefined),
  mediaKeyHandler: null as ((mediaKey: MatrixRtcMediaKey) => void) | null,
  mediaKeyFailureHandler: null as ((failure: { roomId: string; code: string }) => void) | null,
  mediaKeyPauseHandler: null as ((pause: MatrixRtcMediaKeyPause) => void) | null,
  engineHandlers: null as {
    onConnectionState?: (state: VoiceConnectionState, reason: string | null) => void
    onEncryptionFailure?: (reason: string, sessionId: string | null) => void
  } | null,
}))

vi.mock('@mesh/matrix-voice-runtime', () => ({
  LiveKitVoiceEngine: class {
    sessionId: string | null = null
    canApplyMediaKeys = false
    publicationGeneration = 0
    activePublisherActivationId: string | null = null

    constructor(handlers: typeof mocks.engineHandlers) {
      mocks.engineHandlers = handlers
    }

    connect = async (...args: unknown[]) => {
      this.sessionId = 'session-1'
      return mocks.connect(...args)
    }
    disconnect = mocks.disconnect
    getStats = mocks.getStats
    getDevices = mocks.getDevices
    applyMediaKey = mocks.applyMediaKey
    updatePublicationLease = mocks.updatePublicationLease
    pausePublisherForActivation = (pause: MatrixRtcMediaKeyPause) => {
      this.activePublisherActivationId = pause.activationId
      this.publicationGeneration += 1
      return mocks.pausePublisherForActivation(pause)
    }
    installLocalActivationKey = mocks.installLocalActivationKey
    resumePublisherAfterActivation = mocks.resumePublisherAfterActivation
    failClosedMediaEncryption = mocks.failClosedMediaEncryption
    setMuted = vi.fn().mockResolvedValue(undefined)
    setDeafened = vi.fn()
  },
}))

vi.mock('../lib/bridge', () => {
  const voiceService = {
    provider: 'matrix-rtc',
    availability: 'ready',
    discoveryKey: null,
    livekitServiceUrl: 'https://livekit.example.org',
    tokenEndpoint: 'https://livekit.example.org/token',
    livekitSfuUrl: 'wss://livekit.example.org',
    cspReady: true,
    mediaE2eeReady: true,
    reason: null,
  }

  return {
    getBackendStatusSnapshot: () => ({
      kind: 'matrix',
      capabilities: {
        encryptedText: true,
        encryptedAttachments: true,
        directMessages: true,
        voice: true,
        durableTimeouts: true,
        deviceManagement: true,
        recovery: true,
        legacyMigration: false,
      },
      voiceService,
      authenticated: true,
      userId: '@alice:example.org',
      deviceId: 'DEVICE',
      homeserver: 'https://example.org',
      syncRunning: true,
      durableHistory: true,
      supportsE2ee: true,
      sessionE2eeReady: true,
      warnings: [],
    }),
    getVoiceServiceStatus: () => voiceService,
    matrixRtcJoin: mocks.matrixRtcJoin,
    matrixRtcLeave: mocks.matrixRtcLeave,
    matrixRtcRenewMediaKeyLease: mocks.matrixRtcRenewMediaKeyLease,
    matrixRtcAckMediaKeyPause: mocks.matrixRtcAckMediaKeyPause,
    matrixRtcAckMediaKey: mocks.matrixRtcAckMediaKey,
    matrixRtcRefreshMembership: vi.fn().mockResolvedValue(undefined),
    onMatrixRtcMediaKey: vi.fn(async (
      handler: NonNullable<typeof mocks.mediaKeyHandler>,
    ) => {
      mocks.mediaKeyHandler = handler
      return () => {
        if (mocks.mediaKeyHandler === handler) mocks.mediaKeyHandler = null
      }
    }),
    onMatrixRtcMediaKeyFailure: vi.fn(async (
      handler: NonNullable<typeof mocks.mediaKeyFailureHandler>,
    ) => {
      mocks.mediaKeyFailureHandler = handler
      return () => {
        if (mocks.mediaKeyFailureHandler === handler) {
          mocks.mediaKeyFailureHandler = null
        }
      }
    }),
    onMatrixRtcMediaKeyPause: vi.fn(async (
      handler: NonNullable<typeof mocks.mediaKeyPauseHandler>,
    ) => {
      mocks.mediaKeyPauseHandler = handler
      return () => {
        if (mocks.mediaKeyPauseHandler === handler) {
          mocks.mediaKeyPauseHandler = null
        }
      }
    }),
    onVoiceJoin: vi.fn(),
    onVoiceLeave: vi.fn(),
    onVoiceSession: vi.fn(),
    onVoiceSessionEvent: vi.fn(),
    onVoiceSignal: vi.fn(),
    setDeafened: vi.fn().mockResolvedValue(undefined),
    setMuted: vi.fn().mockResolvedValue(undefined),
  }
})

import { useVoiceEngine } from './useVoiceEngine'

function Harness() {
  const { connectionWarning } = useVoiceEngine()
  return <span data-testid="voice-warning">{connectionWarning}</span>
}

function joinedCredentials() {
  return {
    roomId: '!voice:example.org',
    sessionId: 'session-1',
    memberId: 'member-1',
    url: 'wss://livekit.example.org',
    token: 'signed-token',
    roomName: 'voice-room',
    participantIdentity: '@alice:example.org:DEVICE',
    mediaE2eeReady: true,
    mediaKey: {
      roomId: '!voice:example.org',
      userId: '@alice:example.org',
      deviceId: 'DEVICE',
      memberId: 'member-1',
      participantIdentity: '@alice:example.org:DEVICE',
      keyIndex: 0,
      key: 'AAAAAAAAAAAAAAAAAAAAAA',
      sentTs: 1,
      sessionId: null,
      activationId: null,
    },
  }
}

function mediaKeyLease(keyIndex = 0) {
  return {
    roomId: '!voice:example.org',
    sessionId: 'session-1',
    memberId: 'member-1',
    keyIndex,
    expiresAt: Date.now() + 3_000,
  }
}

function mediaKeyPause() {
  return {
    roomId: '!voice:example.org',
    sessionId: 'session-1',
    memberId: 'member-1',
    activationId: 'activation-1',
    keyIndex: 1,
  }
}

function activationCandidate() {
  return {
    ...joinedCredentials().mediaKey,
    keyIndex: 1,
    key: 'AQEBAQEBAQEBAQEBAQEBAQ',
    sentTs: 2,
    sessionId: 'session-1',
    activationId: 'activation-1',
  }
}

describe('useVoiceEngine MatrixRTC lifecycle', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    vi.useRealTimers()
    vi.clearAllMocks()
    mocks.connect.mockReset().mockResolvedValue(undefined)
    mocks.disconnect.mockResolvedValue(undefined)
    mocks.getStats.mockResolvedValue({ latencyMs: 42, quality: 'good' })
    mocks.getDevices.mockResolvedValue([])
    mocks.matrixRtcJoin.mockResolvedValue(joinedCredentials())
    mocks.matrixRtcLeave.mockResolvedValue(undefined)
    mocks.matrixRtcRenewMediaKeyLease
      .mockReset()
      .mockResolvedValue(mediaKeyLease())
    mocks.matrixRtcAckMediaKeyPause
      .mockReset()
      .mockResolvedValue(activationCandidate())
    mocks.matrixRtcAckMediaKey.mockReset().mockResolvedValue(undefined)
    mocks.applyMediaKey.mockResolvedValue(undefined)
    mocks.updatePublicationLease.mockReset().mockReturnValue(true)
    mocks.pausePublisherForActivation.mockReset().mockResolvedValue('paused')
    mocks.installLocalActivationKey.mockReset().mockResolvedValue(undefined)
    mocks.resumePublisherAfterActivation.mockReset().mockResolvedValue(true)
    mocks.failClosedMediaEncryption.mockResolvedValue(undefined)
    mocks.mediaKeyHandler = null
    mocks.mediaKeyFailureHandler = null
    mocks.mediaKeyPauseHandler = null
    mocks.engineHandlers = null
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    useVoiceStore.getState().resetVoiceState()
    useVoiceStore.getState().setCurrentVoiceSession('community-1', '!voice:example.org')
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  it('leaves MatrixRTC membership when the media engine cannot connect', async () => {
    mocks.connect.mockRejectedValueOnce(new Error('SFU unavailable'))

    await act(async () => {
      root.render(<Harness />)
    })

    await vi.waitFor(() => {
      expect(mocks.matrixRtcLeave).toHaveBeenCalledWith(
        '!voice:example.org',
        'session-1',
      )
    })
    expect(mocks.disconnect).toHaveBeenCalledWith(false)
    expect(useVoiceStore.getState().connectionState).toBe('disconnected')
  })

  it('starts latency polling only after the asynchronous connection succeeds', async () => {
    let resolveConnect: (() => void) | undefined
    mocks.connect.mockImplementationOnce(
      () => new Promise<void>((resolve) => {
        resolveConnect = resolve
      }),
    )

    await act(async () => {
      root.render(<Harness />)
    })
    await vi.waitFor(() => expect(mocks.connect).toHaveBeenCalledOnce())
    expect(mocks.getStats).not.toHaveBeenCalled()

    await act(async () => {
      resolveConnect?.()
      await Promise.resolve()
    })

    await vi.waitFor(() => expect(mocks.getStats).toHaveBeenCalledOnce())
  })

  it('passes the current push-to-talk privacy state into the asynchronous join', async () => {
    useVoiceStore.getState().setInputMode('push-to-talk')

    await act(async () => {
      root.render(<Harness />)
    })

    await vi.waitFor(() => expect(mocks.connect).toHaveBeenCalledOnce())
    expect(mocks.connect.mock.calls[0][2]).toBe(false)
    expect(mocks.connect.mock.calls[0][3]).toEqual(joinedCredentials().mediaKey)
  })

  it('buffers remote keys received during join and applies them only through connect setup', async () => {
    const remoteKey = {
      roomId: '!voice:example.org',
      userId: '@bob:example.org',
      deviceId: 'BOB',
      memberId: 'member-bob',
      participantIdentity: '@bob:example.org:BOB',
      keyIndex: 16,
      key: 'AQEBAQEBAQEBAQEBAQEBAQ',
      sentTs: 2,
      sessionId: null,
      activationId: null,
    }
    mocks.matrixRtcJoin.mockImplementationOnce(async () => {
      mocks.mediaKeyHandler?.(remoteKey)
      return joinedCredentials()
    })

    await act(async () => {
      root.render(<Harness />)
    })

    await vi.waitFor(() => expect(mocks.connect).toHaveBeenCalledOnce())
    expect(mocks.connect.mock.calls[0][4]).toEqual([remoteKey])
    expect(mocks.connect.mock.calls[0][5]).toEqual(
      expect.objectContaining({
        roomId: '!voice:example.org',
        sessionId: 'session-1',
        memberId: 'member-1',
        keyIndex: 0,
      }),
    )
  })

  it('never copies ephemeral media key material into the voice store', async () => {
    await act(async () => {
      root.render(<Harness />)
    })

    await vi.waitFor(() => expect(mocks.connect).toHaveBeenCalledOnce())
    expect(JSON.stringify(useVoiceStore.getState())).not.toContain(
      joinedCredentials().mediaKey.key,
    )
  })

  it('leaves membership when the media engine reports an encryption failure', async () => {
    await act(async () => {
      root.render(<Harness />)
    })
    await vi.waitFor(() => expect(mocks.connect).toHaveBeenCalledOnce())
    mocks.matrixRtcLeave.mockClear()

    await act(async () => {
      mocks.engineHandlers?.onEncryptionFailure?.(
        'Private media encryption failed',
        'session-1',
      )
    })

    await vi.waitFor(() => {
      expect(mocks.matrixRtcLeave).toHaveBeenCalledWith(
        '!voice:example.org',
        'session-1',
      )
    })
    expect(useVoiceStore.getState()).toMatchObject({
      isMuted: true,
      isCameraEnabled: false,
      isScreenSharing: false,
      lastReconnectReason: 'Private voice was stopped to keep this call secure. Try again.',
    })
    expect(container.textContent).toContain(
      'Private voice was stopped to keep this call secure. Try again.',
    )
    expect(container.textContent).not.toContain('media encryption')
  })

  it('fails closed if publisher-key distribution fails during join', async () => {
    mocks.matrixRtcJoin.mockImplementationOnce(async () => {
      mocks.mediaKeyFailureHandler?.({
        roomId: '!voice:example.org',
        code: 'distribution-failed',
      })
      return joinedCredentials()
    })

    await act(async () => {
      root.render(<Harness />)
    })

    await vi.waitFor(() => {
      expect(mocks.matrixRtcLeave).toHaveBeenCalledWith(
        '!voice:example.org',
        'session-1',
      )
    })
    expect(mocks.failClosedMediaEncryption).toHaveBeenCalledWith(
      'Private media key distribution failed',
    )
    expect(mocks.connect).not.toHaveBeenCalled()
  })

  it('activates a publisher key only after pause, both acknowledgements, and a new lease', async () => {
    await act(async () => {
      root.render(<Harness />)
    })
    await vi.waitFor(() => expect(mocks.connect).toHaveBeenCalledOnce())
    const pause = mediaKeyPause()

    await act(async () => {
      mocks.mediaKeyPauseHandler?.(pause)
    })

    await vi.waitFor(() => {
      expect(mocks.resumePublisherAfterActivation).toHaveBeenCalledWith(
        pause.activationId,
      )
    })
    expect(mocks.matrixRtcAckMediaKeyPause).toHaveBeenCalledWith(
      pause.roomId,
      pause.sessionId,
      pause.memberId,
      pause.activationId,
    )
    expect(mocks.installLocalActivationKey).toHaveBeenCalledWith(
      pause,
      activationCandidate(),
    )
    expect(mocks.matrixRtcAckMediaKey).toHaveBeenCalledWith(
      pause.roomId,
      pause.sessionId,
      pause.memberId,
      pause.activationId,
      1,
      2,
    )
    expect(
      mocks.pausePublisherForActivation.mock.invocationCallOrder[0],
    ).toBeLessThan(
      mocks.matrixRtcAckMediaKeyPause.mock.invocationCallOrder[0],
    )
    expect(
      mocks.matrixRtcAckMediaKeyPause.mock.invocationCallOrder[0],
    ).toBeLessThan(
      mocks.installLocalActivationKey.mock.invocationCallOrder[0],
    )
    expect(
      mocks.installLocalActivationKey.mock.invocationCallOrder[0],
    ).toBeLessThan(
      mocks.matrixRtcAckMediaKey.mock.invocationCallOrder[0],
    )
    expect(
      mocks.matrixRtcAckMediaKey.mock.invocationCallOrder[0],
    ).toBeLessThan(
      mocks.updatePublicationLease.mock.invocationCallOrder[0],
    )
    expect(
      mocks.updatePublicationLease.mock.invocationCallOrder[0],
    ).toBeLessThan(
      mocks.resumePublisherAfterActivation.mock.invocationCallOrder[0],
    )
  })

  it('allows a federation-backed pause acknowledgement to exceed the lease timeout', async () => {
    vi.useFakeTimers()
    mocks.matrixRtcAckMediaKeyPause.mockImplementationOnce(
      () => new Promise((resolve) => {
        setTimeout(() => resolve(activationCandidate()), 1_600)
      }),
    )
    mocks.matrixRtcRenewMediaKeyLease
      .mockResolvedValueOnce(mediaKeyLease())
      .mockResolvedValueOnce(mediaKeyLease(1))
    await act(async () => {
      root.render(<Harness />)
      await vi.advanceTimersByTimeAsync(0)
    })

    await act(async () => {
      mocks.mediaKeyPauseHandler?.(mediaKeyPause())
      await vi.advanceTimersByTimeAsync(1_599)
    })
    expect(mocks.resumePublisherAfterActivation).not.toHaveBeenCalled()
    expect(mocks.failClosedMediaEncryption).not.toHaveBeenCalled()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2)
    })
    expect(mocks.resumePublisherAfterActivation).toHaveBeenCalledWith(
      'activation-1',
    )
    expect(mocks.failClosedMediaEncryption).not.toHaveBeenCalled()
  })

  it('ignores a pause for the wrong MatrixRTC session', async () => {
    await act(async () => {
      root.render(<Harness />)
    })
    await vi.waitFor(() => expect(mocks.connect).toHaveBeenCalledOnce())

    await act(async () => {
      mocks.mediaKeyPauseHandler?.({
        ...mediaKeyPause(),
        sessionId: 'stale-session',
      })
    })

    expect(mocks.pausePublisherForActivation).not.toHaveBeenCalled()
    expect(mocks.matrixRtcAckMediaKeyPause).not.toHaveBeenCalled()
    expect(mocks.resumePublisherAfterActivation).not.toHaveBeenCalled()
  })

  it('does not let a stale pre-join pause abort a new MatrixRTC session', async () => {
    mocks.matrixRtcJoin.mockImplementationOnce(async () => {
      mocks.mediaKeyPauseHandler?.({
        ...mediaKeyPause(),
        sessionId: 'stale-session',
        memberId: 'stale-member',
      })
      return joinedCredentials()
    })

    await act(async () => {
      root.render(<Harness />)
    })

    await vi.waitFor(() => expect(mocks.connect).toHaveBeenCalledOnce())
    expect(mocks.matrixRtcLeave).not.toHaveBeenCalled()
    expect(mocks.matrixRtcAckMediaKeyPause).not.toHaveBeenCalled()
  })

  it('fails closed before connecting when the current session was paused during join', async () => {
    mocks.matrixRtcJoin.mockImplementationOnce(async () => {
      mocks.mediaKeyPauseHandler?.(mediaKeyPause())
      return joinedCredentials()
    })

    await act(async () => {
      root.render(<Harness />)
    })

    await vi.waitFor(() => {
      expect(mocks.matrixRtcLeave).toHaveBeenCalledWith(
        '!voice:example.org',
        'session-1',
      )
    })
    expect(mocks.connect).not.toHaveBeenCalled()
    expect(mocks.matrixRtcAckMediaKeyPause).not.toHaveBeenCalled()
  })

  it('never routes a local activation DTO through the remote-key path', async () => {
    mocks.matrixRtcJoin.mockImplementationOnce(async () => {
      mocks.mediaKeyHandler?.(activationCandidate())
      return joinedCredentials()
    })

    await act(async () => {
      root.render(<Harness />)
    })

    await vi.waitFor(() => {
      expect(mocks.failClosedMediaEncryption).toHaveBeenCalledWith(
        'A private media key update had invalid activation metadata',
      )
    })
    expect(mocks.applyMediaKey).not.toHaveBeenCalled()
    expect(mocks.connect).not.toHaveBeenCalled()
  })

  it('fails closed when a periodic publisher lease renewal is rejected', async () => {
    vi.useFakeTimers()
    mocks.matrixRtcRenewMediaKeyLease
      .mockResolvedValueOnce(mediaKeyLease())
      .mockRejectedValueOnce(new Error('lease rejected'))
    await act(async () => {
      root.render(<Harness />)
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(mocks.connect).toHaveBeenCalledOnce()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000)
    })

    expect(mocks.failClosedMediaEncryption).toHaveBeenCalledWith(
      'Private media publication lease could not be renewed',
    )
  })

  it('ignores an old lease renewal response after publisher activation advances generation', async () => {
    vi.useFakeTimers()
    let resolveOldLease: ((lease: ReturnType<typeof mediaKeyLease>) => void) | undefined
    const oldLease = new Promise<ReturnType<typeof mediaKeyLease>>((resolve) => {
      resolveOldLease = resolve
    })
    mocks.matrixRtcRenewMediaKeyLease
      .mockResolvedValueOnce(mediaKeyLease())
      .mockReturnValueOnce(oldLease)
      .mockResolvedValueOnce(mediaKeyLease(1))

    await act(async () => {
      root.render(<Harness />)
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(mocks.connect).toHaveBeenCalledOnce()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000)
    })
    expect(mocks.matrixRtcRenewMediaKeyLease).toHaveBeenCalledTimes(2)

    await act(async () => {
      mocks.mediaKeyPauseHandler?.(mediaKeyPause())
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(mocks.resumePublisherAfterActivation).toHaveBeenCalledWith(
      'activation-1',
    )
    expect(mocks.updatePublicationLease).toHaveBeenCalledOnce()

    await act(async () => {
      resolveOldLease?.(mediaKeyLease())
      await vi.advanceTimersByTimeAsync(0)
    })

    expect(mocks.updatePublicationLease).toHaveBeenCalledOnce()
    expect(mocks.failClosedMediaEncryption).not.toHaveBeenCalled()
  })
})
