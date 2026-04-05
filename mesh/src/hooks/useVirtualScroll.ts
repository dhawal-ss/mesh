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

  const [scrollTop, setScrollTop] = useState(0)
  const [viewportHeight, setViewportHeight] = useState(0)
  const [layoutVersion, setLayoutVersion] = useState(0)

  // --- Compute layout from items and measured heights ---

  const itemOffsets: number[] = []
  const itemHeights: number[] = []
  let totalContentHeight = 0

  for (const item of items) {
    itemOffsets.push(totalContentHeight)
    const estimated = item.type === 'gap' ? estimatedGapHeight : estimatedMessageHeight
    const measured = rowHeightsRef.current[item.key] ?? estimated
    itemHeights.push(measured)
    totalContentHeight += measured
  }

  const viewportStart = Math.max(0, scrollTop - overscanPx)
  const viewportEnd = scrollTop + viewportHeight + overscanPx

  let visibleStart = 0
  while (
    visibleStart < items.length - 1 &&
    itemOffsets[visibleStart] + itemHeights[visibleStart] < viewportStart
  ) {
    visibleStart += 1
  }

  let visibleEnd = visibleStart
  while (visibleEnd < items.length - 1 && itemOffsets[visibleEnd] < viewportEnd) {
    visibleEnd += 1
  }

  const topSpacerHeight = items.length === 0 ? 0 : itemOffsets[visibleStart] ?? 0
  const bottomSpacerHeight =
    items.length === 0
      ? 0
      : Math.max(
          0,
          totalContentHeight - ((itemOffsets[visibleEnd] ?? 0) + (itemHeights[visibleEnd] ?? 0)),
        )

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

    const anchorIndex = items.findIndex(
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
  }, [items, itemOffsets, layoutVersion])

  // --- Callbacks ---

  const handleMeasuredHeight = useCallback((rowKey: string, height: number) => {
    const nextHeight = Math.ceil(height)
    if (rowHeightsRef.current[rowKey] === nextHeight) return

    rowHeightsRef.current = {
      ...rowHeightsRef.current,
      [rowKey]: nextHeight,
    }
    setLayoutVersion((v) => v + 1)
  }, [])

  const handleScroll = useCallback(() => {
    const el = scrollRef.current
    if (!el) return

    setScrollTop(el.scrollTop)
    isAtBottomRef.current = totalContentHeight - el.scrollTop - el.clientHeight < bottomThreshold
  }, [totalContentHeight, bottomThreshold])

  const scrollToBottom = useCallback(() => {
    const el = scrollRef.current
    if (!el) return

    el.scrollTop = el.scrollHeight
    setScrollTop(el.scrollTop)
    isAtBottomRef.current = true
  }, [])

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
    resetLayout,
    setScrollAnchor,
  ])
}
