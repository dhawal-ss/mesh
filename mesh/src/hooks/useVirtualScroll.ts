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
  scrollRef: React.RefObject<HTMLDivElement | null>
  scrollTop: number
  viewportHeight: number
  isAtBottom: boolean
  topSpacerHeight: number
  bottomSpacerHeight: number
  totalContentHeight: number
  visibleRange: { start: number; end: number }
  /** Notify the hook of a measured row height */
  handleMeasuredHeight: (rowKey: string, height: number) => void
  /** Call this from the container's onScroll */
  handleScroll: () => void
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

function hasSameLayoutItems(previous: VirtualItem[], next: VirtualItem[]): boolean {
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

  const scrollRef = useRef<HTMLDivElement>(null)
  const isAtBottomRef = useRef(true)
  const rowHeightsRef = useRef<Record<string, number>>({})
  const pendingAnchorRef = useRef<{ messageId: string; offset: number } | null>(null)
  const scrollFrameRef = useRef<number | null>(null)
  const layoutItemsRef = useRef(items)

  const [scrollTop, setScrollTop] = useState(0)
  const [viewportHeight, setViewportHeight] = useState(0)
  const [layoutVersion, setLayoutVersion] = useState(0)

  // --- Compute layout from items and measured heights ---

  // Callers commonly project DTOs into a fresh item array during every render.
  // Preserve the previous array when its layout identity is unchanged so scroll
  // state updates do not invalidate the offset-table memo.
  if (!hasSameLayoutItems(layoutItemsRef.current, items)) {
    layoutItemsRef.current = items
  }
  const layoutItems = layoutItemsRef.current

  const {
    itemOffsets,
    itemHeights,
    totalContentHeight,
  } = useMemo(() => {
    const nextOffsets: number[] = []
    const nextHeights: number[] = []
    let nextTotalHeight = 0

    for (const item of layoutItems) {
      nextOffsets.push(nextTotalHeight)
      const estimated =
        item.height ?? (item.type === 'gap' ? estimatedGapHeight : estimatedMessageHeight)
      const measured = rowHeightsRef.current[item.key] ?? estimated
      nextHeights.push(measured)
      nextTotalHeight += measured
    }

    return {
      itemOffsets: nextOffsets,
      itemHeights: nextHeights,
      totalContentHeight: nextTotalHeight,
    }
  }, [estimatedGapHeight, estimatedMessageHeight, layoutItems, layoutVersion])

  const {
    visibleStart,
    visibleEnd,
    topSpacerHeight,
    bottomSpacerHeight,
  } = useMemo(() => {
    const viewportStart = Math.max(0, scrollTop - overscanPx)
    const viewportEnd = scrollTop + viewportHeight + overscanPx

    let nextVisibleStart = 0
    while (
      nextVisibleStart < layoutItems.length - 1 &&
      itemOffsets[nextVisibleStart] + itemHeights[nextVisibleStart] < viewportStart
    ) {
      nextVisibleStart += 1
    }

    let nextVisibleEnd = nextVisibleStart
    while (
      nextVisibleEnd < layoutItems.length - 1 &&
      itemOffsets[nextVisibleEnd] < viewportEnd
    ) {
      nextVisibleEnd += 1
    }

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
  scrollMetricsRef.current = { totalContentHeight, bottomThreshold }

  // Measurements only matter while their rows remain in the bounded message
  // window. Pruning after each committed item change prevents a long-running
  // session from retaining one entry for every message ever viewed.
  useLayoutEffect(() => {
    const activeKeys = new Set(layoutItems.map((item) => item.key))
    for (const rowKey of Object.keys(rowHeightsRef.current)) {
      if (!activeKeys.has(rowKey)) {
        delete rowHeightsRef.current[rowKey]
      }
    }
  }, [layoutItems])

  // --- Observe container resize ---

  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el) return

    setViewportHeight(el.clientHeight)

    const observer = new ResizeObserver((entries) => {
      const nextHeight = entries[0]?.contentRect.height ?? el.clientHeight
      setViewportHeight(nextHeight)
    })

    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  // --- Auto-scroll to bottom when at bottom ---

  useLayoutEffect(() => {
    if (items.length === 0) return
    if (!isAtBottomRef.current) return

    const el = scrollRef.current
    if (!el) return

    el.scrollTop = el.scrollHeight
    setScrollTop(el.scrollTop)
  }, [items.length, layoutVersion])

  // --- Restore scroll anchor after prepend ---

  useLayoutEffect(() => {
    const anchor = pendingAnchorRef.current
    if (!anchor) return

    const anchorIndex = layoutItems.findIndex(
      (item) => item.key === anchor.messageId,
    )
    if (anchorIndex < 0) return

    const frame = requestAnimationFrame(() => {
      const current = scrollRef.current
      if (!current) return

      const targetTop = Math.max(0, (itemOffsets[anchorIndex] ?? 0) + anchor.offset)
      current.scrollTop = targetTop
      setScrollTop(targetTop)
      pendingAnchorRef.current = null
    })

    return () => cancelAnimationFrame(frame)
  }, [layoutItems, itemOffsets, layoutVersion])

  // --- Callbacks ---

  const handleMeasuredHeight = useCallback(
    (rowKey: string, height: number) => {
      const nextHeight = Math.ceil(height)
      if (!Number.isFinite(nextHeight) || nextHeight <= 0) return

      const rowIndex = layoutItems.findIndex((item) => item.key === rowKey)
      if (rowIndex < 0) return

      const previousHeight = itemHeights[rowIndex]
      if (previousHeight === nextHeight) return

      const element = scrollRef.current
      const rowBottom = (itemOffsets[rowIndex] ?? 0) + previousHeight
      const preserveVisibleAnchor = element !== null && rowBottom <= element.scrollTop

      rowHeightsRef.current = {
        ...rowHeightsRef.current,
        [rowKey]: nextHeight,
      }

      if (preserveVisibleAnchor) {
        const anchoredScrollTop = Math.max(0, element.scrollTop + nextHeight - previousHeight)
        element.scrollTop = anchoredScrollTop
        setScrollTop(anchoredScrollTop)
      }

      setLayoutVersion((version) => version + 1)
    },
    [itemHeights, itemOffsets, layoutItems],
  )

  const handleScroll = useCallback(() => {
    if (scrollFrameRef.current !== null) return

    scrollFrameRef.current = requestAnimationFrame(() => {
      scrollFrameRef.current = null
      const element = scrollRef.current
      if (!element) return

      setScrollTop(element.scrollTop)
      const metrics = scrollMetricsRef.current
      isAtBottomRef.current =
        metrics.totalContentHeight - element.scrollTop - element.clientHeight <
        metrics.bottomThreshold
    })
  }, [])

  useLayoutEffect(
    () => () => {
      if (scrollFrameRef.current !== null) {
        cancelAnimationFrame(scrollFrameRef.current)
        scrollFrameRef.current = null
      }
    },
    [],
  )

  const scrollToBottom = useCallback(() => {
    const el = scrollRef.current
    if (!el) return

    el.scrollTop = el.scrollHeight
    setScrollTop(el.scrollTop)
    isAtBottomRef.current = true
  }, [])

  const scrollToItem = useCallback(
    (rowKey: string, align: 'start' | 'center' | 'end' = 'center') => {
      const element = scrollRef.current
      const rowIndex = layoutItems.findIndex((item) => item.key === rowKey)
      if (!element || rowIndex < 0) return false

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
      isAtBottomRef.current =
        totalContentHeight - targetTop - viewport < bottomThreshold
      return true
    },
    [
      bottomThreshold,
      itemHeights,
      itemOffsets,
      layoutItems,
      totalContentHeight,
      viewportHeight,
    ],
  )

  const resetLayout = useCallback(() => {
    isAtBottomRef.current = true
    rowHeightsRef.current = {}
    pendingAnchorRef.current = null
    setScrollTop(0)
    setViewportHeight(scrollRef.current?.clientHeight ?? 0)
    setLayoutVersion((v) => v + 1)
  }, [])

  const setScrollAnchor = useCallback(
    (anchor: { messageId: string; offset: number } | null) => {
      pendingAnchorRef.current = anchor
    },
    [],
  )

  return useMemo(() => ({
    scrollRef,
    scrollTop,
    viewportHeight,
    isAtBottom: isAtBottomRef.current,
    topSpacerHeight,
    bottomSpacerHeight,
    totalContentHeight,
    visibleRange: { start: visibleStart, end: visibleEnd },
    handleMeasuredHeight,
    handleScroll,
    scrollToBottom,
    scrollToItem,
    resetLayout,
    setScrollAnchor,
  }), [
    scrollRef,
    scrollTop,
    viewportHeight,
    topSpacerHeight,
    bottomSpacerHeight,
    totalContentHeight,
    visibleStart,
    visibleEnd,
    handleMeasuredHeight,
    handleScroll,
    scrollToBottom,
    scrollToItem,
    resetLayout,
    setScrollAnchor,
  ])
}
