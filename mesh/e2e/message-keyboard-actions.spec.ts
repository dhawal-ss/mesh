import { expect, test, type Locator, type Page } from '@playwright/test'

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
  expect(runtimeErrors.get(page) ?? [], 'chat view emitted runtime errors').toEqual([])
})

// V-25: the message action bar (react/reply/edit/context-menu) used to render
// only on mouse hover, and the row had no focusable element wiring the
// keyboard-equivalent ContextMenu key. This fixture proves a keyboard-only
// user can reach and use react/reply/context-menu on a message they did NOT
// send, with zero mouse interaction. Modeled on authenticated-shell.spec.ts's
// fixture, trimmed to a single incoming message from Bob.
async function installKeyboardActionsMock(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const calls: IpcCall[] = []
    const callbacks = new Map<number, (...args: unknown[]) => void>()
    let nextCallbackId = 1
    let nextListenerId = 1

    const community = {
      id: '!mesh-e2e:mesh.test',
      name: 'Mesh Test Community',
      description: 'Keyboard-access browser fixture',
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
    ]
    const matrixProfile = {
      userId: '@alice:mesh.test',
      displayName: 'Alice Mesh',
      avatarUrl: null,
    }
    const timeline = [
      {
        id: '$bob-message',
        channelId: channels[0].id,
        authorPublicKey: '@bob:mesh.test',
        authorDisplayName: 'Bob',
        authorAvatarColor: '#3ba55c',
        content: "A message alice didn't send.",
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
          return []
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
          return { entities: [community], blockedEntities: [] }
        case 'matrix_list_custom_emoji':
          return []
        case 'matrix_get_profile':
          return matrixProfile
        case 'matrix_list_channels':
          return { entities: channels, blockedEntities: [] }
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
        case 'matrix_toggle_reaction':
          return null
        case 'matrix_redact_message':
          return null
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
          return null
        case 'matrix_wait_for_room_update':
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

function ipcCalls(page: Page): Promise<IpcCall[]> {
  return page.evaluate(() => (
    window as unknown as { __MESH_E2E__: { calls: IpcCall[] } }
  ).__MESH_E2E__.calls)
}

// Real Tab-key traversal (not locator.focus(), which bypasses tab order and
// would prove nothing about keyboard reachability). Bounded so a broken tab
// order fails the test instead of hanging.
async function tabUntilFocused(page: Page, target: Locator, direction: 'forward' | 'backward' = 'forward', maxPresses = 60) {
  const key = direction === 'forward' ? 'Tab' : 'Shift+Tab'
  for (let i = 0; i < maxPresses; i += 1) {
    const isFocused = await target.evaluate((el) => el === document.activeElement).catch(() => false)
    if (isFocused) return
    await page.keyboard.press(key)
  }
  await expect(target, `did not reach element via ${maxPresses} × ${key} presses`).toBeFocused()
}

test.describe('message action bar keyboard access (V-25)', () => {
  test.use({ viewport: { width: 1440, height: 900 } })

  test('reacts, replies, and opens the context-menu equivalent on another user\'s message via Tab alone', async ({ page }) => {
    await installKeyboardActionsMock(page)
    await page.goto('/')
    await expect(page.getByRole('log', { name: 'Messages in #general' })).toBeVisible()
    await expect(page.getByText("A message alice didn't send.")).toBeVisible()

    const reactButton = page.getByRole('button', { name: 'React to message from Bob' })
    const replyButton = page.getByRole('button', { name: 'Reply to Bob' })
    // Opacity/pointer-events live on the action bar's wrapper div, not the
    // buttons themselves — assert visibility there.
    const actionBar = reactButton.locator('xpath=..')

    // The composer autofocuses on mount, so a keyboard user reaches the
    // message log by tabbing backward from it — never a mouse.
    await tabUntilFocused(page, reactButton, 'backward')
    await expect(actionBar).toHaveCSS('opacity', '1')

    // --- React ---
    await page.keyboard.press('Enter')
    const thumbsUp = page.getByRole('button', { name: 'React with thumbs up', exact: true })
    await tabUntilFocused(page, thumbsUp, 'forward')
    await page.keyboard.press('Enter')

    await expect.poll(async () => ipcCalls(page)).toContainEqual({
      command: 'matrix_toggle_reaction',
      args: { roomId: '!general:mesh.test', eventId: '$bob-message', key: '👍' },
    })
    // Reaction buttons now expose count and ownership as a complete accessible
    // name instead of relying on their abbreviated visible text.
    await expect(page.getByRole('button', { name: /👍, 1 reaction, you reacted/ })).toBeVisible()

    // --- Reply ---
    await tabUntilFocused(page, replyButton, 'forward')
    await page.keyboard.press('Enter')
    await expect(page.getByText('Replying to')).toBeVisible()
    await expect(page.getByText('Bob', { exact: true }).first()).toBeVisible()

    // --- Context menu equivalent (ContextMenu key / Shift+F10) ---
    // Focus is still on the Reply button — a descendant of the message row —
    // proving the keyboard trigger works without first landing on the row
    // itself. Items carry role="menuitem" (V-25 review follow-up), not the
    // "button" role, so they're located accordingly.
    await page.keyboard.press('Shift+F10')
    await expect(page.getByRole('menuitem', { name: 'Remove message' })).toBeVisible()
    await expect(page.getByRole('menuitem', { name: 'Kick Bob' })).toBeVisible()

    await page.keyboard.press('Escape')
    await expect(page.getByRole('menuitem', { name: 'Remove message' })).toHaveCount(0)
  })

  // Review follow-up on V-25: Escape didn't close the reaction picker (its
  // only close paths were onMouseLeave and picking an emoji), and Shift+F10
  // left focus on <body> instead of moving it into the opened menu.
  test('Escape dismisses the reaction picker without picking an emoji, and Shift+F10 moves focus into the context menu', async ({ page }) => {
    await installKeyboardActionsMock(page)
    await page.goto('/')
    await expect(page.getByText("A message alice didn't send.")).toBeVisible()

    const reactButton = page.getByRole('button', { name: 'React to message from Bob' })
    const row = reactButton.locator('xpath=ancestor::div[@role="group"]')
    await tabUntilFocused(page, reactButton, 'backward')

    // --- Reaction picker: Escape closes it and returns focus to the trigger ---
    await expect(reactButton).toHaveAttribute('aria-expanded', 'false')
    await page.keyboard.press('Enter')
    const thumbsUp = page.getByRole('button', { name: 'React with thumbs up', exact: true })
    await expect(thumbsUp).toBeVisible()
    await expect(reactButton).toHaveAttribute('aria-expanded', 'true')

    await page.keyboard.press('Escape')
    await expect(thumbsUp).toHaveCount(0)
    await expect(reactButton).toBeFocused()
    await expect(reactButton).toHaveAttribute('aria-expanded', 'false')
    // No emoji was picked — the picker was dismissed, not activated.
    await expect(page.getByRole('button', { name: /👍, 1 reaction, you reacted/ })).toHaveCount(0)

    // --- Context menu: Shift+F10 moves focus into the first menu item ---
    await page.keyboard.press('Shift+F10')
    const pinButton = page.getByRole('menuitem', { name: 'Pin message' })
    const removeButton = page.getByRole('menuitem', { name: 'Remove message' })
    await expect(pinButton).toBeVisible()
    await expect(removeButton).toBeVisible()
    await expect(pinButton).toBeFocused()

    // Escape still restores focus to the row (pre-existing behavior for
    // item-selection closes verified separately by the moderation flow).
    await page.keyboard.press('Escape')
    await expect(pinButton).toHaveCount(0)
    await expect(removeButton).toHaveCount(0)
    await expect(row).toBeFocused()
  })

  test('mouse hover still reveals the action bar (no regression)', async ({ page }) => {
    await installKeyboardActionsMock(page)
    await page.goto('/')
    await expect(page.getByText("A message alice didn't send.")).toBeVisible()

    const reactButton = page.getByRole('button', { name: 'React to message from Bob' })
    const actionBar = reactButton.locator('xpath=..')
    await expect(actionBar).toHaveCSS('opacity', '0')

    await page.getByText("A message alice didn't send.").hover()
    await expect(actionBar).toHaveCSS('opacity', '1')

    await page.mouse.move(0, 0)
    await expect(actionBar).toHaveCSS('opacity', '0')
  })
})
