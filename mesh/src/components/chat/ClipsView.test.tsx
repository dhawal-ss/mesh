import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ClipsView } from './ClipsView'
import type { Clip } from '../../lib/room-shape'

function clip(patch: Partial<Clip> = {}): Clip {
  return {
    id: '$one',
    authorDisplayName: 'Maya Chen',
    caption: 'warmer lantern glow',
    attachments: [{
      fileHash: 'abc',
      filename: 'lantern.png',
      size: 2048,
      chunks: 1,
      sourcePeerId: 'peer',
      contentType: 'image/png',
    }],
    reactionCount: 2,
    timestamp: '2026-08-01T10:04:00.000Z',
    ...patch,
  } as Clip
}

describe('ClipsView', () => {
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
  })

  async function render(clips: Clip[], onOpen = vi.fn()) {
    await act(async () => {
      root.render(
        <ClipsView
          roomId="!art:mesh.test"
          channelName="screenshots"
          clips={clips}
          onOpenClip={onOpen}
        />,
      )
    })
    return onOpen
  }

  it('gives every clip its own tile', async () => {
    await render([clip({ id: '$a' }), clip({ id: '$b' })])

    expect(container.querySelectorAll('[data-clip-id]')).toHaveLength(2)
  })

  it('names who posted each clip, because a gallery still has authors', async () => {
    await render([clip()])

    expect(container.textContent).toContain('Maya Chen')
  })

  it('shows the caption when there is one', async () => {
    await render([clip({ caption: 'warmer lantern glow' })])

    expect(container.textContent).toContain('warmer lantern glow')
  })

  it('leaves no empty caption line on a clip posted without words', async () => {
    await render([clip({ caption: '   ' })])

    expect(container.querySelector('[data-clip-caption]')).toBeNull()
  })

  it('counts reactions in text rather than colour alone', async () => {
    await render([clip({ reactionCount: 7 })])

    expect(container.querySelector('[data-clip-reactions]')?.textContent).toContain('7')
  })

  it('says nothing about reactions on a clip nobody has reacted to', async () => {
    await render([clip({ reactionCount: 0 })])

    expect(container.querySelector('[data-clip-reactions]')).toBeNull()
  })

  it('opens the underlying message so a clip is never a dead end', async () => {
    const onOpen = await render([clip({ id: '$pic' })])

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-clip-id="$pic"] button')?.click()
    })

    expect(onOpen).toHaveBeenCalledWith('$pic')
  })

  it('explains an empty room instead of showing a bare grid', async () => {
    await render([])

    expect(container.textContent).toContain('No clips yet')
    expect(container.querySelectorAll('[data-clip-id]')).toHaveLength(0)
  })

  it('names the room in its own accessible name', async () => {
    await render([clip()])

    const region = container.querySelector('[aria-label]')
    expect(region?.getAttribute('aria-label')).toContain('screenshots')
  })
})
