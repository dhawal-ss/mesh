import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ReactionPicker } from './ReactionPicker'

const NATIVE_INPUT_VALUE_SETTER = Object.getOwnPropertyDescriptor(
  window.HTMLInputElement.prototype,
  'value',
)?.set

function typeSearch(input: HTMLInputElement, value: string) {
  NATIVE_INPUT_VALUE_SETTER?.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

describe('ReactionPicker', () => {
  let container: HTMLDivElement
  let root: Root

  const allButtons = () => [...container.querySelectorAll<HTMLButtonElement>('button')]
  // The emoji grid is the roving-tabindex widget under test; the category
  // strip is a separate toolbar, so scope grid assertions by accessible name.
  const gridButtons = () =>
    allButtons().filter((button) => button.getAttribute('aria-label')?.startsWith('React with '))
  const searchInput = () => {
    const input = container.querySelector<HTMLInputElement>('input')
    if (!input) throw new Error('search input was not rendered')
    return input
  }

  const customEmoji = [
    {
      shortcode: 'party_parrot',
      body: 'party parrot',
      mxcUri: 'mxc://example.org/parrot',
      contentType: 'image/png',
      width: 32,
      height: 32,
      sizeBytes: 128,
      imageUrl: 'blob:parrot',
    },
  ]

  beforeEach(() => {
    window.localStorage.clear()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    window.localStorage.clear()
  })

  it('leads with frequent emoji, keeps one grid tab stop, names buttons, and roves with arrows', async () => {
    await act(async () => {
      root.render(<ReactionPicker onSelect={() => {}} onClose={() => {}} />)
    })

    const grid = gridButtons()
    expect(grid.filter((button) => button.tabIndex === 0)).toHaveLength(1)
    expect(grid[0]?.getAttribute('aria-label')).toBe('React with thumbs up')

    grid[0]?.focus()
    await act(async () => {
      grid[0]?.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'ArrowRight',
        bubbles: true,
        cancelable: true,
      }))
    })
    expect(document.activeElement).toBe(grid[1])
    expect(grid[1]?.tabIndex).toBe(0)
  })

  it('does not close on mouse leave', async () => {
    const onClose = vi.fn()
    await act(async () => {
      root.render(<ReactionPicker onSelect={() => {}} onClose={onClose} />)
    })

    await act(async () => {
      container
        .querySelector('.mesh-emoji-picker')
        ?.dispatchEvent(new MouseEvent('mouseleave', { bubbles: true }))
    })
    expect(onClose).not.toHaveBeenCalled()
  })

  it('filters by search text and clears the query with Escape instead of closing', async () => {
    const onClose = vi.fn()
    await act(async () => {
      root.render(<ReactionPicker onSelect={() => {}} onClose={onClose} />)
    })

    await act(async () => {
      typeSearch(searchInput(), 'rocket')
    })
    const results = gridButtons()
    expect(results).toHaveLength(1)
    expect(results[0]?.getAttribute('aria-label')).toBe('React with rocket')

    await act(async () => {
      searchInput().dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Escape',
        bubbles: true,
        cancelable: true,
      }))
    })
    expect(searchInput().value).toBe('')
    expect(gridButtons().length).toBeGreaterThan(1)
    expect(onClose).not.toHaveBeenCalled()
  })

  it('commits a selection, reports it, closes, and remembers it', async () => {
    const onSelect = vi.fn()
    const onClose = vi.fn()
    await act(async () => {
      root.render(<ReactionPicker onSelect={onSelect} onClose={onClose} />)
    })

    await act(async () => {
      gridButtons()[0]?.click()
    })
    expect(onSelect).toHaveBeenCalledWith('👍')
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(window.localStorage.getItem('mesh:emoji:recent')).toContain('👍')
  })

  it('surfaces a Recently used section from stored history', async () => {
    window.localStorage.setItem('mesh:emoji:recent', JSON.stringify(['🚀']))
    await act(async () => {
      root.render(<ReactionPicker onSelect={() => {}} onClose={() => {}} />)
    })

    expect(container.textContent).toContain('Recently used')
    expect(gridButtons()[0]?.getAttribute('aria-label')).toBe('React with rocket')
  })

  it('jumps to a category and focuses its first emoji from the category strip', async () => {
    await act(async () => {
      root.render(<ReactionPicker onSelect={() => {}} onClose={() => {}} />)
    })

    const heartsTab = allButtons().find(
      (button) => button.getAttribute('aria-label') === 'Jump to Hearts',
    )
    expect(heartsTab).toBeTruthy()

    await act(async () => {
      heartsTab?.click()
    })
    expect(document.activeElement?.getAttribute('aria-label')).toBe('React with red heart')
  })

  it('surfaces a This community section and commits custom emoji as a shortcode', async () => {
    const onSelect = vi.fn()
    const onClose = vi.fn()
    await act(async () => {
      root.render(
        <ReactionPicker onSelect={onSelect} onClose={onClose} customEmoji={customEmoji} />,
      )
    })

    expect(container.textContent).toContain('This community')
    const parrot = allButtons().find(
      (button) => button.getAttribute('aria-label') === 'React with party_parrot',
    )
    expect(parrot).toBeTruthy()
    expect(parrot?.querySelector('img')?.getAttribute('src')).toBe('blob:parrot')

    await act(async () => {
      parrot?.click()
    })
    expect(onSelect).toHaveBeenCalledWith(':party_parrot:')
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('includes custom emoji in search results', async () => {
    await act(async () => {
      root.render(<ReactionPicker onSelect={() => {}} onClose={() => {}} customEmoji={customEmoji} />)
    })

    await act(async () => {
      typeSearch(searchInput(), 'parrot')
    })
    const results = gridButtons()
    expect(results).toHaveLength(1)
    expect(results[0]?.getAttribute('aria-label')).toBe('React with party_parrot')
  })
})
