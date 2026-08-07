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
  expect(runtimeErrors.get(page) ?? [], 'Matrix messaging emitted runtime errors').toEqual([])
})

async function installAuthenticatedMatrixMessagingMock(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const calls: IpcCall[] = []
    const callbacks = new Map<number, (...args: unknown[]) => void>()
    let nextCallbackId = 1
    let nextListenerId = 1
    const thumbnailBytes = Array.from(
      Uint8Array.from(
        atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='),
        (character) => character.charCodeAt(0),
      ),
    )

    const community = {
      id: '!mesh-e2e:mesh.test',
      name: 'Mesh Test Community',
      description: 'Authenticated Matrix messaging fixture',
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
    const conversation = {
      id: '!alice-bob-dm:mesh.test',
      peerPublicKey: '@bob:mesh.test',
      peerDisplayName: 'Bob',
      peerAvatarColor: '#3ba55c',
      lastMessageAt: '2026-07-24T00:05:00.000Z',
      unreadCount: 1,
      createdAt: '2026-07-24T00:00:00.000Z',
    }
    const encryptedAttachment = {
      fileHash: 'matrix-sha256:encrypted-plan',
      filename: 'encrypted-plan.pdf',
      size: 2_097_152,
      chunks: 1,
      sourcePeerId: 'matrix',
      contentType: 'application/pdf',
      thumbnail: {
        fileHash: 'matrix-sha256:encrypted-plan-thumbnail',
        size: thumbnailBytes.length,
        width: 1,
        height: 1,
        contentType: 'image/png',
      },
    }
    const dmTimeline = [
      {
        id: '$dm-history',
        conversationId: conversation.id,
        authorPublicKey: '@bob:mesh.test',
        authorDisplayName: 'Bob',
        authorAvatarColor: '#3ba55c',
        content: 'Existing encrypted DM history.',
        timestamp: '2026-07-24T00:05:00.000Z',
        signature: '',
        attachments: [encryptedAttachment],
        reactions: {},
        replyToId: null,
        deliveryStatus: 'sent',
      },
    ]
    const channelTimeline = [
      {
        id: '$welcome',
        channelId: channel.id,
        authorPublicKey: '@bob:mesh.test',
        authorDisplayName: 'Bob',
        authorAvatarColor: '#3ba55c',
        content: 'Welcome to the encrypted Mesh test room.',
        attachments: [encryptedAttachment],
        reactions: {},
        timestamp: '2026-07-24T00:00:00.000Z',
        signature: '',
        replyToId: null,
        deliveryStatus: 'sent',
      },
    ]

    const directMessage = (
      content: string,
      attachments: typeof dmTimeline[number]['attachments'] = [],
    ) => ({
      id: `$sent-dm-${dmTimeline.length}`,
      conversationId: conversation.id,
      authorPublicKey: '@alice:mesh.test',
      authorDisplayName: 'alice',
      authorAvatarColor: '#52b5f4',
      content,
      timestamp: new Date().toISOString(),
      signature: '',
      attachments,
      reactions: {},
      replyToId: null,
      deliveryStatus: 'sent',
    })

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
        case 'matrix_list_channels':
          return { entities: [channel], blockedEntities: [] }
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
          return channelTimeline.filter((message) => message.channelId === args.roomId)
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
        case 'matrix_send_dm': {
          const message = directMessage(String(args.body))
          dmTimeline.push(message)
          return message
        }
        case 'matrix_send_message': {
          // DM text now uses the same durable room queue as channels. Keep
          // attachment sends on the dedicated protected-DM command below.
          const message = directMessage(String(args.body))
          dmTimeline.push(message)
          return {
            ...message,
            channelId: conversation.id,
            transactionId: String(args.transactionId),
          }
        }
        case 'matrix_send_dm_attachment': {
          const filename = args.attachmentGrant === 'grant-mesh-beta'
            ? 'mesh-beta.pdf'
            : 'attachment.bin'
          const attachment = {
            fileHash: `matrix-sha256:sent-${dmTimeline.length}`,
            filename,
            size: 1_024,
            chunks: 1,
            sourcePeerId: 'matrix',
            contentType: filename.endsWith('.pdf') ? 'application/pdf' : 'application/octet-stream',
          }
          const message = directMessage(String(args.body), [attachment])
          dmTimeline.push(message)
          return message
        }
        case 'matrix_download_attachment':
          return 'C:\\Users\\alice\\Downloads\\encrypted-plan.pdf'
        case 'matrix_load_attachment_thumbnail':
          return thumbnailBytes
        case 'pick_attachment_grants':
          return {
            files: [{
              grant: 'grant-mesh-beta',
              name: 'mesh-beta.pdf',
              size: 1_024,
              contentType: 'application/pdf',
            }],
            errors: [],
            accountScope: {
              accountGeneration: 0,
              userId: '@alice:mesh.test',
            },
          }
        case 'plugin:opener|open_path':
        case 'open_downloaded_file':
        case 'discard_attachment_grant':
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
          throw new Error(`Unhandled Matrix messaging E2E IPC command: ${command}`)
      }
    }

    ;(window as unknown as {
      __MESH_MATRIX_MESSAGING_E2E__: { calls: IpcCall[] }
      isTauri: boolean
      __TAURI_INTERNALS__: {
        invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown>
        transformCallback: (callback: (...args: unknown[]) => void) => number
        unregisterCallback: (id: number) => void
      }
      __TAURI_EVENT_PLUGIN_INTERNALS__: {
        unregisterListener: () => void
      }
    }).__MESH_MATRIX_MESSAGING_E2E__ = { calls }

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
  await installAuthenticatedMatrixMessagingMock(page)
  await page.goto('/')
  await expect(
    page.getByRole('navigation', { name: 'Communities and direct messages' }),
  ).toBeVisible({ timeout: 10_000 })

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
    window as unknown as {
      __MESH_MATRIX_MESSAGING_E2E__: { calls: IpcCall[] }
    }
  ).__MESH_MATRIX_MESSAGING_E2E__.calls)
}

test.describe('Matrix direct messaging and encrypted attachments', () => {
  test.use({ viewport: { width: 1440, height: 900 } })

  test('keeps a received encrypted channel thumbnail protected', async ({ page }) => {
    await openDirectMessage(page)

    const messageLog = page.getByRole('log', { name: 'Messages with Bob' })
    await expect(messageLog.getByText('Encrypted preview stays protected', { exact: true })).toBeVisible({
      timeout: 10_000,
    })
    await expect(messageLog.getByText(
      'Save the file explicitly to inspect it. Mesh does not decrypt received thumbnails into the app interface.',
      { exact: true },
    )).toBeVisible()
    await expect(messageLog.getByAltText('Preview of encrypted-plan.pdf')).toHaveCount(0)
    await expect(page.locator('body')).not.toContainText('matrix-sha256:encrypted-plan-thumbnail')
    const calls = await ipcCalls(page)
    expect(calls.map((call) => call.command)).not.toContain('matrix_load_attachment_thumbnail')
  })

  test('@a11y opens an existing encrypted DM and loads its history through Matrix IPC', async ({ page }) => {
    await openDirectMessage(page)

    const messageLog = page.getByRole('log', { name: 'Messages with Bob' })
    await expect(messageLog.getByText('Existing encrypted DM history.', { exact: true })).toBeVisible()
    await expect(messageLog.getByText('encrypted-plan.pdf', { exact: true })).toBeVisible()
    await expect(messageLog.getByText('Encrypted preview stays protected', { exact: true })).toBeVisible()
    await expect(messageLog.getByAltText('Preview of encrypted-plan.pdf')).toHaveCount(0)
    await expect(messageLog.getByRole('button', { name: 'Download encrypted-plan.pdf' })).toBeVisible()
    await expectNoWcagViolations(page, 'Encrypted direct message')

    const calls = await ipcCalls(page)
    expect(calls).toContainEqual({
      command: 'matrix_dm_conversations',
      args: expect.objectContaining({
        deadlineMs: 14_000,
        requestId: expect.any(String),
      }),
    })
    expect(calls).toContainEqual({
      command: 'matrix_dm_messages',
      args: expect.objectContaining({
        conversationId: '!alice-bob-dm:mesh.test',
        limit: 50,
      }),
    })
    expect(calls).toContainEqual({
      command: 'matrix_mark_dm_read',
      args: { conversationId: '!alice-bob-dm:mesh.test' },
    })
    expect(calls.map((call) => call.command)).not.toContain('matrix_load_attachment_thumbnail')
  })

  test('keeps DM safety contextual, explains who can read, and opens device review', async ({ page }) => {
    await openDirectMessage(page)

    const safetyTrigger = page.getByRole('button', {
      name: 'Open Safety with Bob',
    })
    await expect(safetyTrigger).toBeVisible()
    await expect(page.getByText('1 device needs review before it can be fully trusted.')).toBeVisible()

    await safetyTrigger.click()
    const safetyPane = page.getByRole('complementary', { name: 'Safety with Bob' })
    await expect(safetyPane).toBeVisible()
    await expect(safetyPane.getByText('Only you, Bob, and approved devices can read these messages.')).toBeVisible()
    await expect(safetyPane.getByText('Message backup')).toBeVisible()

    const reviewDevices = safetyPane.getByRole('button', { name: 'Review devices and backup' })
    await reviewDevices.click()
    const securityDialog = page.getByRole('dialog', { name: 'Your devices' })
    await expect(securityDialog).toBeVisible()
    await expect(page.getByRole('dialog')).toHaveCount(1)
    await expect(page.getByText('Message backup is ready')).toBeVisible()

    await page.keyboard.press('Escape')
    await expect(securityDialog).toHaveCount(0)
    await expect(reviewDevices).toBeFocused()
    await safetyPane.getByRole('button', { name: 'Close Safety' }).click()
    await expect(safetyTrigger).toBeFocused()
    expect(await page.evaluate(() => document.activeElement === document.body)).toBe(false)
  })

  test('sends DM text through the durable Matrix room queue', async ({ page }) => {
    await openDirectMessage(page)

    const composer = page.getByRole('textbox', { name: 'Message Bob' })
    await composer.fill('A production-path encrypted DM')
    await composer.press('Enter')

    await expect(
      page.getByText('A production-path encrypted DM', { exact: true }),
    ).toBeVisible({ timeout: 10_000 })
    await expect(composer).toHaveValue('')

    const calls = await ipcCalls(page)
    expect(calls).toContainEqual({
      command: 'matrix_send_message',
      args: expect.objectContaining({
        roomId: '!alice-bob-dm:mesh.test',
        body: 'A production-path encrypted DM',
        transactionId: expect.any(String),
      }),
    })
    expect(calls.some((call) => call.command === 'matrix_send_dm')).toBe(false)
  })

  test('selects and sends a DM attachment through the native dialog and encrypted Matrix IPC', async ({ page }) => {
    await openDirectMessage(page)

    await page.getByRole('button', { name: 'Attach file' }).click()
    await expect(page.getByText('mesh-beta.pdf', { exact: true })).toBeVisible()

    const composer = page.getByRole('textbox', { name: 'Message Bob' })
    await composer.fill('Private beta document')
    await composer.press('Enter')

    await expect(
      page.getByRole('log', { name: 'Messages with Bob' }).getByText('Private beta document', { exact: true }),
    ).toBeVisible({ timeout: 10_000 })
    await expect(page.getByText('mesh-beta.pdf', { exact: true })).toBeVisible()
    await expect(composer).toHaveValue('')

    const calls = await ipcCalls(page)
    expect(calls).toContainEqual({
      command: 'pick_attachment_grants',
      args: {},
    })
    expect(calls).toContainEqual({
      command: 'matrix_send_dm_attachment',
      args: expect.objectContaining({
        recipientUserId: '@bob:mesh.test',
        attachmentGrant: 'grant-mesh-beta',
        transferId: expect.any(String),
        body: 'Private beta document',
      }),
    })
    expect(calls.some((call) => (
      call.command === 'matrix_send_dm_attachment'
      && ('filePath' in call.args || 'filename' in call.args || 'contentType' in call.args)
    ))).toBe(false)
  })

  test('downloads, decrypts, and opens a Matrix attachment through the intended IPC boundaries', async ({ page }) => {
    await openDirectMessage(page)

    await page.getByRole('button', { name: 'Download encrypted-plan.pdf' }).click()
    // The shared channel/DM row also exposes the protected preview button;
    // exact matching selects the downloaded-file action.
    const openButton = page.getByRole('button', {
      name: 'Open encrypted-plan.pdf',
      exact: true,
    })
    await expect(openButton).toBeVisible()
    await openButton.click()

    const calls = await ipcCalls(page)
    const download = calls.find((call) => call.command === 'matrix_download_attachment')
    expect(download?.args).toEqual({
      roomId: '!alice-bob-dm:mesh.test',
      eventId: '$dm-history',
      attachmentIndex: 0,
      transferId: expect.any(String),
    })
    expect(calls).toContainEqual({
      command: 'open_downloaded_file',
      args: {
        localPath: 'C:\\Users\\alice\\Downloads\\encrypted-plan.pdf',
      },
    })
  })
})
