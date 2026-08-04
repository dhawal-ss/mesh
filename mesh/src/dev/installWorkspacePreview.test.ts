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

    await expect(previewInternals().invoke('matrix_login', {
      homeserver: 'https://matrix.org',
      username: 'preview',
      password: 'preview-password',
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
})
