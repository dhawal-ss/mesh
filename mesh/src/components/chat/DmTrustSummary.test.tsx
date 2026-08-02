import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { RoomTrustSnapshot } from '../../hooks/useRoomTrust'
import { Modal } from '../ui/Modal'
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
    secureStorageState: 'saved',
    warnings: [],
  },
  accountId: '@me:mesh.im',
  homeService: 'mesh.im',
  syncRunning: true,
  loadingAccountTrust: false,
}

function TrustToSecurityHarness() {
  const [securityOpen, setSecurityOpen] = useState(false)

  return (
    <>
      <DmTrustSummary trust={trust} peerName="Ana" onReviewDevices={() => setSecurityOpen(true)} />
      {securityOpen && (
        <Modal open onClose={() => setSecurityOpen(false)} title="Your devices">
          <p>Device security</p>
        </Modal>
      )}
    </>
  )
}

describe('DmTrustSummary', () => {
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

  it('keeps detailed trust information behind a compact, actionable status', async () => {
    const onReviewDevices = vi.fn()
    await act(async () => {
      root.render(<DmTrustSummary trust={trust} peerName="Ana" onReviewDevices={onReviewDevices} />)
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

  it('restores Security focus to the persistent trust-summary trigger', async () => {
    await act(async () => {
      root.render(<TrustToSecurityHarness />)
    })

    const trigger = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Encrypted. Open conversation trust details."]',
    )
    trigger?.focus()
    await act(async () => {
      trigger?.click()
      await Promise.resolve()
    })

    const reviewButton = [...document.body.querySelectorAll('button')].find(
      (button) => button.textContent === 'Review devices and backup',
    )
    reviewButton?.focus()
    await act(async () => {
      reviewButton?.click()
      await Promise.resolve()
    })

    expect(document.body.querySelectorAll('[role="dialog"]')).toHaveLength(1)
    expect(document.body.textContent).not.toContain('Who can read this conversation?')
    expect(reviewButton?.isConnected).toBe(false)

    const closeButton = document.body.querySelector<HTMLButtonElement>(
      '[role="dialog"] button[aria-label="Close dialog"]',
    )
    await act(async () => {
      closeButton?.click()
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    expect(document.body.querySelector('[role="dialog"]')).toBeNull()
    expect(document.activeElement).toBe(trigger)
    expect(document.activeElement).not.toBe(document.body)
  })
})
