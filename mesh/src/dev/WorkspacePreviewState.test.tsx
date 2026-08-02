import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WorkspacePreviewState } from './WorkspacePreviewState'
import { useVoiceStore } from '../store/voice'

describe('WorkspacePreviewState', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    vi.useFakeTimers()
    useVoiceStore.getState().resetVoiceState()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    useVoiceStore.getState().resetVoiceState()
    container.remove()
    vi.useRealTimers()
  })

  it('keeps the default workspace preview aligned with fail-closed voice', async () => {
    useVoiceStore.getState().setCurrentVoiceSession('!community:example.org', '!voice:example.org')
    useVoiceStore.getState().setConnectionState('connected')

    await act(async () => {
      root.render(<WorkspacePreviewState />)
    })

    expect(useVoiceStore.getState()).toMatchObject({
      currentCommunityId: null,
      currentChannelId: null,
      connectionState: 'idle',
      peers: [],
    })
  })

  it('seeds simulated voice only after an explicit preview opt-in', async () => {
    await act(async () => {
      root.render(<WorkspacePreviewState simulateVoice />)
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300)
    })

    expect(useVoiceStore.getState()).toMatchObject({
      currentCommunityId: '!lantern-guild:mesh.test',
      currentChannelId: '!studio:mesh.test',
      connectionState: 'connected',
    })
    expect(useVoiceStore.getState().peers).toHaveLength(4)
  })
})
