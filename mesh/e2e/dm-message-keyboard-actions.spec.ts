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
  expect(runtimeErrors.get(page) ?? [], 'DM view emitted runtime errors').toEqual([])
})

// Follow-up on V-25: the channel-view message action bar (Message.tsx) was
// made keyboard-reachable, but DM conversations render through a completely
// separate, still mouse-only row implementation in DmView.tsx. This fixture
// proves a keyboard-only user can reach and use react/reply on an incoming
// DM message and edit their own DM message, with zero mouse interaction.
// Modeled on message-keyboard-actions.spec.ts, with DM setup borrowed from
// matrix-messaging.spec.ts's installAuthenticatedMatrixMessagingMock.
async function installDmKeyboardActionsMock(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const calls: IpcCall[] = []
    const callbacks = new Map<number, (...args: unknown[]) => void>()
    let nextCallbackId = 1
    let nextListenerId = 1

    const community = {
      id: '!mesh-e2e:mesh.test',
      name: 'Mesh Test Community',
      description: 'DM keyboard-access browser fixture',
      memberCount: 2,
      role: 'owner',
      joinedAt: '2026-07-24T00:00:00.000Z',
    }
    const channel = {
      id: '!general:mesh.test',
      communityId: community.id,
      name: 'general',
      channelType: 'text',
      unreadCount: 0,
    }
    const matrixProfile = {
      userId: '@alice:mesh.test',
      displayName: 'Alice Mesh',
      avatarUrl: null,
    }
    const conversation = {
      id: '!alice-bob-dm:mesh.test',
      peerPublicKey: '@bob:mesh.test',
      peerDisplayName: 'Bob',
      peerAvatarColor: '#3ba55c',
      lastMessageAt: '2026-07-24T00:05:00.000Z',
      unreadCount: 0,
      createdAt: '2026-07-24T00:00:00.000Z',
    }
    // Two authors so both the "incoming message" (react/reply) and "own
    // message" (edit) action-bar paths are covered from one fixture.
    const dmTimeline = [
      {
        id: '$dm-history',
        conversationId: conversation.id,
        authorPublicKey: '@bob:mesh.test',
        authorDisplayName: 'Bob',
        authorAvatarColor: '#3ba55c',
        content: "A DM Bob didn't send to himself.",
        timestamp: '2026-07-24T00:04:00.000Z',
        signature: '',
        attachments: [],
        reactions: {},
        replyToId: null,
        deliveryStatus: 'sent',
      },
      {
        id: '$dm-own',
        conversationId: conversation.id,
        authorPublicKey: '@alice:mesh.test',
        authorDisplayName: 'alice',
        authorAvatarColor: '#52b5f4',
        content: "Alice's own DM, editable via keyboard.",
        timestamp: '2026-07-24T00:05:00.000Z',
        signature: '',
        attachments: [],
        reactions: {},
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
          return { entities: [channel], blockedEntities: [] }
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
          return []
        case 'matrix_queued_messages':
          return []
        case 'matrix_dm_conversations':
          return { entities: [conversation], blockedEntities: [] }
        case 'matrix_dm_messages':
          return args.conversationId === conversation.id ? dmTimeline : []
        case 'matrix_load_composer_draft':
          return null
        case 'matrix_dm_blocked':
          return false
        case 'matrix_toggle_reaction':
          return null
        case 'matrix_edit_message': {
          const target = dmTimeline.find((message) => message.id === args.eventId)
          if (target) target.content = String(args.body)
          return null
        }
        case 'matrix_mark_dm_read':
        case 'matrix_mark_read':
        case 'matrix_set_typing':
        case 'matrix_save_composer_draft':
        case 'matrix_clear_composer_draft':
        case 'plugin:event|unlisten':
          return null
        case 'plugin:deep-link|get_current':
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
        case 'matrix_wait_for_room_update':
          // The Rust command long-polls the Matrix SDK room update stream.
          return new Promise(() => {})
        case 'plugin:event|listen':
          return nextListenerId++
        default:
          throw new Error(`Unhandled Mesh DM E2E IPC command: ${command}`)
      }
    }

    ;(window as unknown as {
      __MESH_DM_KEYBOARD_E2E__: { calls: IpcCall[] }
      isTauri: boolean
      __TAURI_INTERNALS__: {
        invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown>
        transformCallback: (callback: (...args: unknown[]) => void) => number
        unregisterCallback: (id: number) => void
      }
      __TAURI_EVENT_PLUGIN_INTERNALS__: {
        unregisterListener: () => void
      }
    }).__MESH_DM_KEYBOARD_E2E__ = { calls }

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

async function openDirectMessage(page: Page): Promise<void> {
  await installDmKeyboardActionsMock(page)
  await page.goto('/')
  await expect(page.getByRole('navigation', { name: 'Communities and direct messages' })).toBeVisible()

  await page.getByRole('button', { name: 'Direct messages', exact: true }).click()
  await expect(
    page.getByRole('complementary', { name: 'Direct message conversations' }),
  ).toBeVisible()

  const conversation = page.getByRole('button', { name: 'Direct message with Bob' })
  await expect(conversation).toBeVisible()
  await conversation.click()
  await expect(page.getByRole('textbox', { name: 'Message Bob' })).toBeVisible()
}

function ipcCalls(page: Page): Promise<IpcCall[]> {
  return page.evaluate(() => (
    window as unknown as { __MESH_DM_KEYBOARD_E2E__: { calls: IpcCall[] } }
  ).__MESH_DM_KEYBOARD_E2E__.calls)
}

// Real Tab-key traversal (not locator.focus(), which bypasses tab order and
// would prove nothing about keyboard reachability). Bounded so a broken tab
// order fails the test instead of hanging.
async function tabUntilFocused(page: Page, target: Locator, direction: 'forward' | 'backward' = 'forward', maxPresses = 80) {
  const key = direction === 'forward' ? 'Tab' : 'Shift+Tab'
  for (let i = 0; i < maxPresses; i += 1) {
    const isFocused = await target.evaluate((el) => el === document.activeElement).catch(() => false)
    if (isFocused) return
    await page.keyboard.press(key)
  }
  await expect(target, `did not reach element via ${maxPresses} × ${key} presses`).toBeFocused()
}

test.describe('DM message action bar keyboard access (V-25 follow-up)', () => {
  test.use({ viewport: { width: 1440, height: 900 } })

  test('reacts and replies to an incoming DM, and edits your own DM message, via Tab alone', async ({ page }) => {
    await openDirectMessage(page)
    const messageLog = page.getByRole('log', { name: 'Messages with Bob' })
    await expect(page.getByText("A DM Bob didn't send to himself.")).toBeVisible()
    await expect(messageLog.getByText("Alice's own DM, editable via keyboard.")).toBeVisible()

    const bobRow = page.getByRole('group', { name: /^Message from Bob,/ })
    const ownRow = page.getByRole('group', { name: /^Message from alice,/ })
    // DMs now use the shared channel row, whose accessible action names
    // include the author so repeated controls remain distinguishable.
    const reactButtonBob = bobRow.getByRole('button', { name: 'React to message from Bob' })
    const replyButtonBob = bobRow.getByRole('button', { name: 'Reply to Bob' })
    const editButtonOwn = ownRow.getByRole('button', { name: 'Edit message' })
    // Opacity/pointer-events live on the action bar's wrapper div, not the
    // buttons themselves — assert visibility there, matching Message.tsx's
    // equivalent test.
    const actionBarBob = reactButtonBob.locator('xpath=..')

    // The composer autofocuses on mount, so a keyboard user reaches the
    // message log by tabbing backward from it — never a mouse.
    await tabUntilFocused(page, reactButtonBob, 'backward')
    await expect(actionBarBob).toHaveCSS('opacity', '1')

    // --- React (on Bob's message) ---
    await page.keyboard.press('Enter')
    const thumbsUp = page.getByRole('button', { name: 'React with thumbs up', exact: true })
    await tabUntilFocused(page, thumbsUp, 'forward')
    await page.keyboard.press('Enter')

    await expect.poll(async () => ipcCalls(page)).toContainEqual({
      command: 'matrix_toggle_reaction',
      args: { roomId: '!alice-bob-dm:mesh.test', eventId: '$dm-history', key: '👍' },
    })
    await expect(
      bobRow.getByRole('button', { name: /1 reaction, you reacted/ }),
    ).toBeVisible()

    // --- Reply (to Bob's message) ---
    await tabUntilFocused(page, replyButtonBob, 'forward')
    await page.keyboard.press('Enter')
    await expect(page.getByText('Replying to Bob:')).toBeVisible()

    // --- Edit (own message) ---
    await tabUntilFocused(page, editButtonOwn, 'forward')
    await page.keyboard.press('Enter')
    const editTextarea = ownRow.getByRole('textbox')
    await expect(editTextarea).toBeFocused()
    await expect(editTextarea).toHaveValue("Alice's own DM, editable via keyboard.")
    // autoFocus leaves the caret at position 0, not the end of the value —
    // move it explicitly so typed text appends instead of prepending.
    await page.keyboard.press('End')
    await page.keyboard.type(' v2')
    await page.keyboard.press('Enter')

    await expect.poll(async () => ipcCalls(page)).toContainEqual({
      command: 'matrix_edit_message',
      args: {
        roomId: '!alice-bob-dm:mesh.test',
        eventId: '$dm-own',
        body: "Alice's own DM, editable via keyboard. v2",
      },
    })
    await expect(messageLog.getByText("Alice's own DM, editable via keyboard. v2")).toBeVisible()
  })

  // Review follow-up on V-25 (DmView is the same gap on the DM path): the
  // reaction picker's only close paths were onMouseLeave and picking an
  // emoji — Escape did nothing, and ReactionPicker.tsx itself has no Escape
  // handling, so the fix has to live in DmView's row keydown handler.
  test('Escape dismisses the reaction picker without picking an emoji', async ({ page }) => {
    await openDirectMessage(page)
    await expect(page.getByText("A DM Bob didn't send to himself.")).toBeVisible()

    const bobRow = page.getByRole('group', { name: /^Message from Bob,/ })
    const reactButtonBob = bobRow.getByRole('button', { name: 'React to message from Bob' })
    await tabUntilFocused(page, reactButtonBob, 'backward')

    await expect(reactButtonBob).toHaveAttribute('aria-expanded', 'false')
    await page.keyboard.press('Enter')
    const thumbsUp = page.getByRole('button', { name: 'React with thumbs up', exact: true })
    await expect(thumbsUp).toBeVisible()
    await expect(reactButtonBob).toHaveAttribute('aria-expanded', 'true')

    await page.keyboard.press('Escape')
    await expect(thumbsUp).toHaveCount(0)
    await expect(reactButtonBob).toBeFocused()
    await expect(reactButtonBob).toHaveAttribute('aria-expanded', 'false')
    // No emoji was picked — the picker was dismissed, not activated.
    await expect(bobRow.getByRole('button', { name: /1 reaction, you reacted/ })).toHaveCount(0)
    expect(await ipcCalls(page)).not.toContainEqual(
      expect.objectContaining({ command: 'matrix_toggle_reaction' }),
    )
  })

  test('mouse hover still reveals the action bar (no regression)', async ({ page }) => {
    await openDirectMessage(page)
    await expect(page.getByText("A DM Bob didn't send to himself.")).toBeVisible()

    const bobRow = page.getByRole('group', { name: /^Message from Bob,/ })
    const reactButtonBob = bobRow.getByRole('button', { name: 'React to message from Bob' })
    const actionBarBob = reactButtonBob.locator('xpath=..')
    await expect(actionBarBob).toHaveCSS('opacity', '0')

    await page.getByText("A DM Bob didn't send to himself.").hover()
    await expect(actionBarBob).toHaveCSS('opacity', '1')

    await page.mouse.move(0, 0)
    await expect(actionBarBob).toHaveCSS('opacity', '0')
  })
})
