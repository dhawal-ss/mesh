import { afterEach, describe, expect, it } from 'vitest'
import { ROOM_CONTEXT_OPEN_KEY } from '../lib/layout-preferences'
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
    window.localStorage.removeItem(ROOM_CONTEXT_OPEN_KEY)
  })

  it('does not overwrite a user who chose to keep room details closed', () => {
    window.localStorage.setItem(ROOM_CONTEXT_OPEN_KEY, 'false')

    installWorkspacePreview({ simulateSignedOut: false, simulateInvitation: false })

    expect(window.localStorage.getItem(ROOM_CONTEXT_OPEN_KEY)).toBe('false')
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
      name: 'Canyon Collective',
    })

    await expect(previewInternals().invoke('matrix_list_channels', {
      communityId: '!canyon-crew:canyon.example',
    })).resolves.toMatchObject({
      entities: [{
        id: '!controller-lab:canyon.example',
        communityId: '!canyon-crew:canyon.example',
        name: 'controller lab',
        topic: '',
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
      topic: '',
      channelType: 'text',
    })).resolves.toMatchObject({
      communityId: '!lantern-guild:mesh.test',
      name: 'roadmap',
      topic: '',
      channelType: 'text',
      unreadCount: 0,
    })

    await expect(previewInternals().invoke('matrix_list_channels', {
      communityId: '!lantern-guild:mesh.test',
    })).resolves.toMatchObject({
      entities: expect.arrayContaining([
        expect.objectContaining({ name: 'roadmap', topic: '', channelType: 'text' }),
      ]),
      blockedEntities: [],
    })
  })

  it('accepts community detail changes in the administration preview', async () => {
    installWorkspacePreview({ simulateSignedOut: false, simulateInvitation: false })

    await expect(previewInternals().invoke('matrix_update_community', {
      communityId: '!lantern-guild:mesh.test',
      name: 'Lantern Guild Studio',
      description: 'A late-night community for playtests, clips, art, and co-op runs.',
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
      joinRule: 'knock',
    })).resolves.toEqual({
      alias: 'lantern-guild',
      discoverable: true,
      joinRule: 'knock',
    })

    // Rooms can be renamed and removed. Before this the only room command was
    // creation, while community settings pointed administrators at a menu that
    // carried neither action, so a typo in a room name was permanent.
    const created = await previewInternals().invoke('matrix_create_channel', {
      communityId: '!lantern-guild:mesh.test',
      name: 'playtest-notes',
      topic: '',
      channelType: 'text',
    }) as { id: string; name: string }
    expect(created.name).toBe('playtest-notes')

    await expect(previewInternals().invoke('matrix_update_channel', {
      communityId: '!lantern-guild:mesh.test',
      channelId: created.id,
      name: 'playtest-log',
      topic: null,
    })).resolves.toMatchObject({ id: created.id, name: 'playtest-log' })

    await expect(previewInternals().invoke('matrix_remove_channel', {
      communityId: '!lantern-guild:mesh.test',
      channelId: created.id,
    })).resolves.toBeUndefined()

    // The join rule is chosen, not derived from directory visibility: a
    // community can take join requests without being listed anywhere.
    await expect(previewInternals().invoke('matrix_update_community_access', {
      communityId: '!lantern-guild:mesh.test',
      alias: '',
      discoverable: false,
      joinRule: 'knock',
    })).resolves.toEqual({
      alias: null,
      discoverable: false,
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
