import { type ReactNode } from 'react'
import { Tooltip as TooltipPrimitive } from 'radix-ui'
import clsx from 'clsx'

interface TooltipProps {
  content: ReactNode
  side?: 'top' | 'right' | 'bottom' | 'left'
  children: ReactNode
  className?: string
}

export function Tooltip({ content, side = 'top', children, className }: TooltipProps) {
  return (
    <TooltipPrimitive.Provider delayDuration={300} skipDelayDuration={100}>
      <TooltipPrimitive.Root>
        <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
        <TooltipPrimitive.Portal>
          <TooltipPrimitive.Content
            side={side}
            sideOffset={8}
            collisionPadding={8}
            className={clsx(
              'z-tooltip max-w-xs rounded-md bg-surface-overlay px-3 py-1.5 text-xs font-medium text-content shadow-floating',
              'data-[state=delayed-open]:animate-in data-[state=closed]:animate-out',
              className,
            )}
          >
            {content}
            <TooltipPrimitive.Arrow className="fill-surface-overlay" />
          </TooltipPrimitive.Content>
        </TooltipPrimitive.Portal>
      </TooltipPrimitive.Root>
    </TooltipPrimitive.Provider>
  )
}
