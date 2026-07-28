import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { RoomTrustSnapshot } from '../../hooks/useRoomTrust'
import { DmTrustSummary } from './DmTrustSummary'

const trust: RoomTrustSnapshot = {
  matrixMode: true,
  protection: 'protected',
  communityMemberCount: 2,
  services: [
    { name: 'mesh.im', memberCount: 1 },
    { name: 'example.org', memberCount: 1 },
  ],
  devices: [],
  devicesNeedReview: 1,
  verifiedDevices: 2,
  backup: {
    recoveryState: 'enabled',
    backupState: 'enabled',
    backupExistsOnServer: true,
    backupEnabled: true,
    healthy: true,
    checkedAt: '2026-07-25T12:00:00.000Z',
    lastSuccessfulTestAt: '2026-07-25T12:00:00.000Z',
    warnings: [],
  },
  accountId: '@me:mesh.im',
  homeService: 'mesh.im',
  syncRunning: true,
  loadingAccountTrust: false,
}

describe('DmTrustSummary', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    vi.stubGlobal('ResizeObserver', class {
      observe() {}
      unobserve() {}
      disconnect() {}
    })
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    document.body.querySelectorAll('[data-radix-popper-content-wrapper]').forEach((element) => element.remove())
    container.remove()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('keeps detailed trust information behind a compact, actionable status', async () => {
    const onReviewDevices = vi.fn()
    await act(async () => {
      root.render(
        <DmTrustSummary
          trust={trust}
          peerName="Ana"
          onReviewDevices={onReviewDevices}
        />,
      )
    })

    const trigger = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Encrypted. Open conversation trust details."]',
    )
    expect(trigger?.className).toContain('min-h-8')

    await act(async () => {
      trigger?.click()
      await Promise.resolve()
    })

    expect(document.body.textContent).toContain('Who can read this conversation?')
    expect(document.body.textContent).toContain('Connected services2')
    expect(document.body.textContent).toContain('Need review1')

    const reviewButton = [...document.body.querySelectorAll('button')].find(
      (button) => button.textContent === 'Review devices and backup',
    )
    await act(async () => {
      reviewButton?.click()
    })

    expect(onReviewDevices).toHaveBeenCalledOnce()
  })
})
