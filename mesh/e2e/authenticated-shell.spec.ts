import { expect, test, type Page } from '@playwright/test'
import { expectNoWcagViolations } from './helpers/accessibility'

type IpcCall = {
  command: string
  args: Record<string, unknown>
}

const runtimeErrors = new WeakMap<Page, string[]>()

test.beforeEach(async ({ page }) => {
  const errors: string[] = []
  runtimeErrors.set(page, errors)
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`))
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(`console: ${message.text()}`)
  })
})

test.afterEach(async ({ page }) => {
  expect(runtimeErrors.get(page) ?? [], 'authenticated shell emitted runtime errors').toEqual([])
})

async function installAuthenticatedMatrixMock(
  page: Page,
  currentDeepLinks: string[] | null = null,
): Promise<void> {
  await page.addInitScript((deepLinks) => {
    const calls: IpcCall[] = []
    const callbacks = new Map<number, (...args: unknown[]) => void>()
    let nextCallbackId = 1
    let nextListenerId = 1
    let invitationJoined = false

    const community = {
      id: '!mesh-e2e:mesh.test',
      name: 'Mesh Test Community',
      description: 'Authenticated browser fixture',
      memberCount: 2,
      role: 'owner',
      joinedAt: '2026-07-24T00:00:00.000Z',
    }
    const secondCommunity = {
      id: '!mesh-e2e-two:mesh.test',
      name: 'Second Test Community',
      description: 'Inactive unread fixture',
      memberCount: 3,
      role: 'member',
      joinedAt: '2026-07-24T00:00:00.000Z',
    }
    const invitedCommunity = {
      id: '!invited:mesh.test',
      name: 'Invited Mesh Community',
      description: 'Joined from the cold-start invitation',
      memberCount: 4,
      role: 'member',
      joinedAt: '2026-07-29T00:00:00.000Z',
    }
    const channels = [
      {
        id: '!general:mesh.test',
        communityId: community.id,
        name: 'general',
        channelType: 'text',
        unreadCount: 0,
      },
      {
        id: '!random:mesh.test',
        communityId: community.id,
        name: 'random',
        channelType: 'text',
        unreadCount: 1,
      },
      {
        id: '!lounge:mesh.test',
        communityId: community.id,
        name: 'Lounge',
        channelType: 'voice',
        unreadCount: 0,
      },
    ]
    const secondCommunityChannels = [
      {
        id: '!updates:mesh.test',
        communityId: secondCommunity.id,
        name: 'updates',
        channelType: 'text',
        unreadCount: 3,
      },
    ]
    const matrixProfile = {
      userId: '@alice:mesh.test',
      displayName: 'Alice Mesh',
      avatarUrl: null,
    }
    const timeline = [
      {
        id: '$welcome',
        channelId: channels[0].id,
        authorPublicKey: '@bob:mesh.test',
        authorDisplayName: 'Bob',
        authorAvatarColor: '#3ba55c',
        content: 'Welcome to the encrypted Mesh test room.',
        attachments: [],
        reactions: {},
        timestamp: '2026-07-24T00:00:00.000Z',
        signature: '',
        replyToId: null,
        deliveryStatus: 'sent',
      },
    ]

    const responseFor = (
      command: string,
      args: Record<string, unknown>,
    ): unknown | Promise<unknown> => {
      switch (command) {
        case 'set_notification_context':
        case 'matrix_set_room_notification_mode':
        case 'send_test_notification':
          return null
        case 'matrix_get_room_notification_mode':
          return 'all'
        case 'matrix_rtc_members':
          return args.roomId === '!lounge:mesh.test'
            ? [
                {
                  roomId: '!lounge:mesh.test',
                  userId: '@bob:mesh.test',
                  deviceId: 'BOB-E2E',
                  sessionId: 'bob-session',
                  displayName: 'Bob',
                  avatarUrl: null,
                },
              ]
            : []
        case 'get_backend_status':
          return {
            kind: 'matrix',
            capabilities: {
              encryptedText: true,
              encryptedAttachments: true,
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
              reason: 'MatrixRTC services are not configured',
            },
            authenticated: true,
            userId: '@alice:mesh.test',
            deviceId: 'ALICE-E2E',
            homeserver: 'https://mesh.test',
            syncRunning: true,
            durableHistory: true,
            endToEndEncryption: true,
            warnings: [],
          }
        case 'matrix_list_communities':
          return invitationJoined
            ? [community, secondCommunity, invitedCommunity]
            : [community, secondCommunity]
        case 'matrix_join_community':
          if (
            args.roomOrAlias !== invitedCommunity.id
            || !Array.isArray(args.via)
            || args.via.length !== 1
            || args.via[0] !== 'mesh.test'
          ) {
            throw new Error('Cold-start invitation was not forwarded to Matrix correctly')
          }
          invitationJoined = true
          return invitedCommunity
        case 'matrix_room_is_encrypted':
          return true
        case 'matrix_devices':
          return [
            {
              deviceId: 'ALICE-E2E',
              displayName: 'Mesh Desktop',
              lastSeenIp: null,
              lastSeenAt: '2026-07-24T00:00:00.000Z',
              firstSeenAt: '2026-07-20T00:00:00.000Z',
              current: true,
              verified: true,
              crossSigned: true,
              newDevice: false,
              identityChanged: false,
            },
            {
              deviceId: 'ALICE-NEW',
              displayName: 'New phone',
              lastSeenIp: null,
              lastSeenAt: '2026-07-24T00:00:00.000Z',
              firstSeenAt: '2026-07-24T00:00:00.000Z',
              current: false,
              verified: false,
              crossSigned: false,
              newDevice: true,
              identityChanged: false,
            },
          ]
        case 'matrix_recovery_health':
          return {
            recoveryState: 'enabled',
            backupState: 'enabled',
            backupExistsOnServer: true,
            backupEnabled: true,
            healthy: true,
            checkedAt: '2026-07-24T00:00:00.000Z',
            lastSuccessfulTestAt: '2026-07-24T00:00:00.000Z',
            warnings: [],
          }
        case 'matrix_list_custom_emoji':
          return []
        case 'matrix_community_access_settings':
          return {
            alias: 'mesh-test-community',
            discoverable: false,
            joinRule: 'invite',
          }
        case 'matrix_list_community_applications':
        case 'matrix_list_moderation_audit':
          return []
        case 'matrix_get_profile':
          return matrixProfile
        case 'matrix_update_profile_display_name':
          matrixProfile.displayName = String(args.displayName)
          return { ...matrixProfile }
        case 'matrix_list_channels':
          return args.communityId === invitedCommunity.id
            ? [
                {
                  id: '!invited-general:mesh.test',
                  communityId: invitedCommunity.id,
                  name: 'welcome',
                  channelType: 'text',
                  unreadCount: 0,
                },
              ]
            : args.communityId === secondCommunity.id
            ? secondCommunityChannels
            : channels
        case 'matrix_list_members':
          return [
            {
              publicKey: '@alice:mesh.test',
              displayName: 'alice',
              avatarColor: '#52b5f4',
              role: 'owner',
              joinStatus: 'joined',
              banStatus: 'none',
              lastSeen: '2026-07-24T00:00:00.000Z',
              online: true,
            },
            {
              publicKey: '@bob:mesh.test',
              displayName: 'Bob',
              avatarColor: '#3ba55c',
              role: 'member',
              joinStatus: 'joined',
              banStatus: 'none',
              lastSeen: '2026-07-24T00:00:00.000Z',
              online: true,
            },
          ]
        case 'matrix_get_messages':
          return timeline.filter((message) => message.channelId === args.roomId)
        case 'matrix_queued_messages':
          return []
        case 'matrix_load_composer_draft':
          return null
        case 'matrix_send_message': {
          const message = {
            id: `$sent-${timeline.length}`,
            channelId: String(args.roomId),
            authorPublicKey: '@alice:mesh.test',
            authorDisplayName: 'alice',
            authorAvatarColor: '#52b5f4',
            content: String(args.body),
            attachments: [],
            reactions: {},
            timestamp: new Date().toISOString(),
            signature: '',
            replyToId: args.replyToId ?? null,
            deliveryStatus: 'sent',
          }
          timeline.push(message)
          return message
        }
        case 'matrix_user_preferences':
          return null
        case 'matrix_update_user_preferences':
          return {
            ...(args.preferences as Record<string, unknown>),
            updatedAt: '2026-07-24T00:00:00.000Z',
          }
        case 'matrix_typing_users':
          return []
        case 'matrix_room_pins':
          return {
            roomId: String(args.roomId),
            eventIds: [],
            messages: [],
            unavailableEventIds: [],
            canManage: true,
          }
        case 'matrix_mark_read':
        case 'matrix_set_typing':
        case 'matrix_save_composer_draft':
        case 'matrix_clear_composer_draft':
        case 'plugin:event|unlisten':
          return null
        case 'plugin:deep-link|get_current':
          return deepLinks
        case 'matrix_wait_for_room_update':
          // The real command long-polls the SDK room-update stream. Keeping
          // this promise pending models that boundary without a CPU-heavy loop.
          return new Promise(() => {})
        case 'plugin:event|listen':
          return nextListenerId++
        default:
          throw new Error(`Unhandled Mesh E2E IPC command: ${command}`)
      }
    }

    ;(window as unknown as {
      __MESH_E2E__: { calls: IpcCall[] }
      isTauri: boolean
      __TAURI_INTERNALS__: {
        invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown>
        transformCallback: (callback: (...args: unknown[]) => void) => number
        unregisterCallback: (id: number) => void
      }
      __TAURI_EVENT_PLUGIN_INTERNALS__: {
        unregisterListener: () => void
      }
    }).__MESH_E2E__ = { calls }

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

async function openAuthenticatedShell(
  page: Page,
  currentDeepLinks: string[] | null = null,
): Promise<void> {
  await installAuthenticatedMatrixMock(page, currentDeepLinks)
  await page.goto('/')
  await expect(
    page.getByRole('navigation', { name: 'Communities and direct messages' }),
  ).toBeVisible({ timeout: 10_000 })
  if (!currentDeepLinks?.length) {
    await expect(page.getByRole('log', { name: 'Messages in #general' })).toBeVisible({
      timeout: 10_000,
    })
  }
}

function ipcCalls(page: Page): Promise<IpcCall[]> {
  return page.evaluate(() => (
    window as unknown as { __MESH_E2E__: { calls: IpcCall[] } }
  ).__MESH_E2E__.calls)
}

test.describe('authenticated desktop shell', () => {
  test.use({ viewport: { width: 1440, height: 900 } })

  test('exposes communities, rooms, and the signed-in account', async ({ page }) => {
    await openAuthenticatedShell(page)

    await expect(page.locator('button[aria-label^="Mesh Test Community"]')).toHaveAttribute(
      'aria-current',
      'true',
    )
    await expect(
      page.getByRole('button', { name: 'Second Test Community, 3 unread' }),
    ).toBeVisible()
    await expect(page.getByRole('complementary', { name: 'Room list' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Text room: general' })).toHaveAttribute(
      'aria-current',
      'page',
    )
    await expect(page.getByText('Mesh account', { exact: true })).toBeVisible()
    await expect(page.getByText('@alice:mesh.test', { exact: true })).toHaveCount(0)
    await expect(page.getByText('Alice Mesh', { exact: true })).toBeVisible()
    await expect(page.getByText('Anonymous', { exact: true })).toHaveCount(0)
  })

  test('joins a cold-start Mesh invitation through Matrix and opens the community', async ({ page }) => {
    const invite =
      'mesh://join?v=3&kind=matrix&room=!invited:mesh.test&via=mesh.test&service=https%3A%2F%2Fmatrix.mesh.test'
    await openAuthenticatedShell(page, [invite])

    await expect.poll(async () => (
      (await ipcCalls(page)).filter((call) => call.command === 'matrix_join_community')
    )).toEqual([{
      command: 'matrix_join_community',
      args: {
        roomOrAlias: '!invited:mesh.test',
        via: ['mesh.test'],
      },
    }])
    await expect(
      page.getByRole('button', { name: 'Invited Mesh Community', exact: true }),
    ).toHaveAttribute('aria-current', 'true')
    await expect(page.getByRole('button', { name: 'Text room: welcome' })).toHaveAttribute(
      'aria-current',
      'page',
    )
    await expect(page.getByRole('dialog', { name: 'Join a community' })).toHaveCount(0)

  })

  test('@a11y has no automated WCAG A/AA violations in the shell and settings', async ({ page }) => {
    await openAuthenticatedShell(page)
    await expectNoWcagViolations(page, 'Authenticated desktop shell')

    await page.getByRole('button', { name: 'User settings' }).click()
    const dialog = page.getByRole('dialog', { name: 'User Settings' })
    await expect(dialog).toBeVisible()
    await expect(dialog.getByText('Account', { exact: true })).toBeVisible()
    await expect(dialog.locator(':scope > div').first()).toHaveCSS('opacity', '1')
    await expectNoWcagViolations(page, 'User Settings dialog')
  })

  test('sends a message through the Matrix boundary and renders it in the chat log', async ({ page }) => {
    await openAuthenticatedShell(page)

    const composer = page.getByRole('textbox', { name: 'Message general' })
    await composer.fill('A browser-tested encrypted hello')
    await composer.press('Enter')

    await expect(
      page.getByRole('log', { name: 'Messages in #general' })
        .getByText('A browser-tested encrypted hello'),
    ).toBeVisible()
    await expect(composer).toHaveValue('')

    const calls = await ipcCalls(page)
    expect(calls).toContainEqual({
      command: 'matrix_send_message',
      args: expect.objectContaining({
        roomId: '!general:mesh.test',
        body: 'A browser-tested encrypted hello',
      }),
    })
  })

  test('opens the room ledger and switches among useful room context views', async ({ page }) => {
    await openAuthenticatedShell(page)

    const trustSummary = page.getByRole('button', { name: /Encrypted, 2 members, 1 connected service, 1 device needs review. Open room ledger./ })
    await expect(trustSummary).toBeVisible()
    await trustSummary.click()

    const context = page.getByRole('complementary', { name: 'Room context for general' })
    await expect(context).toBeVisible()
    const peopleTab = context.getByRole('tab', { name: 'People' })
    const ledgerTab = context.getByRole('tab', { name: 'Ledger' })
    const filesTab = context.getByRole('tab', { name: 'Files' })
    const pinsTab = context.getByRole('tab', { name: 'Pins' })
    await expect(ledgerTab).toHaveAttribute('aria-selected', 'true')
    await expect(ledgerTab).toHaveAttribute('tabindex', '0')
    await expect(peopleTab).toHaveAttribute('tabindex', '-1')
    await expect(filesTab).toHaveAttribute('tabindex', '-1')
    await expect(pinsTab).toHaveAttribute('tabindex', '-1')
    await expect(context.getByText('Protected end to end')).toBeVisible()
    await expect(context.getByText('1 need review')).toBeVisible()
    await expect(context.getByText('Ready', { exact: true })).toBeVisible()

    await ledgerTab.focus()
    await page.keyboard.press('ArrowRight')
    await expect(filesTab).toBeFocused()
    await expect(filesTab).toHaveAttribute('aria-selected', 'true')
    await expect(context.getByRole('tabpanel')).toHaveAttribute(
      'aria-labelledby',
      await filesTab.getAttribute('id') ?? '',
    )
    await page.keyboard.press('End')
    await expect(pinsTab).toBeFocused()
    await expect(pinsTab).toHaveAttribute('aria-selected', 'true')
    await expect(context.getByText('Nothing pinned yet')).toBeVisible()
    await page.keyboard.press('Home')
    await expect(peopleTab).toBeFocused()
    await expect(peopleTab).toHaveAttribute('aria-selected', 'true')
    await page.keyboard.press('ArrowLeft')
    await expect(pinsTab).toBeFocused()
    await page.keyboard.press('ArrowLeft')
    await expect(filesTab).toBeFocused()
    await expect(context.getByText('No files shared yet')).toBeVisible()

    await context.getByRole('button', { name: 'Close room context' }).click()
    await expect(context).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Show room context' })).toHaveAttribute(
      'aria-expanded',
      'false',
    )
  })

  test('opens settings as a labelled modal, closes with Escape, and restores focus', async ({ page }) => {
    await openAuthenticatedShell(page)

    const settingsButton = page.getByRole('button', { name: 'User settings' })
    await settingsButton.click()

    const dialog = page.getByRole('dialog', { name: 'User Settings' })
    await expect(dialog).toBeVisible()
    await expect(dialog.getByText('Mesh account', { exact: true })).toBeVisible()

    await dialog.getByRole('textbox', { name: 'Display name' }).fill('Alice Updated')
    await dialog.getByRole('button', { name: 'Save display name' }).click()
    // The Privacy Center's own save-sync status can legitimately be visible
    // at the same time (e.g. an initial preference sync completing), so this
    // must target the display-name status by its distinguishing name rather
    // than assuming it's the only `role="status"` region in the dialog.
    await expect(
      dialog.getByRole('status', { name: 'Display name save status' }),
    ).toHaveText('Profile updated')

    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
    await expect(settingsButton).toBeFocused()
    await expect(page.getByText('Alice Updated', { exact: true })).toBeVisible()

    const calls = await ipcCalls(page)
    expect(calls).toContainEqual({
      command: 'matrix_update_profile_display_name',
      args: { displayName: 'Alice Updated' },
    })
  })

  test('hands Security focus back to the persistent User Settings trigger', async ({ page }) => {
    await openAuthenticatedShell(page)

    const settingsButton = page.getByRole('button', { name: 'User settings' })
    await settingsButton.click()
    const settingsDialog = page.getByRole('dialog', { name: 'User Settings' })
    await expect(settingsDialog).toBeVisible()

    await settingsDialog.getByRole('button', { name: 'Open your devices' }).click()
    const securityDialog = page.getByRole('dialog', { name: 'Your devices' })
    await expect(settingsDialog).toHaveCount(0)
    await expect(securityDialog).toBeVisible()
    await expect(page.getByRole('dialog')).toHaveCount(1)

    await page.keyboard.press('Escape')

    await expect(securityDialog).toHaveCount(0)
    await expect(settingsButton).toBeFocused()
    expect(await page.evaluate(() => document.activeElement === document.body)).toBe(false)
  })

  test('opens community management as an accessible sheet and restores focus', async ({ page }) => {
    await openAuthenticatedShell(page)

    const settingsButton = page.getByRole('button', {
      name: 'Open settings for Mesh Test Community',
    })
    await settingsButton.click()

    const sheet = page.getByRole('dialog', { name: 'Community settings' })
    await expect(sheet).toBeVisible()
    await expect(
      sheet.getByText('Manage Mesh Test Community, its rooms, and who can find it.'),
    ).toBeVisible()
    await expect(sheet.getByRole('switch', { name: 'List this community publicly' })).toHaveAttribute(
      'aria-checked',
      'false',
    )

    const createRoom = sheet.getByRole('button', { name: 'Create room', exact: true })
    await createRoom.click()
    await expect(sheet.getByRole('button', { name: 'Cancel', exact: true })).toHaveAttribute(
      'aria-expanded',
      'true',
    )
    await expect(sheet.getByRole('button', { name: 'Text' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    await expect(sheet.getByRole('button', { name: 'Voice' })).toHaveCount(0)
    await expectNoWcagViolations(page, 'Community settings sheet')

    await page.keyboard.press('Escape')
    await expect(sheet).toHaveCount(0)
    await expect(settingsButton).toBeFocused()
  })

  test('changes room notification rules and marks unread state from the context menu', async ({ page }) => {
    await openAuthenticatedShell(page)

    const randomChannel = page.getByRole('button', {
      name: 'Text room: random, 1 unread',
    })
    await randomChannel.click({ button: 'right' })
    const menu = page.getByRole('menu', { name: 'Actions for random' })
    await expect(menu.getByRole('menuitem', { name: 'Mute for 15 minutes' })).toBeVisible()
    await menu
      .getByRole('menuitem', { name: 'Notifications: Only @mentions' })
      .click()

    await expect.poll(async () => ipcCalls(page)).toContainEqual({
      command: 'matrix_set_room_notification_mode',
      args: {
        roomId: '!random:mesh.test',
        mode: 'mentions',
      },
    })

    await randomChannel.click({ button: 'right' })
    await page
      .getByRole('menu', { name: 'Actions for random' })
      .getByRole('menuitem', { name: 'Mark as read' })
      .click()

    await expect.poll(async () => ipcCalls(page)).toContainEqual({
      command: 'matrix_mark_read',
      args: { roomId: '!random:mesh.test' },
    })
    await expect(
      page.getByRole('button', { name: 'Text room: random' }),
    ).toBeVisible()
  })

  test('shows MatrixRTC membership but never starts media while encryption is unverified', async ({ page }) => {
    await openAuthenticatedShell(page)

    await expect(page.getByLabel('Lounge call members').getByText('Bob')).toBeVisible()
    await page.getByRole('button', { name: 'Voice room: Lounge' }).click()

    await expect(page.getByRole('heading', { name: 'Calling is not ready yet' })).toBeVisible()
    await expect(
      page.getByText('Your microphone, camera, and screen stay off until every safety check passes.'),
    ).toBeVisible()

    const calls = await ipcCalls(page)
    expect(calls).toContainEqual({
      command: 'matrix_rtc_members',
      args: { roomId: '!lounge:mesh.test' },
    })
    expect(calls.some((call) => call.command === 'matrix_rtc_join')).toBe(false)
    expect(calls.some((call) => call.command === 'matrix_rtc_leave')).toBe(false)
  })
})

test.describe('authenticated narrow shell', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true })

  test('@a11y has no automated WCAG A/AA violations with navigation open', async ({ page }) => {
    await openAuthenticatedShell(page)
    await page.getByRole('button', { name: 'Open room navigation' }).click()
    await expect(page.getByRole('button', { name: 'Close room navigation' })).toBeVisible()
    const navigationDrawer = page.locator('#mesh-context-sidebar')
    await expect(navigationDrawer).toHaveAttribute('aria-modal', 'true')
    expect(await navigationDrawer.evaluate((drawer) => drawer.contains(document.activeElement))).toBe(true)
    for (let index = 0; index < 10; index += 1) await page.keyboard.press('Tab')
    expect(await navigationDrawer.evaluate((drawer) => drawer.contains(document.activeElement))).toBe(true)

    await expectNoWcagViolations(page, 'Authenticated narrow shell with room navigation')
  })

  test('closes room navigation with Escape and restores its trigger', async ({ page }) => {
    await openAuthenticatedShell(page)
    const drawerButton = page.getByRole('button', { name: 'Open room navigation' })
    await drawerButton.click()
    await expect(page.locator('#mesh-context-sidebar')).toHaveAttribute('data-open', 'true')

    await page.keyboard.press('Escape')

    await expect(page.locator('#mesh-context-sidebar')).toHaveAttribute('data-open', 'false')
    await expect(drawerButton).toBeFocused()
  })

  test('keeps message actions reachable on touch-only layouts', async ({ page }) => {
    await openAuthenticatedShell(page)
    const actions = page.locator('.mesh-message-actions').first()

    await expect(actions).toHaveCSS('opacity', '1')
    await expect(actions).toHaveCSS('pointer-events', 'auto')
    await expect(actions.getByRole('button', { name: /React to message/ })).toBeVisible()
  })

  test('opens the room drawer, changes rooms, and sends a message without overflow', async ({ page }) => {
    await openAuthenticatedShell(page)

    const drawerButton = page.getByRole('button', { name: 'Open room navigation' })
    await expect(drawerButton).toHaveAttribute('aria-expanded', 'false')
    await expect(drawerButton).toHaveAttribute('aria-controls', 'mesh-context-sidebar')

    await drawerButton.click()
    await expect(page.getByRole('button', { name: 'Close room navigation' })).toBeVisible()
    await expect(page.locator('#mesh-context-sidebar')).toHaveAttribute('data-open', 'true')

    await page.getByRole('button', { name: /Text room: random/ }).click()
    await expect(page.getByRole('log', { name: 'Messages in #random' })).toBeVisible()
    await expect(page.locator('#mesh-context-sidebar')).toHaveAttribute('data-open', 'false')

    const composer = page.getByRole('textbox', { name: 'Message random' })
    await composer.fill('Hello from a narrow window')
    await composer.press('Enter')
    await expect(
      page.getByRole('log', { name: 'Messages in #random' })
        .getByText('Hello from a narrow window'),
    ).toBeVisible()

    const dimensions = await page.evaluate(() => ({
      viewport: document.documentElement.clientWidth,
      content: document.documentElement.scrollWidth,
    }))
    expect(dimensions.content).toBeLessThanOrEqual(dimensions.viewport)
  })

  test('opens room context as a drawer and restores focus after Escape', async ({ page }) => {
    await openAuthenticatedShell(page)

    const contextToggle = page.getByRole('button', { name: 'Show room context' })
    await expect(contextToggle).toHaveAttribute('aria-expanded', 'false')
    await contextToggle.click()

    const context = page.getByRole('complementary', { name: 'Room context for general' })
    await expect(context).toBeVisible()
    await expect(page.locator('.mesh-room-context-backdrop')).toBeVisible()
    expect(await context.evaluate((panel) => panel.contains(document.activeElement))).toBe(true)
    for (let index = 0; index < 8; index += 1) await page.keyboard.press('Tab')
    expect(await context.evaluate((panel) => panel.contains(document.activeElement))).toBe(true)
    const ledgerTab = context.getByRole('tab', { name: 'Ledger' })
    const peopleTab = context.getByRole('tab', { name: 'People' })
    const pinsTab = context.getByRole('tab', { name: 'Pins' })
    await ledgerTab.focus()
    await page.keyboard.press('ArrowLeft')
    await expect(peopleTab).toBeFocused()
    await page.keyboard.press('ArrowLeft')
    await expect(pinsTab).toBeFocused()
    await page.keyboard.press('Home')
    await expect(peopleTab).toBeFocused()
    await ledgerTab.click()
    await expect(context.getByText('Protected end to end')).toBeVisible()
    await expectNoWcagViolations(page, 'Authenticated narrow room context drawer')

    await page.keyboard.press('Escape')
    await expect(context).toHaveCount(0)
    await expect(contextToggle).toBeFocused()
    await expect(contextToggle).toHaveAttribute('aria-expanded', 'false')
  })

  test('opens mobile user settings from the drawer and closes it with Escape', async ({ page }) => {
    await openAuthenticatedShell(page)

    await page.getByRole('button', { name: 'Open room navigation' }).click()
    await expect(page.getByText('Mesh account', { exact: true })).toBeVisible()
    await expect(page.getByText('Anonymous', { exact: true })).toHaveCount(0)

    await page.getByRole('button', { name: 'User settings' }).click()
    const dialog = page.getByRole('dialog', { name: 'User Settings' })
    await expect(dialog).toBeVisible()
    await expect(dialog.getByRole('checkbox', { name: 'Desktop notifications' })).toBeVisible()

    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
  })

  test('hands narrow Security focus back to the persistent User Settings trigger', async ({ page }) => {
    await openAuthenticatedShell(page)

    await page.getByRole('button', { name: 'Open room navigation' }).click()
    const settingsButton = page.getByRole('button', { name: 'User settings' })
    await settingsButton.click()
    const settingsDialog = page.getByRole('dialog', { name: 'User Settings' })
    await expect(settingsDialog).toBeVisible()

    await settingsDialog.getByRole('button', { name: 'Open your devices' }).click()
    const securityDialog = page.getByRole('dialog', { name: 'Your devices' })
    await expect(settingsDialog).toHaveCount(0)
    await expect(securityDialog).toBeVisible()
    await expect(page.getByRole('dialog')).toHaveCount(1)

    await page.keyboard.press('Escape')

    await expect(securityDialog).toHaveCount(0)
    await expect(settingsButton).toBeFocused()
    expect(await page.evaluate(() => document.activeElement === document.body)).toBe(false)
  })

  test('fits community management to the viewport and restores its drawer trigger', async ({ page }) => {
    await openAuthenticatedShell(page)

    await page.getByRole('button', { name: 'Open room navigation' }).click()
    const settingsButton = page.getByRole('button', {
      name: 'Open settings for Mesh Test Community',
    })
    await settingsButton.click()

    const sheet = page.getByRole('dialog', { name: 'Community settings' })
    await expect(sheet).toBeVisible()
    await expect.poll(async () => Math.round((await sheet.boundingBox())?.x ?? -1)).toBe(0)
    const bounds = await sheet.boundingBox()
    expect(Math.abs(bounds?.x ?? Number.POSITIVE_INFINITY)).toBeLessThan(0.5)
    expect(bounds?.width).toBe(390)

    const dimensions = await page.evaluate(() => ({
      viewport: document.documentElement.clientWidth,
      content: document.documentElement.scrollWidth,
    }))
    expect(dimensions.content).toBeLessThanOrEqual(dimensions.viewport)
    await expectNoWcagViolations(page, 'Narrow community settings sheet')

    await page.keyboard.press('Escape')
    await expect(sheet).toHaveCount(0)
    await expect(settingsButton).toBeFocused()
  })
})
