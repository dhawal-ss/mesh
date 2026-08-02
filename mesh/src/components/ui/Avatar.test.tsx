import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Avatar } from './Avatar'

describe('Avatar pixel defaults', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  it('uses the profile pixel mark when no custom image exists', () => {
    act(() => {
      root.render(<Avatar color="var(--avatar-violet)" name="Taylor" />)
    })

    expect(container.querySelector('.mesh-pixel-avatar-default')).not.toBeNull()
    expect(container.querySelector('.mesh-pixel-mark-profile')).not.toBeNull()
    expect(container.querySelector('[role="img"]')?.getAttribute('aria-label')).toBe('Taylor')
  })

  it('uses the community pixel mark for community fallbacks', () => {
    act(() => {
      root.render(
        <Avatar
          color="var(--avatar-emerald)"
          name="Field Notes"
          variant="community"
        />,
      )
    })

    expect(container.querySelector('.mesh-pixel-mark-community')).not.toBeNull()
  })

  it('keeps a custom image as the authoritative identity', () => {
    act(() => {
      root.render(
        <Avatar
          color="var(--avatar-violet)"
          name="Taylor"
          imageUrl="https://example.test/taylor.png"
        />,
      )
    })

    expect(container.querySelector('img')?.getAttribute('src')).toBe(
      'https://example.test/taylor.png',
    )
    expect(container.querySelector('.mesh-pixel-mark')).toBeNull()
  })

  it('falls back to pixel art when a custom image fails', () => {
    act(() => {
      root.render(
        <Avatar
          color="var(--avatar-violet)"
          name="Taylor"
          imageUrl="https://example.test/missing.png"
        />,
      )
    })

    act(() => {
      container.querySelector('img')?.dispatchEvent(new Event('error'))
    })

    expect(container.querySelector('.mesh-pixel-avatar-default')).not.toBeNull()
    expect(container.querySelector('.mesh-pixel-mark-profile')).not.toBeNull()
  })
})
