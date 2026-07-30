import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as bridge from '../lib/bridge'
import { useRoomTrust } from './useRoomTrust'

function TrustProbe() {
  const trust = useRoomTrust('!room:example.org', [{ publicKey: '@alice:example.org' }])
  return <output data-review-count={trust.devicesNeedReview}>{trust.devicesNeedReview}</output>
}

describe('useRoomTrust refresh subscriptions', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    vi.spyOn(bridge, 'isMatrixBackend').mockReturnValue(true)
    vi.spyOn(bridge, 'getBackendStatusSnapshot').mockReturnValue(null)
    vi.spyOn(bridge, 'getMatrixUserId').mockReturnValue('@alice:example.org')
    vi.spyOn(bridge, 'getBackendStatus').mockResolvedValue({
      kind: 'matrix',
      capabilities: {
        encryptedText: true,
        encryptedAttachments: false,
        directMessages: true,
        voice: false,
        durableTimeouts: false,
        deviceManagement: true,
        recovery: true,
        legacyMigration: false,
      },
      voiceService: {
        provider: 'matrix-rtc',
        availability: 'not-configured',
        discoveryKey: 'org.matrix.msc4143.rtc_foci',
        livekitServiceUrl: null,
        tokenEndpoint: null,
        livekitSfuUrl: null,
        cspReady: false,
        mediaE2eeVerified: false,
        reason: 'Not configured',
      },
      authenticated: true,
      userId: '@alice:example.org',
      deviceId: 'DEVICE',
      homeserver: 'https://example.org',
      syncRunning: true,
      durableHistory: true,
      endToEndEncryption: true,
      warnings: [],
    })
    vi.spyOn(bridge, 'matrixRoomIsEncrypted').mockResolvedValue(true)
    vi.spyOn(bridge, 'matrixRecoveryHealth').mockResolvedValue({
      recoveryState: 'enabled',
      backupState: 'enabled',
      backupExistsOnServer: true,
      backupEnabled: true,
      healthy: true,
      checkedAt: '2026-07-30T00:00:00Z',
      lastSuccessfulTestAt: null,
      warnings: [],
    })
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('refreshes an open room when device trust changes', async () => {
    const devices = vi.spyOn(bridge, 'matrixDevices')
      .mockResolvedValueOnce([device(false)])
      .mockResolvedValue([device(true)])

    await act(async () => {
      root.render(<TrustProbe />)
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(container.querySelector('output')?.textContent).toBe('1')

    await act(async () => {
      window.dispatchEvent(new Event(bridge.MATRIX_TRUST_CHANGED_EVENT))
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(devices).toHaveBeenCalledTimes(2)
    expect(container.querySelector('output')?.textContent).toBe('0')
  })
})

function device(verified: boolean): bridge.MatrixDevice {
  return {
    deviceId: 'DEVICE',
    displayName: 'Mesh Desktop',
    lastSeenIp: null,
    lastSeenAt: null,
    firstSeenAt: null,
    current: true,
    verified,
    crossSigned: verified,
    newDevice: !verified,
    identityChanged: false,
  }
}
