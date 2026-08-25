import { useNetworkStore, type MatrixLinkPhase } from '../../store/network'
import { StatusDot, type StatusDotProps } from './StatusDot'

interface IndicatorCopy {
  state: StatusDotProps['state']
  /**
   * At most seven characters. The community rail is 56px wide at the reference
   * viewport, so anything longer is truncated to an ellipsis and stops being a
   * text cue at all. The full sentence lives in `description`.
   */
  label: string
  description: string
}

/*
 * Matrix indicator copy.
 *
 * A rail indicator reports the link state and nothing else. What happens to a
 * message sent while the link is down is said once, by the shell's connection
 * band, which is also the surface carrying the control that acts on it.
 */
const MATRIX_INDICATOR: Record<MatrixLinkPhase, IndicatorCopy> = {
  online: {
    state: 'connected',
    label: 'Online',
    description: 'Connected to your account service.',
  },
  reconnecting: {
    state: 'degraded',
    label: 'Offline',
    description: 'Reconnecting to your account service.',
  },
  unreachable: {
    state: 'disconnected',
    label: 'Offline',
    description: 'Mesh cannot reach your account service.',
  },
  'signed-out': {
    state: 'disconnected',
    label: 'Sign in',
    description: 'This device is signed out.',
  },
}

const MATRIX_STARTING: IndicatorCopy = {
  state: 'connecting',
  label: 'Starting',
  description: 'Connecting to your account service.',
}

export function NetworkStatus({ matrixMode }: { matrixMode: boolean }) {
  const network = useNetworkStore((state) => state.status)
  const matrixLink = useNetworkStore((state) => state.matrixLink)

  const indicator = matrixMode
    ? matrixIndicator(matrixLink?.phase)
    : localIndicator(network.state, network.peerCount)

  return (
    <div
      className={
        matrixMode
          ? 'flex max-w-full flex-col items-center gap-1 px-1 text-center text-caption text-muted'
          : 'flex max-w-full items-center justify-center gap-1.5 px-1 text-center text-caption text-muted'
      }
      /*
        Legacy keeps its live region: it is the only connection surface that
        backend has. Matrix mode does not repeat itself. The shell band owns
        the single polite announcement for a Matrix connection change, and a
        second live region in the rail would say the same thing twice.
      */
      role={matrixMode ? undefined : 'status'}
      aria-label={matrixMode ? undefined : indicator.description}
      title={indicator.description}
    >
      <StatusDot state={indicator.state} label={indicator.description} />
      {/*
        The legacy indicator keeps `.mesh-network-label`, which globals.css
        hides below 800px. The Matrix indicator cannot: hiding the word there
        would leave a bare coloured dot, which is state carried by colour alone
        and fails the contract. Stacking the word under the dot is what makes a
        readable label fit inside the 56px rail at every width.
      */}
      <span className={matrixMode ? 'min-w-0 truncate' : 'mesh-network-label min-w-0 truncate'}>
        {indicator.label}
      </span>
    </div>
  )
}

function matrixIndicator(phase: MatrixLinkPhase | undefined): IndicatorCopy {
  // No phase published yet means the first backend status has not landed, not
  // that anything is wrong. Say "Starting" rather than claim a connection.
  return phase ? MATRIX_INDICATOR[phase] : MATRIX_STARTING
}

function localIndicator(
  state: StatusDotProps['state'],
  remotePeerCount: number,
): IndicatorCopy {
  const isRunningSolo =
    state !== 'connecting'
    && state !== 'disconnected'
    && remotePeerCount === 0

  return {
    state: isRunningSolo ? 'degraded' : state,
    label: state === 'connecting'
      ? 'Starting'
      : state === 'disconnected'
        ? 'Offline'
        : isRunningSolo
          ? 'Solo (you)'
          : `You + ${remotePeerCount}`,
    description: state === 'connecting'
      ? 'Starting Mesh'
      : state === 'disconnected'
        ? 'Mesh is offline.'
        : isRunningSolo
          ? 'This device is offline from other Mesh users.'
          : `Connected to ${remotePeerCount} other device${remotePeerCount === 1 ? '' : 's'}`,
  }
}
