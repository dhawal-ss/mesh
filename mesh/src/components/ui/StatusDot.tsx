import { Tooltip } from './Tooltip'
import { useNetworkStore } from '../../store/network'

export function StatusDot() {
  const { status } = useNetworkStore()

  const colors: Record<string, string> = {
    connected:    'bg-green',
    degraded:     'bg-yellow',
    disconnected: 'bg-red',
    connecting:   'bg-accent animate-pulse-soft',
  }

  const labels: Record<string, string> = {
    connected:    `Connected · ${status.peerCount} peers`,
    degraded:     `Relay mode · ${status.peerCount} peers`,
    disconnected: 'Disconnected',
    connecting:   'Connecting…',
  }

  return (
    <Tooltip content={labels[status.state] ?? 'Unknown'} side="top">
      <div className={`w-2.5 h-2.5 rounded-full ${colors[status.state] ?? 'bg-muted'} transition-colors duration-500`} />
    </Tooltip>
  )
}
