import { afterEach, describe, expect, it } from 'vitest'
import { installWorkspacePreview } from './installWorkspacePreview'

type PreviewInternals = {
  invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown>
}

function previewInternals(): PreviewInternals {
  return (window as typeof window & { __TAURI_INTERNALS__?: PreviewInternals }).__TAURI_INTERNALS__!
}

describe('installWorkspacePreview', () => {
  afterEach(() => {
    Reflect.deleteProperty(window, '__TAURI_INTERNALS__')
    Reflect.deleteProperty(window, '__TAURI_EVENT_PLUGIN_INTERNALS__')
  })

  it('supports the signed-out service check and login journey', async () => {
    installWorkspacePreview({ simulateSignedOut: true, simulateInvitation: true })

    await expect(previewInternals().invoke('matrix_service_capabilities', {
      homeserver: 'https://matrix.org',
    })).resolves.toMatchObject({
      homeserver: 'https://matrix.org',
      passwordLogin: true,
      browserLogin: true,
      registration: 'open',
    })

    const firstAttemptId = await previewInternals().invoke(
      'matrix_reserve_login_attempt',
    ) as string
    const secondAttemptId = await previewInternals().invoke(
      'matrix_reserve_login_attempt',
    ) as string

    expect(firstAttemptId).not.toHaveLength(0)
    expect(secondAttemptId).not.toHaveLength(0)
    expect(secondAttemptId).not.toBe(firstAttemptId)

    await expect(previewInternals().invoke('matrix_login', {
      request: {
        homeserver: 'https://matrix.org',
        username: 'preview',
        password: 'preview-password',
      },
      attemptId: firstAttemptId,
    })).resolves.toMatchObject({
      authenticated: true,
      userId: '@taylor:mesh.test',
      homeserver: 'https://mesh.test',
    })

    await expect(previewInternals().invoke('join_pending_invitation', {
      handle: 'preview-invitation-handle',
    })).resolves.toMatchObject({
      id: '!canyon-crew:canyon.example',
      name: 'Canyon Crew',
    })

    await expect(previewInternals().invoke('matrix_list_channels', {
      communityId: '!canyon-crew:canyon.example',
    })).resolves.toMatchObject({
      entities: [{
        id: '!controller-lab:canyon.example',
        communityId: '!canyon-crew:canyon.example',
        name: 'controller lab',
        channelType: 'text',
      }],
      blockedEntities: [],
    })
  })

  it('persists a sent preview message so the invitation journey reaches a working room', async () => {
    installWorkspacePreview({ simulateSignedOut: false, simulateInvitation: true })

    const sent = await previewInternals().invoke('matrix_send_message', {
      roomId: '!controller-lab:canyon.example',
      body: 'Glad to be here.',
      transactionId: 'preview-request-controller-lab',
    })

    expect(sent).toMatchObject({
      channelId: '!controller-lab:canyon.example',
      content: 'Glad to be here.',
      transactionId: 'preview-request-controller-lab',
      clientRequestId: 'preview-request-controller-lab',
      deliveryStatus: 'sent',
    })
    await expect(previewInternals().invoke('matrix_get_messages', {
      roomId: '!controller-lab:canyon.example',
      limit: 50,
    })).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: (sent as { id: string }).id,
        content: 'Glad to be here.',
      }),
    ]))
  })

  it('keeps the preview recovery controls internally consistent', async () => {
    installWorkspacePreview({ simulateSignedOut: false, simulateInvitation: false })

    await expect(previewInternals().invoke('matrix_recovery_health')).resolves.toMatchObject({
      healthy: true,
      secureStorageState: 'saved',
    })
    await expect(previewInternals().invoke('matrix_test_stored_recovery')).resolves.toMatchObject({
      healthy: true,
      secureStorageState: 'saved',
    })
    await expect(previewInternals().invoke('matrix_enable_recovery')).resolves.toMatchObject({
      secureStorageState: 'saved',
      verificationState: 'verified',
    })
  })

  it('ends preview room-update waits cleanly instead of timing out at the bridge', async () => {
    installWorkspacePreview({ simulateSignedOut: false, simulateInvitation: false })

    await expect(previewInternals().invoke('matrix_wait_for_room_update', {
      roomId: '!controller-lab:canyon.example',
      timeoutMs: 5,
    })).resolves.toBe(false)
  })

  it('supports the invitation creation and direct-account preview journey', async () => {
    installWorkspacePreview({ simulateSignedOut: false, simulateInvitation: false })

    await expect(previewInternals().invoke('matrix_create_community_invite', {
      communityId: '!lantern-guild:mesh.test',
    })).resolves.toBe(
      'https://mesh.test/invite/abcdefghijklmnopqrstuvwxyzABCDEFG_123456789',
    )
    await expect(previewInternals().invoke('matrix_invite_to_community', {
      communityId: '!lantern-guild:mesh.test',
      username: '@maya:mesh.test',
    })).resolves.toBeNull()
  })

  it('persists a created room in the preview community inventory', async () => {
    installWorkspacePreview({ simulateSignedOut: false, simulateInvitation: false })

    await expect(previewInternals().invoke('matrix_create_channel', {
      communityId: '!lantern-guild:mesh.test',
      name: 'roadmap',
      channelType: 'text',
    })).resolves.toMatchObject({
      communityId: '!lantern-guild:mesh.test',
      name: 'roadmap',
      channelType: 'text',
      unreadCount: 0,
    })

    await expect(previewInternals().invoke('matrix_list_channels', {
      communityId: '!lantern-guild:mesh.test',
    })).resolves.toMatchObject({
      entities: expect.arrayContaining([
        expect.objectContaining({ name: 'roadmap', channelType: 'text' }),
      ]),
      blockedEntities: [],
    })
  })

  it('accepts community detail changes in the administration preview', async () => {
    installWorkspacePreview({ simulateSignedOut: false, simulateInvitation: false })

    await expect(previewInternals().invoke('matrix_update_community', {
      communityId: '!lantern-guild:mesh.test',
      name: 'Lantern Guild Studio',
      description: 'A late-night crew for playtests, clips, art, and co-op runs.',
    })).resolves.toBeNull()
  })

  it('supports access changes and join-request decisions in the administration preview', async () => {
    installWorkspacePreview({ simulateSignedOut: false, simulateInvitation: false })

    await expect(previewInternals().invoke('matrix_list_community_applications', {
      communityId: '!lantern-guild:mesh.test',
    })).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ userId: '@avery:open-matrix.example' }),
      expect.objectContaining({ userId: '@noor:matrix.org' }),
    ]))

    await expect(previewInternals().invoke('matrix_update_community_access', {
      communityId: '!lantern-guild:mesh.test',
      alias: 'lantern-guild',
      discoverable: true,
    })).resolves.toEqual({
      alias: 'lantern-guild',
      discoverable: true,
      joinRule: 'knock',
    })

    await expect(previewInternals().invoke('matrix_respond_community_application', {
      communityId: '!lantern-guild:mesh.test',
      userId: '@avery:open-matrix.example',
      accept: true,
      reason: null,
    })).resolves.toBeNull()

    await expect(previewInternals().invoke('matrix_list_community_applications', {
      communityId: '!lantern-guild:mesh.test',
    })).resolves.toEqual([
      expect.objectContaining({ userId: '@noor:matrix.org' }),
    ])
  })

  it('supports listing, adding, and removing community emoji in the administration preview', async () => {
    installWorkspacePreview({ simulateSignedOut: false, simulateInvitation: false })

    await expect(previewInternals().invoke('matrix_list_custom_emoji', {
      communityId: '!lantern-guild:mesh.test',
    })).resolves.toHaveLength(3)

    const selection = await previewInternals().invoke('pick_custom_emoji_grant', {
      communityId: '!lantern-guild:mesh.test',
    }) as {
      grant: string
      name: string
      size: number
      contentType: string
    }
    await expect(previewInternals().invoke('matrix_upload_custom_emoji', {
      communityId: '!lantern-guild:mesh.test',
      shortcode: 'playtest_ready',
      grant: selection.grant,
    })).resolves.toMatchObject({
      shortcode: 'playtest_ready',
      contentType: 'image/png',
      sizeBytes: 8,
    })

    await expect(previewInternals().invoke('matrix_list_custom_emoji', {
      communityId: '!lantern-guild:mesh.test',
    })).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ shortcode: 'playtest_ready' }),
    ]))

    await expect(previewInternals().invoke('matrix_remove_custom_emoji', {
      communityId: '!lantern-guild:mesh.test',
      shortcode: 'playtest_ready',
    })).resolves.toBeNull()

    await expect(previewInternals().invoke('matrix_sync_once')).resolves.toBeNull()
    await expect(previewInternals().invoke('matrix_list_custom_emoji', {
      communityId: '!lantern-guild:mesh.test',
    })).resolves.not.toEqual(expect.arrayContaining([
      expect.objectContaining({ shortcode: 'playtest_ready' }),
    ]))
  })

  it('can simulate native emoji picker cancellation and upload failure', async () => {
    installWorkspacePreview({ simulateEmojiPickerCancel: true })
    await expect(previewInternals().invoke('pick_custom_emoji_grant', {
      communityId: '!lantern-guild:mesh.test',
    })).resolves.toBeNull()

    Reflect.deleteProperty(window, '__TAURI_INTERNALS__')
    Reflect.deleteProperty(window, '__TAURI_EVENT_PLUGIN_INTERNALS__')
    installWorkspacePreview({ simulateEmojiUploadFailure: true })
    const selection = await previewInternals().invoke('pick_custom_emoji_grant', {
      communityId: '!lantern-guild:mesh.test',
    }) as { grant: string }
    await expect(previewInternals().invoke('matrix_upload_custom_emoji', {
      communityId: '!lantern-guild:mesh.test',
      shortcode: 'retry_me',
      grant: selection.grant,
    })).rejects.toThrow('Preview custom emoji upload failed')
  })

  it('can simulate one recoverable saved-message restore failure', async () => {
    installWorkspacePreview({
      simulateQueue: true,
      simulateQueueRestoreFailure: true,
    })

    await expect(previewInternals().invoke('matrix_queued_messages'))
      .rejects.toThrow('Preview saved-message restore failed')
    await expect(previewInternals().invoke('matrix_queued_messages'))
      .resolves.toEqual(expect.arrayContaining([
        expect.objectContaining({
          transactionId: 'preview-queued-lighting-note',
          deliveryStatus: 'pending',
        }),
      ]))
  })

  it('can simulate one recoverable saved-message listener failure', async () => {
    installWorkspacePreview({ simulateQueueListenerFailure: true })

    await expect(previewInternals().invoke('plugin:event|listen', {
      event: 'matrix:queued-message',
    })).rejects.toThrow('Preview saved-message listener failed')
    await expect(previewInternals().invoke('plugin:event|listen', {
      event: 'matrix:queued-message',
    })).rejects.toThrow('Preview saved-message listener failed')
    await expect(previewInternals().invoke('plugin:event|listen', {
      event: 'matrix:queued-message',
    })).resolves.toBe(1)
  })
})
