import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { VoiceControls } from './VoiceControls'
import { useVoiceStore } from '../../store/voice'

const devices = [
  { deviceId: 'mic-1', kind: 'audioinput' as const, label: 'Desk microphone' },
  { deviceId: 'speaker-1', kind: 'audiooutput' as const, label: 'Headphones' },
  { deviceId: 'camera-1', kind: 'videoinput' as const, label: 'Desk camera' },
]

function props() {
  return {
    devices,
    roomName: 'Studio',
    onOpenMessages: vi.fn(),
    onLeave: vi.fn(),
    onInputDeviceChange: vi.fn().mockResolvedValue(undefined),
    onOutputDeviceChange: vi.fn().mockResolvedValue(undefined),
    onCameraDeviceChange: vi.fn().mockResolvedValue(undefined),
    onAudioProcessingChange: vi.fn().mockResolvedValue(undefined),
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
      cameraDeviceId: null,
      audioProcessing: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
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

  it('switches call devices only after the transport accepts them', async () => {
    const controls = props()
    await act(async () => root.render(<VoiceControls {...controls} />))
    await openVoiceSettings(container)
    const selects = document.querySelectorAll('select')

    await act(async () => {
      selectValue(selects[1], 'mic-1')
      selectValue(selects[2], 'speaker-1')
      selectValue(selects[3], 'camera-1')
      await Promise.resolve()
    })

    expect(controls.onInputDeviceChange).toHaveBeenCalledWith('mic-1')
    expect(controls.onOutputDeviceChange).toHaveBeenCalledWith('speaker-1')
    expect(controls.onCameraDeviceChange).toHaveBeenCalledWith('camera-1')
    expect(useVoiceStore.getState()).toMatchObject({
      inputDeviceId: 'mic-1',
      outputDeviceId: 'speaker-1',
      cameraDeviceId: 'camera-1',
    })
  })

  it('defaults audio cleanup on and applies changes through a live microphone restart', async () => {
    const controls = props()
    await act(async () => root.render(<VoiceControls {...controls} />))
    await openVoiceSettings(container)

    const echo = document.querySelector<HTMLInputElement>('input[aria-label="Echo cancellation"]')
      ?? Array.from(document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'))[0]
    expect(echo.checked).toBe(true)

    await act(async () => {
      echo.click()
      await Promise.resolve()
    })

    expect(controls.onAudioProcessingChange).toHaveBeenCalledWith({
      echoCancellation: false,
      noiseSuppression: true,
      autoGainControl: true,
    })
  })

  it('turns raw audio-device failures into plain recovery guidance', async () => {
    const controls = props()
    controls.onInputDeviceChange.mockRejectedValue(
      new Error('M_FORBIDDEN from https://voice.example/_matrix/client'),
    )
    await act(async () => root.render(<VoiceControls {...controls} />))
    await openVoiceSettings(container)
    const inputSelect = document.querySelectorAll('select')[1]

    await act(async () => {
      selectValue(inputSelect, 'mic-1')
      await Promise.resolve()
    })

    const alert = container.querySelector('[role="alert"]')?.textContent ?? ''
    expect(alert).toContain('could not switch microphones')
    expect(alert).toContain('system settings')
    expect(alert).not.toContain('M_FORBIDDEN')
    expect(alert).not.toContain('_matrix')
    expect(useVoiceStore.getState().inputDeviceId).toBeNull()
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

  it('starts and stops screen sharing through an explicit connected-call control', async () => {
    const controls = props()
    await act(async () => root.render(<VoiceControls {...controls} />))

    const start = container.querySelector<HTMLButtonElement>('button[aria-label="Share screen"]')!
    expect(start.getAttribute('aria-pressed')).toBe('false')
    await act(async () => {
      start.click()
      await Promise.resolve()
    })

    expect(controls.onScreenShareChange).toHaveBeenCalledWith(true)

    await act(async () => useVoiceStore.getState().setScreenSharing(true))
    const stop = container.querySelector<HTMLButtonElement>('button[aria-label="Stop sharing screen"]')!
    expect(stop.getAttribute('aria-pressed')).toBe('true')
    expect(stop.dataset.screenSharing).toBe('true')
    await act(async () => {
      stop.click()
      await Promise.resolve()
    })

    expect(controls.onScreenShareChange).toHaveBeenLastCalledWith(false)
  })

  it('keeps screen-sharing failures actionable and hides raw transport details', async () => {
    const controls = props()
    controls.onScreenShareChange.mockRejectedValue(
      new Error('M_FORBIDDEN at wss://rtc.example.test?access_token=secret'),
    )
    await act(async () => root.render(<VoiceControls {...controls} />))

    await act(async () => {
      container.querySelector<HTMLButtonElement>('button[aria-label="Share screen"]')?.click()
      await Promise.resolve()
    })

    const alert = container.querySelector('[role="alert"]')?.textContent ?? ''
    expect(alert).toContain('Choose the window again')
    expect(alert).not.toContain('M_FORBIDDEN')
    expect(alert).not.toContain('access_token')
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
      'Mesh cannot use your camera. Allow camera access in system settings.',
    )
  })

  it('keeps all four beta call actions visible and wired to their existing boundaries', async () => {
    const controls = props()
    await act(async () => root.render(<VoiceControls {...controls} />))

    const mute = container.querySelector<HTMLButtonElement>('button[aria-label="Mute microphone"]')!
    const deafen = container.querySelector<HTMLButtonElement>('button[aria-label="Turn incoming audio off"]')!
    const camera = container.querySelector<HTMLButtonElement>('button[aria-label="Turn camera on"]')!
    const disconnect = container.querySelector<HTMLButtonElement>('button[aria-label="Leave Studio"]')!

    expect([mute, deafen, camera, disconnect].every(Boolean)).toBe(true)

    await act(async () => {
      mute.click()
      deafen.click()
      camera.click()
      await Promise.resolve()
    })

    expect(useVoiceStore.getState()).toMatchObject({
      isMuted: true,
      isDeafened: true,
    })
    expect(controls.onCameraChange).toHaveBeenCalledWith(true)

    await act(async () => disconnect.click())
    expect(controls.onLeave).toHaveBeenCalledOnce()
  })

  it('keeps text focus labelled and separate from the destructive leave action', async () => {
    const controls = props()
    await act(async () => root.render(<VoiceControls {...controls} />))

    await act(async () => {
      container.querySelector<HTMLButtonElement>('button[aria-label="Open messages from Studio"]')?.click()
    })

    expect(controls.onOpenMessages).toHaveBeenCalledOnce()
    expect(container.querySelector('button[aria-label="Leave Studio"]')).not.toBeNull()
  })

  it('uses attention for muted states, accent for active media, and danger only for disconnect', async () => {
    useVoiceStore.setState({
      isMuted: true,
      isDeafened: true,
      isCameraEnabled: true,
    })
    await act(async () => root.render(<VoiceControls {...props()} />))

    expect(
      container.querySelector<HTMLButtonElement>('button[aria-label="Unmute microphone"]')?.className,
    ).toContain('bg-marker')
    expect(
      container.querySelector<HTMLButtonElement>('button[aria-label="Turn incoming audio on"]')?.className,
    ).toContain('bg-marker')
    expect(
      container.querySelector<HTMLButtonElement>('button[aria-label="Turn camera off"]')?.className,
    ).toContain('bg-primary')
    /*
      Leave is a flat vermilion plane, and it is the only plane in the row.

      It used to carry its tone in ink and a rule instead, on the reasoning
      that a solid red button would read as the primary action. That reasoning
      belonged to a row of five circular fills competing for attention. Under
      Quiet Structure the other controls are hairline cells with mono labels
      and no fill at all, so nothing is competing, and the plane is precisely
      how this system marks the one action here that pressing again does not
      undo.

      The fill is asserted with an anchored prefix because the previous
      assertion, a bare `bg-error`, also matched the substring inside
      `hover:bg-error/10` and so passed for a button with no danger
      background in any state.
    */
    const leave = container.querySelector<HTMLButtonElement>('button[aria-label="Leave Studio"]')?.className
    expect(leave?.split(/\s+/)).toContain('bg-error')
    expect(leave).toContain('text-on-error')
    expect(leave).toContain('rounded-full')
  })
})
