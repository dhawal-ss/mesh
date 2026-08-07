import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { VOICE_ACTIVATION_EVENT } from '../../lib/voice-activation'
import { useIdentityStore } from '../../store/identity'
import { useVoiceStore } from '../../store/voice'
import { VoicePeerGrid } from './VoicePeerGrid'

describe('VoicePeerGrid party composition', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    vi.stubGlobal('matchMedia', vi.fn().mockImplementation((query: string) => ({
      matches: query === '(max-width: 1099px)',
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })))
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
          publicKey: '@rohan:mesh.test',
          peerId: 'rohan',
          displayName: 'Rohan',
          avatarColor: '#f1a45b',
          latency: 20,
          connectionState: 'connected',
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
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    useVoiceStore.getState().resetVoiceState()
    useIdentityStore.getState().clear()
    vi.unstubAllGlobals()
  })

  it('presents one party focus and orders the active speaker before the local player', async () => {
    await act(async () => root.render(<VoicePeerGrid channelName="Studio" />))

    expect(container.querySelector('[aria-label="Studio party focus"]')).not.toBeNull()
    const roster = container.querySelector('[aria-label="People in Studio"]')
    const participantLabels = Array.from(roster?.querySelectorAll<HTMLElement>('[aria-label]') ?? [])
      .map((element) => element.getAttribute('aria-label'))
      .filter((label) => label?.includes(', '))
    expect(participantLabels.slice(0, 3)).toEqual([
      'Maya, speaking',
      'Taylor, you',
      'Rohan, listening',
    ])
    expect(container.textContent).not.toContain('in call')
  })

  it('records click-to-audible only when remote audio actually starts playing', async () => {
    const listener = vi.fn()
    window.addEventListener(VOICE_ACTIVATION_EVENT, listener)
    await act(async () => root.render(<VoicePeerGrid channelName="Studio" />))

    const remote = container.querySelector<HTMLElement>('[aria-label="Maya, speaking"]')
    await act(async () => remote?.querySelector('audio')?.dispatchEvent(new Event('playing')))

    expect(listener).toHaveBeenCalledOnce()
    const event = listener.mock.calls[0]?.[0] as CustomEvent
    expect(event.detail).toMatchObject({ segment: 'click-to-audible' })
    expect(event.detail.durationMs).toBeGreaterThanOrEqual(0)
    expect(JSON.stringify(event.detail)).not.toContain('voice-one')
    window.removeEventListener(VOICE_ACTIVATION_EVENT, listener)
  })

  it('treats the narrow roster as a modal drawer with focus and Escape recovery', async () => {
    const closeRoster = vi.fn()
    await act(async () => root.render(
      <VoicePeerGrid
        channelName="Studio"
        rosterOpen
        onCloseRoster={closeRoster}
      />,
    ))

    const drawer = container.querySelector<HTMLElement>('[role="dialog"][aria-modal="true"]')
    const closeButton = drawer?.querySelector<HTMLButtonElement>('button[aria-label="Close party roster"]')
    expect(drawer?.getAttribute('aria-label')).toBe('People in Studio')
    expect(document.activeElement).toBe(closeButton)

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(closeRoster).toHaveBeenCalledOnce()
  })

  it('does not leave a hidden modal focus trap behind on a wide viewport', async () => {
    vi.stubGlobal('matchMedia', vi.fn().mockImplementation((query: string) => ({
      matches: query === '(max-width: 1099px)' ? false : true,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })))

    await act(async () => root.render(
      <VoicePeerGrid channelName="Studio" rosterOpen onCloseRoster={vi.fn()} />,
    ))

    expect(container.querySelector('[role="dialog"][aria-modal="true"]')).toBeNull()
  })
})
