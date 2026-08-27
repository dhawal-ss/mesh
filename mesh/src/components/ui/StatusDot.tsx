import { Tooltip } from './Tooltip'

export interface StatusDotProps {
  state: 'connected' | 'degraded' | 'disconnected' | 'connecting'
  label: string
  className?: string
}

/**
 * The Material 3 small badge: a 6px dot with a 2px ring in the surface colour,
 * so it stays legible where it overlaps an avatar or a rail item.
 *
 * Healthy is not a colour here. A connected link is the norm and takes the
 * neutral outline. Amber is transient and will clear on its own; coral cannot
 * clear without the person, which is the same two-step severity the shell's
 * connection band uses. The tooltip carries the word in every state, so
 * nothing on this indicator is colour-only.
 */
const STATE_FILL: Record<StatusDotProps['state'], string> = {
  connected: 'bg-outline',
  degraded: 'bg-marker',
  disconnected: 'bg-error',
  connecting: 'bg-primary',
}

export function StatusDot({ state, label, className }: StatusDotProps) {
  return (
    <Tooltip content={label} side="top">
      <span
        role="img"
        aria-label={label}
        data-state={state}
        className={`mesh-status-badge inline-block h-1.5 w-1.5 rounded-full ${STATE_FILL[state]} transition-colors duration-normal ${className ?? ''}`}
      />
    </Tooltip>
  )
}
