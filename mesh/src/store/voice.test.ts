import { describe, it, expect, beforeEach } from 'vitest'
import { useVoiceStore } from './voice'
import type { Peer, VoiceSessionSnapshot } from '../types/ipc'

// Helper: build a minimal VoiceSessionSnapshot
function makeSnapshot(overrides: Partial<VoiceSessionSnapshot> = {}): VoiceSessionSnapshot {
  return {
    communityId: 'comm-1',
    channelId: 'ch-1',
    sessionEpoch: 1,
    memberCount: 1,
    relay: { relayRequired: false, relayCandidatePublicKey: null },
    members: [
      {
        publicKey: 'pk-alice',
        joinedAt: '2025-01-01T00:00:00Z',
        lastSeenAt: '2025-01-01T00:00:00Z',
        isLocal: true,
        displayName: 'Alice',
        avatarColor: '#ff0000',
      },
    ],
    updatedAt: '2025-01-01T00:00:00Z',
    ...overrides,
  }
}

// Helper: build a minimal Peer
function makePeer(overrides: Partial<Peer> & Pick<Peer, 'publicKey'>): Peer {
  return {
    displayName: 'Peer',
    avatarColor: '#c8b89a',
    peerId: overrides.publicKey,
    latency: 0,
    ...overrides,
  }
}

// Reset store between tests
beforeEach(() => {
  useVoiceStore.setState({
    currentChannelId: null,
    currentCommunityId: null,
    localPublicKey: null,
    sessionSnapshot: null,
    peers: [],
    connectionState: 'idle',
    lastReconnectReason: null,
    isMuted: false,
    isDeafened: false,
    inputMode: 'voice-activity',
    isPushToTalking: false,
    isCameraEnabled: false,
    isScreenSharing: false,
    inputDeviceId: null,
    outputDeviceId: null,
    localAudioLevel: 0,
    participantVolumes: {},
    matrixRtcMembersByRoom: {},
  })
})

// ─── mergePeerRecord (tested indirectly through upsertPeer) ───

describe('upsertPeer / mergePeerRecord', () => {
  it('adds a new peer when no matching peer exists', () => {
    useVoiceStore.getState().upsertPeer(makePeer({ publicKey: 'pk-bob', displayName: 'Bob' }))

    const peers = useVoiceStore.getState().peers
    expect(peers).toHaveLength(1)
    expect(peers[0].publicKey).toBe('pk-bob')
    expect(peers[0].displayName).toBe('Bob')
  })

  it('merges new fields into an existing peer', () => {
    useVoiceStore.getState().upsertPeer(
      makePeer({ publicKey: 'pk-bob', displayName: 'Bob', latency: 10 }),
    )
    useVoiceStore.getState().upsertPeer(
      makePeer({ publicKey: 'pk-bob', displayName: 'Bobby', latency: 25 }),
    )

    const peers = useVoiceStore.getState().peers
    expect(peers).toHaveLength(1)
    expect(peers[0].displayName).toBe('Bobby')
    expect(peers[0].latency).toBe(25)
  })

  it('falls back to existing displayName when next has empty string', () => {
    useVoiceStore.getState().upsertPeer(
      makePeer({ publicKey: 'pk-bob', displayName: 'Bob' }),
    )
    useVoiceStore.getState().upsertPeer(
      makePeer({ publicKey: 'pk-bob', displayName: '' }),
    )

    const peers = useVoiceStore.getState().peers
    expect(peers[0].displayName).toBe('Bob')
  })

  it('preserves existing stream if next has no stream and existing stream is not available', () => {
    // With no MediaStream available in jsdom, stream should end up undefined
    useVoiceStore.getState().upsertPeer(
      makePeer({ publicKey: 'pk-bob', stream: undefined }),
    )
    useVoiceStore.getState().upsertPeer(
      makePeer({ publicKey: 'pk-bob', stream: undefined }),
    )

    const peers = useVoiceStore.getState().peers
    expect(peers[0].stream).toBeUndefined()
  })

  it('clears stale camera and screen streams from an authoritative peer snapshot', () => {
    const cameraStream = {} as MediaStream
    const screenShareStream = {} as MediaStream
    const screenShareAudioStream = {} as MediaStream
    useVoiceStore.getState().setPeers([
      makePeer({
        publicKey: 'pk-bob',
        cameraStream,
        screenShareStream,
        screenShareAudioStream,
      }),
    ])

    useVoiceStore.getState().setPeers([makePeer({ publicKey: 'pk-bob' })])

    expect(useVoiceStore.getState().peers[0]).toMatchObject({
      publicKey: 'pk-bob',
      cameraStream: undefined,
      screenShareStream: undefined,
      screenShareAudioStream: undefined,
    })
  })
})

// ─── setSessionSnapshot ───

describe('setSessionSnapshot', () => {
  it('sets the snapshot and builds peers from members', () => {
    useVoiceStore.getState().setLocalPublicKey('pk-alice')

    const snapshot = makeSnapshot()
    useVoiceStore.getState().setSessionSnapshot(snapshot)

    const state = useVoiceStore.getState()
    expect(state.sessionSnapshot).not.toBeNull()
    expect(state.sessionSnapshot!.communityId).toBe('comm-1')
    expect(state.peers.length).toBeGreaterThanOrEqual(1)
  })

  it('detects epoch change and transitions connectionState to reconnecting', () => {
    useVoiceStore.getState().setLocalPublicKey('pk-alice')

    // Set initial snapshot at epoch 1
    useVoiceStore.getState().setSessionSnapshot(makeSnapshot({ sessionEpoch: 1 }))
    expect(useVoiceStore.getState().connectionState).not.toBe('reconnecting')

    // Set new snapshot at epoch 2
    useVoiceStore.getState().setSessionSnapshot(makeSnapshot({ sessionEpoch: 2 }))

    const state = useVoiceStore.getState()
    expect(state.connectionState).toBe('reconnecting')
    expect(state.lastReconnectReason).toBe('epoch change')
  })

  it('does not set reconnecting when epoch stays the same', () => {
    useVoiceStore.getState().setLocalPublicKey('pk-alice')

    useVoiceStore.getState().setSessionSnapshot(makeSnapshot({ sessionEpoch: 1 }))
    useVoiceStore.getState().setConnectionState('connected')

    useVoiceStore.getState().setSessionSnapshot(makeSnapshot({ sessionEpoch: 1 }))

    expect(useVoiceStore.getState().connectionState).toBe('connected')
  })

  it('clears peers and snapshot when null is passed', () => {
    useVoiceStore.getState().setSessionSnapshot(makeSnapshot())
    expect(useVoiceStore.getState().peers.length).toBeGreaterThanOrEqual(1)

    useVoiceStore.getState().setSessionSnapshot(null)

    const state = useVoiceStore.getState()
    expect(state.sessionSnapshot).toBeNull()
    expect(state.peers).toHaveLength(0)
    expect(state.connectionState).toBe('idle')
  })
})

// ─── resetVoiceState ───

describe('resetVoiceState', () => {
  it('resets all voice state to defaults', () => {
    // Set up some non-default state
    useVoiceStore.setState({
      currentChannelId: 'ch-1',
      currentCommunityId: 'comm-1',
      localPublicKey: 'pk-alice',
      sessionSnapshot: makeSnapshot(),
      peers: [makePeer({ publicKey: 'pk-bob' })],
      connectionState: 'connected',
      lastReconnectReason: 'something',
    })

    useVoiceStore.getState().resetVoiceState()

    const state = useVoiceStore.getState()
    expect(state.currentChannelId).toBeNull()
    expect(state.currentCommunityId).toBeNull()
    expect(state.localPublicKey).toBeNull()
    expect(state.sessionSnapshot).toBeNull()
    expect(state.peers).toHaveLength(0)
    expect(state.connectionState).toBe('idle')
    expect(state.lastReconnectReason).toBeNull()
  })
})

describe('voice media controls', () => {
  it('makes push-to-talk fail closed until the user is actively talking', () => {
    useVoiceStore.getState().setInputMode('push-to-talk')

    expect(useVoiceStore.getState()).toMatchObject({
      inputMode: 'push-to-talk',
      isMuted: true,
      isPushToTalking: false,
    })

    useVoiceStore.getState().setPushToTalking(true)
    useVoiceStore.getState().setMuted(false)

    expect(useVoiceStore.getState()).toMatchObject({
      isMuted: false,
      isPushToTalking: true,
    })
  })

  it('clamps meters and local participant volume to safe UI ranges', () => {
    useVoiceStore.getState().setLocalAudioLevel(4)
    useVoiceStore.getState().setParticipantVolume('pk-bob', -1)
    useVoiceStore.getState().setParticipantVolume('pk-carol', 3)

    expect(useVoiceStore.getState().localAudioLevel).toBe(1)
    expect(useVoiceStore.getState().participantVolumes).toEqual({
      'pk-bob': 0,
      'pk-carol': 2,
    })
  })

  it('replaces MatrixRTC membership authoritatively instead of accumulating stale devices', () => {
    const roomId = '!voice:example.org'
    useVoiceStore.getState().setMatrixRtcMembers(roomId, [
      {
        roomId,
        userId: '@alice:example.org',
        deviceId: 'ALICE',
        sessionId: 'session-a',
        displayName: 'Alice',
        avatarUrl: null,
      },
      {
        roomId,
        userId: '@bob:example.org',
        deviceId: 'BOB',
        sessionId: 'session-b',
        displayName: 'Bob',
        avatarUrl: null,
      },
    ])
    useVoiceStore.getState().setMatrixRtcMembers(roomId, [
      {
        roomId,
        userId: '@alice:example.org',
        deviceId: 'ALICE',
        sessionId: 'session-a2',
        displayName: 'Alice',
        avatarUrl: null,
      },
    ])

    expect(useVoiceStore.getState().matrixRtcMembersByRoom[roomId]).toEqual([
      expect.objectContaining({ userId: '@alice:example.org', sessionId: 'session-a2' }),
    ])

    useVoiceStore.getState().setMatrixRtcMembers(roomId, [])
    expect(useVoiceStore.getState().matrixRtcMembersByRoom[roomId]).toBeUndefined()
  })
})
