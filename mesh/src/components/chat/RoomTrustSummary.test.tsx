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
  recheckProtection: () => {},
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

  /*
    Changed deliberately. This chip is the one place a healthy room says it is
    encrypted, and it says it once per screen: the caption pinned to the bottom
    of the timeline that used to carry the sentence is gone, and the member
    count it showed here is a click away behind Details. What is still true is
    that no service topology reaches the chrome.
  */
  it('states encryption once, in the app bar, without exposing service topology', async () => {
    const onOpenContext = vi.fn()
    await act(async () => {
      root.render(
        <RoomTrustSummary
          trust={protectedRoom}
          encryptionLabel={'Encrypted · 3 servers carry this room'}
          onOpenContext={onOpenContext}
        />,
      )
    })

    expect(container.textContent).toBe('Encrypted · 3 servers carry this room')
    expect(container.textContent).not.toContain('service')

    await act(async () => {
      container.querySelector<HTMLButtonElement>('button')?.click()
    })
    expect(onOpenContext).toHaveBeenCalledWith('ledger')
  })

  it('renders nothing while the room protection is still unknown', async () => {
    await act(async () => {
      root.render(
        <RoomTrustSummary trust={protectedRoom} encryptionLabel={null} onOpenContext={vi.fn()} />,
      )
    })

    expect(container.querySelector('button')).toBeNull()
  })

  it('keeps a privacy problem actionable without exposing service topology', async () => {
    const onOpenContext = vi.fn()
    await act(async () => {
      root.render(
        <RoomTrustSummary
          trust={{ ...protectedRoom, protection: 'unencrypted' }}
          encryptionLabel={null}
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
