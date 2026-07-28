import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, vi } from 'vitest'
import { ReactionPicker } from './ReactionPicker'

describe('ReactionPicker custom emoji', () => {
  it('sends the canonical shortcode reaction key', async () => {
    const container = document.createElement('div')
    const root = createRoot(container)
    const onSelect = vi.fn()
    const onClose = vi.fn()

    await act(async () => {
      root.render(
        <ReactionPicker
          onSelect={onSelect}
          onClose={onClose}
          customEmoji={[{
            shortcode: 'party_parrot',
            body: 'Party parrot',
            mxcUri: 'mxc://mesh.test/party',
            contentType: 'image/png',
            width: 32,
            height: 32,
            sizeBytes: 128,
            imageUrl: 'blob:party-parrot',
          }]}
        />,
      )
    })

    await act(async () => {
      container.querySelector<HTMLButtonElement>(
        '[aria-label="React with party_parrot"]',
      )?.click()
    })
    expect(onSelect).toHaveBeenCalledWith(':party_parrot:')
    expect(onClose).toHaveBeenCalledOnce()

    await act(async () => root.unmount())
  })
})
