import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MatrixIgnoredUsersChanged } from '../types/ipc'

const bridge = vi.hoisted(() => ({
  getBlockedAccounts: vi.fn(),
  getDmConversations: vi.fn(),
  getDmRequests: vi.fn(),
  onMatrixIgnoredUsersChanged: vi.fn(),
}))

vi.mock('../lib/bridge', () => bridge)

import { useIgnoredUserSync } from './useIgnoredUserSync'
import { useDmStore } from '../store/dms'

function Harness() {
  useIgnoredUserSync(true)
  return null
}

describe('useIgnoredUserSync', () => {
  let container: HTMLDivElement
  let root: Root
  let handler: ((change: MatrixIgnoredUsersChanged) => void) | null
  let unlisten: ReturnType<typeof vi.fn>

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    handler = null
    unlisten = vi.fn()
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    vi.clearAllMocks()
    bridge.getDmConversations.mockResolvedValue([])
    bridge.getDmRequests.mockResolvedValue([])
    bridge.getBlockedAccounts.mockResolvedValue({ accounts: [], nextCursor: null })
    bridge.onMatrixIgnoredUsersChanged.mockImplementation(async (nextHandler) => {
      handler = nextHandler
      return unlisten
    })
    useDmStore.setState({
      conversationEntities: {},
      conversationOrder: [],
      conversations: [],
      requests: [],
      blockedAccounts: [],
      blockedAccountsNextCursor: null,
      messageEntities: {},
      messageOrder: {},
      messages: {},
      activeConversationId: null,
      isDmMode: false,
      conversationLoad: { status: 'idle', error: null, generation: 0 },
      requestLoad: { status: 'idle', error: null, generation: 0 },
      blockedAccountLoad: { status: 'idle', error: null, generation: 0 },
      messageLoads: {},
    })
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('applies targeted remote blocks and refreshes authoritative DM projections', async () => {
    bridge.getBlockedAccounts.mockResolvedValue({
      accounts: [{ userId: '@blocked:example.org' }],
      nextCursor: null,
    })
    await act(async () => {
      root.render(<Harness />)
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(handler).not.toBeNull()

    await act(async () => {
      handler?.({ blockedUserIds: ['@blocked:example.org'], resetAll: false })
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(useDmStore.getState().blockedAccounts).toEqual([
      { userId: '@blocked:example.org' },
    ])
    expect(bridge.getDmConversations).toHaveBeenCalledOnce()
    expect(bridge.getDmRequests).toHaveBeenCalledOnce()
    expect(bridge.getBlockedAccounts).toHaveBeenCalledOnce()
  })

  it('uses the reset-all fallback and detaches the native listener', async () => {
    useDmStore.setState({ activeConversationId: '!stale:example.org' })
    await act(async () => {
      root.render(<Harness />)
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(handler).not.toBeNull()
    await act(async () => {
      handler?.({ blockedUserIds: [], resetAll: true })
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(useDmStore.getState().activeConversationId).toBeNull()
    expect(useDmStore.getState().conversationLoad.generation).toBe(2)

    await act(async () => root.unmount())
    expect(unlisten).toHaveBeenCalledOnce()
    root = createRoot(container)
  })
})
