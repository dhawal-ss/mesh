import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../lib/bridge', () => ({
  getMemberPage: vi.fn(),
  getMembers: vi.fn(),
  isMatrixBackend: vi.fn(() => true),
  matrixWaitForRoomUpdate: vi.fn(),
  onControlEvent: vi.fn(),
  requestControlLogSync: vi.fn(),
}))

import * as bridge from '../lib/bridge'
import { useCommunityStore } from '../store/communities'
import { useMembershipStore } from '../store/membership'
import { useCommunitySync } from './useCommunitySync'

function Harness() {
  useCommunitySync()
  return null
}

describe('Matrix community roster synchronization', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    vi.clearAllMocks()
    vi.mocked(bridge.isMatrixBackend).mockReturnValue(true)
    useCommunityStore.setState({
      activeCommunityId: '!community:mesh.test',
      communityEntities: {},
      communityOrder: [],
      communities: [],
    })
    useMembershipStore.setState({
      memberEntities: {},
      memberOrder: {},
      members: {},
      rosterNextCursor: {},
      rosterStateComplete: {},
    })
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('loads one bounded page and does not refresh after an unchanged long poll', async () => {
    vi.mocked(bridge.getMemberPage).mockResolvedValue({
      members: [{
        publicKey: '@alice:mesh.test',
        displayName: 'Alice',
        avatarColor: '#607080',
        role: 'member',
        joinStatus: 'joined',
        banStatus: 'none',
        lastSeen: null,
        online: true,
      }],
      nextCursor: '@alice:mesh.test',
      stateComplete: false,
    })
    vi.mocked(bridge.matrixWaitForRoomUpdate)
      .mockResolvedValueOnce(false)
      .mockImplementation(() => new Promise(() => {}))

    await act(async () => {
      root.render(<Harness />)
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(bridge.getMemberPage).toHaveBeenCalledTimes(1)
    expect(bridge.getMemberPage).toHaveBeenCalledWith('!community:mesh.test')
    expect(bridge.matrixWaitForRoomUpdate).toHaveBeenCalledTimes(2)
    const state = useMembershipStore.getState()
    expect(state.memberOrder['!community:mesh.test']).toEqual(['@alice:mesh.test'])
    expect(state.rosterNextCursor['!community:mesh.test']).toBe('@alice:mesh.test')
    expect(state.rosterStateComplete['!community:mesh.test']).toBe(false)
  })

  it('invalidates loaded later pages after a room update so departed people cannot remain visible', async () => {
    const member = (
      publicKey: string,
      displayName: string,
      joinStatus: 'invited' | 'joined' | 'left' = 'joined',
      banStatus: 'none' | 'banned' = 'none',
    ) => ({
      publicKey,
      displayName,
      avatarColor: '#607080',
      role: 'member' as const,
      joinStatus,
      banStatus,
      lastSeen: null,
      online: false,
    })
    useMembershipStore.getState().setRosterPage(
      '!community:mesh.test',
      [
        member('@alice:mesh.test', 'Old Alice'),
        member('@zoe:mesh.test', 'Zoe'),
        member('@left:mesh.test', 'Left', 'left'),
        member('@banned:mesh.test', 'Banned', 'left', 'banned'),
      ],
      null,
      true,
      false,
    )
    vi.mocked(bridge.getMemberPage).mockResolvedValue({
      members: [member('@alice:mesh.test', 'Alice')],
      nextCursor: '@alice:mesh.test',
      stateComplete: true,
    })
    vi.mocked(bridge.matrixWaitForRoomUpdate).mockImplementation(() => new Promise(() => {}))

    await act(async () => {
      root.render(<Harness />)
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })

    const state = useMembershipStore.getState()
    expect(state.memberOrder['!community:mesh.test']).toEqual(['@alice:mesh.test'])
    expect(state.memberEntities['!community:mesh.test']['@alice:mesh.test'].displayName).toBe('Alice')
    expect(state.memberEntities['!community:mesh.test']['@zoe:mesh.test']).toBeUndefined()
    expect(state.memberEntities['!community:mesh.test']['@left:mesh.test']).toBeUndefined()
    expect(state.memberEntities['!community:mesh.test']['@banned:mesh.test']).toBeUndefined()
    expect(state.rosterNextCursor['!community:mesh.test']).toBe('@alice:mesh.test')
    expect(state.rosterStateComplete['!community:mesh.test']).toBe(true)
  })
})
