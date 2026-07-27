import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { invoke, isTauri } from '@tauri-apps/api/core'
import type { Attachment, BackendStatus, Message } from '../types/ipc'

const invokeMock = vi.mocked(invoke)
const isTauriMock = vi.mocked(isTauri)

function backendStatus(kind: 'matrix' | 'legacy-p2p'): BackendStatus {
  const matrix = kind === 'matrix'
  return {
    kind,
    capabilities: {
      encryptedText: true,
      encryptedAttachments: true,
      directMessages: true,
      voice: !matrix,
      durableTimeouts: false,
      deviceManagement: matrix,
      recovery: matrix,
      legacyMigration: !matrix,
    },
    voiceService: {
      provider: matrix ? 'matrix-rtc' : 'legacy-simple-peer',
      availability: matrix ? 'not-configured' : 'ready',
      discoveryKey: matrix ? 'org.matrix.msc4143.rtc_foci' : null,
      livekitServiceUrl: null,
      tokenEndpoint: null,
      livekitSfuUrl: null,
      cspReady: false,
      mediaE2eeVerified: false,
      reason: matrix ? 'Voice is not configured' : null,
    },
    authenticated: matrix,
    userId: matrix ? '@alice:example.org' : null,
    deviceId: matrix ? 'DEVICE' : null,
    homeserver: matrix ? 'https://example.org' : null,
    syncRunning: matrix,
    durableHistory: true,
    endToEndEncryption: true,
    warnings: [],
  }
}

async function loadBridge(kind: 'matrix' | 'legacy-p2p') {
  vi.resetModules()
  vi.doUnmock('./bridge')
  const bridge = await import('./bridge')
  invokeMock.mockResolvedValueOnce(backendStatus(kind) as never)
  await bridge.getBackendStatus()
  invokeMock.mockReset()
  return bridge
}

describe('bridge message mutation boundary', () => {
  beforeEach(() => {
    isTauriMock.mockReturnValue(true)
    invokeMock.mockReset()
  })

  afterEach(() => {
    isTauriMock.mockReturnValue(false)
    vi.restoreAllMocks()
  })

  it('rejects Matrix attachments before they can reach generic message IPC', async () => {
    const bridge = await loadBridge('matrix')
    const attachment: Attachment = {
      fileHash: 'hash',
      filename: 'file.txt',
      size: 4,
      chunks: 1,
      sourcePeerId: 'peer-1',
    }

    await expect(
      bridge.sendMessage('!room:example.org', 'caption', [attachment]),
    ).rejects.toThrow('Use matrixSendAttachment for encrypted Matrix media')
    expect(invokeMock).not.toHaveBeenCalled()
  })

  it('preserves stable Matrix delivery and reply identifiers', async () => {
    const bridge = await loadBridge('matrix')
    const message = { id: '$event:example.org' } as Message
    invokeMock.mockResolvedValueOnce(message as never)

    await expect(
      bridge.sendMessage(
        '!room:example.org',
        'hello',
        [],
        '$reply:example.org',
        'pending-123',
      ),
    ).resolves.toBe(message)
    expect(invokeMock).toHaveBeenCalledWith('matrix_send_message', {
      roomId: '!room:example.org',
      body: 'hello',
      replyToId: '$reply:example.org',
      transactionId: 'pending-123',
    })
  })

  it('requires room context for every generic Matrix mutation', async () => {
    const bridge = await loadBridge('matrix')

    await expect(bridge.editMessage('$event', 'edited')).rejects.toThrow(
      'Matrix room ID is required',
    )
    await expect(bridge.deleteMessage('$event')).rejects.toThrow(
      'Matrix room ID is required',
    )
    await expect(bridge.addReaction('$event', '👍')).rejects.toThrow(
      'Matrix room ID is required',
    )
    expect(invokeMock).not.toHaveBeenCalled()
  })

  it('maps Matrix mutations only to their room-scoped commands', async () => {
    const bridge = await loadBridge('matrix')
    invokeMock
      .mockResolvedValueOnce({ id: '$event' } as never)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce('$reaction' as never)

    await bridge.editMessage('$event', 'edited', '!room:example.org')
    await bridge.deleteMessage('$event', '!room:example.org')
    await bridge.addReaction('$event', '👍', '!room:example.org')

    expect(invokeMock.mock.calls).toEqual([
      [
        'matrix_edit_message',
        {
          roomId: '!room:example.org',
          eventId: '$event',
          body: 'edited',
        },
      ],
      [
        'matrix_redact_message',
        {
          roomId: '!room:example.org',
          eventId: '$event',
        },
      ],
      [
        'matrix_toggle_reaction',
        {
          roomId: '!room:example.org',
          eventId: '$event',
          key: '👍',
        },
      ],
    ])
  })

  it('keeps legacy mutations entirely on legacy commands', async () => {
    const bridge = await loadBridge('legacy-p2p')
    const attachment: Attachment = {
      fileHash: 'hash',
      filename: 'file.txt',
      size: 4,
      chunks: 1,
      sourcePeerId: 'peer-1',
    }
    invokeMock.mockResolvedValue(undefined)

    await bridge.sendMessage('channel-1', 'hello', [attachment], 'reply-1')
    await bridge.editMessage('message-1', 'edited', 'ignored-room')
    await bridge.deleteMessage('message-1', 'ignored-room')
    await bridge.addReaction('message-1', '👍', 'ignored-room')

    expect(invokeMock.mock.calls).toEqual([
      [
        'send_message',
        {
          channelId: 'channel-1',
          content: 'hello',
          attachments: [attachment],
          replyToId: 'reply-1',
        },
      ],
      ['edit_message', { messageId: 'message-1', content: 'edited' }],
      ['delete_message', { messageId: 'message-1' }],
      ['add_reaction', { messageId: 'message-1', emoji: '👍' }],
    ])
    expect(invokeMock.mock.calls.some(([command]) => (
      typeof command === 'string' && command.startsWith('matrix_')
    ))).toBe(false)
  })
})
