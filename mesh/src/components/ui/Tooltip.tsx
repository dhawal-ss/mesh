import { useState, useRef, useEffect, type ReactNode } from 'react'

interface TooltipProps {
  content: string
  side?: 'top' | 'right' | 'bottom' | 'left'
  children: ReactNode
}

export function Tooltip({ content, side = 'top', children }: TooltipProps) {
  const [visible, setVisible] = useState(false)
  const timeoutRef = useRef<number | undefined>(undefined)

  const show = () => {
    timeoutRef.current = window.setTimeout(() => setVisible(true), 300)
  }

  const hide = () => {
    clearTimeout(timeoutRef.current)
    setVisible(false)
  }

  useEffect(() => {
    return () => clearTimeout(timeoutRef.current)
  }, [])

  const positionClasses = {
    top: 'bottom-full left-1/2 -translate-x-1/2 mb-2',
    right: 'left-full top-1/2 -translate-y-1/2 ml-2',
    bottom: 'top-full left-1/2 -translate-x-1/2 mt-2',
    left: 'right-full top-1/2 -translate-y-1/2 mr-2',
  }

  return (
    <div className="relative inline-flex" onMouseEnter={show} onMouseLeave={hide}>
      {children}
      {visible && (
        <div
          className={`pointer-events-none absolute z-50 whitespace-nowrap rounded-md bg-bg-floating px-3 py-1.5 text-xs font-medium text-primary shadow-floating ${positionClasses[side]}`}
        >
          {content}
          {/* Arrow */}
          <div
            className={`absolute h-0 w-0 ${
              side === 'top' ? 'top-full left-1/2 -translate-x-1/2 border-l-4 border-r-4 border-t-4 border-l-transparent border-r-transparent border-t-bg-floating' :
              side === 'bottom' ? 'bottom-full left-1/2 -translate-x-1/2 border-l-4 border-r-4 border-b-4 border-l-transparent border-r-transparent border-b-bg-floating' :
              side === 'right' ? 'right-full top-1/2 -translate-y-1/2 border-t-4 border-b-4 border-r-4 border-t-transparent border-b-transparent border-r-bg-floating' :
              'left-full top-1/2 -translate-y-1/2 border-t-4 border-b-4 border-l-4 border-t-transparent border-b-transparent border-l-bg-floating'
            }`}
          />
        </div>
      )}
    </div>
  )
}
