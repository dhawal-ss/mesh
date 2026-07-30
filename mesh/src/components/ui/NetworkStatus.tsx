import { useNetworkStore } from '../../store/network'
import { StatusDot, type StatusDotProps } from './StatusDot'

export function NetworkStatus({ matrixMode }: { matrixMode: boolean }) {
  const network = useNetworkStore((state) => state.status)
  const remotePeerCount = network.peerCount
  const isRunningSolo =
    !matrixMode
    && network.state !== 'connecting'
    && network.state !== 'disconnected'
    && remotePeerCount === 0

  const state: StatusDotProps['state'] = isRunningSolo ? 'degraded' : network.state
  const label = matrixMode
    ? network.state === 'connected'
      ? 'Online'
      : network.state === 'connecting'
        ? 'Connecting'
        : network.state === 'degraded'
          ? 'Connection needs attention'
          : 'Offline'
    : network.state === 'connecting'
      ? 'Starting'
      : network.state === 'disconnected'
        ? 'Offline'
        : isRunningSolo
          ? 'Solo (you)'
          : `You + ${remotePeerCount}`
  const description = matrixMode
    ? network.state === 'connected'
      ? 'Connected to Mesh'
      : network.state === 'connecting'
        ? 'Connecting to Mesh'
        : network.state === 'degraded'
          ? 'Mesh is connected, but some network paths need attention.'
          : 'Mesh is offline. It will retry automatically.'
    : network.state === 'connecting'
      ? 'Starting Mesh'
      : network.state === 'disconnected'
        ? 'Mesh is offline. It will retry automatically.'
        : isRunningSolo
          ? 'You are running solo. Messages stay on this device and sync when other peers join.'
          : `Connected to ${remotePeerCount} other peer${remotePeerCount === 1 ? '' : 's'}`

  return (
    <div
      className="flex max-w-full items-center justify-center gap-1.5 px-1 text-center text-caption text-muted"
      role="status"
      aria-label={description}
      title={description}
    >
      <StatusDot state={state} label={description} />
      <span className="mesh-network-label min-w-0 truncate">{label}</span>
    </div>
  )
}
