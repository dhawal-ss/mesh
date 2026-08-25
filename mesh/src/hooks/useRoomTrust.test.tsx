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
        mediaE2eeReady: false,
        reason: 'Not configured',
      },
      authenticated: true,
      userId: '@alice:example.org',
      deviceId: 'DEVICE',
      homeserver: 'https://example.org',
      syncRunning: true,
      durableHistory: true,
      supportsE2ee: true,
      sessionE2eeReady: true,
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
      secureStorageState: 'saved',
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
    const devices = vi
      .spyOn(bridge, 'matrixDevices')
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

describe('useRoomTrust protection recovery', () => {
  let container: HTMLDivElement
  let root: Root

  function ProtectionProbe() {
    const trust = useRoomTrust('!room:example.org', [])
    return (
      <output data-protection={trust.protection}>
        <button type="button" onClick={() => trust.recheckProtection()}>Check again</button>
      </output>
    )
  }

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    vi.spyOn(bridge, 'isMatrixBackend').mockReturnValue(true)
    vi.spyOn(bridge, 'getBackendStatusSnapshot').mockReturnValue(null)
    vi.spyOn(bridge, 'getMatrixUserId').mockReturnValue('@alice:example.org')
    vi.spyOn(bridge, 'getBackendStatus').mockRejectedValue(new Error('offline'))
    vi.spyOn(bridge, 'matrixDevices').mockResolvedValue([])
    vi.spyOn(bridge, 'matrixRecoveryHealth').mockRejectedValue(new Error('offline'))
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('recovers the composer after a cold-start probe failure', async () => {
    /*
      The native side answers NotFound while the room is not yet in the local
      store, which is exactly what happens opening a room from an invitation or
      launching offline. That single rejection used to disable the composer for
      the lifetime of the room view, under copy claiming a check was in progress.
    */
    const probe = vi.spyOn(bridge, 'matrixRoomIsEncrypted')
      .mockRejectedValueOnce(new Error('room not found'))
      .mockResolvedValue(true)

    await act(async () => {
      root.render(<ProtectionProbe />)
    })
    await act(async () => { await Promise.resolve() })

    expect(container.querySelector('output')?.getAttribute('data-protection')).toBe('unavailable')
    expect(probe).toHaveBeenCalledTimes(1)

    await act(async () => {
      container.querySelector('button')?.click()
    })
    await act(async () => { await Promise.resolve() })

    expect(probe).toHaveBeenCalledTimes(2)
    expect(container.querySelector('output')?.getAttribute('data-protection')).toBe('protected')
  })
})
