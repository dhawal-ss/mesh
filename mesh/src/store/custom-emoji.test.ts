import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../lib/bridge', () => ({
  isMatrixBackend: vi.fn(() => true),
  listServerEmoji: vi.fn(async () => [{
    shortcode: 'known_emoji',
    body: 'Known emoji',
    mxcUri: 'mxc://example/known',
    contentType: 'image/png',
    width: 96,
    height: 96,
    sizeBytes: 1024,
  }]),
  loadServerEmojiImage: vi.fn(async () => {
    throw new Error('thumbnail unavailable')
  }),
}))

import * as bridge from '../lib/bridge'
import { useServerEmojiStore } from './custom-emoji'

const EMOJI = {
  shortcode: 'known_emoji',
  body: 'Known emoji',
  mxcUri: 'mxc://example/known',
  contentType: 'image/png',
  width: 96,
  height: 96,
  sizeBytes: 1024,
}

describe('custom emoji metadata resilience', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useServerEmojiStore.getState().clearAll()
    vi.mocked(bridge.listServerEmoji).mockResolvedValue([EMOJI])
  })

  it('preserves known shortcodes when an image preview cannot load', async () => {
    await useServerEmojiStore.getState().load('community-1', true)

    expect(useServerEmojiStore.getState().byCommunity['community-1']).toEqual([
      expect.objectContaining({ shortcode: 'known_emoji' }),
    ])
    expect(useServerEmojiStore.getState().byCommunity['community-1']?.[0]?.imageUrl)
      .toBeUndefined()
  })

  it('cannot repopulate old-account emoji after account cleanup', async () => {
    let resolveMetadata!: (value: typeof EMOJI[]) => void
    vi.mocked(bridge.listServerEmoji).mockReturnValueOnce(new Promise((resolve) => {
      resolveMetadata = resolve
    }))

    const oldLoad = useServerEmojiStore.getState().load('community-1', true)
    await Promise.resolve()
    useServerEmojiStore.getState().clearAll()
    resolveMetadata([EMOJI])
    await oldLoad

    expect(useServerEmojiStore.getState().byCommunity).toEqual({})
    expect(useServerEmojiStore.getState().loading).toEqual({})
    expect(bridge.loadServerEmojiImage).not.toHaveBeenCalled()
  })
})
