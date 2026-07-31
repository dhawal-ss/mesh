import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CommunityPermissionProjection, MatrixPermissionStateChanged } from '../types/ipc'

const bridge = vi.hoisted(() => ({
  getCommunityPermissionProjection: vi.fn(),
  getMatrixUserId: vi.fn(() => '@me:example.org'),
  onMatrixPermissionStateChanged: vi.fn(),
}))

vi.mock('../lib/bridge', () => bridge)

import { useCommunityPermissionProjection } from './useCommunityPermissionProjection'

function Harness({
  communityId,
  sessionKey = '@me:example.org',
}: {
  communityId: string
  sessionKey?: string
}) {
  const state = useCommunityPermissionProjection({
    communityId,
    enabled: true,
    sessionKey,
  })
  return <div>{state.projection?.communityId ?? 'none'}</div>
}

describe('useCommunityPermissionProjection', () => {
  let container: HTMLDivElement
  let root: Root
  let stateHandler: ((change: MatrixPermissionStateChanged) => void) | null

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    stateHandler = null
    vi.clearAllMocks()
    bridge.getMatrixUserId.mockReturnValue('@me:example.org')
    bridge.onMatrixPermissionStateChanged.mockImplementation(async (handler) => {
      stateHandler = handler
      return () => {
        stateHandler = null
      }
    })
  })

  afterEach(async () => {
    vi.useRealTimers()
    await act(async () => {
      root.unmount()
    })
    container.remove()
  })

  it('does not let an older community request overwrite the active projection', async () => {
    let resolveOld: ((projection: CommunityPermissionProjection) => void) | null = null
    bridge.getCommunityPermissionProjection.mockImplementation(
      (communityId: string) => communityId === '!old:example.org'
        ? new Promise<CommunityPermissionProjection>((resolve) => {
            resolveOld = resolve
          })
        : Promise.resolve(projectionFor(communityId)),
    )

    await act(async () => {
      root.render(<Harness communityId="!old:example.org" />)
      await Promise.resolve()
    })
    await act(async () => {
      root.render(<Harness communityId="!new:example.org" />)
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(container.textContent).toBe('!new:example.org')

    await act(async () => {
      resolveOld?.(projectionFor('!old:example.org'))
      await Promise.resolve()
    })

    expect(container.textContent).toBe('!new:example.org')
  })

  it('debounces relevant native state changes and ignores other communities', async () => {
    vi.useFakeTimers()
    bridge.getCommunityPermissionProjection.mockImplementation(
      (communityId: string) => Promise.resolve(projectionFor(communityId)),
    )

    await act(async () => {
      root.render(<Harness communityId="!active:example.org" />)
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(bridge.getCommunityPermissionProjection).toHaveBeenCalledTimes(1)

    await act(async () => {
      stateHandler?.({ roomId: '!room:active.example.org' })
      stateHandler?.({ roomId: '!room:active.example.org' })
      await vi.advanceTimersByTimeAsync(150)
    })
    expect(bridge.getCommunityPermissionProjection).toHaveBeenCalledTimes(2)

    await act(async () => {
      stateHandler?.({ roomId: '!unrelated:example.org' })
      await vi.advanceTimersByTimeAsync(150)
    })
    expect(bridge.getCommunityPermissionProjection).toHaveBeenCalledTimes(2)
  })
})

function projectionFor(communityId: string): CommunityPermissionProjection {
  return {
    communityId,
    subjectUserId: '@me:example.org',
    discoveryComplete: true,
    discoveryFailureReason: null,
    aggregate: [],
    rooms: [{
      roomId: '!room:active.example.org',
      roomName: 'General',
      roomKind: 'room',
      status: 'matrix-default',
      policy: null,
      failureReason: null,
    }],
  }
}
