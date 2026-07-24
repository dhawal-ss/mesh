import { expect, test, type Page } from '@playwright/test'

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

async function installAuthenticatedMatrixMock(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const calls: IpcCall[] = []
    const callbacks = new Map<number, (...args: unknown[]) => void>()
    let nextCallbackId = 1
    let nextListenerId = 1

    const community = {
      id: '!mesh-e2e:mesh.test',
      name: 'Mesh Test Community',
      description: 'Authenticated browser fixture',
      memberCount: 2,
      role: 'owner',
      joinedAt: '2026-07-24T00:00:00.000Z',
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
          return [community]
        case 'matrix_get_profile':
          return matrixProfile
        case 'matrix_update_profile_display_name':
          matrixProfile.displayName = String(args.displayName)
          return { ...matrixProfile }
        case 'matrix_list_channels':
          return channels
        case 'matrix_list_members':
          return [
            {
              publicKey: '@alice:mesh.test',
              displayName: 'alice',
              avatarColor: '#5865f2',
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
        case 'matrix_send_message': {
          const message = {
            id: `$sent-${timeline.length}`,
            channelId: String(args.roomId),
            authorPublicKey: '@alice:mesh.test',
            authorDisplayName: 'alice',
            authorAvatarColor: '#5865f2',
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
        case 'matrix_mark_read':
        case 'matrix_set_typing':
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
  })
}

async function openAuthenticatedShell(page: Page): Promise<void> {
  await installAuthenticatedMatrixMock(page)
  await page.goto('/')
  await expect(page.getByRole('navigation', { name: 'Communities and DMs' })).toBeVisible()
  await expect(page.getByRole('log', { name: 'Messages in #general' })).toBeVisible()
}

function ipcCalls(page: Page): Promise<IpcCall[]> {
  return page.evaluate(() => (
    window as unknown as { __MESH_E2E__: { calls: IpcCall[] } }
  ).__MESH_E2E__.calls)
}

test.describe('authenticated desktop shell', () => {
  test.use({ viewport: { width: 1440, height: 900 } })

  test('exposes communities, channels, and the signed-in Matrix identity', async ({ page }) => {
    await openAuthenticatedShell(page)

    await expect(page.locator('button[aria-label="Mesh Test Community"]')).toHaveAttribute(
      'aria-current',
      'true',
    )
    await expect(page.getByRole('complementary', { name: 'Channel list' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Text channel: general' })).toHaveAttribute(
      'aria-current',
      'page',
    )
    await expect(page.getByText('@alice:mesh.test', { exact: true })).toBeVisible()
    await expect(page.getByText('Alice Mesh', { exact: true })).toBeVisible()
    await expect(page.getByText('Anonymous', { exact: true })).toHaveCount(0)
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

  test('opens settings as a labelled modal, closes with Escape, and restores focus', async ({ page }) => {
    await openAuthenticatedShell(page)

    const settingsButton = page.getByRole('button', { name: 'User settings' })
    await settingsButton.click()

    const dialog = page.getByRole('dialog', { name: 'User Settings' })
    await expect(dialog).toBeVisible()
    await expect(dialog.getByText('@alice:mesh.test', { exact: true })).toBeVisible()

    await dialog.getByRole('textbox', { name: 'Display name' }).fill('Alice Updated')
    await dialog.getByRole('button', { name: 'Save display name' }).click()
    await expect(dialog.getByRole('status')).toHaveText('Profile updated')

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
})

test.describe('authenticated narrow shell', () => {
  test.use({ viewport: { width: 390, height: 844 } })

  test('opens the channel drawer, changes channels, and sends a message without overflow', async ({ page }) => {
    await openAuthenticatedShell(page)

    const drawerButton = page.getByRole('button', { name: 'Channels', exact: true })
    await expect(drawerButton).toHaveAttribute('aria-expanded', 'false')
    await expect(drawerButton).toHaveAttribute('aria-controls', 'mesh-context-sidebar')

    await drawerButton.click()
    await expect(page.getByRole('button', { name: 'Close channel navigation' })).toBeVisible()
    await expect(page.locator('#mesh-context-sidebar')).toHaveAttribute('data-open', 'true')

    await page.getByRole('button', { name: /Text channel: random/ }).click()
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

  test('opens mobile user settings from the drawer and closes it with Escape', async ({ page }) => {
    await openAuthenticatedShell(page)

    await page.getByRole('button', { name: 'Channels', exact: true }).click()
    await expect(page.getByText('@alice:mesh.test', { exact: true })).toBeVisible()
    await expect(page.getByText('Anonymous', { exact: true })).toHaveCount(0)

    await page.getByRole('button', { name: 'User settings' }).click()
    const dialog = page.getByRole('dialog', { name: 'User Settings' })
    await expect(dialog).toBeVisible()
    await expect(dialog.getByRole('checkbox', { name: 'Desktop notifications' })).toBeVisible()

    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
  })
})
