import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ScrollArea, Slider } from './Primitives'

describe('accessible primitives', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    vi.restoreAllMocks()
  })

  it('gives sliders a 24 pixel pointer target and an associated label', async () => {
    await act(async () => root.render(<Slider label="Microphone volume" value={50} />))

    const slider = container.querySelector<HTMLInputElement>('input[type="range"]')
    expect(slider?.className).toContain('h-6')
    expect(container.querySelector(`label[for="${slider?.id}"]`)?.textContent).toBe(
      'Microphone volume',
    )
  })

  it('does not add a tab stop when the scroll area has no overflow', async () => {
    await act(async () => root.render(<ScrollArea label="Messages">One message</ScrollArea>))

    expect(container.querySelector('[aria-label="Messages"]')?.hasAttribute('tabindex')).toBe(false)
  })

  it('adds a tab stop when content actually overflows', async () => {
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(100)
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(200)
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(100)
    vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockReturnValue(100)

    await act(async () => root.render(<ScrollArea label="Messages">Many messages</ScrollArea>))

    expect(container.querySelector('[aria-label="Messages"]')?.getAttribute('tabindex')).toBe('0')
  })
})
