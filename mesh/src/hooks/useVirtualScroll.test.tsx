import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  findVisibleRange,
  useVirtualScroll,
  type VirtualItem,
  type VirtualScrollState,
} from './useVirtualScroll'

type ResizeCallback = ConstructorParameters<typeof ResizeObserver>[0]

class ResizeObserverMock {
  static instances: ResizeObserverMock[] = []

  private readonly callback: ResizeCallback

  constructor(callback: ResizeCallback) {
    this.callback = callback
    ResizeObserverMock.instances.push(this)
  }

  observe() {}

  unobserve() {}

  disconnect() {}

  trigger(height: number) {
    this.callback(
      [{ contentRect: { height } } as ResizeObserverEntry],
      this as unknown as ResizeObserver,
    )
  }
}

describe('findVisibleRange', () => {
  it('preserves inclusive viewport-boundary semantics', () => {
    const offsets = [0, 100, 200, 300]
    const heights = [100, 100, 100, 100]

    expect(findVisibleRange(offsets, heights, 100, 300)).toEqual({
      start: 0,
      end: 3,
    })
    expect(findVisibleRange(offsets, heights, 101, 299)).toEqual({
      start: 1,
      end: 3,
    })
    expect(findVisibleRange([], [], 0, 100)).toEqual({ start: 0, end: 0 })
  })

  it('finds a bounded range in 50,000 rows with logarithmic indexed reads', () => {
    const rowCount = 50_000
    const offsets = Array.from({ length: rowCount }, (_, index) => index * 100)
    const heights = Array.from({ length: rowCount }, () => 100)
    let indexedReads = 0
    const countReads = (values: number[]) => new Proxy(values, {
      get(target, property, receiver) {
        if (typeof property === 'string' && /^\d+$/.test(property)) indexedReads += 1
        return Reflect.get(target, property, receiver)
      },
    })

    const range = findVisibleRange(
      countReads(offsets),
      countReads(heights),
      2_500_000,
      2_500_500,
    )

    expect(range).toEqual({ start: 24_999, end: 25_005 })
    expect(range.end - range.start + 1).toBe(7)
    expect(indexedReads).toBeLessThan(80)
  })
})

interface HarnessProps {
  items: VirtualItem[]
  onRender: (state: VirtualScrollState) => void
}

function Harness({ items, onRender }: HarnessProps) {
  const state = useVirtualScroll(items, {
    estimatedMessageHeight: 100,
    estimatedGapHeight: 50,
    overscanPx: 0,
    bottomThreshold: 10,
  })
  onRender(state)
  return <div ref={state.scrollRef} />
}

describe('useVirtualScroll', () => {
  let container: HTMLDivElement
  let root: Root
  let latest: VirtualScrollState
  let renderCount: number
  let animationFrames: Map<number, FrameRequestCallback>
  let nextFrameId: number

  const render = async (items: VirtualItem[]) => {
    await act(async () => {
      root.render(
        <Harness
          items={items}
          onRender={(state) => {
            latest = state
            renderCount += 1
          }}
        />,
      )
    })
  }

  const scrollElement = () => {
    const element = container.querySelector('div')
    if (!element) throw new Error('virtual scroll element was not rendered')
    return element
  }

  const flushAnimationFrame = async () => {
    const callbacks = [...animationFrames.values()]
    animationFrames.clear()
    await act(async () => {
      callbacks.forEach((callback) => callback(16))
    })
  }

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    renderCount = 0
    animationFrames = new Map()
    nextFrameId = 1
    ResizeObserverMock.instances = []

    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    vi.stubGlobal('ResizeObserver', ResizeObserverMock)
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      const id = nextFrameId
      nextFrameId += 1
      animationFrames.set(id, callback)
      return id
    })
    vi.stubGlobal('cancelAnimationFrame', (id: number) => {
      animationFrames.delete(id)
    })
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    vi.unstubAllGlobals()
  })

  it('prunes measured heights after their rows leave the item window', async () => {
    const row = { key: 'message-a', type: 'message' as const }
    await render([row])

    await act(async () => {
      latest.handleMeasuredHeight(row.key, 240)
    })
    expect(latest.totalContentHeight).toBe(240)

    await render([])
    await render([row])

    expect(latest.totalContentHeight).toBe(100)
  })

  it('coalesces native scroll events into one update per animation frame', async () => {
    await render([
      { key: 'message-a', type: 'message' },
      { key: 'message-b', type: 'message' },
    ])
    const element = scrollElement()
    Object.defineProperty(element, 'clientHeight', { configurable: true, value: 100 })
    ResizeObserverMock.instances[0].trigger(100)
    await act(async () => {})

    const rendersBeforeScroll = renderCount
    element.scrollTop = 10
    latest.handleScroll()
    element.scrollTop = 20
    latest.handleScroll()
    element.scrollTop = 30
    latest.handleScroll()

    expect(latest.scrollTop).toBe(0)
    expect(animationFrames).toHaveLength(1)

    await flushAnimationFrame()

    expect(latest.scrollTop).toBe(30)
    expect(renderCount - rendersBeforeScroll).toBe(1)
  })

  it('preserves the visible anchor and spacer math when a row above it grows', async () => {
    const rows = Array.from({ length: 10 }, (_, index) => ({
      key: `message-${index}`,
      type: 'message' as const,
    }))
    await render(rows)

    const element = scrollElement()
    Object.defineProperty(element, 'clientHeight', { configurable: true, value: 100 })
    Object.defineProperty(element, 'scrollHeight', {
      configurable: true,
      get: () => latest.totalContentHeight,
    })
    ResizeObserverMock.instances[0].trigger(100)
    await act(async () => {})

    element.scrollTop = 201
    latest.handleScroll()
    await flushAnimationFrame()

    expect(latest.topSpacerHeight).toBe(200)
    expect(latest.bottomSpacerHeight).toBe(500)

    await act(async () => {
      latest.handleMeasuredHeight('message-0', 150)
    })

    expect(element.scrollTop).toBe(251)
    expect(latest.scrollTop).toBe(251)
    expect(latest.totalContentHeight).toBe(1050)
    expect(latest.topSpacerHeight).toBe(250)
    expect(latest.bottomSpacerHeight).toBe(500)
  })

  it('centers a virtual row that is outside the rendered range', async () => {
    const rows = Array.from({ length: 10 }, (_, index) => ({
      key: `message-${index}`,
      type: 'message' as const,
    }))
    await render(rows)

    const element = scrollElement()
    Object.defineProperty(element, 'clientHeight', { configurable: true, value: 200 })
    Object.defineProperty(element, 'scrollHeight', {
      configurable: true,
      get: () => latest.totalContentHeight,
    })
    ResizeObserverMock.instances[0].trigger(200)
    await act(async () => {})

    await act(async () => {
      expect(latest.scrollToItem('message-7', 'center')).toBe(true)
    })

    expect(element.scrollTop).toBe(650)
    expect(latest.scrollTop).toBe(650)
    expect(latest.visibleRange).toEqual({ start: 6, end: 9 })
    expect(latest.scrollToItem('missing')).toBe(false)
  })
})
