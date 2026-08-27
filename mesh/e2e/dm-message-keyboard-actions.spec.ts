import { expect, test, type Locator, type Page } from '@playwright/test'
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
      topic: '',
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
      peers: [{ userId: '@bob:mesh.test', displayName: 'Bob', avatarColor: '#3ba55c' }],
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
        case 'get_notification_account_scope':
          return { accountGeneration: 0, userId: args.expectedUserId }
        case 'set_notification_context':
        case 'matrix_set_room_notification_mode':
        case 'send_test_notification':
          return null
        case 'matrix_get_room_notification_mode':
          return 'all'
        case 'matrix_rtc_members':
          return []
        case 'ensure_backend_started':
          return { phase: 'ready', issue: null }
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
              mediaE2eeReady: false,
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
          return { members: [
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
          ], nextCursor: null, stateComplete: true }
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
        case 'matrix_redact_message':
          return null
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
  await expect(page.getByRole('combobox', { name: 'Message Bob' })).toBeVisible()
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

// The action bar is a `role="toolbar"` with a roving tabindex: exactly one of
// its controls is tabbable at a time, so Tab moves into and out of the bar
// while ArrowLeft/ArrowRight/Home/End move between the actions inside it. That
// is the WAI-ARIA toolbar contract, so a test that walked the bar with Tab
// would prove nothing except that it had skipped every tabindex="-1" action.
async function moveToAction(
  page: Page,
  key: 'ArrowRight' | 'ArrowLeft' | 'Home' | 'End',
  target: Locator,
) {
  await page.keyboard.press(key)
  await expect(target, `${key} did not move toolbar focus to the expected action`).toBeFocused()
}


test.describe('DM message action bar keyboard access (V-25 follow-up)', () => {
  test.use({ viewport: { width: 1440, height: 900 } })

  test('reacts and replies to an incoming DM, and edits your own DM message, using the keyboard alone', async ({ page }) => {
    await openDirectMessage(page)
    const messageLog = page.getByRole('feed', { name: 'Messages with Bob' })
    await expect(page.getByText("A DM Bob didn't send to himself.")).toBeVisible()
    await expect(messageLog.getByText("Alice's own DM, editable via keyboard.")).toBeVisible()

    // Each timeline row is a role="article" named from its author, so the
    // incoming and own rows stay distinguishable without indexing into the
    // feed by position.
    const bobRow = messageLog.getByRole('article', { name: 'Bob' })
    const ownRow = messageLog.getByRole('article', { name: 'alice' })
    // DMs now use the shared channel row, whose accessible action names
    // include the author so repeated controls remain distinguishable.
    // Opacity and pointer-events live on the toolbar element, not on the
    // buttons inside it, matching Message.tsx's equivalent test.
    const actionBarBob = bobRow.getByRole('toolbar', { name: 'Actions for the message from Bob' })
    const actionBarOwn = ownRow.getByRole('toolbar', { name: 'Actions for the message from alice' })
    const reactButtonBob = actionBarBob.getByRole('button', { name: 'React to message from Bob' })
    const replyButtonBob = actionBarBob.getByRole('button', { name: 'Reply to Bob' })
    const reactButtonOwn = actionBarOwn.getByRole('button', { name: 'React to message from alice' })
    const editButtonOwn = actionBarOwn.getByRole('button', { name: 'Edit message' })

    // The composer autofocuses on mount, so a keyboard user reaches the
    // message log by tabbing backward from it, never a mouse.
    //
    // Roving-tabindex toolbar: React holds the bar's only tab stop, so Tab
    // gets you in and nothing more. Do not "fix" the steps below back into Tab
    // presses, they would leave the bar instead of walking it.
    await tabUntilFocused(page, reactButtonBob, 'backward')
    await expect(actionBarBob).toHaveCSS('opacity', '1')

    // --- React (on Bob's message) ---
    await page.keyboard.press('Enter')
    // The picker lists common emoji twice: once in its lead section (labelled
    // "Recently used" or "Frequently used" depending on stored recents) and
    // again inside the category they belong to. The lead section comes first in
    // the DOM and carries the roving Tab stop, so match that copy.
    const thumbsUp = page
      .getByRole('button', { name: 'React with thumbs up', exact: true })
      .first()
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
    // Sending the reaction takes the row through its in-flight state, which
    // unmounts the bar and drops focus, so the keyboard journey restarts the
    // way a real one would: Tab back to the toolbar's stop, then one
    // ArrowRight, because Reply sits immediately after React on a message
    // somebody else sent.
    await tabUntilFocused(page, reactButtonBob, 'forward')
    await moveToAction(page, 'ArrowRight', replyButtonBob)
    await page.keyboard.press('Enter')
    await expect(page.getByText('Replying to Bob:')).toBeVisible()

    // --- Edit (own message) ---
    // Tab leaves Bob's toolbar entirely and lands on the next row's own single
    // stop, where one ArrowRight reaches Edit: it is offered only on a message
    // you sent, and so sits between React and Reply there.
    await tabUntilFocused(page, reactButtonOwn, 'forward')
    await moveToAction(page, 'ArrowRight', editButtonOwn)
    await page.keyboard.press('Enter')
    const editTextarea = ownRow.getByRole('textbox')
    await expect(editTextarea).toBeFocused()
    await expect(editTextarea).toHaveValue("Alice's own DM, editable via keyboard.")
    /*
      Neither of the two message-interaction specs called axe, so the edit
      composer -- a text field that replaces a message in place, inside a feed --
      had never been scanned in any state.
    */
    await expectNoWcagViolations(page, 'Direct message edit composer open')
    /*
      autoFocus leaves the caret at position 0, not the end of the value, so it
      moves explicitly or the typed text prepends.

      Control+End rather than End: a message is a bubble now and a bubble is at
      most 62% of the conversation, so this value wraps. End goes to the end of
      the visual line, which put " v2" into the middle of the sentence.
    */
    await expect(editTextarea).toBeFocused()
    await page.keyboard.press('Control+End')
    await page.keyboard.type(' v2')
    await expect(editTextarea).toHaveValue("Alice's own DM, editable via keyboard. v2")
    await page.keyboard.press('Enter')

    await expect.poll(async () => ipcCalls(page)).toContainEqual({
      command: 'matrix_edit_message',
      args: {
        roomId: '!alice-bob-dm:mesh.test',
        eventId: '$dm-own',
        body: "Alice's own DM, editable via keyboard. v2",
        mentions: [],
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

    const bobRow = page.getByRole('feed', { name: 'Messages with Bob' })
      .getByRole('article', { name: 'Bob' })
    const reactButtonBob = bobRow
      .getByRole('toolbar', { name: 'Actions for the message from Bob' })
      .getByRole('button', { name: 'React to message from Bob' })
    // Roving-tabindex toolbar: React is the bar's only tab stop, which is what
    // makes a single backward Tab run the right entry point to assert.
    await tabUntilFocused(page, reactButtonBob, 'backward')

    await expect(reactButtonBob).toHaveAttribute('aria-expanded', 'false')
    await page.keyboard.press('Enter')
    // The picker lists common emoji twice: once in its lead section (labelled
    // "Recently used" or "Frequently used" depending on stored recents) and
    // again inside the category they belong to. The lead section comes first in
    // the DOM and carries the roving Tab stop, so match that copy.
    const thumbsUp = page
      .getByRole('button', { name: 'React with thumbs up', exact: true })
      .first()
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

  test('requires confirmation before deleting your own message', async ({ page }) => {
    await openDirectMessage(page)

    const ownRow = page.getByRole('feed', { name: 'Messages with Bob' })
      .getByRole('article', { name: 'alice' })
    const actionBarOwn = ownRow.getByRole('toolbar', { name: 'Actions for the message from alice' })
    const reactButtonOwn = actionBarOwn.getByRole('button', { name: 'React to message from alice' })
    const editButton = actionBarOwn.getByRole('button', { name: 'Edit message' })
    // Roving-tabindex toolbar: tabbing backward from the composer enters the
    // bar at React, its only tab stop, and ArrowRight is what reaches Edit.
    await tabUntilFocused(page, reactButtonOwn, 'backward')
    await moveToAction(page, 'ArrowRight', editButton)
    await page.keyboard.press('Shift+F10')

    const deleteItem = page.getByRole('menuitem', { name: 'Delete message' })
    await expect(deleteItem).toBeVisible()
    await deleteItem.click()

    const confirmation = page.getByRole('dialog', { name: 'Delete message?' })
    await expect(confirmation).toBeVisible()
    expect(await ipcCalls(page)).not.toContainEqual(
      expect.objectContaining({ command: 'matrix_redact_message' }),
    )

    await confirmation.getByRole('button', { name: 'Keep message' }).click()
    await expect(confirmation).toHaveCount(0)
    expect(await ipcCalls(page)).not.toContainEqual(
      expect.objectContaining({ command: 'matrix_redact_message' }),
    )

    // A roving toolbar remembers the action you left it on, so the second trip
    // back in lands on Edit rather than resetting to React.
    await tabUntilFocused(page, editButton, 'forward')
    await page.keyboard.press('Shift+F10')
    await page.getByRole('menuitem', { name: 'Delete message' }).click()
    await page.getByRole('dialog', { name: 'Delete message?' })
      .getByRole('button', { name: 'Delete message' })
      .click()

    await expect.poll(async () => ipcCalls(page)).toContainEqual({
      command: 'matrix_redact_message',
      args: { roomId: '!alice-bob-dm:mesh.test', eventId: '$dm-own' },
    })
  })

  test('mouse hover still reveals the action bar (no regression)', async ({ page }) => {
    await openDirectMessage(page)
    await expect(page.getByText("A DM Bob didn't send to himself.")).toBeVisible()

    // The bar is always mounted so Tab can reach it, so "hidden" here means
    // transparent and click-through rather than absent: both halves matter,
    // because an invisible bar that still swallowed clicks would sit over the
    // message underneath it.
    const actionBarBob = page.getByRole('feed', { name: 'Messages with Bob' })
      .getByRole('article', { name: 'Bob' })
      .getByRole('toolbar', { name: 'Actions for the message from Bob' })
    await expect(actionBarBob).toHaveCSS('opacity', '0')
    await expect(actionBarBob).toHaveCSS('pointer-events', 'none')

    await page.getByText("A DM Bob didn't send to himself.").hover()
    await expect(actionBarBob).toHaveCSS('opacity', '1')
    await expect(actionBarBob).toHaveCSS('pointer-events', 'auto')

    await page.mouse.move(0, 0)
    await expect(actionBarBob).toHaveCSS('opacity', '0')
    await expect(actionBarBob).toHaveCSS('pointer-events', 'none')
  })
})
