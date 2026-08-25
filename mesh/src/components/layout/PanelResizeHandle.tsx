import type { PointerEvent as ReactPointerEvent } from 'react'

interface PanelResizeHandleProps {
  label: string
  side: 'left' | 'right'
  value: number
  minimum: number
  maximum: number
  onPointerDown: (event: ReactPointerEvent<HTMLElement>, direction: 1 | -1) => void
  onResizeBy: (delta: number) => void
}

export function PanelResizeHandle({
  label,
  side,
  value,
  minimum,
  maximum,
  onPointerDown,
  onResizeBy,
}: PanelResizeHandleProps) {
  const increaseDirection = side === 'right' ? 1 : -1
  return (
    <div
      role="separator"
      tabIndex={0}
      aria-label={label}
      aria-orientation="vertical"
      aria-valuemin={minimum}
      aria-valuemax={maximum}
      aria-valuenow={value}
      className={`mesh-panel-resize-handle mesh-panel-resize-handle-${side}`}
      onPointerDown={(event) => onPointerDown(event, increaseDirection)}
      onKeyDown={(event) => {
        if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
        event.preventDefault()
        const physicalDirection = event.key === 'ArrowRight' ? 1 : -1
        onResizeBy(physicalDirection * increaseDirection * 8)
      }}
    />
  )
}
