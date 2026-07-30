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

  it('uses one toolbar tab stop, named emoji, and arrow-key navigation', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    const onClose = vi.fn()
    await act(async () => {
      root.render(<ReactionPicker onSelect={() => {}} onClose={onClose} />)
    })

    const buttons = [...container.querySelectorAll<HTMLButtonElement>('button')]
    expect(buttons.filter((button) => button.tabIndex === 0)).toHaveLength(1)
    expect(buttons[0]?.getAttribute('aria-label')).toBe('React with thumbs up')
    buttons[0]?.focus()
    await act(async () => {
      buttons[0]?.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'ArrowRight',
        bubbles: true,
        cancelable: true,
      }))
    })
    expect(document.activeElement).toBe(buttons[1])
    expect(buttons[1]?.tabIndex).toBe(0)

    await act(async () => {
      container.querySelector('[role="toolbar"]')
        ?.dispatchEvent(new MouseEvent('mouseleave', { bubbles: true }))
    })
    expect(onClose).not.toHaveBeenCalled()

    await act(async () => root.unmount())
    container.remove()
  })
})
