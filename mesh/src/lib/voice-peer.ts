/**
 * Peer abstraction for the voice engine.
 *
 * The VoiceEngine previously instantiated SimplePeer directly, which made
 * the entire churn/reconnect/relay-rebuild state machine untestable without
 * a browser WebRTC stack. This module introduces a thin `VoicePeer`
 * interface covering ONLY the methods the engine actually calls, plus a
 * `VoicePeerFactory` seam that the engine uses for peer creation.
 *
 * Production: `DefaultVoicePeerFactory` wraps `simple-peer` verbatim.
 * Tests: `createFakePeerFactory()` returns a controllable factory that lets
 * tests drive peer events manually and assert on engine state transitions.
 */
import SimplePeer from 'simple-peer'

/// Events the voice engine listens for on peers.
export type VoicePeerEvent = 'signal' | 'connect' | 'stream' | 'error' | 'close'

/**
 * Event handler types for VoicePeer. Keeping these as an explicit type map
 * avoids the overloaded-method compatibility issues with TypeScript when
 * implementing the interface.
 */
export type VoicePeerEventHandlers = {
  signal: (signal: SimplePeer.SignalData) => void
  connect: () => void
  stream: (stream: MediaStream) => void
  error: (error: Error) => void
  close: () => void
}

/**
 * Narrow interface over SimplePeer.Instance.
 *
 * Only methods the VoiceEngine actually uses are exposed. This keeps the
 * fake implementation small and ensures future uses of SimplePeer's API
 * must flow through this interface (making them explicit).
 */
export interface VoicePeer {
  /** True when the peer has fired 'connect' and hasn't been destroyed. */
  readonly connected: boolean

  /** Submit a remote signal (SDP or ICE candidate). */
  signal(data: SimplePeer.SignalData): void

  /**
   * Add a media track to the peer connection. Used by the relay to forward
   * streams from other peers.
   */
  addTrack(track: MediaStreamTrack, stream: MediaStream): void

  /**
   * Trigger SDP renegotiation explicitly. SimplePeer exposes this via a
   * property we cast to; the fake implements it as a direct method.
   */
  negotiate(): void

  /**
   * Gracefully destroy the peer connection. Idempotent.
   */
  destroy(): void

  /**
   * Register an event handler. The caller is responsible for passing a
   * handler whose signature matches the event type. Using a single generic
   * signature (vs overloaded) avoids interface-implementation pitfalls.
   */
  on<E extends keyof VoicePeerEventHandlers>(
    event: E,
    handler: VoicePeerEventHandlers[E],
  ): this
}

/** Options passed to the peer factory at construction time. */
export interface VoicePeerOptions {
  initiator: boolean
  stream: MediaStream | undefined
  trickle: boolean
  iceServers: RTCIceServer[]
}

/**
 * Factory interface the VoiceEngine uses to create peers. Production code
 * uses `DefaultVoicePeerFactory`; tests inject a fake.
 */
export interface VoicePeerFactory {
  create(opts: VoicePeerOptions): VoicePeer
}

// ─── Default factory (production) ─────────────────────

/**
 * Wraps SimplePeer.Instance so it conforms to the VoicePeer interface.
 * The wrapper is mostly a pass-through but provides a typed `negotiate()`
 * method that internally does the `(peer as unknown as {...}).negotiate()`
 * cast that the engine previously did inline.
 */
class SimplePeerWrapper implements VoicePeer {
  constructor(private readonly peer: SimplePeer.Instance) {}

  get connected(): boolean {
    // SimplePeer doesn't expose a typed `connected` but it has the field.
    return (this.peer as unknown as { connected: boolean }).connected === true
  }

  signal(data: SimplePeer.SignalData): void {
    this.peer.signal(data)
  }

  addTrack(track: MediaStreamTrack, stream: MediaStream): void {
    this.peer.addTrack(track, stream)
  }

  negotiate(): void {
    // SimplePeer has a private `negotiate` method on its instance, cast to access
    ;(this.peer as unknown as { negotiate: () => void }).negotiate()
  }

  destroy(): void {
    this.peer.destroy()
  }

  on<E extends keyof VoicePeerEventHandlers>(
    event: E,
    handler: VoicePeerEventHandlers[E],
  ): this {
    // SimplePeer's `on` is compatible at runtime; we erase types at the boundary.
    ;(this.peer as unknown as { on: (e: string, h: (...a: unknown[]) => void) => void }).on(
      event,
      handler as (...a: unknown[]) => void,
    )
    return this
  }

  /** Access the underlying SimplePeer instance for stats queries. */
  raw(): SimplePeer.Instance {
    return this.peer
  }
}

/**
 * Default factory that creates real SimplePeer instances.
 * Used in production code paths and in real browsers.
 */
export class DefaultVoicePeerFactory implements VoicePeerFactory {
  create(opts: VoicePeerOptions): VoicePeer {
    const peer = new SimplePeer({
      initiator: opts.initiator,
      stream: opts.stream,
      trickle: opts.trickle,
      config: {
        iceServers: opts.iceServers,
      },
    })
    return new SimplePeerWrapper(peer)
  }
}

// ─── Fake factory (tests) ──────────────────────────────

/**
 * A fake VoicePeer used in unit tests. Records method calls and lets
 * tests drive the peer lifecycle by calling `emit*` methods directly.
 */
export class FakeVoicePeer implements VoicePeer {
  // Public state for test inspection
  readonly options: VoicePeerOptions
  public signalCalls: SimplePeer.SignalData[] = []
  public addedTracks: Array<{ track: MediaStreamTrack; stream: MediaStream }> = []
  public negotiateCalls: number = 0
  public destroyCalls: number = 0
  public isConnected: boolean = false
  public destroyed: boolean = false

  private handlers: {
    signal: Array<(data: SimplePeer.SignalData) => void>
    connect: Array<() => void>
    stream: Array<(stream: MediaStream) => void>
    error: Array<(err: Error) => void>
    close: Array<() => void>
  } = {
    signal: [],
    connect: [],
    stream: [],
    error: [],
    close: [],
  }

  constructor(options: VoicePeerOptions) {
    this.options = options
  }

  get connected(): boolean {
    return this.isConnected && !this.destroyed
  }

  signal(data: SimplePeer.SignalData): void {
    if (this.destroyed) return
    this.signalCalls.push(data)
  }

  addTrack(track: MediaStreamTrack, stream: MediaStream): void {
    if (this.destroyed) return
    this.addedTracks.push({ track, stream })
  }

  negotiate(): void {
    if (this.destroyed) return
    this.negotiateCalls += 1
  }

  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
    this.isConnected = false
    this.destroyCalls += 1
    // Fire 'close' handlers on destroy, mirroring SimplePeer
    for (const h of this.handlers.close) h()
  }

  on<E extends keyof VoicePeerEventHandlers>(
    event: E,
    handler: VoicePeerEventHandlers[E],
  ): this {
    switch (event) {
      case 'signal':
        this.handlers.signal.push(handler as (d: SimplePeer.SignalData) => void)
        break
      case 'connect':
        this.handlers.connect.push(handler as () => void)
        break
      case 'stream':
        this.handlers.stream.push(handler as (s: MediaStream) => void)
        break
      case 'error':
        this.handlers.error.push(handler as (e: Error) => void)
        break
      case 'close':
        this.handlers.close.push(handler as () => void)
        break
    }
    return this
  }

  // ─── Test-driven event triggers ──────────────────

  /** Simulate the peer becoming connected. */
  emitConnect(): void {
    if (this.destroyed) return
    this.isConnected = true
    for (const h of this.handlers.connect) h()
  }

  /** Simulate an outgoing signal (as if the local peer generated SDP). */
  emitSignal(data: SimplePeer.SignalData): void {
    if (this.destroyed) return
    for (const h of this.handlers.signal) h(data)
  }

  /** Simulate a remote stream arriving. */
  emitStream(stream: MediaStream): void {
    if (this.destroyed) return
    for (const h of this.handlers.stream) h(stream)
  }

  /** Simulate an error. */
  emitError(err: Error): void {
    if (this.destroyed) return
    for (const h of this.handlers.error) h(err)
  }

  /** Simulate a remote close. */
  emitClose(): void {
    if (this.destroyed) return
    this.destroyed = true
    this.isConnected = false
    for (const h of this.handlers.close) h()
  }
}

/**
 * A fake factory that records all created peers and lets tests access
 * them by insertion order. Combined with FakeVoicePeer, gives full
 * control over the voice engine state machine without WebRTC.
 */
export interface FakeVoicePeerFactory extends VoicePeerFactory {
  readonly createdPeers: FakeVoicePeer[]
  /** The most recently created peer, or undefined if none. */
  latest(): FakeVoicePeer | undefined
  /** Number of peers created since the factory was initialized. */
  count(): number
  /** Reset the created-peer list (does not destroy existing peers). */
  reset(): void
}

export function createFakePeerFactory(): FakeVoicePeerFactory {
  const createdPeers: FakeVoicePeer[] = []
  return {
    createdPeers,
    create(opts: VoicePeerOptions): VoicePeer {
      const peer = new FakeVoicePeer(opts)
      createdPeers.push(peer)
      return peer
    },
    latest(): FakeVoicePeer | undefined {
      return createdPeers[createdPeers.length - 1]
    },
    count(): number {
      return createdPeers.length
    },
    reset(): void {
      createdPeers.length = 0
    },
  }
}
