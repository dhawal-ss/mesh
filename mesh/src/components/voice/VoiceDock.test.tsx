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

vi.mock('../../lib/interface-sounds', () => ({
  playInterfaceSound: interfaceSounds.play,
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
      memberCount: 3,
      role: 'member',
      joinedAt: '2026-08-01T00:00:00.000Z',
    }])
    useChannelStore.getState().setChannels([
      {
        id: '!concept:mesh.test',
        communityId: '!community:mesh.test',
        name: 'concept-art',
        channelType: 'text',
        unreadCount: 0,
      },
      {
        id: '!studio:mesh.test',
        communityId: '!community:mesh.test',
        name: 'Studio',
        channelType: 'voice',
        unreadCount: 0,
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
    expect(container.textContent).toContain('1 in party')

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
