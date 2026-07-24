import { afterEach, describe, expect, it, vi } from 'vitest'
import * as bridge from './bridge'
import {
  MAX_ATTACHMENT_BYTES,
  MAX_PASTED_ATTACHMENT_BYTES,
  stagedFileFromGrant,
  stageWebFile,
  validateAttachment,
} from './attachments'

describe('attachment intake', () => {
  afterEach(() => vi.restoreAllMocks())

  it('projects an opaque native grant without inventing a filesystem path', () => {
    expect(stagedFileFromGrant({
      grant: 'opaque-grant',
      name: 'cat.gif',
      size: 123,
      contentType: 'image/gif',
    })).toEqual({
      grant: 'opaque-grant',
      name: 'cat.gif',
      size: 123,
      contentType: 'image/gif',
      source: 'native',
    })
  })

  it('reports honest size and executable-extension errors', () => {
    expect(() => validateAttachment('archive.zip', MAX_ATTACHMENT_BYTES + 1))
      .toThrow('100.0 MB')
    expect(() => validateAttachment('installer.MSI', 12))
      .toThrow('can execute code')
  })

  it('materializes a clipboard image through bounded native staging', async () => {
    const stage = vi.spyOn(bridge, 'stageAttachmentBytes').mockResolvedValue({
      token: 'opaque-token',
      grant: 'opaque-token',
      name: 'pasted-image.png',
      size: 4,
      contentType: 'image/png',
    })
    const file = new File([new Uint8Array([1, 2, 3, 4])], '', { type: 'image/png' })

    await expect(stageWebFile(file)).resolves.toEqual({
      name: 'pasted-image.png',
      size: 4,
      grant: 'opaque-token',
      contentType: 'image/png',
      source: 'temporary',
      stagingToken: 'opaque-token',
    })
    expect(stage).toHaveBeenCalledWith('pasted-image.png', [1, 2, 3, 4])
  })

  it('rejects an oversized pasted blob before crossing IPC', async () => {
    const stage = vi.spyOn(bridge, 'stageAttachmentBytes')
    const file = {
      name: 'large.gif',
      type: 'image/gif',
      size: MAX_PASTED_ATTACHMENT_BYTES + 1,
      arrayBuffer: vi.fn(),
    } as unknown as File

    await expect(stageWebFile(file)).rejects.toThrow('use the attachment button')
    expect(stage).not.toHaveBeenCalled()
    expect(file.arrayBuffer).not.toHaveBeenCalled()
  })
})
