import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { KitchenSink } from '../dev/KitchenSink'
import { Button } from './Button'
import { StatusDot } from './StatusDot'

describe('design-system primitives', () => {
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

  it('uses semantic tone and variant contracts without changing button defaults', () => {
    act(() => {
      root.render(
        <>
          <Button tone="danger" variant="outline">Remove</Button>
          <Button variant="primary">Create</Button>
        </>,
      )
    })

    const [remove, create] = container.querySelectorAll('button')
    expect(remove.className).toContain('border-status-danger')
    expect(create.className).toContain('bg-accent')
    expect(remove.type).toBe('button')
  })

  it('keeps StatusDot prop-driven and screen-reader labelled', () => {
    act(() => {
      root.render(<StatusDot state="connected" label="Connected to Mesh" />)
    })

    const dot = container.querySelector('[role="img"]')
    expect(dot?.getAttribute('aria-label')).toBe('Connected to Mesh')
    expect(dot?.className).toContain('bg-status-success')
  })

  it('renders the kitchen sink across dark, light, and high-contrast themes', () => {
    act(() => {
      root.render(<KitchenSink />)
    })

    expect(container.querySelector('[data-theme="dark"]')).not.toBeNull()
    expect(container.querySelector('[data-theme="light"]')).not.toBeNull()
    expect(container.querySelector('[data-theme="high-contrast"]')).not.toBeNull()
    expect(container.textContent).toContain('Interactive overlays')
    expect(container.querySelectorAll('button').length).toBeGreaterThan(20)
  })
})
