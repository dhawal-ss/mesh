import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { VoiceControls } from './VoiceControls'
import { useVoiceStore } from '../../store/voice'

const devices = [
  { deviceId: 'mic-1', kind: 'audioinput' as const, label: 'Desk microphone' },
  { deviceId: 'speaker-1', kind: 'audiooutput' as const, label: 'Headphones' },
]

function props() {
  return {
    devices,
    onInputDeviceChange: vi.fn().mockResolvedValue(undefined),
    onOutputDeviceChange: vi.fn().mockResolvedValue(undefined),
    onCameraChange: vi.fn().mockResolvedValue(undefined),
    onScreenShareChange: vi.fn().mockResolvedValue(undefined),
  }
}

function selectValue(select: HTMLSelectElement, value: string) {
  const setValue = Object.getOwnPropertyDescriptor(
    HTMLSelectElement.prototype,
    'value',
  )?.set
  setValue?.call(select, value)
  select.dispatchEvent(new Event('change', { bubbles: true }))
}

describe('VoiceControls', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    useVoiceStore.setState({
      currentCommunityId: 'community-1',
      currentChannelId: 'voice-1',
      connectionState: 'connected',
      isMuted: false,
      isDeafened: false,
      inputMode: 'voice-activity',
      isPushToTalking: false,
      isCameraEnabled: false,
      isScreenSharing: false,
      inputDeviceId: null,
      outputDeviceId: null,
      localAudioLevel: 0.42,
    })
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  it('switches audio devices only after the transport accepts them', async () => {
    const controls = props()
    await act(async () => root.render(<VoiceControls {...controls} />))
    const selects = container.querySelectorAll('select')

    await act(async () => {
      selectValue(selects[1], 'mic-1')
      selectValue(selects[2], 'speaker-1')
      await Promise.resolve()
    })

    expect(controls.onInputDeviceChange).toHaveBeenCalledWith('mic-1')
    expect(controls.onOutputDeviceChange).toHaveBeenCalledWith('speaker-1')
    expect(useVoiceStore.getState()).toMatchObject({
      inputDeviceId: 'mic-1',
      outputDeviceId: 'speaker-1',
    })
  })

  it('holds the microphone closed in push-to-talk mode until pressed', async () => {
    await act(async () => root.render(<VoiceControls {...props()} />))
    const talkMode = container.querySelectorAll('select')[0]
    await act(async () => selectValue(talkMode, 'push-to-talk'))

    expect(useVoiceStore.getState()).toMatchObject({
      inputMode: 'push-to-talk',
      isMuted: true,
    })

    const button = container.querySelector<HTMLButtonElement>('button[aria-label="Hold to talk"]')!
    const setPointerCapture = vi.fn()
    const releasePointerCapture = vi.fn()
    button.setPointerCapture = setPointerCapture
    button.hasPointerCapture = vi.fn(() => true)
    button.releasePointerCapture = releasePointerCapture
    await act(async () => {
      button.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 7 }))
    })
    expect(setPointerCapture).toHaveBeenCalledWith(7)
    expect(useVoiceStore.getState()).toMatchObject({
      isPushToTalking: true,
      isMuted: false,
    })
    await act(async () => {
      button.dispatchEvent(new PointerEvent('pointercancel', { bubbles: true, pointerId: 7 }))
    })
    expect(releasePointerCapture).toHaveBeenCalledWith(7)
    expect(useVoiceStore.getState()).toMatchObject({
      isPushToTalking: false,
      isMuted: true,
    })
  })

  it('reports a disconnected transport honestly', async () => {
    useVoiceStore.setState({ connectionState: 'disconnected' })
    await act(async () => root.render(<VoiceControls {...props()} />))

    expect(container.textContent).toContain('Voice disconnected')
    expect(container.textContent).not.toContain('Voice connected')
  })

  it('uses the browser-native display picker through the transport', async () => {
    const controls = props()
    await act(async () => root.render(<VoiceControls {...controls} />))
    const shareButton = container.querySelector<HTMLButtonElement>('button[aria-label="Share screen"]')

    await act(async () => {
      shareButton?.click()
      await Promise.resolve()
    })

    expect(controls.onScreenShareChange).toHaveBeenCalledWith(true)
  })

  it('uses attention for muted states, accent for active media, and danger only for disconnect', async () => {
    useVoiceStore.setState({
      isMuted: true,
      isDeafened: true,
      isCameraEnabled: true,
      isScreenSharing: true,
    })
    await act(async () => root.render(<VoiceControls {...props()} />))

    expect(
      container.querySelector<HTMLButtonElement>('button[aria-label="Unmute microphone"]')?.className,
    ).toContain('bg-status-warning')
    expect(
      container.querySelector<HTMLButtonElement>('button[aria-label="Undeafen audio"]')?.className,
    ).toContain('bg-status-warning')
    expect(
      container.querySelector<HTMLButtonElement>('button[aria-label="Turn camera off"]')?.className,
    ).toContain('bg-accent')
    expect(
      container.querySelector<HTMLButtonElement>('button[aria-label="Stop sharing screen"]')?.className,
    ).toContain('bg-accent')
    expect(
      container.querySelector<HTMLButtonElement>('button[aria-label="Disconnect from voice room"]')?.className,
    ).toContain('bg-status-danger')
  })
})
