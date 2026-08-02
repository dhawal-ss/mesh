import { afterEach, describe, expect, it, vi } from 'vitest'
import { isTauri } from '@tauri-apps/api/core'
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
      transferId: expect.any(String),
    })
  })

  it('reports honest size and executable-extension errors', () => {
    expect(() => validateAttachment('archive.zip', MAX_ATTACHMENT_BYTES + 1))
      .toThrow('100.0 MB')
    expect(() => validateAttachment('installer.MSI', 12))
      .toThrow('can execute code')
  })

  it('materializes a clipboard image only inside the browser preview', async () => {
    const arrayBuffer = vi.fn(async () => new Uint8Array([1, 2, 3, 4]).buffer)
    const file = {
      name: '',
      type: 'image/png',
      size: 4,
      arrayBuffer,
    } as unknown as File

    const staged = await stageWebFile(file)
    expect(staged).toEqual({
      name: 'pasted-image.png',
      size: 4,
      grant: expect.stringMatching(/^browser-preview:/),
      contentType: 'image/png',
      source: 'temporary',
      stagingToken: expect.stringMatching(/^browser-preview:/),
      transferId: expect.any(String),
    })
    expect(staged.stagingToken).toBe(staged.grant)
    expect(arrayBuffer).toHaveBeenCalledOnce()
  })

  it('rejects an oversized pasted blob before reading it', async () => {
    const file = {
      name: 'large.gif',
      type: 'image/gif',
      size: MAX_PASTED_ATTACHMENT_BYTES + 1,
      arrayBuffer: vi.fn(),
    } as unknown as File

    await expect(stageWebFile(file)).rejects.toThrow('use the attachment button')
    expect(file.arrayBuffer).not.toHaveBeenCalled()
  })

  it('rejects a 1 GiB desktop payload without reading or copying its bytes', async () => {
    vi.mocked(isTauri).mockReturnValue(true)
    const file = {
      name: 'memory-pressure.bin',
      type: 'application/octet-stream',
      size: 1024 * 1024 * 1024,
      arrayBuffer: vi.fn(),
    } as unknown as File

    await expect(stageWebFile(file)).rejects.toThrow('limited to 100 MB')
    expect(file.arrayBuffer).not.toHaveBeenCalled()
  })

  it('rejects even small WebView files before allocating a byte array', async () => {
    vi.mocked(isTauri).mockReturnValue(true)
    const file = {
      name: 'clipboard.png',
      type: 'image/png',
      size: 4,
      arrayBuffer: vi.fn(),
    } as unknown as File

    await expect(stageWebFile(file)).rejects.toThrow('attachment button')
    expect(file.arrayBuffer).not.toHaveBeenCalled()
  })
})
