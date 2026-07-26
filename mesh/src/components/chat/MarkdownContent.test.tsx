import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MarkdownContent } from './MarkdownContent'

describe('MarkdownContent mentions', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    vi.unstubAllGlobals()
  })

  it('resolves member display names and highlights a self-mention', async () => {
    await act(async () => {
      root.render(
        <MarkdownContent
          content="hello @alice:example.org, and @unknown:example.org"
          members={[{ publicKey: '@alice:example.org', displayName: 'Alice' }]}
          ownUserId="@alice:example.org"
        />,
      )
    })

    const mentions = Array.from(container.querySelectorAll<HTMLElement>('[data-mention-id]'))
    expect(mentions).toHaveLength(2)
    expect(mentions[0].textContent).toBe('@Alice')
    expect(mentions[0].getAttribute('title')).toBe('@alice:example.org')
    expect(mentions[0].getAttribute('aria-label')).toBe('Mention @alice:example.org')
    expect(mentions[0].className).toContain('bg-accent/25')
    expect(mentions[1].textContent).toBe('@unknown:example.org')
    expect(container.textContent).toContain('@Alice, and @unknown:example.org')
  })

  it('keeps room-wide mentions plain until an explicit policy enables them', async () => {
    await act(async () => {
      root.render(<MarkdownContent content="@everyone @here @room" />)
    })
    expect(container.querySelectorAll('[data-mention-kind="room-wide"]')).toHaveLength(0)
    expect(container.textContent).toContain('@everyone @here @room')

    await act(async () => {
      root.render(
        <MarkdownContent content="@everyone @here @room" roomWideMentionsAllowed />,
      )
    })
    expect(container.querySelectorAll('[data-mention-kind="room-wide"]')).toHaveLength(3)
  })

  it('does not turn inline code into a mention pill', async () => {
    await act(async () => {
      root.render(<MarkdownContent content="`@alice:example.org`" />)
    })
    expect(container.querySelectorAll('[data-mention-id]')).toHaveLength(0)
    expect(container.textContent).toBe('@alice:example.org')
  })
})
