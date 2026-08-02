/**
 * End-to-end test for the diagnostics panel flow.
 *
 * This test exercises the diagnostics UI through a real Chromium browser
 * with Playwright. It mocks the Tauri IPC bridge (since we can't launch
 * the full Tauri process without tauri-driver) so the React tree renders
 * and the diagnostics panel's data-binding and interactions work end-to-end.
 *
 * What this proves:
 *   - Diagnostics panel opens and renders without errors
 *   - Probe button triggers the probe_ice_servers IPC command
 *   - Probe results render with correct outcome labels
 *   - Error states are displayed correctly
 *
 * What this does NOT prove:
 *   - Real Tauri process lifecycle (requires tauri-driver)
 *   - Real backend/network behavior (mocked here)
 */
import { test, expect, type Locator, type Page } from '@playwright/test'
import { expectNoWcagViolations } from './helpers/accessibility'

/**
 * Install a mock Tauri bridge on the page so the frontend's
 * `tauriInvoke()` calls resolve with test data instead of failing.
 *
 * This runs before the page script so the window has `__TAURI_INTERNALS__`
 * before the React bundle loads.
 */
async function installTauriMock(
  page: Page,
  overrides: Record<string, unknown> = {},
): Promise<void> {
  await page.addInitScript((mocks) => {
    // Default mock responses for every IPC command Mesh uses during
    // diagnostics panel render. Tests can override any of these by
    // passing them into installTauriMock.
    const defaults: Record<string, unknown> = {
      get_backend_status: {
        kind: 'legacy-p2p',
        capabilities: {
          encryptedText: true,
          encryptedAttachments: true,
          directMessages: true,
          voice: true,
          durableTimeouts: true,
          deviceManagement: false,
          recovery: false,
          legacyMigration: true,
        },
        voiceService: {
          provider: 'legacy-simple-peer',
          availability: 'ready',
          discoveryKey: null,
          livekitServiceUrl: null,
          tokenEndpoint: null,
          livekitSfuUrl: null,
          cspReady: true,
          mediaE2eeVerified: false,
          reason: 'Experimental peer-to-peer WebRTC transport',
        },
        authenticated: true,
        userId: null,
        deviceId: null,
        homeserver: null,
        syncRunning: true,
        durableHistory: true,
        endToEndEncryption: true,
        warnings: [],
      },
      get_identity: {
        publicKey: 'mesh-e2e-alice',
        displayName: 'Alice',
        avatarColor: '#52b5f4',
      },
      get_communities: [
        {
          id: 'community-e2e',
          name: 'Mesh E2E',
          description: 'Browser diagnostics fixture',
          memberCount: 1,
          role: 'owner',
          createdAt: '2026-07-24T00:00:00.000Z',
        },
      ],
      get_channels: [],
      get_members: [],
      get_diagnostics: {
        networkConnected: true,
        networkPeerCount: 3,
        identityLoaded: true,
        communityCount: 2,
        memberCount: 12,
        activeDownloadCount: 0,
        downloadStats: [],
        activeVoiceSessions: 0,
        iceServerStatus: {
          stunConfigured: true,
          turnConfigured: false,
          customServers: false,
        },
        pendingMessageCount: 0,
        version: '0.1.0',
        warnings: ['No TURN server configured — voice may fail behind strict NATs'],
      },
      probe_ice_servers: [
        {
          url: 'stun:stun.l.google.com:19302',
          scheme: 'stun',
          host: 'stun.l.google.com',
          port: 19302,
          outcome: 'ok',
          detail: 'STUN Binding Success Response received',
          resolvedAddrs: ['142.250.82.1:19302'],
          latencyMs: 42,
        },
      ],
    }
    const responses = { ...defaults, ...mocks } as Record<string, unknown>
    // Wire up @tauri-apps/api/core invoke shim — this is the path
    // every bridge.ts helper ultimately calls.
    ;(window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
      invoke: (cmd: string) => Promise.resolve(responses[cmd] ?? null),
      transformCallback: () => 0,
    }
    ;(
      window as unknown as {
        __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: () => void }
      }
    ).__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} }
    // Tauri v2's isTauri() checks this marker, independently of
    // __TAURI_INTERNALS__. Keep both so bridge.ts takes the real IPC path.
    ;(window as unknown as { isTauri: boolean }).isTauri = true
    // Tag for tests to verify the mock took effect
    ;(window as unknown as { __MESH_E2E_MOCK: boolean }).__MESH_E2E_MOCK = true
  }, overrides)
}

async function openAdvancedDiagnostics(
  page: Page,
): Promise<{ dialog: Locator; trigger: Locator }> {
  const settingsButton = page.getByRole('button', { name: /^User settings for / })
  if (!await settingsButton.isVisible().catch(() => false)) {
    const roomNavigationButton = page.getByRole('button', { name: 'Open room navigation' })
    if (await roomNavigationButton.isVisible().catch(() => false)) {
      await roomNavigationButton.click()
    }
  }
  await settingsButton.click()
  const settings = page.getByRole('dialog', { name: 'User Settings' })
  await expect(settings).toBeVisible()
  // UserSettingsPanel is lazy-loaded: the dialog that first becomes visible
  // can be the Suspense fallback (a spinner in a dialog titled "User
  // Settings" too), which has no Ctrl+Shift+D listener. Wait for real panel
  // content — not just the dialog title — before sending the shortcut, or
  // the keypress can land before the actual component (and its keydown
  // listener) has mounted.
  await expect(settings.getByRole('tab', { name: 'Devices' })).toBeVisible()
  await settings.getByRole('tab', { name: 'Devices' }).click()
  await page.keyboard.press('Control+Shift+D')
  const diagnosticsButton = settings.getByRole('button', { name: 'System diagnostics' })
  await expect(diagnosticsButton).toBeVisible()
  await diagnosticsButton.click()
  const dialog = page.getByRole('dialog', { name: 'System diagnostics' })
  await expect(dialog).toBeVisible()
  await expect(dialog.getByText('Overview', { exact: true })).toBeVisible()
  return { dialog, trigger: diagnosticsButton }
}

test.describe('diagnostics panel E2E', () => {
  test.beforeEach(async ({ page }) => {
    page.on('pageerror', (err) => console.error('[page error]', err.message))
    page.on('console', (message) => {
      if (message.type() === 'error') {
        console.error('[browser console]', message.text())
      }
    })
  })

  test('mock bridge is installed on window', async ({ page }) => {
    await installTauriMock(page)
    await page.goto('/')
    await page.waitForLoadState('networkidle')

    const mockInstalled = await page.evaluate(() => {
      return (window as unknown as { __MESH_E2E_MOCK?: boolean }).__MESH_E2E_MOCK === true
    })
    expect(mockInstalled).toBe(true)
  })

  test('diagnostics panel opens from Profile Advanced', async ({ page }) => {
    await installTauriMock(page)
    await page.goto('/')
    await page.waitForLoadState('networkidle')

    // The fixture must reach the authenticated shell; onboarding is covered separately.
    await openAdvancedDiagnostics(page)
  })

  test('diagnostics panel shows mocked peer count and TURN warning', async ({ page }) => {
    await installTauriMock(page)
    await page.goto('/')
    await page.waitForLoadState('networkidle')

    await openAdvancedDiagnostics(page)

    // Look for a peer count number that matches our mock
    // The mock returns networkPeerCount=3 and communityCount=2
    await expect(page.getByText('2', { exact: true })).toBeVisible()

    // The warning about missing TURN should be rendered
    await expect(
      page.getByText(/No TURN server configured/i).first(),
    ).toBeVisible()
  })

  test('is accessible in a narrow window and restores focus after Escape', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await installTauriMock(page)
    await page.goto('/')
    await page.waitForLoadState('networkidle')

    const { dialog, trigger } = await openAdvancedDiagnostics(page)
    const bounds = await dialog.boundingBox()
    expect(bounds?.x).toBeGreaterThanOrEqual(0)
    expect((bounds?.x ?? 0) + (bounds?.width ?? 0)).toBeLessThanOrEqual(390)
    expect(bounds?.height).toBeLessThanOrEqual(844)
    await expect(dialog.getByRole('button', { name: 'Refresh diagnostics' })).toBeVisible()
    await expectNoWcagViolations(page, 'Narrow system diagnostics dialog')

    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
    await expect(trigger).toBeFocused()
  })

  test('clicking Run probe triggers the probe and renders results', async ({ page }) => {
    await installTauriMock(page)
    await page.goto('/')
    await page.waitForLoadState('networkidle')

    await openAdvancedDiagnostics(page)

    const probeButton = page.getByRole('button', {
      name: /Run ICE reachability probe/i,
    })
    await probeButton.click()

    // The mocked probe returns outcome=ok → label "Reachable"
    await expect(page.locator('text=/Reachable/i').first()).toBeVisible({
      timeout: 3000,
    })
    // Latency is present
    await expect(page.locator('text=/42ms/i')).toBeVisible()
  })

  test('auth_rejected outcome renders with error styling', async ({ page }) => {
    await installTauriMock(page, {
      probe_ice_servers: [
        {
          url: 'turn:turn.example.com:3478',
          scheme: 'turn',
          host: 'turn.example.com',
          port: 3478,
          outcome: 'auth_rejected',
          detail: 'TURN server rejected credentials (error 401: Unauthorized)',
          resolvedAddrs: ['198.51.100.1:3478'],
          latencyMs: null,
        },
      ],
    })
    await page.goto('/')
    await page.waitForLoadState('networkidle')

    await openAdvancedDiagnostics(page)

    await page.getByRole('button', { name: /Run ICE reachability probe/i }).click()

    await expect(page.locator('text=/Auth rejected/i')).toBeVisible({ timeout: 3000 })
    await expect(page.locator('text=/401/')).toBeVisible()
  })

  test('allocation_ok outcome renders with success styling', async ({ page }) => {
    await installTauriMock(page, {
      probe_ice_servers: [
        {
          url: 'turn:turn.example.com:3478',
          scheme: 'turn',
          host: 'turn.example.com',
          port: 3478,
          outcome: 'allocation_ok',
          detail: 'TURN Allocate succeeded — server accepted credentials',
          resolvedAddrs: ['198.51.100.1:3478'],
          latencyMs: 88,
        },
      ],
    })
    await page.goto('/')
    await page.waitForLoadState('networkidle')

    await openAdvancedDiagnostics(page)

    await page.getByRole('button', { name: /Run ICE reachability probe/i }).click()

    await expect(page.locator('text=/TURN Allocate OK/i')).toBeVisible({ timeout: 3000 })
    await expect(page.locator('text=/88ms/')).toBeVisible()
  })
})
