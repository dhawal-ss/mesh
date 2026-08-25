import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { VOICE_ACTIVATION_EVENT } from '../../lib/voice-activation'
import { useIdentityStore } from '../../store/identity'
import { useVoiceStore } from '../../store/voice'
import { VoiceAudioSink } from './VoiceAudioSink'

describe('VoiceAudioSink', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    useIdentityStore.getState().setIdentity({
      publicKey: '@taylor:mesh.test',
      displayName: 'Taylor',
      avatarColor: '#55a8df',
    })
    useVoiceStore.getState().setLocalPublicKey('@taylor:mesh.test')
    useVoiceStore.getState().setCurrentVoiceSession('community-one', 'voice-one')
    useVoiceStore.setState({
      connectionState: 'connected',
      peers: [
        {
          publicKey: '@taylor:mesh.test',
          peerId: 'taylor',
          displayName: 'Taylor',
          avatarColor: '#55a8df',
          latency: 0,
          connectionState: 'connected',
          speaking: false,
          isSelf: true,
        },
        {
          publicKey: '@maya:mesh.test',
          peerId: 'maya',
          displayName: 'Maya',
          avatarColor: '#9b7cff',
          latency: 20,
          connectionState: 'connected',
          speaking: true,
          stream: { id: 'maya-voice' } as MediaStream,
        },
      ],
    })
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    useVoiceStore.getState().resetVoiceState()
    useIdentityStore.getState().clear()
    vi.unstubAllGlobals()
  })

  it('plays every remote peer without ever playing the local participant back', async () => {
    await act(async () => root.render(<VoiceAudioSink />))

    expect(container.querySelector('[data-peer-audio="@maya:mesh.test"]')).not.toBeNull()
    expect(container.querySelector('[data-peer-audio="@taylor:mesh.test"]')).toBeNull()
  })

  it('carries call audio while the person is reading another room', async () => {
    // The roster used to own the only audio elements, so leaving the voice room
    // silenced the call. The sink is mounted by the shell instead, so the peer
    // stream stays attached no matter which view is on screen.
    await act(async () => root.render(<VoiceAudioSink />))

    const remote = container.querySelector<HTMLAudioElement>('[data-peer-audio="@maya:mesh.test"]')
    expect(remote?.srcObject).toEqual({ id: 'maya-voice' })
  })

  it('stops playing once the call ends', async () => {
    await act(async () => root.render(<VoiceAudioSink />))
    await act(async () => {
      useVoiceStore.getState().setCurrentVoiceSession(null, null)
    })

    expect(container.querySelector('[data-peer-audio]')).toBeNull()
  })

  it('records click-to-audible only when remote audio actually starts playing', async () => {
    const listener = vi.fn()
    window.addEventListener(VOICE_ACTIVATION_EVENT, listener)
    await act(async () => root.render(<VoiceAudioSink />))

    const remote = container.querySelector<HTMLAudioElement>('[data-peer-audio="@maya:mesh.test"]')
    await act(async () => remote?.dispatchEvent(new Event('playing')))

    expect(listener).toHaveBeenCalledOnce()
    const event = listener.mock.calls[0]?.[0] as CustomEvent
    expect(event.detail).toMatchObject({ segment: 'click-to-audible' })
    expect(event.detail.durationMs).toBeGreaterThanOrEqual(0)
    expect(JSON.stringify(event.detail)).not.toContain('voice-one')
    window.removeEventListener(VOICE_ACTIVATION_EVENT, listener)
  })

  it('plays the optional display audio that comes with a screen share', async () => {
    const screenShareAudioStream = { id: 'screen-audio' } as MediaStream
    useVoiceStore.setState((state) => ({
      peers: state.peers.map((peer) => peer.publicKey === '@maya:mesh.test'
        ? { ...peer, screenShareAudioStream }
        : peer),
    }))

    await act(async () => root.render(<VoiceAudioSink />))

    const displayAudio = container.querySelector<HTMLAudioElement>('[data-screen-share-audio="active"]')
    expect(displayAudio?.srcObject).toBe(screenShareAudioStream)
    expect(displayAudio?.muted).toBe(false)
  })

  it('silences playback while deafened without dropping the stream', async () => {
    useVoiceStore.getState().setDeafened(true)

    await act(async () => root.render(<VoiceAudioSink />))

    const remote = container.querySelector<HTMLAudioElement>('[data-peer-audio="@maya:mesh.test"]')
    expect(remote?.muted).toBe(true)
    expect(remote?.srcObject).toEqual({ id: 'maya-voice' })
  })

  it('routes playback to the chosen speaker', async () => {
    const setSinkId = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(HTMLMediaElement.prototype, 'setSinkId', {
      configurable: true,
      writable: true,
      value: setSinkId,
    })
    useVoiceStore.getState().setOutputDeviceId('speaker-2')

    await act(async () => root.render(<VoiceAudioSink />))

    expect(setSinkId).toHaveBeenCalledWith('speaker-2')
    Reflect.deleteProperty(HTMLMediaElement.prototype, 'setSinkId')
  })

  it('keeps playing when the chosen speaker is gone', async () => {
    const setSinkId = vi.fn().mockRejectedValue(new Error('device missing'))
    Object.defineProperty(HTMLMediaElement.prototype, 'setSinkId', {
      configurable: true,
      writable: true,
      value: setSinkId,
    })
    useVoiceStore.getState().setOutputDeviceId('removed-speaker')

    await act(async () => root.render(<VoiceAudioSink />))

    const remote = container.querySelector<HTMLAudioElement>('[data-peer-audio="@maya:mesh.test"]')
    expect(remote?.srcObject).toEqual({ id: 'maya-voice' })
    Reflect.deleteProperty(HTMLMediaElement.prototype, 'setSinkId')
  })
})
