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
}))

vi.mock('../../lib/interface-sounds', () => ({
  playInterfaceSound: interfaceSounds.play,
}))

vi.mock('../../hooks/useVoiceEngine', () => ({
  useVoiceEngine: () => ({
    connectionWarning: voiceEngineState.connectionWarning,
    microphonePermission: 'denied',
    relayChanged: false,
    voiceService: {
      provider: 'matrix-rtc',
      availability: 'invalid-configuration',
      mediaE2eeReady: false,
    },
    matrixVoiceReady: false,
    matrixUnavailableReason: 'The calling service is missing required configuration.',
    devices: [],
    refreshDevices: vi.fn(async () => {}),
    switchInputDevice: vi.fn(),
    switchOutputDevice: vi.fn(),
    setParticipantVolume: vi.fn(),
    toggleCamera: vi.fn(),
    toggleScreenShare: vi.fn(),
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
    expect(container.textContent).toContain('Voice is not available for this room')
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

  it('keeps the connected party focused on media, roster, messages, and explicit leave', async () => {
    document.documentElement.dataset.meshSimulateVoice = 'true'
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

    expect(container.textContent).toContain('Studio voice')
    expect(container.querySelector('#mesh-voice-heading .hidden')?.textContent).toBe(' voice')
    expect(container.querySelector('#mesh-voice-heading .sr-only')?.textContent).toBe(' voice room')
    expect(container.textContent).toContain('2 in party')
    expect(container.querySelector('[aria-label="Studio party focus"]')).not.toBeNull()
    expect(container.querySelector('[aria-label="People in Studio"]')).not.toBeNull()
    const messageButtons = container.querySelectorAll('button[aria-label="Open messages from Studio"]')
    expect(messageButtons).toHaveLength(2)
    expect(messageButtons[0]?.querySelector('span')?.className).toContain('min-[380px]:inline')
    expect(container.querySelector('button[aria-label="Leave Studio"]')).not.toBeNull()
    expect(container.textContent).toContain('microphone')

    await act(async () => {
      container.querySelector<HTMLButtonElement>('button[aria-label="Leave Studio"]')?.click()
    })
    expect(useVoiceStore.getState().currentChannelId).toBeNull()
    expect(backToChat).toHaveBeenCalledOnce()
    expect(interfaceSounds.play).toHaveBeenCalledWith('voice-self-leave')
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
    expect(status?.textContent).toContain('Party audio needs attention.')
    expect(status?.textContent).toContain('Audio playback is blocked. Click Mesh, then try again.')
  })
})
