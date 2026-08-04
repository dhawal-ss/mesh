import { expect, test, type Page } from '@playwright/test'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
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
    let pendingInvitationLink: string | null = deepLinks?.[0] ?? null

    const pendingInvitationMetadata = () => {
      if (!pendingInvitationLink) return null
      const parsed = new URL(pendingInvitationLink)
      return {
        handle: '11111111-2222-4333-8444-555555555555',
        roomOrAlias: parsed.searchParams.get('room'),
        via: parsed.searchParams.getAll('via').flatMap((value) => value.split(',')),
        service: parsed.searchParams.get('community_service')
          ?? parsed.searchParams.get('service'),
        admissionService: parsed.searchParams.get('admission'),
        communityName: 'Invited Mesh Community',
        inviterDisplayName: 'Bob',
        inviterUserId: '@bob:mesh.test',
        joinRule: 'public',
        communityServiceDisplayName: 'Matrix Test Service',
        storedAt: 1_785_552_000_000,
        expiresAt: 1_788_144_000_000,
      }
    }

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
        unreadMentions: 2,
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
      supportsE2ee: true,
      sessionE2eeReady: true,
            warnings: [],
          }
        case 'matrix_list_communities':
          return {
            entities: invitationJoined
              ? [community, secondCommunity, invitedCommunity]
              : [community, secondCommunity],
            blockedEntities: [],
          }
        case 'join_pending_invitation':
          if (args.handle !== pendingInvitationMetadata()?.handle) {
            throw new Error('Cold-start invitation handle was not forwarded correctly')
          }
          invitationJoined = true
          pendingInvitationLink = null
          return invitedCommunity
        case 'peek_pending_invitation':
          return pendingInvitationMetadata()
        case 'clear_pending_invitation':
          pendingInvitationLink = null
          return null
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
          return {
            entities: args.communityId === invitedCommunity.id
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
              : channels,
            blockedEntities: [],
          }
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
            eventIds: ['$pinned-e2e'],
            messages: [{
              ...timeline[0],
              id: '$pinned-e2e',
              channelId: String(args.roomId),
              content: 'Pinned guidance stays reachable at every supported width.',
            }],
            unavailableEventIds: [],
            canManage: true,
          }
        case 'matrix_mark_read':
        case 'matrix_set_typing':
        case 'matrix_save_composer_draft':
        case 'matrix_clear_composer_draft':
        case 'plugin:event|unlisten':
          return null
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
  expectedRoomName = 'general',
): Promise<void> {
  await installAuthenticatedMatrixMock(page, currentDeepLinks)
  await page.goto('/')
  if (currentDeepLinks?.length) {
    await expect(
      page.getByRole('heading', { name: /^Invitation to .+$/ }),
    ).toBeVisible({ timeout: 10_000 })
    return
  }
  await expect(
    page.getByRole('navigation', { name: 'Communities and direct messages' }),
  ).toBeVisible({ timeout: 10_000 })

  const community = page.locator('button[aria-label^="Mesh Test Community"]').first()
  await expect(community).toBeVisible()
  await community.click()

  const room = page.getByRole('button', { name: `Text room: ${expectedRoomName}` })
  if (!(await room.isVisible())) {
    const openRoomNavigation = page.getByRole('button', { name: 'Open room navigation' })
    await expect(openRoomNavigation).toBeVisible()
    await openRoomNavigation.click()
  }
  await expect(room).toBeVisible()
  await room.click()
  await expect(page.getByRole('log', { name: `Messages in #${expectedRoomName}` })).toBeVisible({
    timeout: 10_000,
  })
}

async function expectCriticalConversationGeometry(
  page: Page,
  label: string,
): Promise<Record<string, { x: number; width: number; right: number }>> {
  const criticalElements = [
    ['conversation header', page.locator('.mesh-conversation-header')],
    ['message log', page.getByRole('log', { name: /Messages in #/ })],
    ['pinned message', page.getByRole('button', { name: /Open pinned message from/ })],
    ['composer', page.getByRole('textbox', { name: /^Message / })],
    ['send control', page.getByRole('button', { name: 'Send message' })],
  ] as const

  const viewportWidth = await page.evaluate(() => window.innerWidth)
  const measurements: Record<string, { x: number; width: number; right: number }> = {}
  for (const [elementName, locator] of criticalElements) {
    await expect(locator, `${label}: ${elementName} should be visible`).toBeVisible()
    const box = await locator.boundingBox()
    expect(box, `${label}: ${elementName} should have geometry`).not.toBeNull()
    expect(box!.x, `${label}: ${elementName} starts before the viewport`).toBeGreaterThanOrEqual(-0.5)
    expect(box!.x + box!.width, `${label}: ${elementName} ends after the viewport`).toBeLessThanOrEqual(viewportWidth + 0.5)
    expect(box!.width, `${label}: ${elementName} should retain usable width`).toBeGreaterThanOrEqual(
      elementName === 'send control' ? 40 : 44,
    )
    measurements[elementName] = {
      x: box!.x,
      width: box!.width,
      right: box!.x + box!.width,
    }
  }
  return measurements
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

  test('restores an account-scoped room route with authoritative mention badges', async ({ page }) => {
    await page.addInitScript(() => {
      const accountId = '@alice:mesh.test'
      localStorage.setItem(`mesh-navigation-v1:${encodeURIComponent(accountId)}`, JSON.stringify({
        schemaVersion: 1,
        accountId,
        entries: [
          { kind: 'home' },
          {
            kind: 'room',
            communityId: '!mesh-e2e:mesh.test',
            roomId: '!random:mesh.test',
          },
        ],
        index: 1,
        recents: [
          {
            route: {
              kind: 'room',
              communityId: '!mesh-e2e:mesh.test',
              roomId: '!random:mesh.test',
            },
            lastOpenedAt: 2,
          },
          {
            route: {
              kind: 'room',
              communityId: '!mesh-e2e:mesh.test',
              roomId: '!general:mesh.test',
            },
            lastOpenedAt: 1,
          },
        ],
      }))
    })
    await installAuthenticatedMatrixMock(page)
    await page.goto('/')

    await expect(page.getByRole('log', { name: 'Messages in #random' })).toBeVisible({
      timeout: 10_000,
    })
    await expect(page.getByRole('button', { name: /^Text room: random, 2 mentions/ })).toHaveAttribute(
      'aria-current',
      'page',
    )
    await expect(page.getByRole('button', { name: 'Text room: general' })).toBeVisible()
  })

  test('joins a cold-start Mesh invitation through Matrix and opens the community', async ({ page }) => {
    const invite =
      'mesh://join?v=3&kind=matrix&room=!invited:mesh.test&via=mesh.test&service=https%3A%2F%2Fmatrix.mesh.test'
    await openAuthenticatedShell(page, [invite])

    const invitationHeading = page.getByRole('heading', {
      name: 'Invitation to Invited Mesh Community',
    })
    await expect(invitationHeading).toBeVisible()
    const destination = page.getByRole('region', { name: 'Invitation destination' })
    await expect(destination.getByText('Invited Mesh Community', { exact: true })).toBeVisible()
    await expect(destination.getByText('Bob', { exact: true })).toBeVisible()
    await expect(destination.getByText('Matrix Test Service', { exact: true })).toBeVisible()
    await expect.poll(async () => (
      (await ipcCalls(page)).filter((call) => call.command === 'join_pending_invitation')
    )).toEqual([])

    await page.getByRole('button', { name: 'Join Invited Mesh Community' }).click()
    await expect.poll(async () => (
      (await ipcCalls(page)).filter((call) => call.command === 'join_pending_invitation')
    )).toEqual([{
      command: 'join_pending_invitation',
      args: {
        handle: '11111111-2222-4333-8444-555555555555',
      },
    }])
    await expect(
      page.getByRole('navigation', { name: 'Communities and direct messages' }),
    ).toBeVisible()
    const invitationCalls = await ipcCalls(page)
    expect(invitationCalls.map((call) => call.command)).not.toEqual(expect.arrayContaining([
      'plugin:deep-link|get_current',
      'store_pending_invitation',
      'read_pending_invitation',
      'resolve_pending_invitation',
    ]))
    expect(JSON.stringify(invitationCalls)).not.toContain(invite)
    await expect(
      page.getByRole('button', { name: 'Invited Mesh Community', exact: true }),
    ).toHaveAttribute('aria-current', 'true')
    await expect(page.getByRole('button', { name: 'Text room: welcome' })).toBeVisible()
    await expect(invitationHeading).toHaveCount(0)

  })

  test('@a11y has no automated WCAG A/AA violations in the shell and settings', async ({ page }) => {
    await openAuthenticatedShell(page)
    await expectNoWcagViolations(page, 'Authenticated desktop shell')

    await page.getByRole('button', { name: 'User settings' }).click()
    const dialog = page.getByRole('dialog', { name: 'User Settings' })
    await expect(dialog).toBeVisible()
    await expect(dialog.getByRole('tab', { name: 'Account' })).toBeVisible()
    await expect(dialog.locator(':scope > div').first()).toHaveCSS('opacity', '1')
    await expectNoWcagViolations(page, 'User Settings dialog')
  })

  test('cycles major regions with F6 and exposes virtual message order', async ({ page }) => {
    await openAuthenticatedShell(page)

    await page.keyboard.press('F6')
    await expect(
      page.getByRole('navigation', { name: 'Communities and direct messages' }),
    ).toBeFocused()
    await page.keyboard.press('F6')
    await expect(page.getByRole('complementary', { name: 'Room list' })).toBeFocused()
    await page.keyboard.press('F6')
    await expect(page.getByRole('main')).toBeFocused()
    await page.keyboard.press('Shift+F6')
    await expect(page.getByRole('complementary', { name: 'Room list' })).toBeFocused()

    const message = page
      .getByRole('log', { name: 'Messages in #general' })
      .getByRole('article')
    await expect(message).toHaveAttribute('aria-posinset', '1')
    await expect(message).toHaveAttribute('aria-setsize', '1')
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

  test('opens Signal Check and switches among useful Details views', async ({ page }) => {
    await openAuthenticatedShell(page)

    const trustSummary = page.getByRole('button', { name: /1 device needs review. Open Signal Check./ })
    await expect(trustSummary).toBeVisible()
    await trustSummary.click()

    const signalCheck = page.getByRole('complementary', { name: 'Signal Check for general' })
    await expect(signalCheck).toBeVisible()
    await expect(signalCheck.getByRole('region', { name: 'Signal Check' })).toBeVisible()
    await expect(signalCheck.getByText('Protected end to end')).toBeVisible()
    await expect(signalCheck.getByText('1 need review')).toBeVisible()
    await expect(signalCheck.getByText('Ready', { exact: true })).toBeVisible()
    await signalCheck.getByRole('button', { name: 'Close room context' }).click()

    await page.getByRole('button', { name: 'Show Details' }).click()
    const context = page.getByRole('complementary', { name: 'Details for general' })
    await expect(context).toBeVisible()
    const peopleTab = context.getByRole('tab', { name: 'People' })
    const filesTab = context.getByRole('tab', { name: 'Files' })
    const pinsTab = context.getByRole('tab', { name: 'Pins' })
    await expect(peopleTab).toHaveAttribute('aria-selected', 'true')
    await expect(peopleTab).toHaveAttribute('tabindex', '0')
    await expect(filesTab).toHaveAttribute('tabindex', '-1')
    await expect(pinsTab).toHaveAttribute('tabindex', '-1')

    await peopleTab.focus()
    await page.keyboard.press('ArrowRight')
    await expect(pinsTab).toBeFocused()
    await expect(pinsTab).toHaveAttribute('aria-selected', 'true')
    await expect(context.getByRole('tabpanel')).toHaveAttribute(
      'aria-labelledby',
      await pinsTab.getAttribute('id') ?? '',
    )
    await page.keyboard.press('End')
    await expect(filesTab).toBeFocused()
    await expect(filesTab).toHaveAttribute('aria-selected', 'true')
    await page.keyboard.press('Home')
    await expect(peopleTab).toBeFocused()
    await expect(peopleTab).toHaveAttribute('aria-selected', 'true')
    await page.keyboard.press('ArrowLeft')
    await expect(filesTab).toBeFocused()
    await expect(context.getByText('No files shared yet')).toBeVisible()

    await context.getByRole('button', { name: 'Close room context' }).click()
    await expect(context).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Show Details' })).toHaveAttribute(
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
    await dialog.getByRole('tab', { name: 'Profile' }).click()
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

    await settingsDialog.getByRole('tab', { name: 'Safety and devices' }).click()
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

  test('opens community administration as an accessible routed surface', async ({ page }) => {
    await openAuthenticatedShell(page)

    const settingsButton = page.getByRole('button', {
      name: 'Open settings for Mesh Test Community',
    })
    await settingsButton.click()

    const administration = page.getByRole('region', { name: 'Community administration' })
    await expect(administration).toBeVisible()
    await expect(page.getByRole('dialog', { name: 'Community settings' })).toHaveCount(0)
    const sectionNavigation = administration.getByRole('navigation', {
      name: 'Community administration sections',
    })
    await expect(sectionNavigation.getByRole('tab')).toHaveCount(8)

    await sectionNavigation.getByRole('tab', { name: /^Discovery and access/ }).click()
    await expect(administration.getByRole('switch', { name: 'List this community publicly' })).toHaveAttribute(
      'aria-checked',
      'false',
    )

    await sectionNavigation.getByRole('tab', { name: /^Moderation/ }).click()
    await expect(
      administration.getByText('Mesh does not currently provide an authoritative administrator-action history.'),
    ).toBeVisible()

    await sectionNavigation.getByRole('tab', { name: /^Rooms and voice/ }).click()
    const createRoom = administration.getByRole('button', { name: 'Create room', exact: true })
    await createRoom.click()
    await expect(administration.getByRole('button', { name: 'Cancel', exact: true })).toHaveAttribute(
      'aria-expanded',
      'true',
    )
    await expect(administration.getByRole('button', { name: 'Text' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    await expect(administration.getByRole('button', { name: 'Voice' })).toHaveCount(0)
    await expectNoWcagViolations(page, 'Community administration route')

    await administration.getByRole('button', { name: 'Back to community' }).click()
    await expect(administration).toHaveCount(0)
    await expect(page.getByRole('heading', { name: 'Mesh Test Community' })).toBeVisible()
  })

  test('changes room notification rules and marks unread state from the context menu', async ({ page }) => {
    await openAuthenticatedShell(page)

    const randomChannel = page.getByRole('button', {
      name: /^Text room: random/,
    })
    await randomChannel.click({ button: 'right' })
    const menu = page.getByRole('menu', { name: 'Actions for random' })
    await menu.getByRole('menuitem', { name: 'Mute notifications' }).click()

    await expect.poll(async () => ipcCalls(page)).toContainEqual({
      command: 'matrix_set_room_notification_mode',
      args: {
        roomId: '!random:mesh.test',
        mode: 'nothing',
      },
    })

    await randomChannel.click({ button: 'right' })
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

  test('@a11y shows MatrixRTC membership but never starts media while encryption is unverified', async ({ page }) => {
    await openAuthenticatedShell(page)

    await expect(page.getByLabel('Lounge call members').getByText('Bob')).toBeVisible()
    await page.getByRole('button', { name: 'Voice room: Lounge' }).click()

    await expect(page.getByRole('heading', { name: 'Voice is not available for this room' })).toBeVisible()
    await expect(page.getByText('You can keep using messages.')).toBeVisible()
    await expectNoWcagViolations(page, 'Voice-disabled room')

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
    await expect(page.getByRole('button', { name: 'Close room navigation', exact: true })).toBeVisible()
    const navigationDrawer = page.locator('#mesh-context-sidebar')
    await expect(navigationDrawer).toHaveAttribute('aria-modal', 'true')
    const closeDrawer = navigationDrawer.getByRole('button', { name: 'Close room navigation drawer' })
    await expect(closeDrawer).toBeVisible()
    const closeDrawerBox = await closeDrawer.boundingBox()
    expect(closeDrawerBox?.width).toBeGreaterThanOrEqual(44)
    expect(closeDrawerBox?.height).toBeGreaterThanOrEqual(44)
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
    await expect(page.getByRole('button', { name: 'Close room navigation', exact: true })).toBeVisible()
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

    await expectCriticalConversationGeometry(page, '390x844 compact conversation')
  })

  test('keeps critical conversation descendants inside every release layout', async ({ page }) => {
    await openAuthenticatedShell(page)

    const layouts = [
      { width: 320, height: 844, label: '320x844 compact' },
      { width: 390, height: 844, label: '390x844 compact' },
      { width: 768, height: 1024, label: '768x1024 compact' },
      { width: 1280, height: 800, label: '1280x800 desktop' },
      { width: 640, height: 800, label: '200% zoom equivalent from 1280px' },
      { width: 320, height: 800, label: '400% zoom equivalent from 1280px' },
    ]

    const evidenceDirectory = process.env.MESH_RESPONSIVE_EVIDENCE_DIR
    const measurements: Record<string, unknown> = {}
    if (evidenceDirectory) await mkdir(evidenceDirectory, { recursive: true })
    for (const layout of layouts) {
      await page.setViewportSize({ width: layout.width, height: layout.height })
      measurements[layout.label] = await expectCriticalConversationGeometry(page, layout.label)
      if (evidenceDirectory) {
        const filename = `${layout.label.toLowerCase().replaceAll(/[^a-z0-9]+/g, '-')}.png`
        await page.screenshot({ path: join(evidenceDirectory, filename), fullPage: true })
      }
    }
    if (evidenceDirectory) {
      await writeFile(
        join(evidenceDirectory, 'responsive-conversation-geometry.json'),
        `${JSON.stringify(measurements, null, 2)}\n`,
        'utf8',
      )
    }
  })

  test('keeps narrow conversation chrome collision-free and sticky surfaces opaque', async ({ page }) => {
    await openAuthenticatedShell(page)
    await page.emulateMedia({ reducedMotion: 'reduce' })
    // Chromium does not expose desktop browser zoom through Playwright. Browser
    // zoom reduces the CSS viewport, so exercise the equivalent 1280px release
    // viewport at 200% and 400% instead of applying CSS `zoom`, which scales the
    // desktop layout after media-query selection and can push it off-screen.
    const scenarios = [
      { width: 320, height: 844, label: '320px' },
      { width: 390, height: 844, label: '390px' },
      { width: 1280, height: 800, label: '1280px' },
      { width: 640, height: 800, label: '200-percent-zoom-equivalent' },
      { width: 320, height: 800, label: '400-percent-zoom-equivalent' },
    ]
    const evidenceDirectory = process.env.MESH_RESPONSIVE_EVIDENCE_DIR
    if (evidenceDirectory) await mkdir(evidenceDirectory, { recursive: true })

    for (const [scenarioIndex, scenario] of scenarios.entries()) {
      await page.setViewportSize({ width: scenario.width, height: scenario.height })
      const closeNavigation = page.getByRole('button', {
        name: 'Close room navigation',
        exact: true,
      })
      if (await closeNavigation.isVisible()) await closeNavigation.click()
      const log = page.getByRole('log', { name: 'Messages in #general' })
      await expect(log).toBeVisible()

      const headerLayout = await page.locator('.mesh-conversation-header').evaluate((header) => {
        const bounds = header.getBoundingClientRect()
        const titleBounds = header.querySelector('h1')!.getBoundingClientRect()
        const actions = [...header.querySelectorAll<HTMLButtonElement>('button')]
          .map((button) => button.getBoundingClientRect())
          .filter((buttonBounds) => buttonBounds.width > 0 && buttonBounds.height > 0)
          .sort((left, right) => left.x - right.x)
          .map((buttonBounds) => ({ left: buttonBounds.left, right: buttonBounds.right }))
        const trustLabel = header.querySelector<HTMLElement>('.mesh-trust-summary span')
        return {
          header: { left: bounds.left, right: bounds.right },
          title: { left: titleBounds.left, right: titleBounds.right },
          actions,
          trustLabelVisible: trustLabel ? getComputedStyle(trustLabel).display !== 'none' : null,
        }
      })
      expect(headerLayout.title.left, `${scenario.label} room title starts inside header`)
        .toBeGreaterThanOrEqual(headerLayout.header.left - 0.5)
      expect(headerLayout.title.right, `${scenario.label} room title clears header actions`)
        .toBeLessThanOrEqual(headerLayout.actions[0]!.left + 0.5)
      for (const [index, action] of headerLayout.actions.entries()) {
        expect(action.left, `${scenario.label} header action ${index + 1} starts inside header`)
          .toBeGreaterThanOrEqual(headerLayout.header.left - 0.5)
        expect(action.right, `${scenario.label} header action ${index + 1} ends inside header`)
          .toBeLessThanOrEqual(headerLayout.header.right + 0.5)
        if (index > 0) {
          expect(action.left, `${scenario.label} header actions ${index} and ${index + 1} do not overlap`)
            .toBeGreaterThanOrEqual(headerLayout.actions[index - 1]!.right - 0.5)
        }
      }
      expect(headerLayout.trustLabelVisible, `${scenario.label} trust label responsive state`)
        .toBe(scenario.width >= 640)

      const pinnedMessage = page.getByRole('button', { name: /Open pinned message from/ })
      await expect(pinnedMessage).toBeVisible()
      const pinnedLayout = await pinnedMessage.evaluate((button) => {
        const copy = button.querySelector<HTMLElement>('.mesh-pinned-message-copy')!
        const preview = copy.lastElementChild as HTMLElement
        const action = button.querySelector<HTMLElement>('.mesh-pinned-message-action')!
        const buttonBounds = button.getBoundingClientRect()
        const copyBounds = copy.getBoundingClientRect()
        const previewBounds = preview.getBoundingClientRect()
        const actionBounds = action.getBoundingClientRect()
        const previewStyle = getComputedStyle(preview)
        return {
          button: { left: buttonBounds.left, right: buttonBounds.right },
          copy: { left: copyBounds.left, right: copyBounds.right },
          preview: { left: previewBounds.left, right: previewBounds.right },
          action: { left: actionBounds.left, right: actionBounds.right },
          previewOverflow: previewStyle.overflow,
          previewTextOverflow: previewStyle.textOverflow,
          previewWhiteSpace: previewStyle.whiteSpace,
          scrollWidth: button.scrollWidth,
          clientWidth: button.clientWidth,
        }
      })
      expect(pinnedLayout.copy.right, `${scenario.label} pinned copy clears action`)
        .toBeLessThanOrEqual(pinnedLayout.action.left + 0.5)
      expect(pinnedLayout.preview.right, `${scenario.label} pinned preview clears action`)
        .toBeLessThanOrEqual(pinnedLayout.action.left + 0.5)
      expect(pinnedLayout.action.right, `${scenario.label} pinned action stays inside row`)
        .toBeLessThanOrEqual(pinnedLayout.button.right + 0.5)
      expect(pinnedLayout.previewOverflow, `${scenario.label} pinned preview clips`).toBe('hidden')
      expect(pinnedLayout.previewTextOverflow, `${scenario.label} pinned preview ellipsizes`).toBe('ellipsis')
      expect(pinnedLayout.previewWhiteSpace, `${scenario.label} pinned preview remains one line`).toBe('nowrap')
      expect(pinnedLayout.scrollWidth, `${scenario.label} pinned row has no horizontal overflow`)
        .toBeLessThanOrEqual(pinnedLayout.clientWidth)

      await log.evaluate((element) => {
        element.scrollTop = Math.max(1, element.scrollHeight / 3)
      })
      const divider = log.getByRole('separator').first()
      await expect(divider).toBeVisible()
      const surface = await divider.evaluate((element) => {
        const style = getComputedStyle(element)
        const bounds = element.getBoundingClientRect()
        const parentBounds = element.parentElement?.getBoundingClientRect()
        return {
          background: style.backgroundColor,
          opacity: style.opacity,
          width: bounds.width,
          parentWidth: parentBounds?.width ?? 0,
        }
      })
      expect(surface.background, `${scenario.label} divider background`).not.toBe('rgba(0, 0, 0, 0)')
      expect(surface.background, `${scenario.label} divider background`).not.toBe('transparent')
      expect(surface.opacity, `${scenario.label} divider opacity`).toBe('1')
      expect(surface.width, `${scenario.label} divider coverage`).toBeGreaterThanOrEqual(surface.parentWidth - 1)
      if (evidenceDirectory) {
        await page.screenshot({
          path: join(
            evidenceDirectory,
            `${String(scenarioIndex + 1).padStart(2, '0')}-conversation-chrome-${scenario.label}.png`,
          ),
          fullPage: true,
        })
      }
    }

    await page.evaluate(() => {
      document.documentElement.dataset.theme = 'high-contrast'
    })
    const highContrastDivider = page.getByRole('log', { name: 'Messages in #general' })
      .getByRole('separator')
      .first()
    await expect(highContrastDivider).toBeVisible()
    await expectNoWcagViolations(page, 'Sticky conversation surfaces in high contrast')
  })

  test('ignores a retired Details preference in narrow launch and closes Details on resize', async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('mesh-layout-room-context-open', 'true')
    })
    await openAuthenticatedShell(page)

    const context = page.getByRole('complementary', { name: 'Details for general' })
    const contextToggle = page.getByRole('button', { name: 'Show Details' })
    await expect(context).toHaveCount(0)
    await expect.poll(() => page.evaluate(() => (
      localStorage.getItem('mesh-layout-room-context-open')
    ))).toBe('true')

    await page.setViewportSize({ width: 1280, height: 800 })
    await contextToggle.click()
    await expect(context).toBeVisible()
    await page.setViewportSize({ width: 390, height: 844 })
    await expect(context).toHaveCount(0)
    await expect(contextToggle).toBeFocused()
  })

  test('opens room context as a drawer and restores focus after Escape', async ({ page }) => {
    await openAuthenticatedShell(page)

    const contextToggle = page.getByRole('button', { name: 'Show Details' })
    await expect(contextToggle).toHaveAttribute('aria-expanded', 'false')
    await contextToggle.click()

    const context = page.getByRole('complementary', { name: 'Details for general' })
    await expect(context).toBeVisible()
    const closeContext = context.getByRole('button', { name: 'Close room context' })
    const closeContextBox = await closeContext.boundingBox()
    expect(closeContextBox?.width).toBeGreaterThanOrEqual(44)
    expect(closeContextBox?.height).toBeGreaterThanOrEqual(44)
    await expect(page.locator('.mesh-room-context-backdrop')).toBeVisible()
    expect(await context.evaluate((panel) => panel.contains(document.activeElement))).toBe(true)
    for (let index = 0; index < 8; index += 1) await page.keyboard.press('Tab')
    expect(await context.evaluate((panel) => panel.contains(document.activeElement))).toBe(true)
    const peopleTab = context.getByRole('tab', { name: 'People' })
    const pinsTab = context.getByRole('tab', { name: 'Pins' })
    const filesTab = context.getByRole('tab', { name: 'Files' })
    await peopleTab.focus()
    await page.keyboard.press('ArrowLeft')
    await expect(filesTab).toBeFocused()
    await page.keyboard.press('ArrowLeft')
    await expect(pinsTab).toBeFocused()
    await page.keyboard.press('Home')
    await expect(peopleTab).toBeFocused()
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
    await dialog.getByLabel('Settings section').selectOption('notifications')
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

    await settingsDialog.getByLabel('Settings section').selectOption('devices')
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

  test('fits routed community administration to the narrow viewport', async ({ page }) => {
    await openAuthenticatedShell(page)

    await page.getByRole('button', { name: 'Open room navigation' }).click()
    const settingsButton = page.getByRole('button', {
      name: 'Open settings for Mesh Test Community',
    })
    await settingsButton.click()

    const administration = page.getByRole('region', { name: 'Community administration' })
    await expect(administration).toBeVisible()
    await administration.getByRole('combobox', { name: 'Administration section' }).selectOption('danger')
    await expect(administration.getByText('Ownership must be resolved first')).toBeVisible()
    await expect(administration.getByRole('button', { name: 'Leave Community' })).toHaveCount(0)
    await expect(page.getByRole('dialog', { name: 'Community settings' })).toHaveCount(0)

    const dimensions = await page.evaluate(() => ({
      viewport: document.documentElement.clientWidth,
      content: document.documentElement.scrollWidth,
    }))
    expect(dimensions.content).toBeLessThanOrEqual(dimensions.viewport)
    await expectNoWcagViolations(page, 'Narrow community administration route')

    await administration.getByRole('button', { name: 'Back to community' }).click()
    await expect(administration).toHaveCount(0)
  })

  test('keeps the settings index usable at 200% and 400% equivalent widths with reduced motion', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' })

    for (const width of [640, 320]) {
      await page.setViewportSize({ width, height: 720 })
      await openAuthenticatedShell(page)
      await page.getByRole('button', { name: 'Open room navigation' }).click()
      const settingsButton = page.getByRole('button', {
        name: 'Open settings for Mesh Test Community',
      })
      await settingsButton.click()
      const administration = page.getByRole('region', { name: 'Community administration' })
      await expect(
        administration.getByRole('combobox', { name: 'Administration section' }),
      ).toBeVisible()
      const dimensions = await page.evaluate(() => ({
        viewport: document.documentElement.clientWidth,
        content: document.documentElement.scrollWidth,
      }))
      expect(dimensions.content).toBeLessThanOrEqual(dimensions.viewport)
      await administration.getByRole('button', { name: 'Back to community' }).click()
      await expect(administration).toHaveCount(0)
    }
  })
})
