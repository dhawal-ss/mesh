import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { RoomTrustSnapshot } from '../../hooks/useRoomTrust'
import { RoomTrustSummary } from './RoomTrustSummary'

const protectedRoom: RoomTrustSnapshot = {
  matrixMode: true,
  protection: 'protected',
  communityMemberCount: 9,
  services: [
    { name: 'example.org', memberCount: 5 },
    { name: 'matrix.org', memberCount: 4 },
  ],
  devices: [],
  devicesNeedReview: 0,
  verifiedDevices: 2,
  backup: null,
  accountId: '@taylor:example.org',
  homeService: 'example.org',
  syncRunning: true,
  loadingAccountTrust: false,
}

describe('RoomTrustSummary', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    )
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    document.body
      .querySelectorAll('[data-radix-popper-content-wrapper]')
      .forEach((element) => element.remove())
    container.remove()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('keeps successful protocol assurance out of normal room chrome', async () => {
    const onOpenContext = vi.fn()
    await act(async () => {
      root.render(<RoomTrustSummary trust={protectedRoom} onOpenContext={onOpenContext} />)
    })

    expect(container.textContent).toBe('9 members')
    expect(container.textContent).not.toContain('Encrypted')
    expect(container.textContent).not.toContain('service')

    await act(async () => {
      container.querySelector<HTMLButtonElement>('button')?.click()
    })
    expect(onOpenContext).toHaveBeenCalledWith('people')
  })

  it('keeps a privacy problem actionable without exposing service topology', async () => {
    const onOpenContext = vi.fn()
    await act(async () => {
      root.render(
        <RoomTrustSummary
          trust={{ ...protectedRoom, protection: 'unencrypted' }}
          onOpenContext={onOpenContext}
        />,
      )
    })

    expect(container.textContent).toBe('Messages are not private')
    expect(container.textContent).not.toContain('service')

    await act(async () => {
      container.querySelector<HTMLButtonElement>('button')?.click()
    })
    expect(onOpenContext).toHaveBeenCalledWith('ledger')
  })
})
