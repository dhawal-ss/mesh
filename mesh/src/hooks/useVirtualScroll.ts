import { useState, useRef, useCallback, useLayoutEffect, useMemo } from 'react'

export interface VirtualItem {
  key: string
  type: 'message' | 'gap'
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
}

interface LayoutMemory {
  items: VirtualItem[]
  measuredHeights: Record<string, number>
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
  } = { ...DEFAULTS, ...options }

  const scrollElementRef = useRef<HTMLDivElement | null>(null)
  const resizeObserverRef = useRef<ResizeObserver | null>(null)
  const isAtBottomRef = useRef(true)
  const pendingAnchorRef = useRef<{ messageId: string; offset: number } | null>(null)
  const scrollFrameRef = useRef<number | null>(null)

  const [scrollTop, setScrollTop] = useState(0)
  const [viewportHeight, setViewportHeight] = useState(0)
  const [isAtBottom, setIsAtBottom] = useState(true)
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

  // --- Observe container resize ---

  const scrollContainerRef = useCallback((element: HTMLDivElement | null) => {
    resizeObserverRef.current?.disconnect()
    resizeObserverRef.current = null
    scrollElementRef.current = element
    if (!element) return

    setViewportHeight(element.clientHeight)
    const observer = new ResizeObserver((entries) => {
      const nextHeight = entries[0]?.contentRect.height ?? element.clientHeight
      setViewportHeight(nextHeight)
    })
    observer.observe(element)
    resizeObserverRef.current = observer
  }, [])

  // --- Auto-scroll to bottom when at bottom ---

  useLayoutEffect(() => {
    if (layoutItems.length === 0) return
    if (!isAtBottomRef.current) return

    const el = scrollElementRef.current
    if (!el) return

    el.scrollTop = el.scrollHeight
    setScrollTop(el.scrollTop)
  }, [layoutItems.length, totalContentHeight])

  // --- Restore scroll anchor after prepend ---

  useLayoutEffect(() => {
    const anchor = pendingAnchorRef.current
    if (!anchor) return

    const anchorIndex = itemIndexByKey.get(anchor.messageId)
    if (anchorIndex === undefined) return

    const frame = requestAnimationFrame(() => {
      const current = scrollElementRef.current
      if (!current) return

      const targetTop = Math.max(0, (itemOffsets[anchorIndex] ?? 0) + anchor.offset)
      current.scrollTop = targetTop
      setScrollTop(targetTop)
      pendingAnchorRef.current = null
    })

    return () => cancelAnimationFrame(frame)
  }, [itemIndexByKey, itemOffsets])

  // --- Callbacks ---

  const handleMeasuredHeight = useCallback(
    (rowKey: string, height: number) => {
      const nextHeight = Math.ceil(height)
      if (!Number.isFinite(nextHeight) || nextHeight <= 0) return

      const rowIndex = itemIndexByKey.get(rowKey)
      if (rowIndex === undefined) return

      const previousHeight = itemHeights[rowIndex]
      if (previousHeight === nextHeight) return

      const element = scrollElementRef.current
      const rowBottom = (itemOffsets[rowIndex] ?? 0) + previousHeight
      const preserveVisibleAnchor = element !== null && rowBottom <= element.scrollTop

      setLayoutMemory((current) => {
        if (!current.items.some((item) => item.key === rowKey)) return current
        if (current.measuredHeights[rowKey] === nextHeight) return current

        return {
          ...current,
          measuredHeights: {
            ...current.measuredHeights,
            [rowKey]: nextHeight,
          },
        }
      })

      if (preserveVisibleAnchor) {
        const anchoredScrollTop = Math.max(0, element.scrollTop + nextHeight - previousHeight)
        element.scrollTop = anchoredScrollTop
        setScrollTop(anchoredScrollTop)
      }
    },
    [itemHeights, itemIndexByKey, itemOffsets],
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
    isAtBottomRef.current = true
    setIsAtBottom(true)
    pendingAnchorRef.current = null
    setScrollTop(0)
    setViewportHeight(scrollElementRef.current?.clientHeight ?? 0)
    setLayoutMemory((current) => {
      if (Object.keys(current.measuredHeights).length === 0) return current
      return { ...current, measuredHeights: {} }
    })
  }, [])

  const setScrollAnchor = useCallback(
    (anchor: { messageId: string; offset: number } | null) => {
      pendingAnchorRef.current = anchor
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
