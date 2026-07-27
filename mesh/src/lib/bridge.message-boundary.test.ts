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

  it('loads protected thumbnails as raw bytes without accepting media metadata', async () => {
    const bridge = await loadBridge('matrix')
    invokeMock.mockResolvedValueOnce(
      new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]).buffer as never,
    )

    await expect(
      bridge.matrixLoadAttachmentThumbnail(
        '!room:example.org',
        '$event:example.org',
        0,
      ),
    ).resolves.toEqual(new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]))
    expect(invokeMock).toHaveBeenCalledWith(
      'matrix_load_attachment_thumbnail',
      {
        roomId: '!room:example.org',
        eventId: '$event:example.org',
        attachmentIndex: 0,
      },
    )
  })

  it('rejects malformed or oversized thumbnail IPC responses locally', async () => {
    const bridge = await loadBridge('matrix')
    invokeMock
      .mockResolvedValueOnce(new Uint8Array([]).buffer as never)
      .mockResolvedValueOnce(new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7]) as never)
      .mockResolvedValueOnce(new Uint8Array(2 * 1024 * 1024 + 1).buffer as never)

    await expect(
      bridge.matrixLoadAttachmentThumbnail('!room:example.org', '$empty:example.org', 0),
    ).rejects.toThrow('Protected preview failed local validation')
    await expect(
      bridge.matrixLoadAttachmentThumbnail('!room:example.org', '$wrong:example.org', 0),
    ).rejects.toThrow('Protected preview failed local validation')
    await expect(
      bridge.matrixLoadAttachmentThumbnail('!room:example.org', '$large:example.org', 0),
    ).rejects.toThrow('Protected preview failed local validation')
  })

  it('coalesces identical protected thumbnail reads without retry amplification', async () => {
    const bridge = await loadBridge('matrix')
    let resolveRead: ((value: number[]) => void) | undefined
    invokeMock.mockImplementationOnce(() => (
      new Promise<number[]>((resolve) => {
        resolveRead = resolve
      }) as never
    ))

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
    resolveRead?.([137, 80, 78, 71, 13, 10, 26, 10])

    await expect(first).resolves.toEqual(
      new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
    )
    await expect(second).resolves.toEqual(
      new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
    )
    expect(invokeMock).toHaveBeenCalledTimes(1)
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
