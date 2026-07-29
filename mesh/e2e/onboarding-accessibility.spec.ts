import { expect, test, type Page } from '@playwright/test'
import { expectNoWcagViolations } from './helpers/accessibility'

const runtimeErrors = new WeakMap<Page, string[]>()

type OnboardingIpcCall = {
  command: string
  args: Record<string, unknown>
}

async function installUnauthenticatedMatrixMock(
  page: Page,
  currentDeepLinks: string[] | null = null,
): Promise<void> {
  await page.addInitScript((deepLinks) => {
    const calls: OnboardingIpcCall[] = []
    const callbacks = new Map<number, (...args: unknown[]) => void>()
    let nextCallbackId = 1
    let nextListenerId = 1
    let authenticated = false

    const backendStatus = () => ({
      kind: 'matrix',
      capabilities: {
        communities: true,
        durableHistory: true,
        directMessages: true,
        voice: false,
        matrixRtc: false,
        legacyMigration: true,
      },
      voiceService: {
        available: false,
        provider: 'unavailable',
        reason: 'Calling is disabled in this acceptance fixture.',
      },
      authenticated,
      userId: authenticated ? '@alice:friends.example' : null,
      deviceId: authenticated ? 'ALICE-DESKTOP' : null,
      homeserver: authenticated ? 'https://friends.example' : null,
      syncRunning: authenticated,
      durableHistory: true,
      endToEndEncryption: true,
      warnings: [],
    })

    const responseFor = (command: string, args: Record<string, unknown>): unknown => {
      switch (command) {
        case 'plugin:deep-link|get_current':
          return deepLinks
        case 'plugin:event|listen':
          return nextListenerId++
        case 'plugin:event|unlisten':
        case 'matrix_cancel_login':
          return null
        case 'get_backend_status':
          return backendStatus()
        case 'matrix_accounts':
          return [{
            profileId: 'profile-1',
            userId: '@alice:friends.example',
            homeserver: 'https://friends.example',
            deviceId: 'ALICE-DESKTOP',
            lastUsedAt: '2026-07-29T00:00:00.000Z',
            current: false,
          }]
        case 'matrix_oidc_status':
          return {
            homeserver: String(args.homeserver),
            availability: 'supported',
            issuer: 'https://auth.friends.example',
            ready: true,
            authorizationCodePkce: true,
            clientIdConfigured: true,
            redirectUri: 'http://127.0.0.1:8418/oauth/callback',
            authorizationEndpoint: 'https://auth.friends.example/authorize',
            registrationMode: 'static',
            nativeCallbackReady: true,
            reason: '',
          }
        case 'matrix_start_oidc_login':
          authenticated = true
          return null
        case 'matrix_switch_account':
          authenticated = true
          return backendStatus()
        case 'matrix_get_profile':
          return {
            userId: '@alice:friends.example',
            displayName: 'Alice',
            avatarUrl: null,
          }
        case 'matrix_list_communities':
          return []
        case 'matrix_user_preferences':
          return null
        case 'matrix_update_user_preferences':
          return {
            ...(args.preferences as Record<string, unknown>),
            updatedAt: '2026-07-29T00:00:00.000Z',
          }
        case 'matrix_resolve_community_invite':
          return {
            version: 4,
            registrationToken: 'resolved-registration-token',
            roomId: '!invited:friends.example',
            service: 'https://matrix.mesh.dhawal.org',
            via: ['friends.example'],
            expiresAt: 1_800_000_000_000,
          }
        default:
          throw new Error(`Unhandled onboarding E2E IPC command: ${command}`)
      }
    }

    ;(window as unknown as {
      __MESH_ONBOARDING_E2E__: { calls: OnboardingIpcCall[] }
      isTauri: boolean
      __TAURI_INTERNALS__: {
        invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown>
        transformCallback: (callback: (...args: unknown[]) => void) => number
        unregisterCallback: (id: number) => void
      }
      __TAURI_EVENT_PLUGIN_INTERNALS__: {
        unregisterListener: () => void
      }
    }).__MESH_ONBOARDING_E2E__ = { calls }

    ;(window as unknown as { isTauri: boolean }).isTauri = true
    ;(window as unknown as {
      __TAURI_INTERNALS__: {
        invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown>
        transformCallback: (callback: (...args: unknown[]) => void) => number
        unregisterCallback: (id: number) => void
      }
    }).__TAURI_INTERNALS__ = {
      invoke: (command, args = {}) => {
        calls.push({ command, args })
        try {
          return Promise.resolve(responseFor(command, args))
        } catch (error) {
          return Promise.reject(error)
        }
      },
      transformCallback: (callback) => {
        const id = nextCallbackId++
        callbacks.set(id, callback)
        return id
      },
      unregisterCallback: (id) => {
        callbacks.delete(id)
      },
    }
    ;(window as unknown as {
      __TAURI_EVENT_PLUGIN_INTERNALS__: {
        unregisterListener: () => void
      }
    }).__TAURI_EVENT_PLUGIN_INTERNALS__ = {
      unregisterListener: () => {},
    }
  }, currentDeepLinks)
}

function onboardingIpcCalls(page: Page): Promise<OnboardingIpcCall[]> {
  return page.evaluate(() => (
    window as unknown as { __MESH_ONBOARDING_E2E__: { calls: OnboardingIpcCall[] } }
  ).__MESH_ONBOARDING_E2E__.calls)
}

async function waitForAccountScreenMotion(page: Page): Promise<void> {
  const form = page.locator('form')
  const shell = page.locator('[data-onboarding-shell]')
  await expect(form).toBeVisible()
  await expect(shell).toHaveCSS('opacity', '1')
  await expect.poll(() => form.evaluate((element) => (
    getComputedStyle(element.parentElement ?? element).opacity
  ))).toBe('1')
}

test.beforeEach(async ({ page }) => {
  const errors: string[] = []
  runtimeErrors.set(page, errors)
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`))
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(`console: ${message.text()}`)
  })

  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Create your account' })).toBeVisible()
  await waitForAccountScreenMotion(page)
})

test.afterEach(async ({ page }) => {
  expect(runtimeErrors.get(page) ?? [], 'onboarding emitted runtime errors').toEqual([])
})

test('@a11y has no automated WCAG A/AA violations on account creation', async ({ page }) => {
  await expectNoWcagViolations(page, 'Create Account screen')
})

test('@a11y has no automated WCAG A/AA violations on sign in', async ({ page }) => {
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  const signInHeading = page.getByRole('heading', { name: 'Welcome back' })
  await expect(signInHeading).toBeVisible()
  await waitForAccountScreenMotion(page)
  await expect(signInHeading).toBeFocused()

  await expectNoWcagViolations(page, 'Sign In screen')
})

for (const viewport of [
  { width: 800, height: 500 },
  { width: 800, height: 600 },
  { width: 1100, height: 700 },
]) {
  test(`keeps every account path keyboard-reachable at ${viewport.width}x${viewport.height}`, async ({ page }) => {
    await page.setViewportSize(viewport)
    await page.reload()
    await waitForAccountScreenMotion(page)

    const assertReachable = async (name: string) => {
      const control = page.getByRole('button', { name, exact: true })
      await control.focus()
      await expect(control).toBeFocused()
      await control.scrollIntoViewIfNeeded()
      await expect(control).toBeInViewport()
    }

    await page.getByRole('textbox', { name: 'Username' }).fill('compact-user')
    await page.locator('input[name="password"]').fill('a long compact passphrase')
    await page.locator('input[name="password-confirmation"]').fill('a long compact passphrase')
    await page.getByRole('textbox', { name: 'Invitation code' }).fill(
      'abcdefghijklmnopqrstuvwxyzABCDEFG_123456789',
    )
    await expect(page.getByRole('button', { name: 'Create account' })).toBeEnabled()
    await assertReachable('Create account')
    await page.getByRole('button', { name: 'Sign in', exact: true }).click()
    await page.getByRole('textbox', { name: 'Username' }).fill('compact-user')
    await page.locator('input[name="password"]').fill('a long compact passphrase')
    await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeEnabled()
    await assertReachable('Sign in')
    await page.getByRole('button', { name: 'I have an account somewhere else' }).click()
    await expect(page.getByLabel('Service address')).toBeVisible()
    await page.getByLabel('Service address').fill('example.com')
    await page.getByRole('textbox', { name: 'Username' }).fill('compact-user')
    await page.locator('input[name="password"]').fill('a long compact passphrase')
    const browserSignIn = page.getByRole('button', { name: 'Check browser sign-in' })
    await browserSignIn.scrollIntoViewIfNeeded()
    await expect(browserSignIn).toBeInViewport()
    await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeEnabled()
    await assertReachable('Sign in')
    await expectNoWcagViolations(page, `Compact account setup ${viewport.width}x${viewport.height}`)
  })
}

test('keeps validation errors and advanced sign-in reachable at 200% zoom', async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 500 })
  await page.evaluate(() => {
    document.documentElement.style.zoom = '2'
  })

  await page.getByRole('textbox', { name: 'Username' }).fill('a')
  await page.locator('input[name="password"]').fill('short')
  await page.locator('input[name="password-confirmation"]').fill('different')
  await page.getByRole('textbox', { name: 'Invitation code' }).fill('not-valid')
  const validationError = page.getByText('Use at least 3 characters.')
  await validationError.scrollIntoViewIfNeeded()
  await expect(validationError).toBeInViewport()

  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await page.getByRole('button', { name: 'I have an account somewhere else' }).click()
  const serviceAddress = page.getByLabel('Service address')
  await serviceAddress.scrollIntoViewIfNeeded()
  await expect(serviceAddress).toBeInViewport()
  const browserSignIn = page.getByRole('button', { name: 'Check browser sign-in' })
  await browserSignIn.scrollIntoViewIfNeeded()
  await expect(browserSignIn).toBeInViewport()
  await expectNoWcagViolations(page, 'Account setup at 200% zoom')
})

test('offers saved-account switching without exposing the qualified account ID', async ({ page }) => {
  await installUnauthenticatedMatrixMock(page)
  await page.reload()
  await expect(page.getByRole('heading', { name: 'Create your account' })).toBeVisible()

  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  const savedAccount = page.getByRole('button', { name: /alice Saved account Continue/ })
  await expect(savedAccount).toBeVisible()
  await expect(page.getByText('@alice:friends.example', { exact: true })).toHaveCount(0)
  await savedAccount.click()

  await expect.poll(async () => (
    (await onboardingIpcCalls(page)).filter((call) => call.command === 'matrix_switch_account')
  )).toEqual([{
    command: 'matrix_switch_account',
    args: { profileId: 'profile-1' },
  }])
  await expect(page.getByRole('heading', { name: 'Getting things ready' })).toBeVisible()
})

test('checks and starts browser sign-in through the native account boundary', async ({ page }) => {
  await installUnauthenticatedMatrixMock(page)
  await page.reload()
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await page.getByRole('button', { name: 'I have an account somewhere else' }).click()
  await page.getByLabel('Service address').fill('friends.example')

  await page.getByRole('button', { name: 'Check browser sign-in' }).click()
  const continueInBrowser = page.getByRole('button', { name: 'Continue in browser' })
  await expect(continueInBrowser).toBeVisible()
  await continueInBrowser.click()

  await expect.poll(async () => (
    (await onboardingIpcCalls(page))
      .filter((call) => ['matrix_oidc_status', 'matrix_start_oidc_login'].includes(call.command))
  )).toEqual([
    {
      command: 'matrix_oidc_status',
      args: { homeserver: 'friends.example' },
    },
    {
      command: 'matrix_start_oidc_login',
      args: { homeserver: 'friends.example' },
    },
  ])
  await expect(page.getByRole('heading', { name: 'Getting things ready' })).toBeVisible()
})

test('prefills and resolves a cold-start invitation before account creation', async ({ page }) => {
  const invitation =
    'mesh://join?v=4&kind=managed&code=abcdefghijklmnopqrstuvwxyzABCDEFG_123456789&api=https%3A%2F%2Fmesh.example'
  await installUnauthenticatedMatrixMock(page, [invitation])
  await page.reload()

  await expect(page.getByRole('textbox', { name: 'Invitation code' })).toHaveValue(invitation)
  await expect.poll(async () => (
    (await onboardingIpcCalls(page))
      .filter((call) => call.command === 'matrix_resolve_community_invite')
  )).toEqual([{
    command: 'matrix_resolve_community_invite',
    args: { inviteUrl: invitation },
  }])
  await expect(page.getByText('This invitation is for a different Mesh service.')).toHaveCount(0)
})

test('keeps trust context and account setup usable in a narrow window', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })

  const shell = page.getByRole('region', { name: 'Set up Mesh' })
  await expect(shell).toBeVisible()
  await expect(page.getByText('Conversations that stay yours.')).toBeVisible()
  await expect(page.getByRole('list', { name: 'Setup progress' })).toBeVisible()
  await expect(page.getByRole('textbox', { name: 'Username' })).toBeVisible()

  const bounds = await shell.boundingBox()
  expect(bounds?.x).toBeGreaterThanOrEqual(0)
  expect((bounds?.x ?? 0) + (bounds?.width ?? 0)).toBeLessThanOrEqual(390)
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
  await expectNoWcagViolations(page, 'Narrow account setup')
})

test('keeps the onboarding masthead compact at tablet widths', async ({ page }) => {
  await page.setViewportSize({ width: 768, height: 1024 })
  await page.reload()

  const shell = page.locator('[data-onboarding-shell]')
  const masthead = shell.locator('aside')
  await expect(shell).toBeVisible()
  await expect(masthead).toBeVisible()

  const dimensions = await masthead.evaluate((element) => ({
    width: element.getBoundingClientRect().width,
    height: element.getBoundingClientRect().height,
  }))
  expect(dimensions.width).toBeLessThanOrEqual(768)
  expect(dimensions.height).toBeLessThan(240)
})
