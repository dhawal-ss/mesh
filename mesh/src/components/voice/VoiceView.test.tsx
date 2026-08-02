import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useVoiceStore } from '../../store/voice'
import { VoiceView } from './VoiceView'

const engine = vi.hoisted(() => ({
  refreshDevices: vi.fn(async () => {}),
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
    devices: { inputs: [], outputs: [], selectedInputId: null, selectedOutputId: null },
    refreshDevices: engine.refreshDevices,
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
    engine.refreshDevices.mockClear()
    useVoiceStore.setState({
      currentCommunityId: '!community:mesh.test',
      currentChannelId: '!voice:mesh.test',
    })
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    useVoiceStore.getState().resetVoiceState()
    vi.unstubAllGlobals()
  })

  it('explains the blocker and exposes retry, diagnostics, and chat actions', async () => {
    const checkAgain = vi.fn()
    const openDiagnostics = vi.fn()
    const backToChat = vi.fn()
    await act(async () => {
      root.render(
        <VoiceView
          channelId="!voice:mesh.test"
          channelName="Studio"
          onCheckAgain={checkAgain}
          onOpenDiagnostics={openDiagnostics}
          onBackToChat={backToChat}
        />,
      )
    })

    expect(container.textContent).toContain('Permission')
    expect(container.textContent).toContain('system permission')
    const buttons = Array.from(container.querySelectorAll<HTMLButtonElement>('button'))
    const click = async (label: string) => {
      const button = buttons.find((candidate) => candidate.textContent?.includes(label))
      expect(button).toBeDefined()
      await act(async () => button?.click())
    }
    await click('Check again')
    await click('Open call diagnostics')
    await click('Back to chat')

    expect(checkAgain).toHaveBeenCalledOnce()
    expect(engine.refreshDevices).toHaveBeenCalledWith(true)
    expect(openDiagnostics).toHaveBeenCalledOnce()
    expect(backToChat).toHaveBeenCalledOnce()
  })
})
