import { describe, expect, it } from 'vitest'
import { nextMeshRegion } from './region-navigation'

function region(label: string): HTMLElement {
  const element = document.createElement('section')
  element.setAttribute('aria-label', label)
  return element
}

describe('nextMeshRegion', () => {
  it('moves forward from a focused descendant and wraps', () => {
    const communities = region('Communities')
    const rooms = region('Rooms')
    const conversation = region('Conversation')
    const child = document.createElement('button')
    rooms.appendChild(child)

    expect(nextMeshRegion([communities, rooms, conversation], child)).toBe(conversation)
    expect(nextMeshRegion([communities, rooms, conversation], conversation)).toBe(communities)
  })

  it('moves backward with Shift+F6', () => {
    const communities = region('Communities')
    const rooms = region('Rooms')
    const conversation = region('Conversation')

    expect(nextMeshRegion([communities, rooms, conversation], rooms, true)).toBe(communities)
    expect(nextMeshRegion([communities, rooms, conversation], communities, true)).toBe(conversation)
  })

  it('enters the first or last region when focus is outside the shell', () => {
    const communities = region('Communities')
    const conversation = region('Conversation')
    const outside = document.createElement('button')

    expect(nextMeshRegion([communities, conversation], outside)).toBe(communities)
    expect(nextMeshRegion([communities, conversation], outside, true)).toBe(conversation)
  })
})
