import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import {
  CommandPalette,
  isEditableTarget,
  nextCyclicIndex,
  sortCommandsByRecency,
} from './CommandPalette'
import { COMMAND_PALETTE_OPEN_EVENT } from '../../lib/command-palette'

let mountedRoot: ReturnType<typeof createRoot> | null = null
let mountedContainer: HTMLDivElement | null = null

afterEach(() => {
  if (mountedRoot) act(() => mountedRoot?.unmount())
  mountedContainer?.remove()
  mountedRoot = null
  mountedContainer = null
  document.querySelectorAll('[data-radix-portal]').forEach((portal) => portal.remove())
  window.localStorage.clear()
})

describe('command palette helpers', () => {
  it('moves valid recent commands to the front without losing base order', () => {
    const commands = [
      { id: 'one', label: 'One', keywords: [], run: () => {} },
      { id: 'two', label: 'Two', keywords: [], run: () => {} },
      { id: 'three', label: 'Three', keywords: [], run: () => {} },
    ]

    expect(sortCommandsByRecency(commands, ['three', 'missing', 'one']).map(({ id }) => id))
      .toEqual(['three', 'one', 'two'])
  })

  it('recognizes editable keyboard targets', () => {
    expect(isEditableTarget(document.createElement('textarea'))).toBe(true)
    expect(isEditableTarget(document.createElement('button'))).toBe(false)
    const editable = document.createElement('div')
    editable.contentEditable = 'true'
    expect(isEditableTarget(editable)).toBe(true)
  })

  it('cycles navigation in both directions and starts at the nearest edge', () => {
    expect(nextCyclicIndex(-1, 3, 1)).toBe(0)
    expect(nextCyclicIndex(-1, 3, -1)).toBe(2)
    expect(nextCyclicIndex(2, 3, 1)).toBe(0)
    expect(nextCyclicIndex(0, 3, -1)).toBe(2)
  })

  it('opens from the global Ctrl+K shortcut', () => {
    mountedContainer = document.createElement('div')
    document.body.appendChild(mountedContainer)
    mountedRoot = createRoot(mountedContainer)
    act(() => mountedRoot?.render(createElement(CommandPalette)))

    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'k',
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      }))
    })

    expect(document.querySelector('[role="dialog"]')).not.toBeNull()
    expect(document.querySelector('input[role="combobox"]')).not.toBeNull()
  })

  it('opens from the visible affordance event and renders taxonomy as section headings', () => {
    window.localStorage.setItem(
      'mesh-command-palette-recents',
      JSON.stringify(['action:show-shortcuts']),
    )
    mountedContainer = document.createElement('div')
    document.body.appendChild(mountedContainer)
    mountedRoot = createRoot(mountedContainer)
    act(() => mountedRoot?.render(createElement(CommandPalette)))

    act(() => window.dispatchEvent(new Event(COMMAND_PALETTE_OPEN_EVENT)))

    expect(document.body.textContent).toContain('Recent')
    expect(document.body.textContent).toContain('Actions')
    expect(document.body.textContent).toContain('Show keyboard shortcuts')
    // Group names are headings, not prefixes that contaminate fuzzy matching.
    expect(document.body.textContent).not.toContain('Action · Show keyboard shortcuts')
  })
})
