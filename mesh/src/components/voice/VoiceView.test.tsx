import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useVoiceStore } from '../../store/voice'
import { VoiceView } from './VoiceView'

const interfaceSounds = vi.hoisted(() => ({
  play: vi.fn(async () => true),
}))
const voiceEngineState = vi.hoisted(() => ({
  connectionWarning: null as string | null,
  availability: 'invalid-configuration' as 'invalid-configuration' | 'not-configured',
  quality: 'unknown' as 'excellent' | 'good' | 'poor' | 'unknown',
  microphonePermission: 'denied' as 'unknown' | 'granted' | 'denied',
  devices: [] as { deviceId: string; kind: 'audioinput' | 'audiooutput' | 'videoinput'; label: string }[],
  refreshDevices: vi.fn(async () => {}),
}))

vi.mock('../../lib/interface-sounds', () => ({
  playInterfaceSound: interfaceSounds.play,
}))

vi.mock('./VoiceEngineProvider', () => ({
  useVoiceEngineController: () => ({
    connectionWarning: voiceEngineState.connectionWarning,
    microphonePermission: voiceEngineState.microphonePermission,
    relayChanged: false,
    voiceService: {
      provider: 'matrix-rtc',
      availability: voiceEngineState.availability,
      mediaE2eeReady: false,
    },
    matrixVoiceReady: false,
    matrixUnavailableReason: 'The calling service is missing required configuration.',
    devices: voiceEngineState.devices,
    refreshDevices: voiceEngineState.refreshDevices,
    switchInputDevice: vi.fn(),
    switchOutputDevice: vi.fn(),
    switchCameraDevice: vi.fn(),
    setParticipantVolume: vi.fn(),
    toggleCamera: vi.fn(),
    toggleScreenSharing: vi.fn(),
    stats: {
      joinLatencyMs: 612,
      roundTripTimeMs: 34,
      jitterMs: 8,
      packetLossPercent: 0.5,
      quality: voiceEngineState.quality,
    },
  }),
}))

describe('VoiceView fail-closed actions', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0)
      return 1
    })
    interfaceSounds.play.mockClear()
    voiceEngineState.connectionWarning = null
    voiceEngineState.availability = 'invalid-configuration'
    voiceEngineState.quality = 'unknown'
    voiceEngineState.microphonePermission = 'denied'
    voiceEngineState.devices = []
    voiceEngineState.refreshDevices.mockClear()
    useVoiceStore.setState({
      currentCommunityId: '!community:mesh.test',
      currentChannelId: '!voice:mesh.test',
    })
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    useVoiceStore.getState().resetVoiceState()
    delete document.documentElement.dataset.meshSimulateVoice
    vi.unstubAllGlobals()
  })

  it('uses one truthful message recovery action while the production capability is closed', async () => {
    const backToChat = vi.fn()
    await act(async () => {
      root.render(
        <VoiceView
          channelId="!voice:mesh.test"
          channelName="Studio"
          onBackToChat={backToChat}
        />,
      )
    })

    expect(container.textContent).toContain('Studio voice')
    expect(container.querySelector('#mesh-voice-heading .hidden')?.textContent).toBe(' voice')
    expect(container.querySelector('#mesh-voice-heading .sr-only')?.textContent).toBe(' voice room')
    expect(container.textContent).toContain('Voice is unavailable')
    expect(container.textContent).toContain('Unavailable')
    expect(container.textContent).not.toContain('coming soon')
    expect(container.textContent).toContain(
      'Mesh could not verify private call protection, so it kept your microphone and speakers off.',
    )
    expect(container.textContent).not.toContain('Check again')
    expect(container.textContent).not.toContain('Try again')
    expect(container.textContent).not.toContain('call diagnostics')
    const buttons = Array.from(container.querySelectorAll<HTMLButtonElement>('button'))
    expect(buttons).toHaveLength(1)
    await act(async () => buttons[0]?.click())

    expect(backToChat).toHaveBeenCalledOnce()
  })

  it('does not imply a community owner can enable a globally unavailable release capability', async () => {
    voiceEngineState.availability = 'not-configured'
    await act(async () => {
      root.render(
        <VoiceView
          channelId="!voice:mesh.test"
          channelName="Studio"
          onBackToChat={vi.fn()}
        />,
      )
    })

    expect(container.textContent).toContain('Calling is not available for this account.')
    expect(container.textContent).toContain('Back to messages')
    expect(container.textContent).not.toContain('coming soon')
    expect(container.textContent).not.toContain('enabled for this community')
    expect(container.querySelector('[aria-label*="microphone"]')).toBeNull()
    expect(container.querySelector('[aria-label*="camera"]')).toBeNull()
  })

  it('keeps the connected party focused on media, roster, messages, and explicit leave', async () => {
    document.documentElement.dataset.meshSimulateVoice = 'true'
    voiceEngineState.quality = 'good'
    voiceEngineState.microphonePermission = 'granted'
    useVoiceStore.setState({
      connectionState: 'connected',
      peers: [
        {
          publicKey: '@taylor:mesh.test',
          peerId: 'taylor',
          displayName: 'Taylor',
          avatarColor: '#52b5f4',
          latency: 0,
          connectionState: 'connected',
          isSelf: true,
          isLocal: true,
          speaking: false,
        },
        {
          publicKey: '@maya:mesh.test',
          peerId: 'maya',
          displayName: 'Maya',
          avatarColor: '#9b7cff',
          latency: 20,
          connectionState: 'connected',
          speaking: true,
        },
      ],
    })
    const backToChat = vi.fn()
    await act(async () => {
      root.render(
        <VoiceView
          channelId="!voice:mesh.test"
          channelName="Studio"
          onBackToChat={backToChat}
        />,
      )
    })

    /*
      The heading is the room name at the screen-title step, and the eyebrow
      above it says "Voice room". The visible " voice" suffix inside the
      heading is gone: appending the word to a 56px room name repeated what
      the eyebrow already says one line above it. The screen-reader suffix
      stays, because the eyebrow is a separate element and a heading read on
      its own still has to say what kind of room this is.
    */
    expect(container.textContent).toContain('Voice room')
    expect(container.textContent).toContain('Studio')
    expect(container.querySelector('#mesh-voice-heading .sr-only')?.textContent).toBe(' voice room')
    expect(container.textContent).toContain('2 in call')
    expect(container.querySelector('[data-voice-status="success"]')?.textContent).toContain('Good connection')
    expect(container.querySelector('[data-voice-status="success"]')?.getAttribute('aria-label'))
      .toBe('Call status: Good connection')
    const voiceView = container.querySelector('[data-voice-join-latency-ms="612"]')
    expect(voiceView?.getAttribute('data-voice-round-trip-ms')).toBe('34')
    expect(voiceView?.getAttribute('data-voice-jitter-ms')).toBe('8')
    expect(voiceView?.getAttribute('data-voice-packet-loss-percent')).toBe('0.5')
    expect(container.querySelector('[aria-label="Studio call"]')).not.toBeNull()
    expect(container.querySelector('[aria-label="People in Studio"]')).not.toBeNull()
    const messageButtons = container.querySelectorAll('button[aria-label="Open messages from Studio"]')
    expect(messageButtons).toHaveLength(2)
    expect(messageButtons[0]?.querySelector('span')?.className).toContain('voice-message:inline')
    expect(container.querySelector('button[aria-label="Leave Studio"]')).not.toBeNull()
    expect(container.querySelector('button[aria-label="Share screen"]')).not.toBeNull()
    expect(container.textContent).not.toContain('Mesh cannot use your microphone')

    await act(async () => {
      container.querySelector<HTMLButtonElement>('button[aria-label="Leave Studio"]')?.click()
    })
    expect(useVoiceStore.getState().currentChannelId).toBeNull()
    expect(backToChat).toHaveBeenCalledOnce()
    expect(interfaceSounds.play).toHaveBeenCalledWith('voice-self-leave')
  })

  it('surfaces a blocked microphone with the status indicator and the in-call banner', async () => {
    document.documentElement.dataset.meshSimulateVoice = 'true'
    voiceEngineState.quality = 'good'
    useVoiceStore.setState({ connectionState: 'connected' })

    await act(async () => {
      root.render(
        <VoiceView
          channelId="!voice:mesh.test"
          channelName="Studio"
          onBackToChat={vi.fn()}
        />,
      )
    })

    expect(container.querySelector('[data-voice-status="danger"]')?.textContent).toContain('Microphone blocked')
    expect(container.querySelector('[data-voice-status="danger"]')?.getAttribute('aria-label'))
      .toBe('Call status: Microphone blocked')
    expect(container.textContent).toContain('Mesh cannot use your microphone')
  })

  it('shows a dedicated device check before the person is in the call when the microphone is blocked', async () => {
    document.documentElement.dataset.meshSimulateVoice = 'true'
    voiceEngineState.devices = [
      { deviceId: 'out-1', kind: 'audiooutput', label: 'Built-in speakers' },
    ]
    useVoiceStore.setState({ connectionState: 'connecting' })

    await act(async () => {
      root.render(
        <VoiceView
          channelId="!voice:mesh.test"
          channelName="Studio"
          onBackToChat={vi.fn()}
        />,
      )
    })

    expect(container.textContent).toContain('Microphone blocked')
    expect(container.textContent).not.toContain('Keeping your place while voice connects.')
    expect(container.textContent).toContain('No camera detected')
    const speakerRow = Array.from(container.querySelectorAll('dt'))
      .find((term) => term.textContent === 'Speaker')
      ?.nextElementSibling
    expect(speakerRow?.textContent).toBe('Ready')

    const recheckButton = Array.from(container.querySelectorAll('button'))
      .find((button) => button.textContent === 'Check again')
    expect(recheckButton).toBeTruthy()
    await act(async () => {
      recheckButton?.click()
    })
    expect(voiceEngineState.refreshDevices).toHaveBeenCalledWith(true)
  })

  it('shows the actionable audio warning instead of hiding it behind a generic banner', async () => {
    document.documentElement.dataset.meshSimulateVoice = 'true'
    voiceEngineState.connectionWarning = 'Audio playback is blocked. Click Mesh, then try again.'
    useVoiceStore.setState({ connectionState: 'connected' })

    await act(async () => {
      root.render(
        <VoiceView
          channelId="!voice:mesh.test"
          channelName="Studio"
          onBackToChat={vi.fn()}
        />,
      )
    })

    const status = container.querySelector('[role="status"]')
    expect(status?.textContent).toContain('Call audio needs attention.')
    expect(status?.textContent).toContain('Audio playback is blocked. Click Mesh, then try again.')
  })
})
