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

async function openVoiceSettings(container: HTMLElement) {
  const trigger = container.querySelector<HTMLButtonElement>('button[aria-label="Open voice settings"]')
  await act(async () => {
    trigger?.click()
    await Promise.resolve()
  })
  return trigger
}

describe('VoiceControls', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    )
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
    document.body.querySelectorAll('[data-radix-popper-content-wrapper]').forEach((element) => element.remove())
    container.remove()
    vi.unstubAllGlobals()
  })

  it('keeps advanced voice controls collapsed by default', async () => {
    await act(async () => root.render(<VoiceControls {...props()} />))

    expect(container.querySelector('button[aria-label="Open voice settings"]')).not.toBeNull()
    expect(document.body.textContent).not.toContain('Talk mode')
    expect(document.body.textContent).not.toContain('Desk microphone')
    expect(document.querySelector('[role="meter"][aria-label="Microphone input level"]')).toBeNull()
  })

  it('opens voice settings from a keyboard-reachable disclosure and restores focus on Escape', async () => {
    await act(async () => root.render(<VoiceControls {...props()} />))
    const trigger = container.querySelector<HTMLButtonElement>('button[aria-label="Open voice settings"]')!

    trigger.focus()
    expect(document.activeElement).toBe(trigger)
    expect(trigger.getAttribute('aria-expanded')).toBe('false')

    await openVoiceSettings(container)

    expect(trigger.getAttribute('aria-expanded')).toBe('true')
    expect(document.body.textContent).toContain('Voice settings')
    expect(document.body.textContent).toContain('Talk mode')

    const popover = document.querySelector<HTMLElement>('[data-radix-popper-content-wrapper]')
    await act(async () => {
      popover?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      await new Promise((resolve) => window.setTimeout(resolve, 20))
    })

    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    expect(document.body.textContent).not.toContain('Talk mode')
    expect(document.activeElement).toBe(trigger)
  })

  it('switches audio devices only after the transport accepts them', async () => {
    const controls = props()
    await act(async () => root.render(<VoiceControls {...controls} />))
    await openVoiceSettings(container)
    const selects = document.querySelectorAll('select')

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
    await openVoiceSettings(container)
    const talkMode = document.querySelectorAll('select')[0]
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

  it('turns camera permission denial into a system-settings recovery action', async () => {
    const controls = props()
    controls.onCameraChange.mockRejectedValue(
      Object.assign(new Error('raw browser denial'), { name: 'NotAllowedError' }),
    )
    await act(async () => root.render(<VoiceControls {...controls} />))

    await act(async () => {
      container.querySelector<HTMLButtonElement>('button[aria-label="Turn camera on"]')?.click()
      await Promise.resolve()
    })

    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      'Mesh can’t access camera. Allow camera access for Mesh in your system settings, then try again.',
    )
  })

  it('keeps all five core call actions visible and wired to their existing boundaries', async () => {
    const controls = props()
    await act(async () => root.render(<VoiceControls {...controls} />))

    const mute = container.querySelector<HTMLButtonElement>('button[aria-label="Mute microphone"]')!
    const deafen = container.querySelector<HTMLButtonElement>('button[aria-label="Deafen audio"]')!
    const camera = container.querySelector<HTMLButtonElement>('button[aria-label="Turn camera on"]')!
    const share = container.querySelector<HTMLButtonElement>('button[aria-label="Share screen"]')!
    const disconnect = container.querySelector<HTMLButtonElement>('button[aria-label="Disconnect from voice room"]')!

    expect([mute, deafen, camera, share, disconnect].every(Boolean)).toBe(true)

    await act(async () => {
      mute.click()
      deafen.click()
      camera.click()
      share.click()
      await Promise.resolve()
    })

    expect(useVoiceStore.getState()).toMatchObject({
      isMuted: true,
      isDeafened: true,
    })
    expect(controls.onCameraChange).toHaveBeenCalledWith(true)
    expect(controls.onScreenShareChange).toHaveBeenCalledWith(true)

    await act(async () => disconnect.click())
    expect(useVoiceStore.getState()).toMatchObject({
      currentCommunityId: null,
      currentChannelId: null,
    })
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
