import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SecurityDevicesPanel } from './SecurityDevicesPanel'
import { useSettingsStore } from '../../store/settings'

vi.mock('../../lib/bridge', () => ({
  isTauriRuntime: vi.fn(() => false),
  isMatrixBackend: vi.fn(() => true),
  setKv: vi.fn(() => Promise.resolve()),
  getBackendStatus: vi.fn(),
  matrixDevices: vi.fn(),
  matrixRecoveryHealth: vi.fn(() =>
    Promise.resolve({
      recoveryState: 'enabled',
      backupState: 'enabled',
      backupExistsOnServer: true,
      backupEnabled: true,
      healthy: true,
      checkedAt: '2026-07-22T20:00:00Z',
      lastSuccessfulTestAt: '2026-07-21T20:00:00Z',
      secureStorageState: 'saved',
      warnings: [],
    }),
  ),
  matrixAccounts: vi.fn(() => Promise.resolve([])),
  matrixCancelLogin: vi.fn(),
  matrixStartDeviceVerification: vi.fn(),
  matrixDeviceVerificationStatus: vi.fn(),
  matrixSelectDeviceVerificationMethod: vi.fn(),
  matrixConfirmDeviceVerification: vi.fn(),
  matrixCancelDeviceVerification: vi.fn(),
  matrixTestRecovery: vi.fn(),
  matrixTestStoredRecovery: vi.fn(),
  matrixEnableRecovery: vi.fn(),
  matrixRecover: vi.fn(),
  matrixRevokeDevice: vi.fn(),
  matrixLogout: vi.fn(),
  matrixRemoveLocalAccount: vi.fn(),
  matrixExportPersonalData: vi.fn(),
  matrixCancelPersonalDataExport: vi.fn(() => Promise.resolve()),
  matrixDeactivateAccount: vi.fn(),
}))

import {
  getBackendStatus,
  matrixDeactivateAccount,
  matrixDevices,
  matrixEnableRecovery,
  matrixExportPersonalData,
  matrixCancelPersonalDataExport,
  matrixRecoveryHealth,
  matrixRemoveLocalAccount,
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
    mediaE2eeReady: false,
    reason: 'MatrixRTC services are not configured',
  },
  authenticated: true,
  userId: '@alice:example.org',
  deviceId: 'CURRENT',
  homeserver: 'https://matrix.example.org/',
  syncRunning: true,
  durableHistory: true,
      supportsE2ee: true,
      sessionE2eeReady: true,
  warnings: [],
}

const recoveryNotConfigured = {
  recoveryState: 'disabled',
  backupState: 'disabled',
  backupExistsOnServer: false,
  backupEnabled: false,
  healthy: false,
  checkedAt: '2026-08-06T00:00:00Z',
  lastSuccessfulTestAt: null,
  secureStorageState: 'missing' as const,
  warnings: [],
}

const recoveryConfigured = {
  recoveryState: 'enabled',
  backupState: 'enabled',
  backupExistsOnServer: true,
  backupEnabled: true,
  healthy: true,
  checkedAt: '2026-07-22T20:00:00Z',
  lastSuccessfulTestAt: '2026-07-21T20:00:00Z',
  secureStorageState: 'saved' as const,
  warnings: [],
}

describe('SecurityDevicesPanel', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    window.localStorage.clear()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    vi.clearAllMocks()
    useSettingsStore.setState({
      backup: { configured: false, reminderPending: false, dismissedAt: null },
      backupAccountId: null,
      backupByAccount: {},
    })
    useSettingsStore.getState().activateBackupAccount('@alice:example.org')
    useSettingsStore.getState().setBackupConfigured(false)
    vi.mocked(matrixRecoveryHealth).mockResolvedValue(recoveryConfigured)
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
    vi.mocked(matrixEnableRecovery).mockResolvedValue({
      recoveryKey: 'MESH-ONE-TWO-THREE-FOUR',
      secureStorageState: 'saved',
      verificationState: 'verified',
    })
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  it('renders registered devices in plain-language trust states', async () => {
    await act(async () => {
      root.render(<SecurityDevicesPanel open onClose={() => {}} />)
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    expect(document.body.textContent).toContain('Mesh Desktop (this device)')
    expect(document.body.textContent).toContain('Trusted')
    expect(document.body.textContent).toContain('Old phone')
    expect(document.body.textContent).toContain('Not verified yet')
    expect(document.body.textContent).toContain(
      'shares new private-message keys only with trusted devices',
    )
    expect(document.body.textContent).toContain('Is this you?')
    expect(document.body.textContent).toContain('Your devices')
    expect(document.body.textContent).toContain('2 devices')
  })

  it('renders inline in You and handles Escape without nesting a dialog', async () => {
    const onClose = vi.fn()
    await act(async () => {
      root.render(<SecurityDevicesPanel embedded open onClose={onClose} />)
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    expect(document.body.querySelector('[role="dialog"]')).toBeNull()
    expect(document.body.textContent).toContain('Safety and devices')
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    })
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('presents a changed device as a re-check advisory, never as moderation', async () => {
    vi.mocked(matrixDevices).mockResolvedValue([
      {
        deviceId: 'CHANGED',
        displayName: 'Replacement laptop',
        lastSeenIp: null,
        lastSeenAt: '2026-07-22T20:00:00Z',
        firstSeenAt: '2026-07-22T20:00:00Z',
        current: false,
        verified: false,
        crossSigned: false,
        newDevice: false,
        identityChanged: true,
      },
    ])

    await act(async () => {
      root.render(<SecurityDevicesPanel open onClose={() => {}} />)
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    expect(document.body.textContent).toContain(
      'This sign-in changed since you trusted it. Check it again or sign it out.',
    )
    expect(document.body.textContent?.toLowerCase()).not.toContain('banned')
    expect(document.body.textContent?.toLowerCase()).not.toContain('moderation')
  })

  it('uses the compact empty state when no registered devices are returned', async () => {
    vi.mocked(matrixDevices).mockResolvedValue([])

    await act(async () => {
      root.render(<SecurityDevicesPanel open onClose={() => {}} />)
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    expect(document.body.textContent).toContain('No registered devices')
    expect(document.body.textContent).toContain('Devices linked to this account will appear here.')
    const emptyTitle = [...document.body.querySelectorAll('h3')].find(
      (heading) => heading.textContent === 'No registered devices',
    )
    expect(emptyTitle?.closest('section')?.className).toContain('py-5')
  })

  it('does not describe an offline device list as an empty account', async () => {
    vi.mocked(matrixDevices)
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce([
        {
          deviceId: 'CURRENT',
          displayName: 'Mesh Desktop',
          lastSeenIp: null,
          lastSeenAt: '2026-07-22T20:00:00Z',
          firstSeenAt: '2026-07-20T20:00:00Z',
          current: true,
          verified: true,
          crossSigned: true,
          newDevice: false,
          identityChanged: false,
        },
      ])

    await act(async () => {
      root.render(<SecurityDevicesPanel open onClose={() => {}} />)
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    expect(document.body.textContent).toContain('Connection interrupted')
    expect(document.body.textContent).toContain("Mesh couldn't load your devices")
    expect(document.body.textContent).not.toContain('No registered devices')

    await act(async () => {
      findButton(document.body, 'Retry device list').click()
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    expect(matrixDevices).toHaveBeenCalledTimes(2)
    expect(document.body.textContent).toContain('Mesh Desktop (this device)')
  })

  it('keeps an offline backup check scoped to recovery with a retry', async () => {
    vi.mocked(matrixRecoveryHealth).mockRejectedValueOnce(new Error('offline'))

    await act(async () => {
      root.render(<SecurityDevicesPanel open onClose={() => {}} />)
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    expect(document.body.textContent).toContain("Mesh couldn't check your message backup")
    expect(document.body.textContent).toContain('Retry backup check')
    expect(document.body.textContent).toContain('Mesh Desktop (this device)')

    await act(async () => {
      findButton(document.body, 'Retry backup check').click()
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    expect(matrixRecoveryHealth).toHaveBeenCalledTimes(2)
    expect(document.body.textContent).toContain('Message backup is ready')
  })

  it('guides lost-device response with an explicit accessible device choice', async () => {
    await act(async () => {
      root.render(<SecurityDevicesPanel open onClose={() => {}} />)
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    const openWorkflow = findButton(document.body, 'I lost a device')
    expect(openWorkflow.getAttribute('aria-expanded')).toBe('false')
    await act(async () => openWorkflow.click())

    expect(
      document.body.querySelector('#lost-device-workflow[aria-labelledby="lost-device-title"]'),
    ).not.toBeNull()
    expect(document.body.textContent).toContain('cannot delete messages, screenshots')
    expect(document.body.textContent).toContain('message backup is ready')
    expect(document.body.textContent).toContain('Only trust devices you still have')
    expect(document.body.textContent).toContain('cannot erase anything already saved')
    expect(document.body.querySelector('legend')?.textContent).toBe('Which device was lost?')

    const deviceChoices = [
      ...document.body.querySelectorAll<HTMLInputElement>('input[name="lost-device"]'),
    ]
    expect(deviceChoices).toHaveLength(1)
    expect(deviceChoices[0]?.value).toBe('OLDPHONE')
    const continueButton = findButton(document.body, 'Continue to sign out selected device')
    expect(continueButton.disabled).toBe(true)

    await act(async () => deviceChoices[0]?.click())
    const acknowledgement = document.body.querySelector<HTMLInputElement>('input[type="checkbox"]')
    expect(acknowledgement?.parentElement?.textContent).toContain('cannot erase anything')
    expect(continueButton.disabled).toBe(true)
    await act(async () => acknowledgement?.click())
    expect(continueButton.disabled).toBe(false)

    await act(async () => continueButton.click())
    expect(document.body.textContent).toContain('Sign out Old phone?')
    expect(document.body.textContent).toContain('Mesh does not save it')
    expect(document.body.textContent).not.toContain('account website')
    const serviceHelp = [...document.body.querySelectorAll<HTMLAnchorElement>('a')].find(
      (link) => link.textContent === 'Open example.org service site',
    )
    expect(serviceHelp?.href).toBe('https://matrix.example.org/')
    expect(
      document.body.querySelector('input[type="password"][autocomplete="current-password"]'),
    ).not.toBeNull()
  })

  it('revokes only the selected lost device after interactive authentication', async () => {
    vi.mocked(matrixRevokeDevice).mockResolvedValue(true)
    await act(async () => {
      root.render(<SecurityDevicesPanel open onClose={() => {}} />)
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
      findButton(document.body, 'I lost a device').click()
    })
    await act(async () => {
      document.body
        .querySelector<HTMLInputElement>('input[name="lost-device"][value="OLDPHONE"]')
        ?.click()
    })
    await act(async () => {
      document.body.querySelector<HTMLInputElement>('input[type="checkbox"]')?.click()
    })
    await act(async () => {
      findButton(document.body, 'Continue to sign out selected device').click()
    })

    const password = document.body.querySelector<HTMLInputElement>(
      'input[type="password"][autocomplete="current-password"]',
    )!
    expect(password.getAttribute('aria-describedby')).toBe('revoke-device-description')
    await act(async () => setInputValue(password, 'one-use-password'))
    await act(async () => {
      findButton(document.body, 'Sign out device').click()
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    expect(matrixRevokeDevice).toHaveBeenCalledWith('OLDPHONE', 'one-use-password')
    expect(document.body.textContent).not.toContain('one-use-password')
    expect(document.body.textContent).not.toContain('Sign out Old phone?')
  })

  it('requires a typed phrase and acknowledgement before local account erasure', async () => {
    vi.mocked(matrixRemoveLocalAccount).mockRejectedValue(new Error('offline'))
    await act(async () => {
      root.render(<SecurityDevicesPanel open onClose={() => {}} />)
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    const removeButton = Array.from(document.body.querySelectorAll('button')).find(
      (button) => button.textContent === 'Remove account and local data',
    )
    expect(removeButton).toBeDefined()
    act(() => removeButton?.click())

    expect(document.body.textContent).toContain('This cannot be undone')
    expect(document.body.textContent).toContain("only this account's Mesh data")
    expect(document.body.textContent).toContain('Neither action deletes the account at its service')
    expect(document.body.textContent).toContain('history already shared')
    const confirmButton = findButton(document.body, 'Permanently remove local account')
    // Local data deletion now uses the same explicit danger confirmation bar as remote deletion.
    expect(confirmButton.disabled).toBe(true)
    expect(confirmButton.className).toContain('bg-status-danger')

    const phrase = inputForLabel(document.body, 'Type "REMOVE LOCAL DATA" to confirm')
    expect(phrase.getAttribute('aria-describedby')).toBe('local-removal-description')
    expect(phrase.getAttribute('aria-invalid')).not.toBe('true')
    const acknowledgement = [...document.body.querySelectorAll<HTMLLabelElement>('label')]
      .find((label) => label.textContent?.includes('permanently deletes this account'))
      ?.querySelector<HTMLInputElement>('input[type="checkbox"]')
    expect(acknowledgement).not.toBeNull()

    await act(async () => setInputValue(phrase, 'wrong phrase'))
    expect(phrase.getAttribute('aria-invalid')).toBe('true')
    await act(async () => setInputValue(phrase, 'REMOVE LOCAL DATA'))
    expect(phrase.getAttribute('aria-invalid')).not.toBe('true')
    expect(confirmButton.disabled).toBe(true)
    await act(async () => acknowledgement?.click())
    expect(confirmButton.disabled).toBe(false)
    await act(async () => {
      confirmButton.click()
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(matrixRemoveLocalAccount).toHaveBeenCalledOnce()
    expect(document.body.textContent).toContain('Connection interrupted')
  })

  it('exports authored messages and explains the privacy boundary', async () => {
    vi.mocked(matrixExportPersonalData).mockResolvedValue({
      path: 'C:\\Users\\Alice\\Documents\\Mesh personal data 2026-07-29',
      exportedAt: '2026-07-29T12:00:00Z',
      roomCount: 2,
      messageCount: 14,
      mediaFileCount: 3,
      warnings: ['1 attachment had no downloaded local copy.'],
    })
    await act(async () => {
      root.render(<SecurityDevicesPanel open onClose={() => {}} />)
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    await act(async () => {
      findButton(document.body, 'Export my data').click()
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    expect(matrixExportPersonalData).toHaveBeenCalledOnce()
    expect(document.body.textContent).toContain('Your export is ready')
    expect(document.body.textContent).toContain('14 messages across 2 conversations')
    expect(document.body.textContent).toContain('other people')
    expect(document.body.textContent).toContain('readable conversation content')
  })

  it('cancels an in-progress personal-data export without showing an error', async () => {
    let rejectExport!: (reason: unknown) => void
    vi.mocked(matrixExportPersonalData).mockImplementation(() => new Promise((_, reject) => {
      rejectExport = reject
    }))
    vi.mocked(matrixCancelPersonalDataExport).mockImplementation(async () => {
      rejectExport({ code: 'cancelled', detail: 'export cancelled', retryable: false })
    })
    await act(async () => {
      root.render(<SecurityDevicesPanel open onClose={() => {}} />)
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    act(() => findButton(document.body, 'Export my data').click())
    await act(async () => Promise.resolve())
    await act(async () => {
      findButton(document.body, 'Cancel export').click()
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    expect(matrixCancelPersonalDataExport).toHaveBeenCalledOnce()
    expect(document.body.textContent).not.toContain('Action cancelled')
    expect(findButton(document.body, 'Export my data').disabled).toBe(false)
  })

  it('keeps the export label truthful during an unrelated operation', async () => {
    vi.mocked(matrixRecoveryHealth).mockResolvedValueOnce(recoveryNotConfigured)
    vi.mocked(matrixEnableRecovery).mockImplementation(() => new Promise(() => {}))
    await act(async () => {
      root.render(<SecurityDevicesPanel open onClose={() => {}} />)
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    await act(async () => {
      findButton(document.body, 'Create backup code').click()
      await Promise.resolve()
    })

    const exportButton = findButton(document.body, 'Export my data')
    expect(exportButton.disabled).toBe(true)
    expect(document.body.textContent).not.toContain('Working…')
  })

  it('shows whether a newly created backup code was protected and verified', async () => {
    vi.mocked(matrixRecoveryHealth).mockResolvedValueOnce(recoveryNotConfigured)
    await act(async () => {
      root.render(<SecurityDevicesPanel open onClose={() => {}} />)
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    await act(async () => {
      findButton(document.body, 'Create backup code').click()
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    expect(document.body.textContent).toContain('MESH-ONE-TWO-THREE-FOUR')
    expect(document.body.textContent).toContain('protected credential store')
    expect(document.body.textContent).toContain('verified the code against your encrypted message backup')
    expect(document.body.querySelector('output[aria-label="Backup code"]')?.textContent)
      .toBe('MESH-ONE-TWO-THREE-FOUR')
    for (const liveRegion of document.body.querySelectorAll('[role="status"], [role="alert"], [aria-live]')) {
      expect(liveRegion.textContent).not.toContain('MESH-ONE-TWO-THREE-FOUR')
    }
    expect(document.body.textContent).not.toContain('Restore messages')
    expect(document.body.textContent).not.toContain('Test saved copy')
    expect(document.body.textContent).not.toContain('Check backup code')
  })

  it('removes the one-time code only after the saved copy passes its challenge', async () => {
    vi.mocked(matrixRecoveryHealth).mockResolvedValueOnce(recoveryNotConfigured)
    await act(async () => {
      root.render(<SecurityDevicesPanel open onClose={() => {}} />)
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    await act(async () => {
      findButton(document.body, 'Create backup code').click()
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    act(() => findButton(document.body, 'I saved it').click())
    act(() => findButton(document.body, 'Continue').click())
    expect(document.body.querySelector('output[aria-label="Backup code"]')).not.toBeNull()

    const parts = ['ONE', 'TWO', 'THREE', 'FOUR']
    for (const label of document.body.querySelectorAll<HTMLLabelElement>('label')) {
      const match = label.textContent?.match(/^Part (\d+)/)
      if (!match) continue
      const input = label.querySelector<HTMLInputElement>('input')
      if (input) act(() => setInputValue(input, parts[Number(match[1]) - 1] ?? ''))
    }
    act(() => findButton(document.body, 'Continue').click())

    expect(document.body.querySelector('output[aria-label="Backup code"]')).toBeNull()
    expect(useSettingsStore.getState().backup.configured).toBe(true)
    expect(document.body.textContent).not.toContain('Create backup code')
  })

  it('keeps attention scheduled when code confirmation lacks strict healthy evidence', async () => {
    vi.mocked(matrixRecoveryHealth)
      .mockResolvedValueOnce(recoveryNotConfigured)
      .mockResolvedValueOnce({
        ...recoveryNotConfigured,
        recoveryState: 'enabled',
        backupState: 'enabled',
        backupEnabled: true,
        backupExistsOnServer: true,
        warnings: ['Recovery credentials have not been tested on this device'],
      })
    await act(async () => {
      root.render(<SecurityDevicesPanel open onClose={() => {}} />)
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    await act(async () => {
      findButton(document.body, 'Create backup code').click()
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    act(() => findButton(document.body, 'I saved it').click())
    const parts = ['ONE', 'TWO', 'THREE', 'FOUR']
    for (const label of document.body.querySelectorAll<HTMLLabelElement>('label')) {
      const match = label.textContent?.match(/^Part (\d+)/)
      if (!match) continue
      const input = label.querySelector<HTMLInputElement>('input')
      if (input) act(() => setInputValue(input, parts[Number(match[1]) - 1] ?? ''))
    }
    act(() => findButton(document.body, 'Continue').click())

    expect(document.body.querySelector('output[aria-label="Backup code"]')).toBeNull()
    expect(useSettingsStore.getState().backup).toMatchObject({
      configured: false,
      reminderPending: true,
    })
    expect(document.body.textContent).toContain(
      'Mesh has not confirmed that message backup is ready',
    )
    expect(document.body.textContent).toContain('Check again or Test saved copy')
  })

  it('clears a deferred one-time code and schedules the backup reminder', async () => {
    vi.mocked(matrixRecoveryHealth).mockResolvedValueOnce(recoveryNotConfigured)
    await act(async () => {
      root.render(<SecurityDevicesPanel open onClose={() => {}} />)
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    await act(async () => {
      findButton(document.body, 'Create backup code').click()
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    act(() => findButton(document.body, 'Remind me later').click())

    expect(document.body.querySelector('output[aria-label="Backup code"]')).toBeNull()
    expect(useSettingsStore.getState().backup).toMatchObject({
      configured: false,
      reminderPending: true,
    })
  })

  it('clears an unsaved one-time code when the panel closes', async () => {
    const onClose = vi.fn()
    vi.mocked(matrixRecoveryHealth).mockResolvedValueOnce(recoveryNotConfigured)
    await act(async () => {
      root.render(<SecurityDevicesPanel open onClose={onClose} />)
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    await act(async () => {
      findButton(document.body, 'Create backup code').click()
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    act(() => document.body.querySelector<HTMLButtonElement>('button[aria-label="Close dialog"]')?.click())

    expect(onClose).toHaveBeenCalledOnce()
    expect(document.body.querySelector('output[aria-label="Backup code"]')).toBeNull()
    expect(useSettingsStore.getState().backup.reminderPending).toBe(true)
  })

  it('does not offer ambiguous backup-code regeneration for a configured account', async () => {
    await act(async () => {
      root.render(<SecurityDevicesPanel open onClose={() => {}} />)
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    expect(document.body.textContent).toContain('Message backup is ready')
    expect(document.body.textContent).not.toContain('Create backup code')
    expect(document.body.textContent).not.toContain('Show current code')
  })

  it('requires a password, typed phrase, and acknowledgement before remote account deletion', async () => {
    vi.mocked(matrixDeactivateAccount).mockResolvedValue(true)
    await act(async () => {
      root.render(<SecurityDevicesPanel open onClose={() => {}} />)
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    await act(async () => findButton(document.body, 'Start account deletion').click())

    const deleteButton = findButton(document.body, 'Permanently delete my account')
    expect(deleteButton.disabled).toBe(true)
    expect(document.body.textContent).toContain('Messages already shared may remain')
    expect(document.body.textContent).not.toContain('account website')
    expect(document.body.textContent).toContain('Open example.org service site')

    const password = inputForLabel(document.body, 'Account password')
    const phrase = inputForLabel(document.body, 'Type "DELETE MY ACCOUNT" to confirm')
    const acknowledgement = [...document.body.querySelectorAll<HTMLLabelElement>('label')]
      .find((label) => label.textContent?.includes('I understand that shared copies may remain'))
      ?.querySelector<HTMLInputElement>('input[type="checkbox"]')
    expect(acknowledgement).not.toBeNull()

    await act(async () => setInputValue(password, 'one-use-password'))
    await act(async () => setInputValue(phrase, 'DELETE MY ACCOUNT'))
    expect(deleteButton.disabled).toBe(true)
    await act(async () => acknowledgement?.click())
    expect(deleteButton.disabled).toBe(false)

    await act(async () => {
      deleteButton.click()
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(matrixDeactivateAccount).toHaveBeenCalledWith('one-use-password')
    expect(document.body.textContent).not.toContain('one-use-password')
  })

  it('exposes an explicit accessible close control', async () => {
    const onClose = vi.fn()
    await act(async () => {
      root.render(<SecurityDevicesPanel open onClose={onClose} />)
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    const closeButton = document.body.querySelector<HTMLButtonElement>(
      'button[aria-label="Close dialog"]',
    )
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

    const verifyButton = Array.from(document.body.querySelectorAll('button')).find(
      (button) => button.textContent === 'Check device',
    )
    await act(async () => {
      verifyButton?.click()
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(document.body.textContent).toContain('Compare emoji')
    expect(document.body.textContent).toContain('Scan with other device')

    const qrButton = Array.from(document.body.querySelectorAll('button')).find(
      (button) => button.textContent === 'Scan with other device',
    )
    await act(async () => {
      qrButton?.click()
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    expect(matrixSelectDeviceVerificationMethod).toHaveBeenCalledWith('verification-1', 'qr')
    expect(
      document.body.querySelector('img[alt="Code to scan with your other device"]'),
    ).not.toBeNull()
  })

  it('keeps protocol and cryptography jargon out of the rendered device workflow', async () => {
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
    await act(async () => {
      root.render(<SecurityDevicesPanel open onClose={() => {}} />)
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
      findButton(document.body, 'Check device').click()
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    const visibleCopy = document.body.textContent?.toLowerCase() ?? ''
    for (const banned of [
      'matrix',
      'homeserver',
      'cross-signed',
      'cross-signing',
      'verification',
      'revoke',
      'revocation',
      'recovery key',
      'secret storage',
      'ssss',
      'sas',
    ]) {
      expect(visibleCopy).not.toContain(banned)
    }
  })
})

function findButton(container: HTMLElement, label: string): HTMLButtonElement {
  const button = [...container.querySelectorAll<HTMLButtonElement>('button')].find((candidate) =>
    candidate.textContent?.includes(label),
  )
  if (!button) throw new Error(`Button not found: ${label}`)
  return button
}

function inputForLabel(container: HTMLElement, labelText: string): HTMLInputElement {
  const label = [...container.querySelectorAll<HTMLLabelElement>('label')].find(
    (candidate) => candidate.textContent === labelText,
  )
  const id = label?.htmlFor
  const input = id ? (container.ownerDocument.getElementById(id) as HTMLInputElement | null) : null
  if (!input) throw new Error(`Input not found: ${labelText}`)
  return input
}

function setInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  setter?.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}
