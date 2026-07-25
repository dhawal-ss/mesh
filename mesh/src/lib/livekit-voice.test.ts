import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ConnectionQuality,
  ConnectionState,
  KeyProviderEvent,
  type Room,
  RoomEvent,
} from 'livekit-client'
import {
  LiveKitVoiceEngine,
  MatrixRtcKeyProvider,
  type MatrixVoiceCredentials,
} from './livekit-voice'
import type { MatrixRtcMediaKey, MatrixRtcMediaKeyLease } from './bridge'
import { shouldPublishInitialMicrophone } from './voice-runtime'

function credentials(
  overrides: Partial<MatrixVoiceCredentials> = {},
): MatrixVoiceCredentials {
  return {
    roomId: '!voice:example.org',
    sessionId: 'session-1',
    memberId: 'member-1',
    url: 'wss://livekit.example.org',
    token: 'signed-token',
    roomName: 'voice-room',
    participantIdentity: '@alice:example.org:DEVICE',
    mediaE2eeVerified: true,
    ...overrides,
  }
}

function mediaKey(overrides: Partial<MatrixRtcMediaKey> = {}): MatrixRtcMediaKey {
  return {
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
    ...overrides,
  }
}

function mediaKeyLease(
  overrides: Partial<MatrixRtcMediaKeyLease> = {},
): MatrixRtcMediaKeyLease {
  return {
    roomId: '!voice:example.org',
    sessionId: 'session-1',
    memberId: 'member-1',
    keyIndex: 0,
    expiresAt: Date.now() + 3_000,
    ...overrides,
  }
}

function fakeEncryption() {
  const setParticipantKey = vi.fn().mockResolvedValue(undefined)
  const keyProvider = {
    setParticipantKey,
  } as unknown as MatrixRtcKeyProvider
  return {
    factory: vi.fn().mockResolvedValue({
      keyProvider,
      worker: {} as Worker,
    }),
    setParticipantKey,
  }
}

function fakeRoom() {
  const eventHandlers = new Map<string, (...args: unknown[]) => void>()
  const setMicrophoneEnabled = vi.fn().mockResolvedValue(undefined)
  const setCameraEnabled = vi.fn().mockResolvedValue(undefined)
  const setScreenShareEnabled = vi.fn().mockResolvedValue(undefined)
  const microphonePublication = {
    mute: vi.fn().mockResolvedValue(undefined),
    unmute: vi.fn().mockResolvedValue(undefined),
    audioTrack: {
      mediaStreamTrack: undefined,
      getSenderStats: vi.fn().mockResolvedValue({ roundTripTime: 0.042 }),
    },
  }
  const localParticipant = {
    identity: '@alice:example.org:DEVICE',
    sid: 'local-sid',
    name: 'Alice',
    metadata: undefined,
    attributes: {},
    connectionQuality: ConnectionQuality.Excellent,
    joinedAt: new Date('2026-01-01T00:00:00Z'),
    isSpeaking: false,
    isMicrophoneEnabled: false,
    isCameraEnabled: false,
    isScreenShareEnabled: false,
    audioLevel: 0.25,
    getTrackPublication: vi.fn().mockImplementation((source: string) =>
      source === 'microphone' ? microphonePublication : undefined,
    ),
    setMicrophoneEnabled,
    setCameraEnabled,
    setScreenShareEnabled,
  }
  const remoteSetVolume = vi.fn()
  const remoteSetSubscribed = vi.fn()
  const remoteParticipant = {
    identity: '@bob:example.org:DEVICE',
    sid: 'remote-sid',
    name: 'Bob',
    metadata: undefined,
    attributes: {},
    connectionQuality: ConnectionQuality.Good,
    joinedAt: new Date('2026-01-01T00:00:01Z'),
    isSpeaking: true,
    trackPublications: new Map([
      ['remote-track', { setSubscribed: remoteSetSubscribed }],
    ]),
    getTrackPublication: vi.fn().mockReturnValue(undefined),
    setVolume: remoteSetVolume,
  }
  const room = {
    state: ConnectionState.Disconnected,
    isE2EEEnabled: true,
    canPlaybackAudio: true,
    localParticipant,
    remoteParticipants: new Map([[remoteParticipant.identity, remoteParticipant]]),
    on: vi.fn(),
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    removeAllListeners: vi.fn(),
    switchActiveDevice: vi.fn().mockResolvedValue(true),
  }
  room.on.mockImplementation((event: string, handler: (...args: unknown[]) => void) => {
    eventHandlers.set(event, handler)
    return room
  })
  setCameraEnabled.mockImplementation(async (enabled: boolean) => {
    localParticipant.isCameraEnabled = enabled
  })
  setMicrophoneEnabled.mockImplementation(async (enabled: boolean) => {
    localParticipant.isMicrophoneEnabled = enabled
  })
  setScreenShareEnabled.mockImplementation(async (enabled: boolean) => {
    localParticipant.isScreenShareEnabled = enabled
  })

  return {
    room: room as unknown as Room,
    setMicrophoneEnabled,
    setCameraEnabled,
    setScreenShareEnabled,
    remoteSetVolume,
    remoteSetSubscribed,
    connect: room.connect,
    disconnect: room.disconnect,
    localParticipant,
    remoteParticipant,
    emit: (event: RoomEvent, ...args: unknown[]) => eventHandlers.get(event)?.(...args),
  }
}

describe('LiveKitVoiceEngine', () => {
  beforeEach(() => {
    vi.useRealTimers()
  })

  it('fails closed before creating a room when media E2EE is not verified', async () => {
    const roomFactory = vi.fn()
    const encryptionFactory = vi.fn()
    const engine = new LiveKitVoiceEngine({}, roomFactory, encryptionFactory)

    await expect(
      engine.connect(credentials({ mediaE2eeVerified: false })),
    ).rejects.toThrow('complete encrypted session credentials')
    expect(encryptionFactory).not.toHaveBeenCalled()
    expect(roomFactory).not.toHaveBeenCalled()
  })

  it('fails closed before room creation when the typed local publisher key is missing', async () => {
    const roomFactory = vi.fn()
    const encryption = fakeEncryption()
    const engine = new LiveKitVoiceEngine({}, roomFactory, encryption.factory)

    await expect(engine.connect(credentials())).rejects.toThrow(
      'local participant media key',
    )
    expect(encryption.factory).not.toHaveBeenCalled()
    expect(roomFactory).not.toHaveBeenCalled()
  })

  it('connects with the backend token and starts an echo-cancelled microphone', async () => {
    const fake = fakeRoom()
    const roomFactory = vi.fn(() => fake.room)
    const encryption = fakeEncryption()
    const onPeers = vi.fn()
    const engine = new LiveKitVoiceEngine({ onPeers }, roomFactory, encryption.factory)

    await engine.connect(
      credentials(),
      'mic-2',
      true,
      mediaKey(),
      [],
      mediaKeyLease(),
    )

    expect(encryption.factory).toHaveBeenCalledWith()
    expect(encryption.setParticipantKey).toHaveBeenCalledWith(mediaKey())
    expect(fake.connect).toHaveBeenCalledWith(
      'wss://livekit.example.org',
      'signed-token',
      { autoSubscribe: false },
    )
    expect(fake.setMicrophoneEnabled).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        autoGainControl: true,
        echoCancellation: true,
        noiseSuppression: true,
        deviceId: 'mic-2',
      }),
    )
    expect(onPeers).toHaveBeenLastCalledWith([
      expect.objectContaining({ displayName: 'Alice', isSelf: true }),
      expect.objectContaining({ displayName: 'Bob', speaking: true }),
    ])
    const retainedCredentials = (
      engine as unknown as { credentials: Record<string, unknown> }
    ).credentials
    expect(retainedCredentials).not.toHaveProperty('mediaKey')
    expect(JSON.stringify(retainedCredentials)).not.toContain(mediaKey().key)

    await engine.disconnect()
    expect(fake.disconnect).toHaveBeenCalledOnce()
  })

  it('does not subscribe to a remote publication until that participant is keyed', async () => {
    const fake = fakeRoom()
    const engine = new LiveKitVoiceEngine(
      {},
      () => fake.room,
      fakeEncryption().factory,
    )
    await engine.connect(
      credentials(),
      null,
      false,
      mediaKey(),
      [],
      mediaKeyLease(),
    )
    const publication = { setSubscribed: vi.fn() }

    fake.emit(RoomEvent.TrackPublished, publication, fake.remoteParticipant)
    expect(publication.setSubscribed).not.toHaveBeenCalled()

    await engine.applyMediaKey(mediaKey({
      userId: '@bob:example.org',
      deviceId: 'DEVICE',
      memberId: 'member-bob',
      participantIdentity: fake.remoteParticipant.identity,
      sentTs: 2,
    }))
    fake.emit(RoomEvent.TrackPublished, publication, fake.remoteParticipant)

    expect(publication.setSubscribed).toHaveBeenCalledWith(true)
    await engine.disconnect()
  })

  it('installs only the local key before Room setup and applies remote keys afterward', async () => {
    const fake = fakeRoom()
    const encryption = fakeEncryption()
    const localKey = mediaKey()
    const remoteKey = mediaKey({
      userId: '@bob:example.org',
      deviceId: 'DEVICE',
      memberId: 'member-bob',
      participantIdentity: '@bob:example.org:DEVICE',
      keyIndex: 16,
      key: 'AQEBAQEBAQEBAQEBAQEBAQ',
      sentTs: 2,
    })
    const roomFactory = vi.fn(() => {
      expect(encryption.setParticipantKey.mock.calls).toEqual([[localKey]])
      return fake.room
    })
    fake.connect.mockImplementationOnce(async () => {
      expect(encryption.setParticipantKey.mock.calls).toEqual([[localKey]])
    })
    const engine = new LiveKitVoiceEngine({}, roomFactory, encryption.factory)

    await engine.connect(
      credentials(),
      null,
      true,
      localKey,
      [remoteKey],
      mediaKeyLease(),
    )

    expect(encryption.setParticipantKey.mock.calls).toEqual([
      [localKey],
      [remoteKey],
    ])
    expect(fake.remoteSetSubscribed).toHaveBeenCalledWith(true)
    expect(fake.connect.mock.invocationCallOrder[0]).toBeLessThan(
      encryption.setParticipantKey.mock.invocationCallOrder[1],
    )
    expect(encryption.setParticipantKey.mock.invocationCallOrder[1]).toBeLessThan(
      fake.remoteSetSubscribed.mock.invocationCallOrder[0],
    )
    expect(fake.remoteSetSubscribed.mock.invocationCallOrder[0]).toBeLessThan(
      fake.setMicrophoneEnabled.mock.invocationCallOrder[0],
    )
    await engine.disconnect()
  })

  it('uses a participant-specific 256-slot keyring without retaining raw keys', async () => {
    const provider = new MatrixRtcKeyProvider()
    const index16 = mediaKey({ keyIndex: 16 })
    const index255 = mediaKey({
      userId: '@bob:example.org',
      deviceId: 'BOB',
      memberId: 'member-bob',
      participantIdentity: '@bob:example.org:BOB',
      keyIndex: 255,
      key: 'AQEBAQEBAQEBAQEBAQEBAQ',
      sentTs: 2,
    })

    await provider.setParticipantKey(index16)
    await provider.setParticipantKey(index255)

    expect(provider.getOptions()).toMatchObject({
      sharedKey: false,
      ratchetWindowSize: 0,
      keyringSize: 256,
      failureTolerance: 10,
    })
    expect(provider.getKeys().map(({ participantIdentity, keyIndex }) => ({
      participantIdentity,
      keyIndex,
    }))).toEqual([
      { participantIdentity: index16.participantIdentity, keyIndex: 16 },
      { participantIdentity: index255.participantIdentity, keyIndex: 255 },
    ])
    expect(JSON.stringify(provider.getKeys())).not.toContain(index16.key)
    expect(JSON.stringify(provider.getKeys())).not.toContain(index255.key)
  })

  it('rejects malformed or padded media keys without adding key material', async () => {
    const provider = new MatrixRtcKeyProvider()

    await expect(
      provider.setParticipantKey(mediaKey({ key: 'AAAAAAAAAAAAAAAAAAAAAA==' })),
    ).rejects.toThrow('unpadded base64')
    await expect(
      provider.setParticipantKey(mediaKey({ key: 'too-short' })),
    ).rejects.toThrow()
    await expect(
      provider.setParticipantKey(mediaKey({ sentTs: Number.MAX_SAFE_INTEGER + 1 })),
    ).rejects.toThrow('metadata')
    expect(provider.getKeys()).toEqual([])
  })

  it('ignores replayed key events older than the applied participant key', async () => {
    const provider = new MatrixRtcKeyProvider()
    const onSetKey = vi.fn()
    provider.on(KeyProviderEvent.SetKey, onSetKey)

    await provider.setParticipantKey(mediaKey({ sentTs: 20 }))
    await provider.setParticipantKey(
      mediaKey({ key: 'AQEBAQEBAQEBAQEBAQEBAQ', sentTs: 19 }),
    )

    expect(onSetKey).toHaveBeenCalledOnce()
  })

  it('retains the joined session id after a connection failure until cleanup', async () => {
    const fake = fakeRoom()
    fake.connect.mockRejectedValueOnce(new Error('SFU unavailable'))
    const engine = new LiveKitVoiceEngine(
      {},
      () => fake.room,
      fakeEncryption().factory,
    )

    await expect(
      engine.connect(
        credentials(),
        null,
        true,
        mediaKey(),
        [],
        mediaKeyLease(),
      ),
    ).rejects.toThrow('SFU unavailable')
    expect(engine.sessionId).toBe('session-1')

    await engine.disconnect(false)
    expect(engine.sessionId).toBeNull()
  })

  it.each([
    { label: 'muted', isMuted: true, inputMode: 'voice-activity' as const },
    { label: 'push-to-talk', isMuted: false, inputMode: 'push-to-talk' as const },
  ])('does not publish the microphone on an initially $label join', async ({ isMuted, inputMode }) => {
    const fake = fakeRoom()
    const engine = new LiveKitVoiceEngine(
      {},
      () => fake.room,
      fakeEncryption().factory,
    )

    await engine.connect(
      credentials(),
      'mic-2',
      shouldPublishInitialMicrophone(isMuted, inputMode),
      mediaKey(),
      [],
      mediaKeyLease(),
    )

    expect(fake.setMicrophoneEnabled).not.toHaveBeenCalledWith(
      true,
      expect.anything(),
    )
    await engine.disconnect()
  })

  it('caps screen sharing at 1080p60 with optional display audio', async () => {
    const fake = fakeRoom()
    const engine = new LiveKitVoiceEngine(
      {},
      () => fake.room,
      fakeEncryption().factory,
    )
    await engine.connect(
      credentials(),
      null,
      true,
      mediaKey(),
      [],
      mediaKeyLease(),
    )

    await engine.setScreenShareEnabled(true)

    expect(fake.setScreenShareEnabled).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        audio: true,
        resolution: { width: 1920, height: 1080, frameRate: 60 },
      }),
      expect.objectContaining({
        screenShareEncoding: expect.objectContaining({ maxFramerate: 60 }),
      }),
    )
    await engine.disconnect()
  })

  it('publishes authoritative local media state when native screen sharing ends', async () => {
    const fake = fakeRoom()
    const onLocalMediaState = vi.fn()
    const engine = new LiveKitVoiceEngine(
      { onLocalMediaState },
      () => fake.room,
      fakeEncryption().factory,
    )
    await engine.connect(
      credentials(),
      null,
      true,
      mediaKey(),
      [],
      mediaKeyLease(),
    )

    fake.localParticipant.isScreenShareEnabled = true
    fake.emit(RoomEvent.LocalTrackPublished)
    expect(onLocalMediaState).toHaveBeenLastCalledWith({
      cameraEnabled: false,
      screenShareEnabled: true,
    })

    fake.localParticipant.isScreenShareEnabled = false
    fake.emit(RoomEvent.LocalTrackUnpublished)
    expect(onLocalMediaState).toHaveBeenLastCalledWith({
      cameraEnabled: false,
      screenShareEnabled: false,
    })

    await engine.disconnect()
  })

  it.each([
    {
      label: 'an encryption error',
      event: RoomEvent.EncryptionError,
      args: [new Error('decrypt failed')],
    },
    {
      label: 'an unencrypted participant status',
      event: RoomEvent.ParticipantEncryptionStatusChanged,
      args: [false],
    },
  ])('fails closed and unpublishes all local media after $label', async ({ event, args }) => {
    const fake = fakeRoom()
    const onEncryptionFailure = vi.fn()
    const engine = new LiveKitVoiceEngine(
      { onEncryptionFailure },
      () => fake.room,
      fakeEncryption().factory,
    )
    await engine.connect(
      credentials(),
      null,
      true,
      mediaKey(),
      [],
      mediaKeyLease(),
    )
    fake.setMicrophoneEnabled.mockClear()
    fake.setCameraEnabled.mockClear()
    fake.setScreenShareEnabled.mockClear()
    fake.disconnect.mockClear()

    fake.emit(event, ...args)

    await vi.waitFor(() => {
      expect(onEncryptionFailure).toHaveBeenCalledWith(
        expect.any(String),
        'session-1',
      )
    })
    expect(fake.setMicrophoneEnabled).toHaveBeenCalledWith(false)
    expect(fake.setCameraEnabled).toHaveBeenCalledWith(false)
    expect(fake.setScreenShareEnabled).toHaveBeenCalledWith(false)
    expect(fake.disconnect).toHaveBeenCalledOnce()
    expect(engine.sessionId).toBe('session-1')
  })

  it('never publishes the microphone when encryption fails during connection', async () => {
    const fake = fakeRoom()
    let finishConnect: (() => void) | undefined
    fake.connect.mockImplementationOnce(
      () => new Promise<void>((resolve) => {
        finishConnect = resolve
      }),
    )
    const engine = new LiveKitVoiceEngine(
      {},
      () => fake.room,
      fakeEncryption().factory,
    )

    const connecting = engine.connect(
      credentials(),
      null,
      true,
      mediaKey(),
      [],
      mediaKeyLease(),
    )
    await vi.waitFor(() => expect(fake.connect).toHaveBeenCalledOnce())
    fake.emit(RoomEvent.EncryptionError, new Error('decrypt failed'))
    finishConnect?.()

    await expect(connecting).rejects.toThrow('Private media encryption failed')
    expect(fake.setMicrophoneEnabled).toHaveBeenCalledWith(false)
    expect(fake.setMicrophoneEnabled).not.toHaveBeenCalledWith(
      true,
      expect.anything(),
    )
  })

  it('keeps participant volume local and clamps amplification', async () => {
    const fake = fakeRoom()
    const engine = new LiveKitVoiceEngine(
      {},
      () => fake.room,
      fakeEncryption().factory,
    )
    await engine.connect(
      credentials(),
      null,
      true,
      mediaKey(),
      [],
      mediaKeyLease(),
    )

    engine.setParticipantVolume('@bob:example.org:DEVICE', 4)
    expect(fake.remoteSetVolume).toHaveBeenCalledWith(2)

    await engine.disconnect()
  })

  it('plays subtle cues only for remote participant changes after initial hydration', async () => {
    const fake = fakeRoom()
    const cuePlayer = vi.fn()
    const engine = new LiveKitVoiceEngine(
      {},
      () => fake.room,
      fakeEncryption().factory,
      cuePlayer,
    )

    await engine.connect(
      credentials(),
      null,
      true,
      mediaKey(),
      [],
      mediaKeyLease(),
    )
    expect(cuePlayer).not.toHaveBeenCalled()

    fake.emit(RoomEvent.ParticipantConnected, fake.remoteParticipant)
    fake.emit(RoomEvent.ParticipantDisconnected, fake.remoteParticipant)
    fake.emit(RoomEvent.ParticipantConnected, fake.localParticipant)

    expect(cuePlayer.mock.calls).toEqual([['join'], ['leave']])
    await engine.disconnect()
  })

  it('never connects to the SFU without a valid initial publication lease', async () => {
    const fake = fakeRoom()
    const roomFactory = vi.fn(() => fake.room)
    const engine = new LiveKitVoiceEngine(
      {},
      roomFactory,
      fakeEncryption().factory,
    )

    await expect(
      engine.connect(credentials(), null, true, mediaKey()),
    ).rejects.toThrow('valid publication lease')
    await expect(
      engine.connect(
        credentials(),
        null,
        true,
        mediaKey(),
        [],
        mediaKeyLease({ expiresAt: Date.now() - 1 }),
      ),
    ).rejects.toThrow('valid publication lease')

    expect(roomFactory).not.toHaveBeenCalled()
    expect(fake.connect).not.toHaveBeenCalled()
    expect(fake.setMicrophoneEnabled).not.toHaveBeenCalledWith(
      true,
      expect.anything(),
    )
  })

  it('fails closed and unpublishes every local source when the lease expires', async () => {
    vi.useFakeTimers()
    const fake = fakeRoom()
    const onEncryptionFailure = vi.fn()
    const engine = new LiveKitVoiceEngine(
      { onEncryptionFailure },
      () => fake.room,
      fakeEncryption().factory,
    )
    await engine.connect(
      credentials(),
      null,
      true,
      mediaKey(),
      [],
      mediaKeyLease(),
    )
    await engine.setCameraEnabled(true)
    await engine.setScreenShareEnabled(true)
    fake.setMicrophoneEnabled.mockClear()
    fake.setCameraEnabled.mockClear()
    fake.setScreenShareEnabled.mockClear()

    await vi.advanceTimersByTimeAsync(3_001)

    expect(fake.setMicrophoneEnabled).toHaveBeenCalledWith(false)
    expect(fake.setCameraEnabled).toHaveBeenCalledWith(false)
    expect(fake.setScreenShareEnabled).toHaveBeenCalledWith(false)
    expect(onEncryptionFailure).toHaveBeenCalledWith(
      'Private media publication lease expired',
      'session-1',
    )

    await engine.setMuted(false)
    await engine.setCameraEnabled(true)
    await engine.setScreenShareEnabled(true)
    expect(fake.setMicrophoneEnabled).not.toHaveBeenCalledWith(
      true,
      expect.anything(),
    )
    expect(fake.setCameraEnabled).not.toHaveBeenCalledWith(
      true,
      expect.anything(),
    )
    expect(fake.setScreenShareEnabled).not.toHaveBeenCalledWith(
      true,
      expect.anything(),
      expect.anything(),
    )
  })

  it('keeps PTT, camera, and screen-share intent changes made during activation pause', async () => {
    const fake = fakeRoom()
    const encryption = fakeEncryption()
    const engine = new LiveKitVoiceEngine(
      {},
      () => fake.room,
      encryption.factory,
    )
    await engine.connect(
      credentials(),
      null,
      true,
      mediaKey(),
      [],
      mediaKeyLease(),
    )
    await engine.setCameraEnabled(true)
    await engine.setScreenShareEnabled(true)
    const pause = {
      roomId: credentials().roomId,
      sessionId: credentials().sessionId,
      memberId: credentials().memberId,
      activationId: 'activation-1',
      keyIndex: 1,
    }

    await expect(engine.pausePublisherForActivation(pause)).resolves.toBe('paused')
    await engine.setMuted(true)
    await engine.setCameraEnabled(false)
    await engine.setScreenShareEnabled(false)
    const candidate = mediaKey({
      keyIndex: 1,
      key: 'AQEBAQEBAQEBAQEBAQEBAQ',
      sentTs: 2,
      sessionId: pause.sessionId,
      activationId: pause.activationId,
    })
    await engine.installLocalActivationKey(pause, candidate)
    const generation = engine.publicationGeneration
    expect(
      engine.updatePublicationLease(
        mediaKeyLease({ keyIndex: 1 }),
        generation,
        pause.activationId,
      ),
    ).toBe(true)
    await expect(
      engine.resumePublisherAfterActivation(pause.activationId),
    ).resolves.toBe(true)

    expect(fake.localParticipant.isMicrophoneEnabled).toBe(false)
    expect(fake.localParticipant.isCameraEnabled).toBe(false)
    expect(fake.localParticipant.isScreenShareEnabled).toBe(false)
    expect(
      await engine.pausePublisherForActivation(pause),
    ).toBe('replayed')
    expect(
      engine.updatePublicationLease(
        mediaKeyLease({ keyIndex: 0 }),
        generation,
      ),
    ).toBe(false)
    await engine.disconnect()
  })
})
