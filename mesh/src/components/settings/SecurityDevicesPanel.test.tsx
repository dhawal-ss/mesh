import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SecurityDevicesPanel } from './SecurityDevicesPanel'

vi.mock('../../lib/bridge', () => ({
  isTauriRuntime: vi.fn(() => false),
  getBackendStatus: vi.fn(),
  matrixDevices: vi.fn(),
  matrixRecoveryHealth: vi.fn(() => Promise.resolve({
    recoveryState: 'enabled',
    backupState: 'enabled',
    backupExistsOnServer: true,
    backupEnabled: true,
    healthy: true,
    checkedAt: '2026-07-22T20:00:00Z',
    lastSuccessfulTestAt: '2026-07-21T20:00:00Z',
    warnings: [],
  })),
  matrixAccounts: vi.fn(() => Promise.resolve([])),
  matrixCancelLogin: vi.fn(),
  matrixStartDeviceVerification: vi.fn(),
  matrixDeviceVerificationStatus: vi.fn(),
  matrixSelectDeviceVerificationMethod: vi.fn(),
  matrixConfirmDeviceVerification: vi.fn(),
  matrixCancelDeviceVerification: vi.fn(),
  matrixTestRecovery: vi.fn(),
  matrixEnableRecovery: vi.fn(),
  matrixRecover: vi.fn(),
  matrixRevokeDevice: vi.fn(),
  matrixLogout: vi.fn(),
  matrixRemoveLocalAccount: vi.fn(),
}))

import {
  getBackendStatus,
  matrixDevices,
  matrixRevokeDevice,
  matrixSelectDeviceVerificationMethod,
  matrixStartDeviceVerification,
  type BackendStatus,
} from '../../lib/bridge'

const status: BackendStatus = {
  kind: 'matrix',
  capabilities: {
    encryptedText: true,
    encryptedAttachments: false,
    directMessages: false,
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
    reason: 'MatrixRTC services are not configured',
  },
  authenticated: true,
  userId: '@alice:example.org',
  deviceId: 'CURRENT',
  homeserver: 'https://matrix.example.org/',
  syncRunning: true,
  durableHistory: true,
  endToEndEncryption: true,
  warnings: [],
}

describe('SecurityDevicesPanel', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    vi.clearAllMocks()
    vi.mocked(getBackendStatus).mockResolvedValue(status)
    vi.mocked(matrixDevices).mockResolvedValue([
      {
        deviceId: 'CURRENT',
        displayName: 'Mesh Desktop',
        lastSeenIp: '203.0.113.7',
        lastSeenAt: '2026-07-22T20:00:00Z',
        firstSeenAt: '2026-07-20T20:00:00Z',
        current: true,
        verified: true,
        crossSigned: true,
        newDevice: false,
        identityChanged: false,
      },
      {
        deviceId: 'OLDPHONE',
        displayName: 'Old phone',
        lastSeenIp: null,
        lastSeenAt: null,
        firstSeenAt: '2026-07-22T20:00:00Z',
        current: false,
        verified: false,
        crossSigned: false,
        newDevice: true,
        identityChanged: false,
      },
    ])
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  it('renders registered devices and their real trust states', async () => {
    await act(async () => {
      root.render(<SecurityDevicesPanel open onClose={() => {}} />)
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    expect(container.textContent).toContain('Mesh Desktop (this device)')
    expect(container.textContent).toContain('Cross-signed')
    expect(container.textContent).toContain('Old phone')
    expect(container.textContent).toContain('New device')
    expect(container.textContent).toContain('Review 1 untrusted device warning')
    expect(container.textContent).toContain('2 devices')
  })

  it('guides lost-device response with an explicit accessible device choice', async () => {
    await act(async () => {
      root.render(<SecurityDevicesPanel open onClose={() => {}} />)
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    const openWorkflow = findButton(container, 'I lost a device')
    expect(openWorkflow.getAttribute('aria-expanded')).toBe('false')
    await act(async () => openWorkflow.click())

    expect(container.querySelector('#lost-device-workflow[aria-labelledby="lost-device-title"]')).not.toBeNull()
    expect(container.textContent).toContain('cannot remotely erase messages, keys, screenshots')
    expect(container.textContent).toContain('login alone does not restore keys')
    expect(container.textContent).toContain('Verify only devices you still possess')
    expect(container.textContent).toContain('not proof that the lost device was erased')
    expect(container.querySelector('legend')?.textContent).toBe('Which device was lost?')

    const deviceChoices = [...container.querySelectorAll<HTMLInputElement>('input[name="lost-device"]')]
    expect(deviceChoices).toHaveLength(1)
    expect(deviceChoices[0]?.value).toBe('OLDPHONE')
    const continueButton = findButton(container, 'Continue to revoke selected device')
    expect(continueButton.disabled).toBe(true)

    await act(async () => deviceChoices[0]?.click())
    const acknowledgement = container.querySelector<HTMLInputElement>('input[type="checkbox"]')
    expect(acknowledgement?.parentElement?.textContent).toContain('does not remotely wipe the lost device')
    expect(continueButton.disabled).toBe(true)
    await act(async () => acknowledgement?.click())
    expect(continueButton.disabled).toBe(false)

    await act(async () => continueButton.click())
    expect(container.textContent).toContain('Revoke Old phone?')
    expect(container.textContent).toContain('Mesh does not save it')
    expect(container.textContent).toContain('browser-authenticated provider')
    expect(container.querySelector('input[type="password"][autocomplete="current-password"]')).not.toBeNull()
  })

  it('revokes only the selected lost device after interactive authentication', async () => {
    vi.mocked(matrixRevokeDevice).mockResolvedValue()
    await act(async () => {
      root.render(<SecurityDevicesPanel open onClose={() => {}} />)
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
      findButton(container, 'I lost a device').click()
    })
    await act(async () => {
      container.querySelector<HTMLInputElement>('input[name="lost-device"][value="OLDPHONE"]')?.click()
    })
    await act(async () => {
      container.querySelector<HTMLInputElement>('input[type="checkbox"]')?.click()
    })
    await act(async () => {
      findButton(container, 'Continue to revoke selected device').click()
    })

    const password = container.querySelector<HTMLInputElement>('input[type="password"][autocomplete="current-password"]')!
    await act(async () => setInputValue(password, 'one-use-password'))
    await act(async () => {
      findButton(container, 'Revoke device').click()
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    expect(matrixRevokeDevice).toHaveBeenCalledWith('OLDPHONE', 'one-use-password')
    expect(container.textContent).not.toContain('one-use-password')
    expect(container.textContent).not.toContain('Revoke Old phone?')
  })

  it('requires a second confirmation before local account erasure', async () => {
    await act(async () => {
      root.render(<SecurityDevicesPanel open onClose={() => {}} />)
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    const removeButton = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Remove account and local data',
    )
    expect(removeButton).toBeDefined()
    act(() => removeButton?.click())

    expect(container.textContent).toContain('This cannot be undone')
    expect(container.textContent).toContain('Permanently remove local account')
  })

  it('exposes an explicit accessible close control', async () => {
    const onClose = vi.fn()
    await act(async () => {
      root.render(<SecurityDevicesPanel open onClose={onClose} />)
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    const closeButton = container.querySelector<HTMLButtonElement>('button[aria-label="Close dialog"]')
    expect(closeButton).not.toBeNull()
    act(() => closeButton?.click())
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('offers QR or emoji after the other device accepts verification', async () => {
    vi.mocked(matrixStartDeviceVerification).mockResolvedValue({
      verificationId: 'verification-1',
      deviceId: 'OLDPHONE',
      phase: 'choose-method',
      method: null,
      emojis: [],
      decimals: null,
      qrSvg: null,
      cancellationReason: null,
    })
    vi.mocked(matrixSelectDeviceVerificationMethod).mockResolvedValue({
      verificationId: 'verification-1',
      deviceId: 'OLDPHONE',
      phase: 'qr-show',
      method: 'qr',
      emojis: [],
      decimals: null,
      qrSvg: '<svg viewBox="0 0 10 10"></svg>',
      cancellationReason: null,
    })

    await act(async () => {
      root.render(<SecurityDevicesPanel open onClose={() => {}} />)
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    const verifyButton = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Verify',
    )
    await act(async () => {
      verifyButton?.click()
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(container.textContent).toContain('Compare emoji')
    expect(container.textContent).toContain('Show QR code')

    const qrButton = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Show QR code',
    )
    await act(async () => {
      qrButton?.click()
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    expect(matrixSelectDeviceVerificationMethod).toHaveBeenCalledWith('verification-1', 'qr')
    expect(container.querySelector('img[alt="Matrix device verification QR code"]')).not.toBeNull()
  })
})

function findButton(container: HTMLElement, label: string): HTMLButtonElement {
  const button = [...container.querySelectorAll<HTMLButtonElement>('button')]
    .find((candidate) => candidate.textContent?.includes(label))
  if (!button) throw new Error(`Button not found: ${label}`)
  return button
}

function setInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  setter?.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}
