import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import * as bridge from '../../lib/bridge'
import {
  resetNetworkStateForAccountTransition,
  useNetworkStore,
  type MatrixLinkPhase,
} from '../../store/network'
import {
  ConnectionBand,
  useDampedConnectionPhase,
  type DegradedConnectionPhase,
} from './AppLayout'

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  vi.useFakeTimers()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  resetNetworkStateForAccountTransition()
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  resetNetworkStateForAccountTransition()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

function Probe({ phase }: { phase: MatrixLinkPhase | null }) {
  return <span data-testid="phase">{useDampedConnectionPhase(phase) ?? 'none'}</span>
}

async function show(phase: MatrixLinkPhase | null) {
  await act(async () => root.render(<Probe phase={phase} />))
}

async function advance(ms: number) {
  await act(async () => {
    vi.advanceTimersByTime(ms)
  })
}

/** Drain the reconnect promise chain: read, optional restore, then the reset. */
async function settle() {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
  })
}

function banded() {
  return container.querySelector('[data-testid="phase"]')?.textContent
}

function matrixStatus(overrides: Partial<bridge.BackendStatus>): bridge.BackendStatus {
  return {
    kind: 'matrix',
    capabilities: bridge.getBackendCapabilities(),
    voiceService: bridge.getVoiceServiceStatus(),
    authenticated: true,
    userId: '@me:example.org',
    deviceId: 'DEVICE',
    homeserver: 'https://example.org',
    syncRunning: true,
    durableHistory: true,
    supportsE2ee: true,
    sessionE2eeReady: true,
    warnings: [],
    ...overrides,
  }
}

describe('shell connection band timing', () => {
  it('never shows a band for a connection blip', async () => {
    await show('reconnecting')
    await advance(1_000)
    await show('online')
    await advance(30_000)

    expect(banded()).toBe('none')
  })

  it('waits out the grace period before saying anything', async () => {
    await show('reconnecting')
    await advance(3_999)
    expect(banded()).toBe('none')

    await advance(1)
    expect(banded()).toBe('reconnecting')
  })

  /*
   * The regression this guards is a flapping connection removing and re-adding
   * a shell-level band every few seconds, which is worse than showing nothing.
   */
  it('stays put while a flapping connection recovers and dies again', async () => {
    await show('reconnecting')
    await advance(4_000)
    expect(banded()).toBe('reconnecting')

    await show('online')
    await advance(2_000)
    expect(banded()).toBe('reconnecting')

    await show('reconnecting')
    await advance(30_000)
    expect(banded()).toBe('reconnecting')
  })

  it('leaves once the connection has held', async () => {
    await show('reconnecting')
    await advance(4_000)

    await show('online')
    await advance(3_000)

    expect(banded()).toBe('none')
  })

  it('swaps advice in place instead of re-entering', async () => {
    await show('reconnecting')
    await advance(4_000)

    await show('unreachable')
    await advance(1)

    expect(banded()).toBe('unreachable')
  })

  it('says nothing for a backend that publishes no link phase', async () => {
    await show(null)
    await advance(30_000)

    expect(banded()).toBe('none')
  })
})

describe('shell connection band copy', () => {
  async function renderBand(
    phase: DegradedConnectionPhase,
    onSignInRequired: () => void = () => {},
  ) {
    await act(async () => root.render(
      <ConnectionBand phase={phase} onSignInRequired={onSignInRequired} />,
    ))
  }

  it('names the state and keeps the offline queue promise while reconnecting', async () => {
    await renderBand('reconnecting')

    expect(container.textContent).toContain('Reconnecting to your account service.')
    expect(container.textContent).toContain('saved and goes out automatically')
    expect(container.querySelector('button')?.textContent).toBe('Reconnect now')
  })

  it('explains a failed check differently from a stalled sync', async () => {
    await renderBand('unreachable')

    expect(container.textContent).toContain('Mesh could not check your connection.')
    expect(container.querySelector('button')?.textContent).toBe('Check now')
  })

  it('asks for the one thing only the person can do when the device is signed out', async () => {
    const signIn = vi.fn()
    await renderBand('signed-out', signIn)

    expect(container.textContent).toContain('This device is signed out.')
    const action = container.querySelector<HTMLButtonElement>('button')
    expect(action?.textContent).toBe('Sign in')

    await act(async () => action?.click())
    expect(signIn).toHaveBeenCalledOnce()
  })

  it('is not itself a live region', async () => {
    await renderBand('reconnecting')

    expect(container.querySelector('[role="status"]')).toBeNull()
    expect(container.querySelector('[aria-live]')).toBeNull()
  })
})

describe('shell connection band recovery action', () => {
  it('restarts the session when a fresh read confirms the sync is stalled', async () => {
    const read = vi.spyOn(bridge, 'getBackendStatus')
      .mockResolvedValue(matrixStatus({ syncRunning: false }))
    const restore = vi.spyOn(bridge, 'matrixRestoreSession')
      .mockResolvedValue(matrixStatus({ syncRunning: true }))

    await act(async () => root.render(
      <ConnectionBand phase="reconnecting" onSignInRequired={() => {}} />,
    ))
    await act(async () => container.querySelector('button')?.click())
    await settle()

    expect(read).toHaveBeenCalledOnce()
    expect(restore).toHaveBeenCalledOnce()
    expect(useNetworkStore.getState().matrixLink?.phase).toBe('online')
  })

  /*
   * The status poll backs off to five minutes after repeated failures, so an
   * immediate read is the useful half of this action. Restarting the session
   * cancels in-flight native work and must not run when nothing is wrong.
   */
  it('does not restart a session that turns out to be healthy', async () => {
    vi.spyOn(bridge, 'getBackendStatus').mockResolvedValue(matrixStatus({ syncRunning: true }))
    const restore = vi.spyOn(bridge, 'matrixRestoreSession')

    await act(async () => root.render(
      <ConnectionBand phase="unreachable" onSignInRequired={() => {}} />,
    ))
    await act(async () => container.querySelector('button')?.click())
    await settle()

    expect(restore).not.toHaveBeenCalled()
    expect(useNetworkStore.getState().matrixLink?.phase).toBe('online')
  })

  it('says so plainly when the manual attempt fails', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(bridge, 'getBackendStatus').mockRejectedValue(new Error('offline'))

    await act(async () => root.render(
      <ConnectionBand phase="reconnecting" onSignInRequired={() => {}} />,
    ))
    await act(async () => container.querySelector('button')?.click())
    await settle()

    expect(container.textContent).toContain('That did not work')
    expect(container.querySelector('button')?.disabled).toBe(false)
  })
})
