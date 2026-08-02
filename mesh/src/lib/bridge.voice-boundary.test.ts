import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { invoke, isTauri } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import type { BackendStatus } from '../types/ipc'

const invokeMock = vi.mocked(invoke)
const isTauriMock = vi.mocked(isTauri)
const listenMock = vi.mocked(listen)

const matrixStatus: BackendStatus = {
  kind: 'matrix',
  capabilities: {
    encryptedText: true,
    encryptedAttachments: true,
    directMessages: true,
    voice: false,
    durableTimeouts: false,
    deviceManagement: true,
    recovery: true,
    legacyMigration: false,
  },
  voiceService: {
    provider: 'matrix-rtc',
    availability: 'not-configured',
    discoveryKey: 'org.matrix.msc4143.rtc_foci',
    livekitServiceUrl: null,
    tokenEndpoint: null,
    livekitSfuUrl: null,
    cspReady: false,
    mediaE2eeVerified: false,
    reason: 'Voice is not configured',
  },
  authenticated: true,
  userId: '@alice:example.org',
  deviceId: 'DEVICE',
  homeserver: 'https://example.org',
  syncRunning: true,
  durableHistory: true,
      supportsE2ee: true,
      sessionE2eeReady: true,
  warnings: [],
}

const readyLegacyStatus: BackendStatus = {
  ...matrixStatus,
  kind: 'legacy-p2p',
  capabilities: {
    ...matrixStatus.capabilities,
    voice: true,
    deviceManagement: false,
    recovery: false,
    legacyMigration: true,
  },
  voiceService: {
    ...matrixStatus.voiceService,
    provider: 'legacy-simple-peer',
    availability: 'ready',
    reason: null,
  },
  userId: null,
  deviceId: null,
  homeserver: null,
}

async function loadBridge() {
  vi.resetModules()
  vi.doUnmock('./bridge')
  return import('./bridge')
}

async function cacheStatus(status: BackendStatus) {
  const bridge = await loadBridge()
  invokeMock.mockResolvedValueOnce(status as never)
  await bridge.getBackendStatus()
  invokeMock.mockReset()
  return bridge
}

describe('bridge voice backend boundary', () => {
  beforeEach(() => {
    isTauriMock.mockReturnValue(true)
    invokeMock.mockReset()
    listenMock.mockReset()
  })

  afterEach(() => {
    isTauriMock.mockReturnValue(false)
    vi.restoreAllMocks()
  })

  it('fails closed before IPC when backend state is absent or Matrix-owned', async () => {
    const uncachedBridge = await loadBridge()
    await expect(uncachedBridge.joinVoice('community-1', 'channel-1')).rejects.toThrow(
      'never falls back to legacy SimplePeer',
    )
    expect(invokeMock).not.toHaveBeenCalled()

    const matrixBridge = await cacheStatus(matrixStatus)
    await expect(matrixBridge.joinVoice('community-1', 'channel-1')).rejects.toThrow(
      'never falls back to legacy SimplePeer',
    )
    expect(invokeMock).not.toHaveBeenCalled()
  })

  it.each([
    {
      label: 'voice capability is disabled',
      status: {
        ...readyLegacyStatus,
        capabilities: { ...readyLegacyStatus.capabilities, voice: false },
      },
    },
    {
      label: 'provider is not legacy',
      status: {
        ...readyLegacyStatus,
        voiceService: {
          ...readyLegacyStatus.voiceService,
          provider: 'matrix-rtc' as const,
        },
      },
    },
    {
      label: 'service is not ready',
      status: {
        ...readyLegacyStatus,
        voiceService: {
          ...readyLegacyStatus.voiceService,
          availability: 'client-unavailable' as const,
        },
      },
    },
  ])('rejects inconsistent legacy state when $label', async ({ status }) => {
    const bridge = await cacheStatus(status)

    await expect(bridge.joinVoice('community-1', 'channel-1')).rejects.toThrow(
      'never falls back to legacy SimplePeer',
    )
    expect(invokeMock).not.toHaveBeenCalled()
  })

  it('permits legacy voice only after every readiness assertion passes', async () => {
    const bridge = await cacheStatus(readyLegacyStatus)
    const snapshot = {
      communityId: 'community-1',
      channelId: 'channel-1',
      sessionEpoch: 1,
      memberCount: 1,
      members: [],
      updatedAt: '2026-07-27T00:00:00Z',
    }
    invokeMock.mockResolvedValueOnce(snapshot as never)

    await expect(bridge.joinVoice('community-1', 'channel-1')).resolves.toBe(snapshot)
    expect(invokeMock).toHaveBeenCalledWith('join_voice', {
      communityId: 'community-1',
      channelId: 'channel-1',
    })
  })

  it('drops circular signaling before IPC and forwards serializable signaling exactly', async () => {
    const bridge = await cacheStatus(readyLegacyStatus)
    const circular: Record<string, unknown> = {}
    circular.self = circular

    await expect(
      bridge.sendVoiceSignal('peer-1', circular, 'community-1', 'channel-1'),
    ).rejects.toMatchObject({ code: 'serialization_error' })
    expect(invokeMock).not.toHaveBeenCalled()

    const signal = { type: 'offer', sdp: 'bounded-test-sdp' }
    invokeMock.mockResolvedValueOnce(undefined)
    await bridge.sendVoiceSignal('peer-1', signal, 'community-1', 'channel-1')
    expect(invokeMock).toHaveBeenCalledWith('send_voice_signal', {
      peerId: 'peer-1',
      signal,
      communityId: 'community-1',
      channelId: 'channel-1',
    })
  })

  it('does not register legacy voice listeners in Matrix mode', async () => {
    const bridge = await cacheStatus(matrixStatus)
    const handler = vi.fn()

    const unlistenFunctions = await Promise.all([
      bridge.onVoiceSignal(handler),
      bridge.onVoiceJoin(handler),
      bridge.onVoiceLeave(handler),
      bridge.onVoiceSession(handler),
      bridge.onVoiceSessionEvent(handler),
    ])

    expect(listenMock).not.toHaveBeenCalled()
    for (const unlisten of unlistenFunctions) {
      expect(unlisten()).toBeUndefined()
    }
  })

  it('keeps MatrixRTC key events on their dedicated listener boundary', async () => {
    const bridge = await cacheStatus(matrixStatus)
    const unlisten = vi.fn()
    const mediaKey = {
      roomId: '!room:example.org',
      userId: '@alice:example.org',
      deviceId: 'DEVICE',
      memberId: 'member-1',
      sessionId: 'session-1',
      activationId: 'activation-1',
      participantIdentity: 'participant-1',
      keyIndex: 7,
      key: 'redacted-test-key',
      sentTs: 1,
    }
    const handler = vi.fn()
    listenMock.mockImplementationOnce(async (event, listener) => {
      expect(event).toBe('matrix:rtc-media-key')
      listener({ event, id: 1, payload: mediaKey })
      return unlisten
    })

    await expect(bridge.onMatrixRtcMediaKey(handler)).resolves.toBe(unlisten)
    expect(handler).toHaveBeenCalledWith(mediaKey)
  })
})
