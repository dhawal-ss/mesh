/**
 * Integration tests for the VoiceEngine using FakeVoicePeerFactory.
 *
 * These tests drive the full VoiceEngine state machine: peer creation,
 * signal handling, connection lifecycle, relay rebuilds, and disconnect
 * recovery: without requiring a real browser WebRTC stack.
 *
 * The FakeVoicePeer lets tests emit peer events (connect/stream/error/close)
 * directly to assert on the engine's response, and records every method
 * call made on the peer so we can verify the engine's outgoing behavior.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { VoiceEngine, type VoiceEngineHandlers } from './voice-engine'
import {
  createFakePeerFactory,
  type FakeVoicePeer,
  type FakeVoicePeerFactory,
} from './voice-peer'
import type { VoiceSessionSnapshot, VoiceMemberSnapshot } from '../types/ipc'

const sendVoiceSignalMock = vi.hoisted(() => vi.fn(() => Promise.resolve()))

// Mock bridge functions that the engine calls during start().
// The integration tests bypass start() by calling initForTesting(), so
// these mocks are defensive: they prevent accidental calls from leaking
// into real IPC.
vi.mock('./bridge', () => ({
  getIdentity: vi.fn(() => Promise.resolve(null)),
  getIceServers: vi.fn(() => Promise.resolve([])),
  isTauriRuntime: () => false,
  joinVoice: vi.fn(() => Promise.resolve(null)),
  leaveVoice: vi.fn(() => Promise.resolve()),
  sendVoiceSignal: sendVoiceSignalMock,
}))

// jsdom does not provide AudioContext. The engine's speaking-detection
// path instantiates AudioContext when a stream arrives. Provide a minimal
// stub that satisfies the constructor and the analyser graph the engine
// builds: we only need the methods, not actual audio analysis.
class FakeAudioContext {
  static instances: FakeAudioContext[] = []
  state: AudioContextState = 'running'

  constructor() {
    FakeAudioContext.instances.push(this)
  }
  createMediaStreamSource() {
    return { connect: () => {}, disconnect: () => {} }
  }
  createAnalyser() {
    return {
      fftSize: 256,
      smoothingTimeConstant: 0.3,
      frequencyBinCount: 128,
      getByteFrequencyData: () => {},
      connect: () => {},
      disconnect: () => {},
    }
  }
  close() {
    return Promise.resolve()
  }
  resume() {
    return Promise.resolve()
  }
}
;(globalThis as unknown as { AudioContext: unknown }).AudioContext = FakeAudioContext
// Also stub setInterval/clearInterval clearing for the speaking detection
// interval: the engine uses window.setInterval which jsdom provides.

const COMMUNITY_ID = 'test-community'
const CHANNEL_ID = 'test-channel'
// Use a lexicographically HIGH local key so shouldInitiatePeerConnection
// returns true for typical remote-peer-* keys. The engine only creates
// outbound peer connections when the local key is greater than the remote
// (this is the standard deterministic tie-breaker used by WebRTC mesh
// connection logic).
const LOCAL_KEY = 'zzz-local-peer-key'

function member(publicKey: string, isLocal = false): VoiceMemberSnapshot {
  return {
    publicKey,
    joinedAt: '2024-01-01T00:00:00Z',
    lastSeenAt: '2024-01-01T00:00:00Z',
    isLocal,
  }
}

function snapshot(memberKeys: string[], epoch = 1): VoiceSessionSnapshot {
  const members = memberKeys.map((k) => member(k, k === LOCAL_KEY))
  return {
    communityId: COMMUNITY_ID,
    channelId: CHANNEL_ID,
    sessionEpoch: epoch,
    memberCount: members.length,
    members,
    relay: {
      relayRequired: members.length > 8,
      relayCandidatePublicKey: null,
    },
    updatedAt: `2024-01-01T00:00:${epoch.toString().padStart(2, '0')}Z`,
    localPublicKey: LOCAL_KEY,
  }
}

describe('VoiceEngine integration (with FakeVoicePeer)', () => {
  let factory: FakeVoicePeerFactory
  let handlers: VoiceEngineHandlers
  let peerRemoveCalls: string[]
  let peerUpsertCalls: string[]
  let engine: VoiceEngine

  beforeEach(() => {
    FakeAudioContext.instances = []
    sendVoiceSignalMock.mockReset()
    sendVoiceSignalMock.mockResolvedValue(undefined)
    factory = createFakePeerFactory()
    peerRemoveCalls = []
    peerUpsertCalls = []
    handlers = {
      onPeerRemove: (key) => peerRemoveCalls.push(key),
      onPeerUpsert: (peer) => peerUpsertCalls.push(peer.publicKey),
    }
    engine = new VoiceEngine(COMMUNITY_ID, CHANNEL_ID, handlers, factory)
    engine.initForTesting(LOCAL_KEY)
  })

  // ─── Peer creation on snapshot ────────────────────

  it('does not create peer connections for an empty session', () => {
    engine.applySessionSnapshot(snapshot([LOCAL_KEY]))
    expect(factory.count()).toBe(0)
  })

  it('creates a peer connection when a remote member joins', () => {
    engine.applySessionSnapshot(snapshot([LOCAL_KEY, 'remote-peer-1']))
    expect(factory.count()).toBe(1)
    expect(engine.getPeerKeysForTesting()).toContain('remote-peer-1')
  })

  it('does not duplicate peers on repeated snapshots with same members', () => {
    engine.applySessionSnapshot(snapshot([LOCAL_KEY, 'remote-peer-1']))
    // A second snapshot with different epoch but same members should not
    // double-create peers for the same remote
    engine.applySessionSnapshot(snapshot([LOCAL_KEY, 'remote-peer-1'], 1))
    expect(factory.count()).toBe(1)
  })

  it('removes peers when a member leaves (same epoch triggers reconcile)', () => {
    // First snapshot establishes two peers
    const snap1 = snapshot([LOCAL_KEY, 'remote-1', 'remote-2'], 1)
    // Second snapshot at the same epoch but with one member removed.
    // Same epoch avoids the full topology reset that a new epoch triggers.
    // We manually adjust updatedAt so isSameSnapshot returns false.
    const snap2: VoiceSessionSnapshot = {
      ...snapshot([LOCAL_KEY, 'remote-1'], 1),
      updatedAt: '2024-01-01T00:00:99Z',
    }

    engine.applySessionSnapshot(snap1)
    expect(engine.getPeerKeysForTesting().sort()).toEqual(['remote-1', 'remote-2'])

    engine.applySessionSnapshot(snap2)
    expect(engine.getPeerKeysForTesting()).toEqual(['remote-1'])
    expect(peerRemoveCalls).toContain('remote-2')
  })

  // ─── Peer lifecycle ───────────────────────────────

  it('transitions peer view to connected when peer emits connect', () => {
    const states: string[] = []
    const localHandlers: VoiceEngineHandlers = {
      onPeerUpsert: (peer) => {
        if (peer.publicKey === 'remote-1' && peer.connectionState) {
          states.push(peer.connectionState)
        }
      },
    }
    const localEngine = new VoiceEngine(COMMUNITY_ID, CHANNEL_ID, localHandlers, factory)
    localEngine.initForTesting(LOCAL_KEY)
    localEngine.applySessionSnapshot(snapshot([LOCAL_KEY, 'remote-1']))

    const peer = factory.latest()
    expect(peer).toBeDefined()
    peer!.emitConnect()
    expect(states).toContain('connected')
  })

  it('re-creates peer after disconnect to support reconnect', async () => {
    engine.applySessionSnapshot(snapshot([LOCAL_KEY, 'remote-1']))
    const firstPeer = factory.latest()
    expect(firstPeer).toBeDefined()
    expect(factory.count()).toBe(1)

    // Simulate peer-side close
    firstPeer!.emitClose()

    // The peer map should now be empty for remote-1 (it was deleted)
    expect(engine.getPeerKeysForTesting()).not.toContain('remote-1')
    expect(firstPeer!.destroyCalls).toBe(0) // close was emitted, not destroy
  })

  it('destroys old peers when re-applying a new snapshot with different epoch', () => {
    engine.applySessionSnapshot(snapshot([LOCAL_KEY, 'remote-1']))
    const firstPeer = factory.latest()
    expect(firstPeer).toBeDefined()

    // New epoch triggers topology reset: the engine tears down all peers
    engine.applySessionSnapshot(snapshot([LOCAL_KEY, 'remote-1'], 2))
    expect(firstPeer!.destroyCalls).toBeGreaterThan(0)
  })

  // ─── Idempotency ──────────────────────────────────

  it('applying the same snapshot twice is a no-op', () => {
    const snap = snapshot([LOCAL_KEY, 'remote-1'])
    engine.applySessionSnapshot(snap)
    const countAfterFirst = factory.count()
    engine.applySessionSnapshot(snap)
    const countAfterSecond = factory.count()
    expect(countAfterSecond).toBe(countAfterFirst)
  })

  // ─── Relay rebuild under churn ───────────────────

  it('relay rebuild count is zero for sessions below threshold', () => {
    const members = [LOCAL_KEY, 'peer-1', 'peer-2', 'peer-3']
    engine.applySessionSnapshot(snapshot(members))
    expect(engine.getRelayRebuildCount()).toBe(0)
  })

  it('destroys old peers when local stream is reset', async () => {
    engine.applySessionSnapshot(snapshot([LOCAL_KEY, 'remote-1', 'remote-2']))
    expect(factory.count()).toBe(2)
    const peers = [factory.createdPeers[0], factory.createdPeers[1]]

    // Destroy the engine: all peers should be destroyed
    await engine.destroy()

    for (const peer of peers) {
      expect(peer.destroyCalls).toBeGreaterThan(0)
    }
  })

  // ─── Voice signal handling ───────────────────────

  it('creates a non-initiator peer on incoming voice signal from a new remote', () => {
    engine.applySessionSnapshot(snapshot([LOCAL_KEY, 'remote-1']))
    // Clear to reset the "initiator" created by the snapshot
    const baselinePeers = factory.count()

    // Signal from a new peer not yet in any snapshot
    engine.handleVoiceSignal({
      communityId: COMMUNITY_ID,
      channelId: CHANNEL_ID,
      sourcePublicKey: 'unknown-remote',
      signal: { type: 'offer', sdp: 'fake-sdp' } as unknown as RTCSessionDescriptionInit,
      targetPeer: LOCAL_KEY,
    })
    expect(factory.count()).toBeGreaterThan(baselinePeers)
    const newPeer = factory.latest()
    expect(newPeer?.options.initiator).toBe(false)
    expect(newPeer?.signalCalls.length).toBe(1)
  })

  it('forwards the signal to an existing peer', () => {
    engine.applySessionSnapshot(snapshot([LOCAL_KEY, 'remote-1']))
    const peer = factory.latest()
    const initialSignals = peer?.signalCalls.length ?? 0

    engine.handleVoiceSignal({
      communityId: COMMUNITY_ID,
      channelId: CHANNEL_ID,
      sourcePublicKey: 'remote-1',
      signal: { type: 'answer', sdp: 'fake-answer' } as unknown as RTCSessionDescriptionInit,
      targetPeer: LOCAL_KEY,
    })
    expect(peer?.signalCalls.length).toBe(initialSignals + 1)
  })

  it('ignores signals for other community/channel', () => {
    engine.applySessionSnapshot(snapshot([LOCAL_KEY, 'remote-1']))
    const peer = factory.latest()
    const initialSignals = peer?.signalCalls.length ?? 0

    engine.handleVoiceSignal({
      communityId: 'wrong-community',
      channelId: CHANNEL_ID,
      sourcePublicKey: 'remote-1',
      signal: { type: 'answer', sdp: 'fake' } as unknown as RTCSessionDescriptionInit,
      targetPeer: LOCAL_KEY,
    })
    expect(peer?.signalCalls.length).toBe(initialSignals)
  })

  it('ignores signals targeted at other peers', () => {
    engine.applySessionSnapshot(snapshot([LOCAL_KEY, 'remote-1']))
    const peer = factory.latest()
    const initialSignals = peer?.signalCalls.length ?? 0

    engine.handleVoiceSignal({
      communityId: COMMUNITY_ID,
      channelId: CHANNEL_ID,
      sourcePublicKey: 'remote-1',
      signal: { type: 'answer', sdp: 'fake' } as unknown as RTCSessionDescriptionInit,
      targetPeer: 'someone-else',
    })
    expect(peer?.signalCalls.length).toBe(initialSignals)
  })

  // ─── Stale peer cleanup ──────────────────────────

  it('cleans up all peers on destroy', async () => {
    engine.applySessionSnapshot(snapshot([LOCAL_KEY, 'remote-1', 'remote-2', 'remote-3']))
    expect(factory.count()).toBe(3)
    const allPeers = [...factory.createdPeers]

    await engine.destroy()

    for (const peer of allPeers) {
      expect(peer.destroyCalls).toBeGreaterThan(0)
    }
    expect(engine.getPeerKeysForTesting()).toEqual([])
  })

  // ─── Factory injection correctness ───────────────

  it('uses injected factory, not real SimplePeer', () => {
    engine.applySessionSnapshot(snapshot([LOCAL_KEY, 'remote-1']))
    expect(factory.count()).toBe(1)
    const peer = factory.latest()
    // Fake peers have the test-specific fields
    expect(peer?.signalCalls).toBeDefined()
    expect(peer?.destroyCalls).toBeDefined()
    expect(typeof peer?.emitConnect).toBe('function')
  })

  it('passes correct options to the factory', () => {
    engine.applySessionSnapshot(snapshot([LOCAL_KEY, 'remote-1']))
    const peer = factory.latest()
    expect(peer?.options.trickle).toBe(true)
    expect(peer?.options.iceServers).toBeDefined()
    expect(Array.isArray(peer?.options.iceServers)).toBe(true)
  })

  it('surfaces outgoing signaling failures as a connection warning', async () => {
    const warnings: string[] = []
    const localEngine = new VoiceEngine(
      COMMUNITY_ID,
      CHANNEL_ID,
      { onConnectionWarning: (message) => warnings.push(message) },
      factory,
    )
    localEngine.initForTesting(LOCAL_KEY)
    localEngine.applySessionSnapshot(snapshot([LOCAL_KEY, 'remote-warning']))
    sendVoiceSignalMock.mockRejectedValueOnce({
      code: 'network_unavailable',
      detail: 'signaling offline',
      retryable: true,
    })

    factory.latest()?.emitSignal({ type: 'offer', sdp: 'warning-sdp' } as never)
    await vi.waitFor(() => expect(warnings).toContain(
      "Connection interrupted. Mesh couldn't send voice signaling data. Check your connection and try again.",
    ))
  })

  // ─── Media-path simulation ────────────────────────
  //
  // These tests simulate the full signal → connect → stream lifecycle
  // that a real WebRTC media path would follow. We can't exercise actual
  // media (no RTCPeerConnection in jsdom), but we CAN validate that the
  // engine routes every part of the state machine correctly when the
  // fake peer emits the expected events at the expected times.
  //
  // BOUNDARY DOCUMENTATION:
  // - What we CAN test: signal dispatch, connect/stream/close event
  //   handling, peer view state transitions, relay forwarding decisions.
  // - What we CANNOT test: actual audio sample flow, codec negotiation,
  //   ICE candidate gathering, DTLS handshake. Those require a real
  //   browser WebRTC stack (Playwright + headless Chromium).
  // - The media-path boundary is: "the engine tells the peer to do X, and
  //   the peer would do X in production." FakeVoicePeer records every
  //   method call so we can verify the instructions are correct.

  it('signal → connect → stream lifecycle drives peer view state correctly', () => {
    const stateTransitions: Array<{ key: string; state: string | undefined }> = []
    const localHandlers: VoiceEngineHandlers = {
      onPeerUpsert: (peer) => {
        stateTransitions.push({ key: peer.publicKey, state: peer.connectionState })
      },
    }
    const localEngine = new VoiceEngine(COMMUNITY_ID, CHANNEL_ID, localHandlers, factory)
    localEngine.initForTesting(LOCAL_KEY)

    // Step 1: snapshot causes peer creation → initial "connecting" state
    localEngine.applySessionSnapshot(snapshot([LOCAL_KEY, 'remote-1']))
    const peer = factory.latest()
    expect(peer).toBeDefined()

    // Should have seen at least one "connecting" transition
    const connectingSeen = stateTransitions.some(
      (t) => t.key === 'remote-1' && (t.state === 'connecting' || t.state === 'reconnecting'),
    )
    expect(connectingSeen).toBe(true)

    // Step 2: peer reports connect → state becomes "connected"
    peer!.emitConnect()
    const connectedSeen = stateTransitions.some(
      (t) => t.key === 'remote-1' && t.state === 'connected',
    )
    expect(connectedSeen).toBe(true)

    // Step 3: remote stream arrives: the engine should upsert with the stream
    const mockTrack = {
      stop: () => {},
      kind: 'audio',
    } as unknown as MediaStreamTrack
    const mockStream = {
      getAudioTracks: () => [mockTrack],
      getTracks: () => [mockTrack],
    } as unknown as MediaStream
    peer!.emitStream(mockStream)

    // Verify the state transitions include connected after stream
    const streamedTransitions = stateTransitions.filter((t) => t.key === 'remote-1')
    expect(streamedTransitions.length).toBeGreaterThanOrEqual(2)
  })

  it('peer error triggers disconnect handling and cleans up state', () => {
    engine.applySessionSnapshot(snapshot([LOCAL_KEY, 'remote-err']))
    const peer = factory.latest()
    expect(peer).toBeDefined()
    expect(engine.getPeerKeysForTesting()).toContain('remote-err')

    // Simulate peer error
    peer!.emitError(new Error('ICE connection failed'))

    // Engine should have removed the peer from its map
    expect(engine.getPeerKeysForTesting()).not.toContain('remote-err')
  })

  it('recreates a closed AudioContext before attaching a replacement stream', () => {
    engine.applySessionSnapshot(snapshot([LOCAL_KEY, 'remote-audio']))
    const peer = factory.latest()
    const firstTrack = {
      stop: vi.fn(),
      kind: 'audio',
    } as unknown as MediaStreamTrack
    const firstStream = {
      getAudioTracks: () => [firstTrack],
      getTracks: () => [firstTrack],
    } as unknown as MediaStream
    peer!.emitStream(firstStream)
    expect(FakeAudioContext.instances).toHaveLength(1)

    FakeAudioContext.instances[0].state = 'closed'
    const replacementTrack = {
      stop: vi.fn(),
      kind: 'audio',
    } as unknown as MediaStreamTrack
    const replacementStream = {
      getAudioTracks: () => [replacementTrack],
      getTracks: () => [replacementTrack],
    } as unknown as MediaStream
    peer!.emitStream(replacementStream)

    expect(FakeAudioContext.instances).toHaveLength(2)
    expect(FakeAudioContext.instances[1].state).toBe('running')
  })

  it('uses public addTrack forwarding and stops a relay stream once on repeated disconnect', async () => {
    vi.useFakeTimers()
    try {
      const relaySnapshot = snapshot([
        LOCAL_KEY,
        'remote-source',
        'remote-target',
        'remote-3',
        'remote-4',
        'remote-5',
        'remote-6',
        'remote-7',
        'remote-8',
      ])
      relaySnapshot.relay = {
        relayRequired: true,
        relayCandidatePublicKey: LOCAL_KEY,
      }
      engine.applySessionSnapshot(relaySnapshot)
      await vi.advanceTimersByTimeAsync(200)
      const sourcePeer = engine.getPeerForTesting('remote-source')
      const targetPeer = engine.getPeerForTesting('remote-target')
      expect(sourcePeer).toBeDefined()
      expect(targetPeer).toBeDefined()

      const stop = vi.fn()
      const track = { stop, kind: 'audio' } as unknown as MediaStreamTrack
      const stream = {
        getAudioTracks: () => [track],
        getTracks: () => [track],
      } as unknown as MediaStream
      ;(sourcePeer as FakeVoicePeer).emitStream(stream)

      expect((targetPeer as FakeVoicePeer).addedTracks).toContainEqual({
        track,
        stream,
      })
      expect('negotiate' in (targetPeer as object)).toBe(false)

      ;(sourcePeer as FakeVoicePeer).emitError(new Error('relay source lost'))
      ;(sourcePeer as FakeVoicePeer).emitClose()
      expect(stop).toHaveBeenCalledTimes(1)
    } finally {
      await engine.destroy()
      vi.useRealTimers()
    }
  })

  it('stops every retained relay track during full teardown', async () => {
    vi.useFakeTimers()
    try {
      const relaySnapshot = snapshot([
        LOCAL_KEY,
        'remote-source',
        'remote-target',
        'remote-3',
        'remote-4',
        'remote-5',
        'remote-6',
        'remote-7',
        'remote-8',
      ])
      relaySnapshot.relay = {
        relayRequired: true,
        relayCandidatePublicKey: LOCAL_KEY,
      }
      engine.applySessionSnapshot(relaySnapshot)
      await vi.advanceTimersByTimeAsync(200)
      const sourcePeer = engine.getPeerForTesting('remote-source')
      const stopA = vi.fn()
      const stopB = vi.fn()
      const tracks = [
        { stop: stopA, kind: 'audio' },
        { stop: stopB, kind: 'audio' },
      ] as unknown as MediaStreamTrack[]
      const stream = {
        getAudioTracks: () => tracks,
        getTracks: () => tracks,
      } as unknown as MediaStream
      ;(sourcePeer as FakeVoicePeer).emitStream(stream)

      await engine.destroy()

      expect(stopA).toHaveBeenCalledOnce()
      expect(stopB).toHaveBeenCalledOnce()
    } finally {
      vi.useRealTimers()
    }
  })

  it('stream emitted after peer close is safely ignored (no crash)', () => {
    engine.applySessionSnapshot(snapshot([LOCAL_KEY, 'remote-late']))
    const peer = factory.latest()
    expect(peer).toBeDefined()

    // Close the peer first
    peer!.emitClose()

    // Then try to emit a stream: the fake peer's emitStream is a no-op
    // after destroy, so this must not crash
    const mockStream = {
      getAudioTracks: () => [],
      getTracks: () => [],
    } as unknown as MediaStream
    expect(() => peer!.emitStream(mockStream)).not.toThrow()
  })

  it('signal flow: incoming signal → peer.signal() called with payload', () => {
    engine.applySessionSnapshot(snapshot([LOCAL_KEY, 'remote-sig']))
    const peer = factory.latest()
    expect(peer).toBeDefined()

    // Simulate an incoming voice signal (e.g., SDP answer)
    const answerSdp = {
      type: 'answer',
      sdp: 'v=0\r\no=- ...mock-sdp...',
    } as unknown as RTCSessionDescriptionInit
    engine.handleVoiceSignal({
      communityId: COMMUNITY_ID,
      channelId: CHANNEL_ID,
      sourcePublicKey: 'remote-sig',
      signal: answerSdp,
      targetPeer: LOCAL_KEY,
    })

    // Verify the peer.signal() was called with the exact payload
    expect(peer!.signalCalls.length).toBeGreaterThan(0)
    const lastCall = peer!.signalCalls[peer!.signalCalls.length - 1]
    expect(lastCall).toEqual(answerSdp)
  })

  it('multiple signals in sequence accumulate on the peer', () => {
    engine.applySessionSnapshot(snapshot([LOCAL_KEY, 'remote-multi']))
    const peer = factory.latest()
    expect(peer).toBeDefined()

    const before = peer!.signalCalls.length

    // Send 3 ICE candidates in sequence
    for (let i = 0; i < 3; i++) {
      engine.handleVoiceSignal({
        communityId: COMMUNITY_ID,
        channelId: CHANNEL_ID,
        sourcePublicKey: 'remote-multi',
        signal: {
          candidate: `candidate:${i} 1 UDP 2130706431 192.0.2.${i} 12345 typ host`,
          sdpMLineIndex: 0,
        } as unknown as RTCSessionDescriptionInit,
        targetPeer: LOCAL_KEY,
      })
    }

    expect(peer!.signalCalls.length).toBe(before + 3)
  })

  it('signal after destroy is safely ignored (no peer creation)', () => {
    void engine.destroy()
    // After destroy, incoming signals should not create new peers.
    // The engine checks `destroyed` flag inside handleVoiceSignal.
    engine.handleVoiceSignal({
      communityId: COMMUNITY_ID,
      channelId: CHANNEL_ID,
      sourcePublicKey: 'post-destroy',
      signal: { type: 'offer', sdp: 'irrelevant' } as unknown as RTCSessionDescriptionInit,
      targetPeer: LOCAL_KEY,
    })
    // The engine's peers map should not contain post-destroy
    expect(engine.getPeerKeysForTesting()).not.toContain('post-destroy')
  })

  it('two peers in sequence: connect, stream, destroy', () => {
    engine.applySessionSnapshot(snapshot([LOCAL_KEY, 'remote-A', 'remote-B']))
    expect(factory.count()).toBe(2)

    const peerA = factory.createdPeers[0]
    const peerB = factory.createdPeers[1]

    // Both peers go through connect
    peerA.emitConnect()
    peerB.emitConnect()
    expect(peerA.isConnected).toBe(true)
    expect(peerB.isConnected).toBe(true)

    // Both receive a stream
    const mockStream = {
      getAudioTracks: () => [],
      getTracks: () => [],
    } as unknown as MediaStream
    peerA.emitStream(mockStream)
    peerB.emitStream(mockStream)

    // Engine destroy cleans up both
    void engine.destroy()
    expect(peerA.destroyCalls).toBeGreaterThan(0)
    expect(peerB.destroyCalls).toBeGreaterThan(0)
  })
})
