import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import {
  clampPanelWidth,
  readStoredPanelWidth,
  writeStoredPanelWidth,
} from '../lib/layout-preferences'

interface PersistentPanelWidthOptions {
  storageKey: string
  defaultWidth: number
  minimum: number
  maximum: number
}

export function usePersistentPanelWidth({
  storageKey,
  defaultWidth,
  minimum,
  maximum,
}: PersistentPanelWidthOptions) {
  const [width, setWidth] = useState(() => (
    readStoredPanelWidth(storageKey, defaultWidth, minimum, maximum)
  ))
  const cleanupRef = useRef<(() => void) | null>(null)

  useEffect(() => {
    writeStoredPanelWidth(storageKey, width)
  }, [storageKey, width])

  useEffect(() => () => cleanupRef.current?.(), [])

  const resizeBy = useCallback((delta: number) => {
    setWidth((current) => clampPanelWidth(current + delta, minimum, maximum))
  }, [maximum, minimum])

  const startResize = useCallback((
    event: ReactPointerEvent<HTMLElement>,
    direction: 1 | -1,
  ) => {
    if (event.button !== 0) return
    event.preventDefault()
    cleanupRef.current?.()
    const startX = event.clientX
    const startWidth = width
    const handleMove = (moveEvent: PointerEvent) => {
      setWidth(clampPanelWidth(
        startWidth + (moveEvent.clientX - startX) * direction,
        minimum,
        maximum,
      ))
    }
    const cleanup = () => {
      window.removeEventListener('pointermove', handleMove)
      window.removeEventListener('pointerup', cleanup)
      window.removeEventListener('pointercancel', cleanup)
      if (cleanupRef.current === cleanup) cleanupRef.current = null
    }
    cleanupRef.current = cleanup
    window.addEventListener('pointermove', handleMove)
    window.addEventListener('pointerup', cleanup)
    window.addEventListener('pointercancel', cleanup)
  }, [maximum, minimum, width])

  return { width, resizeBy, startResize }
}
