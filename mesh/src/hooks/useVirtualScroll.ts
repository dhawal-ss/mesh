import { useState, useRef, useCallback, useLayoutEffect, useMemo } from 'react'

export interface VirtualItem {
  key: string
  /** Dividers are fixed-height landmarks between timeline messages. */
  type: 'message' | 'gap' | 'divider' | 'unread-divider' | 'history-start'
  height?: number
}

interface UseVirtualScrollOptions {
  /** Estimated height for message rows */
  estimatedMessageHeight?: number
  /** Estimated height for gap rows */
  estimatedGapHeight?: number
  /** Extra pixels to render above and below the viewport */
  overscanPx?: number
  /** Pixel threshold from bottom to consider "at bottom" */
  bottomThreshold?: number
  /** Keep new or remeasured content pinned to the bottom. Message timelines use this; navigation lists do not. */
  autoScrollToBottom?: boolean
}

export interface VirtualScrollState {
  scrollContainerRef: React.RefCallback<HTMLDivElement>
  scrollTop: number
  viewportHeight: number
  isAtBottom: boolean
  topSpacerHeight: number
  bottomSpacerHeight: number
  totalContentHeight: number
  visibleRange: { start: number; end: number }
  /** Notify the hook of a measured row height */
  handleMeasuredHeight: (rowKey: string, height: number) => void
  /** Call this from the container's onScroll for an immediate position snapshot */
  handleScroll: () => { scrollTop: number; isAtBottom: boolean } | null
  /** Read the latest bottom state without resubscribing long-lived listeners */
  getIsAtBottom: () => boolean
  /** Scroll programmatically to the bottom */
  scrollToBottom: () => void
  /** Scroll a row into view using the virtual layout, even if it is not rendered yet */
  scrollToItem: (rowKey: string, align?: 'start' | 'center' | 'end') => boolean
  /** Force a layout recalculation (e.g. after channel switch) */
  resetLayout: () => void
  /** Set a scroll anchor for preserving position across prepends */
  setScrollAnchor: (anchor: { messageId: string; offset: number } | null) => void
}

const DEFAULTS: Required<UseVirtualScrollOptions> = {
  estimatedMessageHeight: 96,
  estimatedGapHeight: 88,
  overscanPx: 600,
  bottomThreshold: 100,
  autoScrollToBottom: true,
}

interface LayoutMemory {
  items: VirtualItem[]
  measuredHeights: Record<string, number>
}

/** The committed layout, kept in a ref so callbacks can stay identity-stable. */
interface LayoutSnapshot {
  items: VirtualItem[]
  itemOffsets: number[]
  itemHeights: number[]
  itemIndexByKey: Map<string, number>
}

interface PendingAnchor {
  messageId: string
  offset: number
  /**
   * The item list the anchor was measured against, and the anchor row's
   * content offset at that moment. Together they scope the anchor to one
   * layout generation: it survives measurement-only passes, is consumed by the
   * first pass that changes the item list, and only moves the viewport when
   * something was actually inserted above the anchor row.
   */
  items: VirtualItem[]
  anchoredTop: number | null
}

function hasSameLayoutItems(
  previous: VirtualItem[],
  next: VirtualItem[],
): boolean {
  return (
    previous.length === next.length &&
    previous.every(
      (item, index) =>
        item.key === next[index]?.key &&
        item.type === next[index]?.type &&
        item.height === next[index]?.height,
    )
  )
}

function reconcileLayoutMemory(
  current: LayoutMemory,
  nextItems: VirtualItem[],
): LayoutMemory {
  if (hasSameLayoutItems(current.items, nextItems)) return current

  const activeKeys = new Set(nextItems.map((item) => item.key))
  const measuredHeights = Object.fromEntries(
    Object.entries(current.measuredHeights).filter(([rowKey]) =>
      activeKeys.has(rowKey),
    ),
  )
  return { items: nextItems, measuredHeights }
}

function lowerBound(
  length: number,
  target: number,
  valueAt: (index: number) => number,
): number {
  let low = 0
  let high = length
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2)
    if (valueAt(middle) < target) low = middle + 1
    else high = middle
  }
  return Math.min(low, length - 1)
}

export function findVisibleRange(
  itemOffsets: number[],
  itemHeights: number[],
  viewportStart: number,
  viewportEnd: number,
): { start: number; end: number } {
  const itemCount = Math.min(itemOffsets.length, itemHeights.length)
  if (itemCount === 0) return { start: 0, end: 0 }

  const start = lowerBound(
    itemCount,
    viewportStart,
    (index) => itemOffsets[index] + itemHeights[index],
  )
  const end = Math.max(
    start,
    lowerBound(itemCount, viewportEnd, (index) => itemOffsets[index]),
  )
  return { start, end }
}

export function useVirtualScroll(
  items: VirtualItem[],
  options: UseVirtualScrollOptions = {},
): VirtualScrollState {
  const {
    estimatedMessageHeight,
    estimatedGapHeight,
    overscanPx,
    bottomThreshold,
    autoScrollToBottom,
  } = { ...DEFAULTS, ...options }

  const scrollElementRef = useRef<HTMLDivElement | null>(null)
  const resizeObserverRef = useRef<ResizeObserver | null>(null)
  const isAtBottomRef = useRef(autoScrollToBottom)
  const pendingAnchorRef = useRef<PendingAnchor | null>(null)
  const scrollFrameRef = useRef<number | null>(null)
  const pendingMeasurementsRef = useRef(new Map<string, number>())
  const measurementFrameRef = useRef<number | null>(null)
  // Tracked separately from the frame id: a synchronous requestAnimationFrame
  // (test environments use one) runs the flush before the id is even assigned,
  // so the id alone cannot say whether a flush is still outstanding.
  const measurementScheduledRef = useRef(false)

  const [scrollTop, setScrollTop] = useState(0)
  const [viewportHeight, setViewportHeight] = useState(0)
  const [isAtBottom, setIsAtBottom] = useState(autoScrollToBottom)
  const [layoutMemory, setLayoutMemory] = useState<LayoutMemory>(() => ({
    items,
    measuredHeights: {},
  }))

  // --- Compute layout from items and measured heights ---

  // Callers commonly project DTOs into a fresh item array during every render.
  // Reconcile during render so committed layouts never briefly combine new
  // items with stale measurements, while preserving identity for equal arrays.
  let activeLayout = layoutMemory
  if (!hasSameLayoutItems(layoutMemory.items, items)) {
    activeLayout = reconcileLayoutMemory(layoutMemory, items)
    setLayoutMemory(activeLayout)
  }
  const layoutItems = activeLayout.items
  const measuredHeights = activeLayout.measuredHeights

  const {
    itemOffsets,
    itemHeights,
    totalContentHeight,
    itemIndexByKey,
  } = useMemo(() => {
    const nextOffsets: number[] = []
    const nextHeights: number[] = []
    const nextIndexByKey = new Map<string, number>()
    let nextTotalHeight = 0

    for (const [index, item] of layoutItems.entries()) {
      nextIndexByKey.set(item.key, index)
      nextOffsets.push(nextTotalHeight)
      const estimated =
        item.height ?? (item.type === 'gap' ? estimatedGapHeight : estimatedMessageHeight)
      const measured = measuredHeights[item.key] ?? estimated
      nextHeights.push(measured)
      nextTotalHeight += measured
    }

    return {
      itemOffsets: nextOffsets,
      itemHeights: nextHeights,
      totalContentHeight: nextTotalHeight,
      itemIndexByKey: nextIndexByKey,
    }
  }, [estimatedGapHeight, estimatedMessageHeight, layoutItems, measuredHeights])

  const {
    visibleStart,
    visibleEnd,
    topSpacerHeight,
    bottomSpacerHeight,
  } = useMemo(() => {
    const viewportStart = Math.max(0, scrollTop - overscanPx)
    const viewportEnd = scrollTop + viewportHeight + overscanPx
    const {
      start: nextVisibleStart,
      end: nextVisibleEnd,
    } = findVisibleRange(itemOffsets, itemHeights, viewportStart, viewportEnd)

    const nextTopSpacerHeight =
      layoutItems.length === 0 ? 0 : itemOffsets[nextVisibleStart] ?? 0
    const nextBottomSpacerHeight =
      layoutItems.length === 0
        ? 0
        : Math.max(
            0,
            totalContentHeight -
              ((itemOffsets[nextVisibleEnd] ?? 0) + (itemHeights[nextVisibleEnd] ?? 0)),
          )

    return {
      visibleStart: nextVisibleStart,
      visibleEnd: nextVisibleEnd,
      topSpacerHeight: nextTopSpacerHeight,
      bottomSpacerHeight: nextBottomSpacerHeight,
    }
  }, [
    itemHeights,
    itemOffsets,
    layoutItems.length,
    overscanPx,
    scrollTop,
    totalContentHeight,
    viewportHeight,
  ])
  const scrollMetricsRef = useRef({ totalContentHeight, bottomThreshold })
  useLayoutEffect(() => {
    scrollMetricsRef.current = { totalContentHeight, bottomThreshold }
  }, [bottomThreshold, totalContentHeight])

  // Measurement callbacks read the layout from here instead of closing over it.
  // Closing over it changed their identity on every measurement, which
  // re-rendered every row and rebuilt every row's ResizeObserver: measuring one
  // row invalidated all the others, so opening a channel cost O(n squared)
  // observer churn.
  const layoutRef = useRef<LayoutSnapshot>({
    items: layoutItems,
    itemOffsets,
    itemHeights,
    itemIndexByKey,
  })
  useLayoutEffect(() => {
    layoutRef.current = { items: layoutItems, itemOffsets, itemHeights, itemIndexByKey }
  }, [itemHeights, itemIndexByKey, itemOffsets, layoutItems])

  // --- Observe container resize ---

  const scrollContainerRef = useCallback((element: HTMLDivElement | null) => {
    resizeObserverRef.current?.disconnect()
    resizeObserverRef.current = null
    scrollElementRef.current = element
    if (!element) return

    setViewportHeight(element.clientHeight || 800)
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver((entries) => {
      const nextHeight = (entries[0]?.contentRect.height ?? element.clientHeight) || 800
      setViewportHeight(nextHeight)
    })
    observer.observe(element)
    resizeObserverRef.current = observer
  }, [])

  // --- Auto-scroll to bottom when at bottom ---

  useLayoutEffect(() => {
    if (!autoScrollToBottom) return
    if (layoutItems.length === 0) return
    if (!isAtBottomRef.current) return

    const el = scrollElementRef.current
    if (!el) return

    el.scrollTop = el.scrollHeight
    setScrollTop(el.scrollTop)
    // viewportHeight is a dependency because a shell band appearing above the
    // scroller resizes it without changing any item offset. Without it, a
    // bottom-pinned reader silently loses the last rows until the next message.
  }, [autoScrollToBottom, layoutItems.length, totalContentHeight, viewportHeight])

  // --- Restore scroll anchor after prepend ---

  useLayoutEffect(() => {
    const anchor = pendingAnchorRef.current
    if (!anchor) return
    // A measurement-only pass is not the prepend this anchor is waiting for,
    // so leave it armed. Any pass that does change the item list consumes it,
    // whether or not it can be applied: an anchor that outlives its generation
    // used to sit pending until some unrelated later render (a message
    // arriving ten minutes on) fired this effect and hard-set scrollTop to an
    // hour-old position while the reader was mid-page.
    if (anchor.items === layoutItems) return
    pendingAnchorRef.current = null

    const anchorIndex = itemIndexByKey.get(anchor.messageId)
    if (anchorIndex === undefined) return

    const current = scrollElementRef.current
    if (!current) return

    const anchoredTop = itemOffsets[anchorIndex] ?? 0
    // Nothing landed above the anchor row, so there is no shift to correct and
    // moving the viewport here would only fight the reader.
    if (anchor.anchoredTop !== null && anchoredTop === anchor.anchoredTop) return

    // Restore synchronously inside the layout effect so the correction lands
    // before the browser paints. Deferring to requestAnimationFrame let the
    // prepended rows paint at the old scrollTop for one frame, producing a
    // visible jump when loading older history.
    const targetTop = Math.max(0, anchoredTop + anchor.offset)
    current.scrollTop = targetTop
    setScrollTop(targetTop)
  }, [itemIndexByKey, itemOffsets, layoutItems])

  // --- Callbacks ---

  const flushMeasuredHeights = useCallback(() => {
    measurementFrameRef.current = null
    measurementScheduledRef.current = false
    const pending = pendingMeasurementsRef.current
    if (pending.size === 0) return
    const measurements = [...pending]
    pending.clear()

    const layout = layoutRef.current
    const element = scrollElementRef.current
    const applied = new Map<string, number>()
    let scrollDelta = 0

    for (const [rowKey, nextHeight] of measurements) {
      const rowIndex = layout.itemIndexByKey.get(rowKey)
      if (rowIndex === undefined) continue

      const previousHeight = layout.itemHeights[rowIndex]
      if (previousHeight === nextHeight) continue
      applied.set(rowKey, nextHeight)

      // Compensate whenever the changed row *starts* at or above the top of the
      // viewport, not only when it sits entirely above the fold. This keeps the
      // topmost visible content anchored when a straddling row (an image/embed
      // that finishes loading, or an inline edit) grows, instead of shoving the
      // reader's content downward.
      const rowTop = layout.itemOffsets[rowIndex] ?? 0
      if (element !== null && rowTop < element.scrollTop) {
        scrollDelta += nextHeight - previousHeight
      }
    }
    if (applied.size === 0) return

    setLayoutMemory((current) => {
      const activeKeys = new Set(current.items.map((item) => item.key))
      let measuredHeights: Record<string, number> | null = null
      for (const [rowKey, nextHeight] of applied) {
        if (!activeKeys.has(rowKey)) continue
        if (current.measuredHeights[rowKey] === nextHeight) continue
        measuredHeights ??= { ...current.measuredHeights }
        measuredHeights[rowKey] = nextHeight
      }
      return measuredHeights ? { ...current, measuredHeights } : current
    })

    if (element !== null && scrollDelta !== 0) {
      const anchoredScrollTop = Math.max(0, element.scrollTop + scrollDelta)
      element.scrollTop = anchoredScrollTop
      setScrollTop(anchoredScrollTop)
    }
  }, [])

  // Permanently identity-stable: rows receive this as onHeightChange, so any
  // change here re-renders every row. Measurements accumulate and land in one
  // state update per frame instead of one per row.
  const handleMeasuredHeight = useCallback(
    (rowKey: string, height: number) => {
      const nextHeight = Math.ceil(height)
      if (!Number.isFinite(nextHeight) || nextHeight <= 0) return

      pendingMeasurementsRef.current.set(rowKey, nextHeight)
      if (measurementScheduledRef.current) return
      measurementScheduledRef.current = true
      measurementFrameRef.current = requestAnimationFrame(flushMeasuredHeights)
    },
    [flushMeasuredHeights],
  )

  const handleScroll = useCallback(() => {
    const element = scrollElementRef.current
    if (!element) return null

    const metrics = scrollMetricsRef.current
    const nextIsAtBottom =
      metrics.totalContentHeight - element.scrollTop - element.clientHeight <
      metrics.bottomThreshold
    isAtBottomRef.current = nextIsAtBottom

    if (scrollFrameRef.current === null) {
      scrollFrameRef.current = requestAnimationFrame(() => {
        scrollFrameRef.current = null
        const current = scrollElementRef.current
        if (!current) return

        const latestMetrics = scrollMetricsRef.current
        const latestIsAtBottom =
          latestMetrics.totalContentHeight - current.scrollTop - current.clientHeight <
          latestMetrics.bottomThreshold
        isAtBottomRef.current = latestIsAtBottom
        setScrollTop(current.scrollTop)
        setIsAtBottom(latestIsAtBottom)
      })
    }

    return { scrollTop: element.scrollTop, isAtBottom: nextIsAtBottom }
  }, [])

  const getIsAtBottom = useCallback(() => isAtBottomRef.current, [])

  useLayoutEffect(
    () => () => {
      if (scrollFrameRef.current !== null) {
        cancelAnimationFrame(scrollFrameRef.current)
        scrollFrameRef.current = null
      }
      if (measurementFrameRef.current !== null) {
        cancelAnimationFrame(measurementFrameRef.current)
        measurementFrameRef.current = null
      }
      measurementScheduledRef.current = false
      pendingMeasurementsRef.current.clear()
      resizeObserverRef.current?.disconnect()
      resizeObserverRef.current = null
    },
    [],
  )

  const scrollToBottom = useCallback(() => {
    const el = scrollElementRef.current
    if (!el) return

    el.scrollTop = el.scrollHeight
    setScrollTop(el.scrollTop)
    isAtBottomRef.current = true
    setIsAtBottom(true)
  }, [])

  const scrollToItem = useCallback(
    (rowKey: string, align: 'start' | 'center' | 'end' = 'center') => {
      const element = scrollElementRef.current
      const rowIndex = itemIndexByKey.get(rowKey)
      if (!element || rowIndex === undefined) return false

      const rowTop = itemOffsets[rowIndex] ?? 0
      const rowHeight = itemHeights[rowIndex] ?? 0
      const viewport = element.clientHeight || viewportHeight
      const alignedTop =
        align === 'start'
          ? rowTop
          : align === 'end'
            ? rowTop + rowHeight - viewport
            : rowTop + rowHeight / 2 - viewport / 2
      const maxScrollTop = Math.max(0, totalContentHeight - viewport)
      const targetTop = Math.min(maxScrollTop, Math.max(0, alignedTop))

      element.scrollTop = targetTop
      setScrollTop(targetTop)
      const nextIsAtBottom =
        totalContentHeight - targetTop - viewport < bottomThreshold
      isAtBottomRef.current = nextIsAtBottom
      setIsAtBottom(nextIsAtBottom)
      return true
    },
    [
      bottomThreshold,
      itemHeights,
      itemIndexByKey,
      itemOffsets,
      totalContentHeight,
      viewportHeight,
    ],
  )

  const resetLayout = useCallback(() => {
    isAtBottomRef.current = autoScrollToBottom
    setIsAtBottom(autoScrollToBottom)
    pendingAnchorRef.current = null
    // Heights measured for the outgoing content must not reach the incoming
    // layout: resetLayout is clearing exactly those measurements below.
    pendingMeasurementsRef.current.clear()
    const element = scrollElementRef.current
    // The hook's position and the element's position have to move together.
    // Resetting only the hook left lists that do not auto-scroll (member list,
    // room sidebar, direct message sidebar) parked at the old offset while the
    // visible range was computed for offset 0, so the reader saw blank space
    // where rows should be until they scrolled. This runs on community switch
    // and on every search keystroke.
    if (element) element.scrollTop = 0
    setScrollTop(0)
    setViewportHeight(element?.clientHeight ?? 0)
    setLayoutMemory((current) => {
      if (Object.keys(current.measuredHeights).length === 0) return current
      return { ...current, measuredHeights: {} }
    })
  }, [autoScrollToBottom])

  const setScrollAnchor = useCallback(
    (anchor: { messageId: string; offset: number } | null) => {
      if (!anchor) {
        pendingAnchorRef.current = null
        return
      }
      const layout = layoutRef.current
      const anchorIndex = layout.itemIndexByKey.get(anchor.messageId)
      pendingAnchorRef.current = {
        messageId: anchor.messageId,
        offset: anchor.offset,
        items: layout.items,
        anchoredTop: anchorIndex === undefined ? null : (layout.itemOffsets[anchorIndex] ?? null),
      }
    },
    [],
  )

  return useMemo(() => ({
    scrollContainerRef,
    scrollTop,
    viewportHeight,
    isAtBottom,
    topSpacerHeight,
    bottomSpacerHeight,
    totalContentHeight,
    visibleRange: { start: visibleStart, end: visibleEnd },
    handleMeasuredHeight,
    handleScroll,
    getIsAtBottom,
    scrollToBottom,
    scrollToItem,
    resetLayout,
    setScrollAnchor,
  }), [
    scrollContainerRef,
    scrollTop,
    viewportHeight,
    isAtBottom,
    topSpacerHeight,
    bottomSpacerHeight,
    totalContentHeight,
    visibleStart,
    visibleEnd,
    handleMeasuredHeight,
    handleScroll,
    getIsAtBottom,
    scrollToBottom,
    scrollToItem,
    resetLayout,
    setScrollAnchor,
  ])
}
