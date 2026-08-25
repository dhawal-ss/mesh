import { Tooltip } from './Tooltip'

export interface StatusDotProps {
  state: 'connected' | 'degraded' | 'disconnected' | 'connecting'
  label: string
  className?: string
}

export function StatusDot({ state, label, className }: StatusDotProps) {
  const colors: Record<StatusDotProps['state'], string> = {
    connected:    'bg-status-success',
    degraded:     'bg-status-warning',
    disconnected: 'bg-status-danger',
    // Cyan, the informational role. This was the accent, which made it a
    // fourth status state inside the status primitive: a user who picked the
    // chrome accent got a "connecting" dot indistinguishable from "degraded".
    connecting:   'bg-status-info',
  }

  return (
    <Tooltip content={label} side="top">
      <span
        role="img"
        aria-label={label}
        className={`inline-block h-2.5 w-2.5 rounded-round ${colors[state]} transition-colors duration-normal ${className ?? ''}`}
      />
    </Tooltip>
  )
}
