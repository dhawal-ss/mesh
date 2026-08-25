import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useChannelStore } from '../../store/channels'
import { useCommunityStore } from '../../store/communities'
import { useIdentityStore } from '../../store/identity'
import { useVoiceStore } from '../../store/voice'
import { useMeshNavigationStore } from '../../store/navigation'
import { currentMeshRoute, emptyMeshNavigation } from '../../lib/mesh-navigation'
import { VoiceDock } from './VoiceDock'

const interfaceSounds = vi.hoisted(() => ({
  play: vi.fn(async () => true),
}))
const voiceEngine = vi.hoisted(() => ({
  toggleCamera: vi.fn(async () => {}),
  toggleScreenSharing: vi.fn(async () => {}),
}))

vi.mock('../../lib/interface-sounds', () => ({
  playInterfaceSound: interfaceSounds.play,
}))

vi.mock('./VoiceEngineProvider', () => ({
  useVoiceEngineController: () => voiceEngine,
}))

describe('VoiceDock', () => {
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
      avatarColor: '#52b5f4',
    })
    useCommunityStore.getState().setCommunities([{
      id: '!community:mesh.test',
      name: 'Lantern Guild',
      description: 'Build together',
      avatarUrl: null,
      memberCount: 3,
      role: 'member',
      joinedAt: '2026-08-01T00:00:00.000Z',
    }])
    useChannelStore.getState().setChannels([
      {
        id: '!concept:mesh.test',
        communityId: '!community:mesh.test',
        name: 'concept-art',
        topic: '',
        channelType: 'text',
        unreadCount: 0,
        joined: true,
      },
      {
        id: '!studio:mesh.test',
        communityId: '!community:mesh.test',
        name: 'Studio',
        topic: '',
        channelType: 'voice',
        unreadCount: 0,
        joined: true,
      },
    ])
    useChannelStore.getState().setActiveChannel('!concept:mesh.test')
    useMeshNavigationStore.setState({
      ...emptyMeshNavigation('local-device'),
      hydrated: true,
      drawer: 'none',
      focusRequest: 0,
    })
    useVoiceStore.setState({
      currentCommunityId: '!community:mesh.test',
      currentChannelId: '!studio:mesh.test',
      localPublicKey: '@taylor:mesh.test',
      connectionState: 'connected',
      isMuted: false,
      isDeafened: false,
      isCameraEnabled: true,
      isScreenSharing: true,
      localAudioLevel: 0.2,
      peers: [],
    })
    interfaceSounds.play.mockClear()
    voiceEngine.toggleCamera.mockClear()
    voiceEngine.toggleScreenSharing.mockClear()
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    useVoiceStore.getState().resetVoiceState()
    useChannelStore.getState().setChannels([])
    useCommunityStore.getState().setCommunities([])
    useIdentityStore.getState().clear()
    vi.unstubAllGlobals()
  })

  it('keeps a real voice session available while another room is open', async () => {
    await act(async () => root.render(<VoiceDock />))

    expect(container.textContent).toContain('Studio')
    expect(container.textContent).toContain('1 in call')

    await act(async () => {
      container.querySelector<HTMLButtonElement>('button[aria-label="Mute microphone"]')?.click()
    })
    expect(useVoiceStore.getState().isMuted).toBe(true)

    await act(async () => {
      container.querySelector<HTMLButtonElement>('button[aria-label="Open voice room Studio"]')?.click()
    })
    expect(useChannelStore.getState().activeChannelId).toBe('!studio:mesh.test')
    expect(currentMeshRoute(useMeshNavigationStore.getState())).toEqual({
      kind: 'voice',
      communityId: '!community:mesh.test',
      roomId: '!studio:mesh.test',
    })
  })

  it('leaves through the existing voice-session boundary', async () => {
    await act(async () => root.render(<VoiceDock />))

    await act(async () => {
      container.querySelector<HTMLButtonElement>('button[aria-label="Leave Studio"]')?.click()
    })

    expect(useVoiceStore.getState()).toMatchObject({
      currentCommunityId: null,
      currentChannelId: null,
      isMuted: true,
      isCameraEnabled: false,
      isScreenSharing: false,
    })
    expect(interfaceSounds.play).toHaveBeenCalledWith('voice-self-leave')
  })

  it('keeps active screen sharing visible and stoppable outside the call room', async () => {
    await act(async () => root.render(<VoiceDock />))

    const stop = container.querySelector<HTMLButtonElement>('button[aria-label="Stop sharing screen"]')
    expect(stop).not.toBeNull()
    await act(async () => {
      stop?.click()
      await Promise.resolve()
    })

    expect(voiceEngine.toggleScreenSharing).toHaveBeenCalledWith(false)
  })

  it('keeps an active camera visible and stoppable outside the call room', async () => {
    await act(async () => root.render(<VoiceDock />))

    const stop = container.querySelector<HTMLButtonElement>('button[aria-label="Turn camera off"]')
    expect(stop).not.toBeNull()
    await act(async () => {
      stop?.click()
      await Promise.resolve()
    })

    expect(voiceEngine.toggleCamera).toHaveBeenCalledWith(false)
  })

  it('names the talking state for assistive tech and carries it without colour', async () => {
    useVoiceStore.setState({
      peers: [{
        publicKey: '@robin:mesh.test',
        displayName: 'Robin Hale',
        avatarColor: '#f4a261',
        peerId: 'robin',
        latency: 12,
        speaking: false,
      }],
    })
    await act(async () => root.render(<VoiceDock />))

    const copy = container.querySelectorAll<HTMLElement>('.mesh-voice-dock-participant-copy')
    expect(copy).toHaveLength(2)
    for (const node of copy) {
      // sr-only keeps the state in the accessibility tree at widths where the
      // dock has no room to show it. `hidden` removed it from the tree.
      expect(node.classList.contains('sr-only')).toBe(true)
      expect(node.classList.contains('hidden')).toBe(false)
    }
    expect(container.textContent).toContain('Talking')
    expect(container.textContent).toContain('Listening')

    const rings = container.querySelectorAll<HTMLElement>('.mesh-voice-dock-participant > span:first-of-type')
    expect(rings[0].className).toContain('bg-status-success')
    expect(rings[1].className).toContain('bg-transparent')
  })

  it('keeps a failed owned session actionable without hiding messages', async () => {
    useVoiceStore.setState({ connectionState: 'disconnected' })
    await act(async () => root.render(<VoiceDock />))

    expect(container.textContent).toContain('Voice could not reconnect')
    const retry = Array.from(container.querySelectorAll<HTMLButtonElement>('button'))
      .find((button) => button.textContent?.includes('Try again'))
    expect(retry).toBeDefined()
    expect(container.querySelector('button[aria-label="Open voice room Studio"]')).not.toBeNull()
    expect(container.querySelector('button[aria-label="Leave Studio"]')).not.toBeNull()
  })
})
