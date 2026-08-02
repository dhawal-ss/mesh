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

  it('keeps durable queue operations on their exact Matrix boundary', async () => {
    const bridge = await loadBridge('matrix')
    const queued = {
      id: 'txn-1',
      channelId: '!room:example.org',
      transactionId: 'txn-1',
      deliveryStatus: 'pending',
    } as Message
    invokeMock
      .mockResolvedValueOnce([queued] as never)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)

    await expect(bridge.matrixQueuedMessages()).resolves.toEqual([queued])
    await bridge.matrixRetryQueuedMessage('!room:example.org', 'txn-1')
    await bridge.matrixCancelQueuedMessage('!room:example.org', 'txn-1')

    expect(invokeMock.mock.calls).toEqual([
      ['matrix_queued_messages', undefined],
      [
        'matrix_retry_queued_message',
        { roomId: '!room:example.org', transactionId: 'txn-1' },
      ],
      [
        'matrix_cancel_queued_message',
        { roomId: '!room:example.org', transactionId: 'txn-1' },
      ],
    ])
  })

  it('does not expose Matrix queue commands to the legacy artifact', async () => {
    const bridge = await loadBridge('legacy-p2p')

    await expect(bridge.matrixQueuedMessages()).resolves.toEqual([])
    await bridge.matrixRetryQueuedMessage('channel-1', 'txn-1')
    await bridge.matrixCancelQueuedMessage('channel-1', 'txn-1')

    expect(invokeMock).not.toHaveBeenCalled()
  })

  it('keeps durable drafts on the protected Matrix room boundary', async () => {
    const bridge = await loadBridge('matrix')
    invokeMock
      .mockResolvedValueOnce('restart-safe draft' as never)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)

    await expect(
      bridge.loadComposerDraft('!room:example.org'),
    ).resolves.toBe('restart-safe draft')
    await bridge.saveComposerDraft('!room:example.org', 'updated draft')
    await bridge.clearComposerDraft('!room:example.org')

    expect(invokeMock.mock.calls).toEqual([
      ['matrix_load_composer_draft', { roomId: '!room:example.org' }],
      [
        'matrix_save_composer_draft',
        { roomId: '!room:example.org', body: 'updated draft' },
      ],
      ['matrix_clear_composer_draft', { roomId: '!room:example.org' }],
    ])
  })

  it('keeps received encrypted thumbnails outside renderer IPC', async () => {
    const bridge = await loadBridge('matrix')

    await expect(
      bridge.matrixLoadAttachmentThumbnail(
        '!room:example.org',
        '$event:example.org',
        0,
      ),
    ).resolves.toBeNull()
    expect(invokeMock).not.toHaveBeenCalled()
  })

  it('loads only recognized protected image bytes for the full-size viewer', async () => {
    const bridge = await loadBridge('matrix')
    const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])
    invokeMock
      .mockResolvedValueOnce(png.buffer as never)
      .mockResolvedValueOnce(new Uint8Array([0, 1, 2, 3]).buffer as never)

    await expect(
      bridge.matrixLoadAttachmentImage('!room:example.org', '$event:example.org', 0),
    ).resolves.toEqual({ bytes: png, contentType: 'image/png' })
    expect(invokeMock).toHaveBeenCalledWith(
      'matrix_load_attachment_image',
      {
        roomId: '!room:example.org',
        eventId: '$event:example.org',
        attachmentIndex: 0,
      },
    )
    await expect(
      bridge.matrixLoadAttachmentImage('!room:example.org', '$invalid:example.org', 0),
    ).rejects.toThrow('Protected image failed local validation')
  })

  it('does not create renderer work for repeated protected-thumbnail reads', async () => {
    const bridge = await loadBridge('matrix')

    const first = bridge.matrixLoadAttachmentThumbnail(
      '!room:example.org',
      '$event:example.org',
      0,
    )
    const second = bridge.matrixLoadAttachmentThumbnail(
      '!room:example.org',
      '$event:example.org',
      0,
    )

    await expect(first).resolves.toBeNull()
    await expect(second).resolves.toBeNull()
    expect(invokeMock).not.toHaveBeenCalled()
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
    await expect(bridge.loadComposerDraft('channel-1')).resolves.toBeNull()
    await bridge.saveComposerDraft('channel-1', 'legacy session draft')
    await bridge.clearComposerDraft('channel-1')
    await expect(
      bridge.matrixLoadAttachmentThumbnail('channel-1', 'message-1', 0),
    ).resolves.toBeNull()

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
