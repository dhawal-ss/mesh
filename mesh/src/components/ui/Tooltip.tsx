import { createContext, useContext, type ReactNode } from 'react'
import { Tooltip as TooltipPrimitive } from 'radix-ui'
import clsx from 'clsx'
import { motion } from '../../lib/lazy-motion'
import { transitions } from '../../lib/motion'

interface TooltipProps {
  content: ReactNode
  side?: 'top' | 'right' | 'bottom' | 'left'
  children: ReactNode
  className?: string
}

/**
 * The one tooltip group for the application.
 *
 * `delayDuration` is the wait before the first tooltip in a group opens;
 * `skipDelayDuration` is the window in which moving to a neighbour opens
 * immediately. Both only mean anything when a single provider wraps the whole
 * tree, so mount this once at the application root.
 */
const TOOLTIP_DELAY_MS = 300
const TOOLTIP_SKIP_DELAY_MS = 100

/** Whether an ancestor already owns the group timing. */
const TooltipGroupContext = createContext(false)

export function TooltipProvider({ children }: { children: ReactNode }) {
  return (
    <TooltipGroupContext.Provider value={true}>
      <TooltipPrimitive.Provider
        delayDuration={TOOLTIP_DELAY_MS}
        skipDelayDuration={TOOLTIP_SKIP_DELAY_MS}
      >
        {children}
      </TooltipPrimitive.Provider>
    </TooltipGroupContext.Provider>
  )
}

/**
 * A tooltip is a leaf, not a provider.
 *
 * `TooltipPrimitive.Provider` owns `delayDuration` and `skipDelayDuration` for
 * a *group* of tooltips. Mounting one per tooltip meant every icon on the
 * community rail re-waited the full open delay, so scanning a rail whose only
 * labels are tooltips felt sticky. The single provider now lives at the
 * application root; see the report entry for App.tsx.
 */
export function Tooltip({ content, side = 'top', children, className }: TooltipProps) {
  const grouped = useContext(TooltipGroupContext)
  const tooltip = (
    <TooltipPrimitive.Root>
      <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
      <TooltipPrimitive.Portal>
        {/*
          * Arrival is an opacity change on the shared fast transition, which is
          * also what reduced motion is allowed to keep. The previous
          * `animate-in` and `animate-out` classes needed tailwindcss-animate,
          * which is not a dependency, so tooltips simply appeared.
          */}
        <TooltipPrimitive.Content side={side} sideOffset={8} collisionPadding={8} asChild>
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={transitions.fast}
            className={clsx(
              'z-tooltip max-w-xs rounded-panel border border-border-subtle bg-surface-overlay px-3 py-1.5 text-xs font-medium text-content shadow-overlay',
              className,
            )}
          >
            {content}
            <TooltipPrimitive.Arrow className="fill-surface-overlay" />
          </motion.div>
        </TooltipPrimitive.Content>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  )

  if (grouped) return tooltip

  // A surface mounted on its own, a settings panel under test or a detached
  // preview, still has to render rather than throw. It joins no group, so it
  // simply waits its own delay.
  return (
    <TooltipPrimitive.Provider
      delayDuration={TOOLTIP_DELAY_MS}
      skipDelayDuration={TOOLTIP_SKIP_DELAY_MS}
    >
      {tooltip}
    </TooltipPrimitive.Provider>
  )
}
