import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useVoiceStore } from '../../store/voice'
import { VoiceView } from './VoiceView'

const interfaceSounds = vi.hoisted(() => ({
  play: vi.fn(async () => true),
}))

vi.mock('../../lib/interface-sounds', () => ({
  playInterfaceSound: interfaceSounds.play,
}))

vi.mock('../../hooks/useVoiceEngine', () => ({
  useVoiceEngine: () => ({
    connectionWarning: null,
    microphonePermission: 'denied',
    relayChanged: false,
    voiceService: {
      provider: 'matrix-rtc',
      availability: 'invalid-configuration',
      mediaE2eeVerified: false,
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
    expect(container.textContent).toContain('Voice is not available for this room')
    expect(container.textContent).toContain('You can keep using messages.')
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
      peers: [{
        publicKey: '@maya:mesh.test',
        peerId: 'maya',
        displayName: 'Maya',
        avatarColor: '#9b7cff',
        latency: 20,
        connectionState: 'connected',
        speaking: true,
      }],
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
    expect(container.textContent).toContain('2 in party')
    expect(container.querySelector('[aria-label="Studio party focus"]')).not.toBeNull()
    expect(container.querySelector('[aria-label="People in Studio"]')).not.toBeNull()
    expect(container.querySelector('button[aria-label="Open messages from Studio"]')).not.toBeNull()
    expect(container.querySelector('button[aria-label="Leave Studio"]')).not.toBeNull()
    expect(container.textContent).toContain('microphone')

    await act(async () => {
      container.querySelector<HTMLButtonElement>('button[aria-label="Leave Studio"]')?.click()
    })
    expect(useVoiceStore.getState().currentChannelId).toBeNull()
    expect(backToChat).toHaveBeenCalledOnce()
    expect(interfaceSounds.play).toHaveBeenCalledWith('voice-self-leave')
  })
})
