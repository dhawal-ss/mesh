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
  capabilityFailure: string | null = null,
  includeSavedAccount = true,
): Promise<void> {
  await page.addInitScript(({ deepLinks, capabilityFailure, includeSavedAccount }) => {
    const calls: OnboardingIpcCall[] = []
    const callbacks = new Map<number, (...args: unknown[]) => void>()
    let nextCallbackId = 1
    let nextListenerId = 1
    let authenticated = false
    let pendingInvitationLink: string | null = deepLinks?.[0] ?? null

    const pendingInvitationMetadata = () => {
      if (!pendingInvitationLink) return null
      const parsed = new URL(pendingInvitationLink)
      return {
        handle: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
        roomOrAlias: parsed.searchParams.get('room'),
        via: parsed.searchParams.getAll('via').flatMap((value) => value.split(',')),
        service: parsed.searchParams.get('community_service')
          ?? parsed.searchParams.get('service'),
        admissionService: parsed.searchParams.get('admission'),
        communityName: 'Friends Community',
        inviterDisplayName: 'Bob',
        joinRule: 'invite',
        communityServiceDisplayName: 'Community account service',
        storedAt: 1_752_000_000_000,
        expiresAt: 1_754_592_000_000,
      }
    }

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
      supportsE2ee: true,
      sessionE2eeReady: true,
      warnings: [],
    })

    const responseFor = (command: string, args: Record<string, unknown>): unknown => {
      switch (command) {
        case 'plugin:event|listen':
          return nextListenerId++
        case 'plugin:event|unlisten':
        case 'matrix_cancel_login':
          return null
        case 'ensure_backend_started':
          return { phase: 'ready', issue: null }
        case 'get_backend_status':
          return backendStatus()
        case 'matrix_accounts':
          return includeSavedAccount ? [{
            profileId: 'profile-1',
            userId: '@alice:friends.example',
            homeserver: 'https://friends.example',
            deviceId: 'ALICE-DESKTOP',
            lastUsedAt: '2026-07-29T00:00:00.000Z',
            current: false,
          }] : []
        case 'matrix_service_capabilities':
          if (capabilityFailure && String(args.homeserver).includes(capabilityFailure)) {
            throw {
              code: 'network_unavailable',
              detail: 'connect ECONNREFUSED at 10.0.0.8:8448',
              retryable: true,
            }
          }
          return {
            homeserver: String(args.homeserver),
            serverVersions: ['v1.11'],
            passwordLogin: true,
            browserLogin: true,
            registration: 'unknown',
            maxUploadBytes: 10 * 1024 * 1024,
          }
        case 'check_username_available':
          return true
        case 'register_account':
        case 'matrix_login':
          authenticated = true
          return backendStatus()
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
        case 'matrix_reserve_login_attempt':
          return 'playwright-login-attempt'
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
          return { entities: [], blockedEntities: [] }
        case 'get_notification_account_scope':
          return { accountGeneration: 0, userId: args.expectedUserId }
        case 'set_notification_context':
          return null
        case 'matrix_queued_messages':
          return []
        case 'matrix_user_preferences':
          return null
        case 'matrix_update_user_preferences':
          return {
            ...(args.preferences as Record<string, unknown>),
            updatedAt: '2026-07-29T00:00:00.000Z',
          }
        case 'peek_pending_invitation':
          return pendingInvitationMetadata()
        case 'clear_pending_invitation':
          pendingInvitationLink = null
          return null
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
  }, { deepLinks: currentDeepLinks, capabilityFailure, includeSavedAccount })
}

function onboardingIpcCalls(page: Page): Promise<OnboardingIpcCall[]> {
  return page.evaluate(() => (
    window as unknown as { __MESH_ONBOARDING_E2E__: { calls: OnboardingIpcCall[] } }
  ).__MESH_ONBOARDING_E2E__.calls)
}

/*
  Answers the new-or-returning question so a test can reach the service list.
  This waits for the list heading rather than returning on the click: the two
  screens cross-fade, so acting on the click alone let assertions run against a
  screen that was still animating in, which failed on whichever viewport
  happened to be slowest under a parallel run.
*/
async function openServiceList(page: Page) {
  const returning = page.getByRole('button', { name: 'I already have an account' })
  if (!(await returning.count())) return
  await expect(returning).toBeVisible()
  await returning.click()
  await expect(page.getByRole('heading', { name: 'Sign in', exact: true })).toBeVisible()
  await waitForAccountScreenMotion(page)
}

async function waitForAccountScreenMotion(page: Page): Promise<void> {
  const shell = page.locator('[data-onboarding-shell]')
  await expect(shell).toBeVisible()
  await expect(shell).toHaveCSS('opacity', '1')
  await expect.poll(() => shell.evaluate((element) => (
    getComputedStyle(element).opacity
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
  await expect(page.getByRole('heading', { name: 'Welcome to Mesh' })).toBeVisible()
  await waitForAccountScreenMotion(page)
})

test.afterEach(async ({ page }) => {
  expect(runtimeErrors.get(page) ?? [], 'onboarding emitted runtime errors').toEqual([])
})

test('@a11y has no automated WCAG A/AA violations on account-service selection', async ({ page }) => {
  await expect(page.getByText('Mesh service', { exact: true })).toHaveCount(0)
  await expect(page.getByText('matrix.mesh.dhawal.org', { exact: false })).toHaveCount(0)
  await expect(page.locator('form')).toHaveCount(0)
  await expectNoWcagViolations(page, 'Account service selection')
})

test('@a11y has no automated WCAG A/AA violations on sign in', async ({ page }) => {
  await openServiceList(page)
  await page.getByRole('button', { name: 'Sign in with Matrix.org' }).click()
  const signInHeading = page.getByRole('heading', { name: 'Sign in to Matrix.org' })
  await expect(signInHeading).toBeVisible()
  await waitForAccountScreenMotion(page)
  await expect(signInHeading).toBeFocused()

  await expectNoWcagViolations(page, 'Sign In screen')
})

test('makes password and username recovery visible from sign in', async ({ page }) => {
  await openServiceList(page)
  await page.getByRole('button', { name: 'Sign in with Matrix.org' }).click()

  await page.getByRole('button', { name: 'Forgot password?' }).click()
  await expect(page.getByText('Password recovery is handled by')).toBeVisible()
  await expect(page.getByRole('link', { name: 'Open Matrix.org account help' })).toHaveAttribute(
    'href',
    'https://app.element.io/#/login',
  )

  await page.getByRole('button', { name: 'Forgot username?' }).click()
  await expect(page.getByText('Check the email or password manager')).toBeVisible()
  await expect(
    page.getByRole('link', { name: 'Open Matrix.org account help' }),
  ).toBeVisible()
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

    await openServiceList(page)
    await assertReachable('Sign in with Matrix.org')
    await assertReachable('My service is not listed')
    await openServiceList(page)
  await page.getByRole('button', { name: 'Sign in with Matrix.org' }).click()
    if (viewport.height >= 600) {
      await expect(page.locator('input[name="password"]')).toBeInViewport()
      await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeInViewport()
    }
    await page.getByRole('textbox', { name: 'Username' }).fill('compact-user')
    await page.locator('input[name="password"]').fill('a long compact passphrase')
    await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeEnabled()
    await assertReachable('Sign in')
    await page.getByRole('button', { name: 'Back', exact: true }).click()
    await openServiceList(page)
  await page.getByRole('button', { name: 'My service is not listed' }).click()
    await expect(page.getByLabel('Service address')).toBeVisible()
    await page.getByLabel('Service address').fill('example.com')
    await page.getByRole('textbox', { name: 'Username' }).fill('@compact-user:example.com')
    await page.getByRole('button', { name: 'Check service' }).click()
    await page.locator('input[name="password"]').fill('a long compact passphrase')
    const browserSignIn = page.getByRole('button', { name: 'Use browser sign-in' })
    await browserSignIn.scrollIntoViewIfNeeded()
    await expect(browserSignIn).toBeInViewport()
    await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeEnabled()
    await assertReachable('Sign in')
    await expectNoWcagViolations(page, `Compact account setup ${viewport.width}x${viewport.height}`)
  })
}

test('keeps validation errors and custom-service sign-in reachable at 200% zoom', async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 500 })
  await page.evaluate(() => {
    document.documentElement.style.zoom = '2'
  })

  await openServiceList(page)
  await page.getByRole('button', { name: 'My service is not listed' }).click()
  await page.getByLabel('Service address').fill(
    ['https', '://', 'alice', ':', 'secret', '@', 'friends.example'].join(''),
  )
  await page.getByRole('button', { name: 'Check service' }).click()
  const validationError = page.getByRole('alert')
  await validationError.scrollIntoViewIfNeeded()
  await expect(validationError).toBeInViewport()

  const providerAddress = page.getByLabel('Service address')
  await providerAddress.scrollIntoViewIfNeeded()
  await expect(providerAddress).toBeInViewport()
  await expectNoWcagViolations(page, 'Account setup at 200% zoom')
})

test('keeps a custom-service outage actionable without leading with technical details', async ({ page }) => {
  await installUnauthenticatedMatrixMock(page, null, 'offline.example')
  await page.setViewportSize({ width: 320, height: 500 })
  await page.reload()
  await waitForAccountScreenMotion(page)

  await openServiceList(page)
  await page.getByRole('button', { name: 'My service is not listed' }).click()
  await page.getByLabel('Service address').fill('offline.example')
  await page.getByRole('button', { name: 'Check service' }).click()

  const alert = page.getByRole('alert')
  await alert.scrollIntoViewIfNeeded()
  await expect(alert).toBeInViewport()
  await expect(alert.locator('p').first()).toHaveText(
    "Mesh couldn't reach that account service. Check your connection or choose another service, then try again.",
  )
  await expect(alert.locator('details')).toHaveCount(0)
  await expect(alert.locator('summary')).toHaveCount(0)
  await expect(alert).not.toContainText('ECONNREFUSED')
  await expect(page.getByRole('button', { name: 'Check service' })).toBeEnabled()
  await expect(page.getByRole('button', { name: 'Back', exact: true })).toBeVisible()
  await expectNoWcagViolations(page, 'Compact custom-service outage')
})

test('@a11y offers saved-account switching without exposing the qualified account ID', async ({ page }) => {
  await installUnauthenticatedMatrixMock(page)
  await page.reload()
  await expect(page.getByRole('heading', { name: 'Welcome to Mesh' })).toBeVisible()

  const savedAccount = page.getByRole('button', { name: /alice Saved on this device Continue/ })
  await expect(savedAccount).toBeVisible()
  await expect(page.getByText('@alice:friends.example', { exact: true })).toHaveCount(0)
  await savedAccount.click()

  await expect.poll(async () => (
    (await onboardingIpcCalls(page)).filter((call) => call.command === 'matrix_switch_account')
  )).toEqual([{
    command: 'matrix_switch_account',
    args: { profileId: 'profile-1' },
  }])
  await expect(page.getByRole('main', { name: 'Home' })).toBeVisible()
  await expectNoWcagViolations(page, 'Saved-account handoff')
})

test('@a11y continues completed setup without another tap at 1280x720', async ({ page }) => {
  const invitation =
    'mesh://join?v=5&kind=community&room=!invited%3Afriends.example&via=friends.example'
    + '&community_service=https%3A%2F%2Fcommunity.example'
  await installUnauthenticatedMatrixMock(page, [invitation])
  await page.setViewportSize({ width: 1280, height: 720 })
  await page.reload()

  await page.getByRole('button', { name: /alice Saved on this device Continue/ }).click()

  await expect(page.getByRole('heading', { name: 'Invitation to Friends Community' }))
    .toBeVisible({ timeout: 5_000 })
  await expect(page.getByRole('button', { name: 'Open Mesh' })).toHaveCount(0)
  await expectNoWcagViolations(page, 'Automatic completed setup handoff at 1280x720')
})

test('@a11y checks and starts browser sign-in through the native account boundary', async ({ page }) => {
  await installUnauthenticatedMatrixMock(page)
  await page.reload()
  await openServiceList(page)
  await page.getByRole('button', { name: 'My service is not listed' }).click()
  await page.getByLabel('Service address').fill('friends.example')

  await page.getByRole('button', { name: 'Check service' }).click()
  await page.getByRole('button', { name: 'Use browser sign-in' }).click()
  const continueInBrowser = page.getByRole('button', { name: 'Continue in browser' })
  await expect(continueInBrowser).toBeVisible()
  await continueInBrowser.click()

  await expect.poll(async () => (
    (await onboardingIpcCalls(page))
      .filter((call) => [
        'matrix_service_capabilities',
        'matrix_oidc_status',
        'matrix_start_oidc_login',
      ].includes(call.command))
  )).toEqual([
    {
      command: 'matrix_service_capabilities',
      args: expect.objectContaining({ homeserver: 'friends.example' }),
    },
    {
      command: 'matrix_oidc_status',
      args: expect.objectContaining({ homeserver: 'friends.example' }),
    },
    {
      command: 'matrix_start_oidc_login',
      args: expect.objectContaining({ homeserver: 'friends.example' }),
    },
  ])
  await expect(page.getByRole('heading', { name: 'Getting things ready' })).toBeVisible()
  await expectNoWcagViolations(page, 'Browser sign-in handoff')
})

test('@a11y prefills an opaque cold-start invitation before account creation', async ({ page }) => {
  const code = 'abcdefghijklmnopqrstuvwxyzABCDEFG_123456789'
  const invitation =
    `mesh://join?v=5&kind=community&room=!invited%3Afriends.example&via=friends.example`
    + `&community_service=https%3A%2F%2Fcommunity.example`
    + `&admission=https%3A%2F%2Fmesh.example&code=${code}`
    + `&resume=https%3A%2F%2Fmesh.example%2Finvite%2F${code}`
  await installUnauthenticatedMatrixMock(page, [invitation])
  await page.reload()

  await expect.poll(async () => (
    (await onboardingIpcCalls(page))
      .filter((call) => call.command === 'peek_pending_invitation')
      .length
  )).toBeGreaterThan(0)
  const invitationCalls = await onboardingIpcCalls(page)
  expect(invitationCalls.map((call) => call.command)).not.toEqual(expect.arrayContaining([
    'plugin:deep-link|get_current',
    'store_pending_invitation',
    'read_pending_invitation',
    'resolve_pending_invitation',
  ]))
  expect(JSON.stringify(invitationCalls)).not.toContain(invitation)
  await openServiceList(page)
  await expect(page.getByRole('button', { name: 'Sign in with Matrix.org' })).toBeVisible()
  await page.getByRole('button', { name: 'Create account with Community account service' }).click()
  const destination = page.getByRole('region', { name: 'Invitation destination' })
  await expect(destination.getByText('Friends Community', { exact: true })).toBeVisible()
  await expect(destination.getByText('Bob', { exact: true })).toBeVisible()
  await expect(destination.getByText('Invite only', { exact: true })).toBeVisible()
  await expect(page.getByRole('heading', {
    name: 'Create your account with Community account service',
  })).toBeVisible()
  await expect(page.getByText('!invited:friends.example', { exact: false })).toHaveCount(0)
  await expect(page.getByRole('textbox', { name: 'Invitation code' })).toHaveCount(0)
  await expect(page.getByText('different Mesh service')).toHaveCount(0)
  await expectNoWcagViolations(page, 'Invitation account creation')
})

test('keeps account setup usable in a narrow window', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })

  const shell = page.getByRole('region', { name: 'Set up Mesh' })
  await expect(shell).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Welcome to Mesh' })).toBeVisible()
  // Both answers fit without scrolling on the narrowest supported window.
  await expect(page.getByRole('link', { name: 'Create an account' })).toBeInViewport()
  await expect(page.getByRole('button', { name: 'I already have an account' })).toBeInViewport()

  const bounds = await shell.boundingBox()
  expect(bounds?.x).toBeGreaterThanOrEqual(0)
  expect((bounds?.x ?? 0) + (bounds?.width ?? 0)).toBeLessThanOrEqual(390)
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
  await expectNoWcagViolations(page, 'Narrow account setup')
})

test('keeps the first invitation account action above the fold in a narrow window', async ({ page }) => {
  const invitation =
    'mesh://join?v=5&kind=community&room=!invited%3Afriends.example&via=friends.example'
    + '&community_service=https%3A%2F%2Fcommunity.example'
  await installUnauthenticatedMatrixMock(page, [invitation], null, false)
  await page.setViewportSize({ width: 390, height: 844 })
  await page.reload()
  await waitForAccountScreenMotion(page)

  await expect(page.getByRole('region', { name: 'Invitation destination' })).toBeInViewport()
  await expect(page.getByRole('link', { name: 'Create an account' })).toBeInViewport()
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
  await expectNoWcagViolations(page, 'Narrow invitation account setup')
})

test('keeps invitation context and the first account action visible at the minimum window', async ({ page }) => {
  const invitation =
    'mesh://join?v=5&kind=community&room=!invited%3Afriends.example&via=friends.example'
    + '&community_service=https%3A%2F%2Fcommunity.example'
  await installUnauthenticatedMatrixMock(page, [invitation], null, false)
  await page.setViewportSize({ width: 800, height: 500 })
  await page.reload()
  await waitForAccountScreenMotion(page)

  /*
    At the minimum supported window the invitation summary and the first
    account action both stay in view. The pitch that used to be traded away
    here no longer exists, so nothing has to be hidden to make room.
  */
  await expect(page.getByRole('region', { name: 'Invitation destination' })).toBeInViewport()
  await expect(page.getByRole('link', { name: 'Create an account' })).toBeInViewport()
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(800)
  await expectNoWcagViolations(page, 'Minimum-window invitation account setup')
})

test('keeps the onboarding shell a single readable column at tablet widths', async ({ page }) => {
  await page.setViewportSize({ width: 768, height: 1024 })
  await page.reload()

  const shell = page.locator('[data-onboarding-shell]')
  await expect(shell).toBeVisible()
  // The shell used to be a two-column grid whose left column was a masthead of
  // marketing copy. There is one column now, and it stays a reading measure
  // rather than stretching to the window.
  await expect(shell.locator('aside')).toHaveCount(0)

  const dimensions = await shell.evaluate((element) => ({
    width: element.getBoundingClientRect().width,
    left: element.getBoundingClientRect().left,
  }))
  expect(dimensions.width).toBeLessThanOrEqual(560)
  expect(dimensions.left).toBeGreaterThan(0)
})
