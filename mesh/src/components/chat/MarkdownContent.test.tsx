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
    expect(mentions[0].getAttribute('title')).toBeNull()
    // Non-interactive mention text keeps its readable label instead of relying on dropped span aria-label.
    expect(mentions[0].hasAttribute('aria-label')).toBe(false)
    expect(mentions[0].className).toContain('bg-container-accent-active')
    expect(mentions[1].textContent).toBe('@unknown:example.org')
    expect(container.textContent).toContain('@Alice, and @unknown:example.org')
  })

  it('keeps room-wide mentions plain unless the message actually carried the flag', async () => {
    // Anyone can type the words. Only a sender with the power level produces a
    // message that set m.mentions.room, and only that message may look like a
    // notification -- otherwise the highlight tells a reader they were paged
    // when nothing reached them.
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
    expect(container.querySelectorAll('[data-mention-kind="room-wide"]')).toHaveLength(2)
  })

  it('leaves @here plain even on a message that notified the room', async () => {
    // m.mentions carries one room-wide flag and no online-only variant, so
    // highlighting @here would promise an audience nothing can deliver. It
    // stays two words until there is a representation for it to mean.
    await act(async () => {
      root.render(<MarkdownContent content="@here standup in five" roomWideMentionsAllowed />)
    })
    expect(container.querySelectorAll('[data-mention-kind="room-wide"]')).toHaveLength(0)
    expect(container.textContent).toContain('@here standup in five')
  })

  it('does not turn inline code into a mention pill', async () => {
    await act(async () => {
      root.render(<MarkdownContent content="`@alice:example.org`" />)
    })
    expect(container.querySelectorAll('[data-mention-id]')).toHaveLength(0)
    expect(container.textContent).toBe('@alice:example.org')
  })

  it('only pills full account IDs or display names backed by mention metadata', async () => {
    await act(async () => {
      root.render(
        <MarkdownContent
          content="@Alice @types/node @ts-ignore email me @ work @unknown:example.org"
          members={[{ publicKey: '@alice:example.org', displayName: 'Alice' }]}
          mentionUserIds={['@alice:example.org']}
        />,
      )
    })

    const mentions = [...container.querySelectorAll<HTMLElement>('[data-mention-id]')]
    expect(mentions).toHaveLength(2)
    expect(mentions[0].dataset.mentionId).toBe('@alice:example.org')
    expect(mentions[0].textContent).toBe('@Alice')
    expect(mentions[1].dataset.mentionId).toBe('@unknown:example.org')
    expect(container.textContent).toContain('@types/node @ts-ignore email me @ work')
  })

  it('keeps a display-name token plain without mention metadata', async () => {
    await act(async () => {
      root.render(
        <MarkdownContent
          content="hello @Alice"
          members={[{ publicKey: '@alice:example.org', displayName: 'Alice' }]}
        />,
      )
    })

    expect(container.querySelectorAll('[data-mention-id]')).toHaveLength(0)
    expect(container.textContent).toBe('hello @Alice')
  })

  it('autolinks bare safe URLs and renders rejected markdown links as plain body text', async () => {
    await act(async () => {
      root.render(
        <MarkdownContent
          content="Visit https://example.org/docs. Do not [run this](javascript:alert(1))."
        />,
      )
    })

    const link = container.querySelector<HTMLAnchorElement>('a')
    expect(link?.getAttribute('href')).toBe('https://example.org/docs')
    expect(link?.textContent).toBe('https://example.org/docs')
    expect(container.textContent).toContain('docs. Do not run this.')
    expect(container.querySelector('a[href^="javascript:"]')).toBeNull()
    expect(container.querySelector('.text-text-link')?.textContent).not.toBe('run this')
  })

  it('keeps safe links visible without adding a hostname preview card', async () => {
    await act(async () => {
      root.render(
        <MarkdownContent
          content="Read [the guide](https://docs.example.org/start) before https://other.example.org."
        />,
      )
    })

    const links = container.querySelectorAll<HTMLAnchorElement>('a')
    expect(links).toHaveLength(2)
    expect(links[0]?.getAttribute('href')).toBe('https://docs.example.org/start')
    expect(links[0]?.getAttribute('rel')).toBe('noopener noreferrer')
    expect(links[1]?.textContent).toBe('https://other.example.org')
    expect(container.querySelector('[data-link-preview="true"]')).toBeNull()
    expect(container.querySelector('img')).toBeNull()
  })

  it('does not preview links that only appear inside code', async () => {
    await act(async () => {
      root.render(
        <MarkdownContent content={'`https://example.org/inline`\n```\nhttps://example.org/block\n```'} />,
      )
    })

    expect(container.querySelector('[data-link-preview="true"]')).toBeNull()
  })

  it('preserves shortcode text and inline code without renderer custom emoji', async () => {
    await act(async () => {
      root.render(
        <MarkdownContent content="Known :party_parrot: unknown :missing: code `:party_parrot:`" />,
      )
    })

    expect(container.querySelector('img')).toBeNull()
    expect(container.textContent).toContain('Known :party_parrot: unknown :missing: code :party_parrot:')
    expect(container.querySelector('code')?.textContent).toBe(':party_parrot:')
  })

  it('renders headings, ordered and unordered lists, nested lists, and block quotes', async () => {
    await act(async () => {
      root.render(
        <MarkdownContent
          content={'# Release notes\n1. First step\n2. **Second step**\n   - Nested detail\n> Calm guidance\n>> Nested context'}
        />,
      )
    })

    expect(container.querySelector('h2')?.textContent).toBe('Release notes')
    const ordered = container.querySelector('ol')
    expect(ordered?.children).toHaveLength(2)
    expect(ordered?.querySelector('strong')?.textContent).toBe('Second step')
    expect(ordered?.querySelector('ul li')?.textContent).toBe('Nested detail')
    const quote = container.querySelector('blockquote')
    expect(quote?.textContent).toContain('Calm guidance')
    expect(quote?.querySelector('blockquote')?.textContent).toContain('Nested context')
  })

  it('keeps spoilers concealed until an explicit accessible reveal action', async () => {
    await act(async () => {
      root.render(<MarkdownContent content="Before ||secret **detail**|| after" />)
    })

    const spoiler = container.querySelector<HTMLButtonElement>('button[aria-expanded]')
    const concealed = spoiler?.querySelector('span[aria-hidden]')
    expect(spoiler?.getAttribute('aria-expanded')).toBe('false')
    expect(spoiler?.querySelector('strong')?.textContent).toBe('detail')
    // Concealed: the body is marked aria-hidden so it is never announced, and
    // the button names itself with the prompt alone.
    expect(concealed?.getAttribute('aria-hidden')).toBe('true')
    expect(spoiler?.textContent).toBe('Reveal spoilersecret detail')

    await act(async () => {
      spoiler?.click()
    })
    expect(spoiler?.getAttribute('aria-expanded')).toBe('true')
    // Revealed: the text has to reach a screen reader. It can only do that as
    // part of the button's own content, so the button must carry no aria-label:
    // a label replaces the accessible name and silently drops the message.
    expect(spoiler?.hasAttribute('aria-label')).toBe(false)
    expect(concealed?.getAttribute('aria-hidden')).toBe('false')
    expect(spoiler?.textContent).toBe('Hide spoiler: secret detail')
  })

  it('escapes injection attempts inside every new block construct', async () => {
    await act(async () => {
      root.render(
        <MarkdownContent
          content={'# <img src=x onerror=alert(1)>\n- [unsafe](javascript:alert(1))\n> <script>alert(1)</script>\n||<svg onload=alert(1)>||'}
        />,
      )
    })

    expect(container.querySelector('img')).toBeNull()
    expect(container.querySelector('script')).toBeNull()
    expect(container.querySelector('svg')).toBeNull()
    expect(container.querySelector('a[href^="javascript:"]')).toBeNull()
    expect(container.textContent).toContain('<img src=x onerror=alert(1)>')
    expect(container.textContent).toContain('unsafe')
    expect(container.textContent).toContain('<script>alert(1)</script>')
  })
})

describe('MarkdownContent custom emoji', () => {
  let container: HTMLDivElement
  let root: Root

  const emoji = [
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

  it('renders a known :shortcode: as a community emoji image', async () => {
    await act(async () => {
      root.render(<MarkdownContent content="nice :party_parrot: work" customEmoji={emoji} />)
    })
    const image = container.querySelector<HTMLImageElement>('img')
    expect(image).not.toBeNull()
    expect(image?.getAttribute('src')).toBe('blob:parrot')
    expect(image?.getAttribute('alt')).toBe(':party_parrot:')
    expect(container.textContent).not.toContain(':party_parrot:')
  })

  it('leaves an unknown or unloaded :shortcode: as literal text', async () => {
    await act(async () => {
      root.render(<MarkdownContent content="pending :party_parrot:" />)
    })
    expect(container.querySelector('img')).toBeNull()
    expect(container.textContent).toContain(':party_parrot:')
  })
})

describe('MarkdownContent emphasis', () => {
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

  const render = async (content: string) => {
    await act(async () => {
      root.render(<MarkdownContent content={content} />)
    })
  }

  // An identifier that italicises loses its underscores entirely, so the text
  // on screen stops being the text that was sent. These are the shapes a
  // developer audience types constantly.
  it.each([
    'MAX_DRAFT_BYTES',
    'snake_case_names',
    '__init__',
    'file_name_utils.ts',
    'a_b_c',
  ])('leaves the intraword underscores in %s alone', async (identifier) => {
    await render(identifier)
    expect(container.textContent).toBe(identifier)
    expect(container.querySelector('em')).toBeNull()
  })

  it('still italicises underscores that stand outside a word', async () => {
    await render('an _emphasised_ word')
    expect(container.querySelector('em')?.textContent).toBe('emphasised')
    expect(container.textContent).toBe('an emphasised word')
  })

  it('italicises underscores flanked by punctuation', async () => {
    await render('(_aside_)')
    expect(container.querySelector('em')?.textContent).toBe('aside')
  })

  it('keeps intraword asterisk emphasis, which CommonMark allows', async () => {
    await render('un*frigging*believable')
    expect(container.querySelector('em')?.textContent).toBe('frigging')
  })

  it('does not let an identifier swallow a later real emphasis', async () => {
    await render('MAX_DRAFT_BYTES and _this_')
    expect(container.querySelector('em')?.textContent).toBe('this')
    expect(container.textContent).toBe('MAX_DRAFT_BYTES and this')
  })
})

describe('MarkdownContent code blocks', () => {
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

  it('renders code in the primary foreground, not the muted one', async () => {
    // Muting the one kind of content a reader most needs to read precisely.
    await act(async () => {
      root.render(<MarkdownContent content={'```\nconst x = 1\n```'} />)
    })
    const pre = container.querySelector('pre')
    expect(pre?.className).toContain('text-content-primary')
    expect(pre?.className).not.toContain('text-secondary')
  })

  it('offers a copy button, because selection inside the virtualizer is fragile', async () => {
    const writeText = vi.fn(async () => {})
    vi.stubGlobal('navigator', { clipboard: { writeText } })

    await act(async () => {
      root.render(<MarkdownContent content={'```ts\nconst x = 1\n```'} />)
    })
    const copy = Array.from(container.querySelectorAll('button'))
      .find((button) => button.textContent === 'Copy')
    expect(copy).toBeTruthy()

    await act(async () => {
      copy!.click()
      await Promise.resolve()
    })
    expect(writeText).toHaveBeenCalledWith('const x = 1')
  })

  it('shows the fence language instead of writing it to a dead attribute', async () => {
    await act(async () => {
      root.render(<MarkdownContent content={'```ts\nconst x = 1\n```'} />)
    })
    expect(container.textContent).toContain('ts')
    expect(container.querySelector('code')?.getAttribute('data-lang')).toBe('ts')
  })
})
