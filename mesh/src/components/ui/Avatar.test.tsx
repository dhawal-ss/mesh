import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as bridge from '../../lib/bridge'
import { MAX_CACHED_AVATARS } from '../../lib/matrix-avatar-source'
import { useMatrixAvatarStore } from '../../store/matrix-avatars'
import { Avatar } from './Avatar'

describe('Avatar geometry: the circle is a person', () => {
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

  const avatar = () => container.querySelector('.mesh-pixel-avatar')!

  it('draws a person as a circle', () => {
    act(() => {
      root.render(<Avatar color="var(--avatar-blue)" name="Maya" seed="@maya:example.org" />)
    })
    expect(avatar().className).toContain('rounded-round')
  })

  it('draws a community as a square, because a community is not a person', () => {
    act(() => {
      root.render(<Avatar color="var(--avatar-blue)" name="Bauhaus" variant="community" seed="!room:example.org" />)
    })
    expect(avatar().className).toContain('rounded-panel')
    expect(avatar().className).not.toContain('rounded-round')
  })

  it('lets a caller keep overriding the shape', () => {
    act(() => {
      root.render(<Avatar color="var(--avatar-blue)" name="Maya" seed="@maya:example.org" className="!rounded-panel" />)
    })
    expect(avatar().className).toContain('!rounded-panel')
  })
})

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

/*
    Every Matrix avatar arrives as an `mxc://` URI, and Mesh's content security
    policy allows images from 'self', data:, and blob: only. So an MXC URI put
    straight into `src` was refused by the CSP, landed in the error handler
    above, and rendered as the generated mark: identical to "no picture set".
    Every caller passed one through, so no profile picture in Mesh was ever
    visible. These cases exist so that cannot come back silently.
*/
describe('Avatar with a Matrix picture', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    vi.stubGlobal('URL', Object.assign(URL, {
      createObjectURL: vi.fn(() => 'blob:resolved-avatar'),
      revokeObjectURL: vi.fn(),
    }))
    vi.spyOn(bridge, 'isMatrixBackend').mockReturnValue(true)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    // clearAll rather than resetting the fields: a test that leaves a load
    // unresolved on purpose otherwise leaves it in flight, and the next test
    // asking for the same picture gets skipped instead of resolved.
    useMatrixAvatarStore.getState().clearAll()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('never puts an mxc URI in the element the policy would refuse it from', async () => {
    vi.spyOn(bridge, 'matrixLoadProfileAvatar')
      .mockResolvedValue(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))

    await act(async () => {
      root.render(
        <Avatar color="var(--avatar-violet)" name="Taylor" imageUrl="mxc://example.org/taylor" />,
      )
    })

    const sources = Array.from(container.querySelectorAll('img'))
      .map((image) => image.getAttribute('src'))
    expect(sources.some((source) => source?.startsWith('mxc://'))).toBe(false)
  })

  it('shows the resolved picture once the native reader returns its bytes', async () => {
    const load = vi.spyOn(bridge, 'matrixLoadProfileAvatar')
      .mockResolvedValue(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))

    await act(async () => {
      root.render(
        <Avatar color="var(--avatar-violet)" name="Taylor" imageUrl="mxc://example.org/taylor" />,
      )
    })
    // The effect starts the load; the bytes land a microtask later.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    expect(load).toHaveBeenCalledWith('mxc://example.org/taylor')
    expect(container.querySelector('img')?.getAttribute('src')).toBe('blob:resolved-avatar')
  })

  it('keeps the generated mark while a picture is still loading', async () => {
    vi.spyOn(bridge, 'matrixLoadProfileAvatar').mockReturnValue(new Promise(() => {}))

    await act(async () => {
      root.render(
        <Avatar color="var(--avatar-violet)" name="Taylor" imageUrl="mxc://example.org/taylor" />,
      )
    })

    // Not an empty box and not a spinner: an avatar that has never resolved
    // looks the same as one nobody set, which is the honest thing to show.
    expect(container.querySelector('.mesh-pixel-mark-profile')).not.toBeNull()
    expect(container.querySelector('img')).toBeNull()
  })

  it('falls back to the generated mark when a picture cannot be read', async () => {
    vi.spyOn(bridge, 'matrixLoadProfileAvatar').mockRejectedValue(new Error('gone'))

    await act(async () => {
      root.render(
        <Avatar color="var(--avatar-violet)" name="Taylor" imageUrl="mxc://example.org/taylor" />,
      )
    })
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    expect(container.querySelector('.mesh-pixel-mark-profile')).not.toBeNull()
  })

  /*
      A picture on screen has to survive the cache filling up somewhere else.
      Eviction revokes the object URL, and a revoked URL reaches `onError` and
      renders as the generated mark, so the person's picture would disappear
      from a row still showing them with nothing to explain it.
  */
  function fillCacheLeavingOldest(oldest: string) {
    const entries: Record<string, { status: 'ready'; objectUrl: string }> = {}
    const recency: string[] = []
    for (let index = 0; index < MAX_CACHED_AVATARS; index += 1) {
      const key = `mxc://example.org/filler-${index}`
      entries[key] = { status: 'ready', objectUrl: `blob:filler-${index}` }
      recency.push(key)
    }
    useMatrixAvatarStore.setState((state) => ({
      entries: { ...state.entries, ...entries },
      recency: [...recency, oldest],
    }))
  }

  it('keeps showing a picture when the cache fills up elsewhere', async () => {
    vi.spyOn(bridge, 'matrixLoadProfileAvatar')
      .mockResolvedValue(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))

    await act(async () => {
      root.render(
        <Avatar color="var(--avatar-violet)" name="Taylor" imageUrl="mxc://example.org/taylor" />,
      )
    })
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    fillCacheLeavingOldest('mxc://example.org/taylor')

    await act(async () => {
      useMatrixAvatarStore.getState().resolve('mxc://example.org/one-more')
    })

    expect(useMatrixAvatarStore.getState().entries['mxc://example.org/taylor']?.objectUrl)
      .toBe('blob:resolved-avatar')
    expect(container.querySelector('img')?.getAttribute('src')).toBe('blob:resolved-avatar')
  })

  it('stops holding a picture once nothing is showing it', async () => {
    // The other half of the same bookkeeping: a hold that outlived its element
    // would pin every picture ever displayed and the cap would stop meaning
    // anything.
    vi.spyOn(bridge, 'matrixLoadProfileAvatar')
      .mockResolvedValue(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))

    await act(async () => {
      root.render(
        <Avatar color="var(--avatar-violet)" name="Taylor" imageUrl="mxc://example.org/taylor" />,
      )
    })
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    await act(async () => {
      root.render(<div />)
    })
    fillCacheLeavingOldest('mxc://example.org/taylor')

    await act(async () => {
      useMatrixAvatarStore.getState().resolve('mxc://example.org/one-more')
    })

    expect(useMatrixAvatarStore.getState().entries['mxc://example.org/taylor'])
      .toBeUndefined()
  })

  it('does not route a picture a caller already resolved through the native reader', async () => {
    const load = vi.spyOn(bridge, 'matrixLoadProfileAvatar')

    await act(async () => {
      root.render(
        <Avatar color="var(--avatar-violet)" name="Taylor" imageUrl="blob:caller-made-this" />,
      )
    })

    expect(load).not.toHaveBeenCalled()
    expect(container.querySelector('img')?.getAttribute('src')).toBe('blob:caller-made-this')
  })
})

describe('Avatar identity form', () => {
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

  function markFor(seed: string) {
    act(() => {
      root.render(<Avatar color="var(--avatar-blue)" name="Taylor" seed={seed} />)
    })
    return container.querySelector<HTMLElement>('.mesh-pixel-mark')
      ?.getAttribute('style') ?? ''
  }

  it('gives two different identities two different forms', () => {
    const maya = markFor('@maya:mesh.test')
    const rohan = markFor('@rohan:mesh.test')

    expect(maya).toBeTruthy()
    expect(maya).not.toBe(rohan)
  })

  it('gives the same identity the same form on every render', () => {
    expect(markFor('@maya:mesh.test')).toBe(markFor('@maya:mesh.test'))
  })

  it('falls back to the variant glyph when the caller has no identity to seed with', () => {
    act(() => {
      root.render(<Avatar color="var(--avatar-blue)" name="Taylor" />)
    })

    const mark = container.querySelector<HTMLElement>('.mesh-pixel-mark')
    expect(mark?.classList.contains('mesh-pixel-mark-profile')).toBe(true)
    expect(mark?.getAttribute('style') ?? '').not.toContain('mesh-pixel-mask')
  })
})
