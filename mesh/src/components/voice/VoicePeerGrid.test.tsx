import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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

  it('presents a three-person grid and orders the active speaker before the local player', async () => {
    await act(async () => root.render(<VoicePeerGrid channelName="Studio" />))

    expect(container.querySelector('[aria-label="Studio call"]')).not.toBeNull()
    const grid = container.querySelector('[data-participant-count="3"]')
    expect(grid).not.toBeNull()
    expect(grid?.querySelectorAll('.mesh-call-tile')).toHaveLength(3)
    expect(grid?.firstElementChild?.getAttribute('aria-label')).toBe('Maya call tile, speaking')
    expect(grid?.firstElementChild?.className).toContain('sm:col-span-2')
    const roster = container.querySelector('[aria-label="People in Studio"]')
    const participantLabels = Array.from(roster?.querySelectorAll<HTMLElement>('[aria-label]') ?? [])
      .map((element) => element.getAttribute('aria-label'))
      .filter((label) => label?.includes(', '))
    expect(participantLabels.slice(0, 3)).toEqual([
      'Maya, speaking',
      'Taylor, you',
      'Rohan, listening',
    ])
    expect(container.textContent).not.toContain('party')
  })

  it('uses two equal tiles for two people and four columns for four to eight', async () => {
    useVoiceStore.setState((state) => ({ peers: state.peers.slice(0, 1) }))
    await act(async () => root.render(<VoicePeerGrid channelName="Studio" />))

    const twoPersonGrid = container.querySelector('[data-participant-count="2"]')
    expect(twoPersonGrid?.querySelectorAll('.mesh-call-tile')).toHaveLength(2)
    expect(twoPersonGrid?.className).toContain('sm:grid-cols-2')
    expect(twoPersonGrid?.className).not.toContain('lg:grid-cols-4')

    await act(async () => {
      useVoiceStore.setState({
        peers: Array.from({ length: 7 }, (_, index) => ({
          publicKey: `@person-${index}:mesh.test`,
          peerId: `person-${index}`,
          displayName: `Person ${index + 1}`,
          avatarColor: '#9b7cff',
          latency: 20,
          connectionState: 'connected' as const,
          speaking: index === 0,
        })),
      })
    })

    const eightPersonGrid = container.querySelector('[data-participant-count="8"]')
    expect(eightPersonGrid?.querySelectorAll('.mesh-call-tile')).toHaveLength(8)
    expect(eightPersonGrid?.className).toContain('lg:grid-cols-4')
  })

  it('shows remote mute state without relying on the local mute choice', async () => {
    useVoiceStore.setState((state) => ({
      peers: state.peers.map((peer) => peer.publicKey === '@rohan:mesh.test'
        ? { ...peer, muted: true }
        : peer),
    }))

    await act(async () => root.render(<VoicePeerGrid channelName="Studio" />))

    const roster = container.querySelector('[aria-label="People in Studio"]')
    expect(roster?.querySelector('[aria-label="Rohan, muted"]')).not.toBeNull()
  })

  it('promotes incoming screen video to the stage', async () => {
    const screenShareStream = { id: 'screen-video' } as MediaStream
    useVoiceStore.setState((state) => ({
      peers: state.peers.map((peer) => peer.publicKey === '@maya:mesh.test'
        ? { ...peer, screenShareStream }
        : peer),
    }))

    await act(async () => root.render(<VoicePeerGrid channelName="Studio" />))

    const stage = container.querySelector<HTMLElement>('[aria-label="Maya screen share"]')
    expect(container.querySelector('[data-screen-share-count="1"]')).not.toBeNull()
    expect(stage).not.toBeNull()
    expect(stage?.querySelector('video')?.srcObject).toBe(screenShareStream)
    expect(stage?.textContent).toContain('Sharing screen')
    expect(container.querySelector('[aria-label="Maya, speaking, sharing screen"]')).not.toBeNull()
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
    const closeButton = drawer?.querySelector<HTMLButtonElement>('button[aria-label="Close people list"]')
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
