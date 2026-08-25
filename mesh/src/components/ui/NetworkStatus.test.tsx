import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { resetNetworkRecoveryForTest, useNetworkStore } from '../../store/network'
import { NetworkStatus } from './NetworkStatus'

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  resetNetworkRecoveryForTest()
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  resetNetworkRecoveryForTest()
})

describe('network status', () => {
  /*
   * This indicator used to return null in Matrix mode, which is the production
   * backend. A stalled sync was written to the store on every poll and rendered
   * nowhere in the product.
   */
  it.each([
    ['online', 'Online'],
    ['reconnecting', 'Offline'],
    ['unreachable', 'Offline'],
    ['signed-out', 'Sign in'],
  ] as const)('shows the Matrix %s link as "%s"', async (phase, label) => {
    useNetworkStore.setState({ matrixLink: { phase, since: 0 } })

    await act(async () => root.render(<NetworkStatus matrixMode />))

    expect(container.textContent).toContain(label)
  })

  it('says the connection is starting before any Matrix status has landed', async () => {
    useNetworkStore.setState({ matrixLink: null })

    await act(async () => root.render(<NetworkStatus matrixMode />))

    expect(container.textContent).toContain('Starting')
  })

  it('pairs the Matrix state with a named dot rather than colour alone', async () => {
    useNetworkStore.setState({ matrixLink: { phase: 'reconnecting', since: 0 } })

    await act(async () => root.render(<NetworkStatus matrixMode />))

    const dot = container.querySelector('[role="img"]')
    expect(dot?.getAttribute('aria-label')).toContain('Reconnecting to your account service')
    expect(dot?.className).toContain('bg-status-warning')
  })

  /*
   * `.mesh-network-label` is display:none below 800px. Wearing it in Matrix
   * mode would reduce a degraded connection to a bare coloured dot on every
   * compact window, which is state carried by colour alone.
   */
  it('keeps the Matrix label out of the class that hides it on compact windows', async () => {
    useNetworkStore.setState({ matrixLink: { phase: 'unreachable', since: 0 } })

    await act(async () => root.render(<NetworkStatus matrixMode />))

    expect(container.querySelector('.mesh-network-label')).toBeNull()
  })

  /*
   * The shell band is the one polite announcement for a Matrix connection
   * change. A second live region in the rail would say the same thing twice.
   */
  it('leaves the Matrix announcement to the shell band', async () => {
    useNetworkStore.setState({ matrixLink: { phase: 'reconnecting', since: 0 } })

    await act(async () => root.render(<NetworkStatus matrixMode />))

    expect(container.querySelector('[role="status"]')).toBeNull()
  })

  it('keeps the local-network participant status available in local mode', async () => {
    useNetworkStore.setState({
      status: { state: 'connected', peerCount: 2, averageLatency: 21 },
      recoveredConnection: null,
    })

    await act(async () => root.render(<NetworkStatus matrixMode={false} />))

    expect(container.textContent).toContain('You + 2')
    expect(container.querySelector('[role="status"]')).not.toBeNull()
    expect(container.querySelector('.mesh-network-label')).not.toBeNull()
  })

  it('keeps naming solo mode in local mode', async () => {
    useNetworkStore.setState({
      status: { state: 'connected', peerCount: 0, averageLatency: 0 },
      recoveredConnection: null,
    })

    await act(async () => root.render(<NetworkStatus matrixMode={false} />))

    expect(container.textContent).toContain('Solo (you)')
  })
})
