import { useEffect, useState, useCallback, type ComponentProps, type ReactNode } from 'react'
import {
  getDiagnostics,
  getBackendStatus,
  probeIceServers,
  type BackendKind,
  type BackendStatus,
  type SystemDiagnostics,
  type SchedulerStats,
  type IceServerProbeResult,
} from '../../lib/bridge'
import { Skeleton } from '../ui/Skeleton'
import { ErrorState } from '../ui/ErrorState'
import { Button } from '../ui/Button'
import { Icon } from '../ui/Icon'
import { Modal } from '../ui/Modal'
import { StatusDot } from '../ui/StatusDot'
import {
  createLegacySupportBundle,
  createMatrixSupportBundle,
  saveSupportBundle,
  serializeSupportBundle,
} from '../../lib/support-bundle'
import { useSettingsStore } from '../../store/settings'
import { isMatrixVoiceFrontendEnabled, shouldExposeVoiceRoutes } from '../../lib/voice-runtime'

interface DiagnosticsPanelProps {
  open: boolean
  onClose: () => void
  backendKind?: BackendKind
  embedded?: boolean
}

/// Diagnostics panel: consumes the `get_diagnostics` command and renders a
/// compact operational health view. Designed for operators and support to
/// answer "is the app working?" without parsing logs.
export function DiagnosticsPanel({
  open,
  onClose,
  backendKind = 'legacy-p2p',
  embedded = false,
}: DiagnosticsPanelProps) {
  const signalCheckEnabled = useSettingsStore((state) => state.signalCheckEnabled)
  const setSignalCheckEnabled = useSettingsStore((state) => state.setSignalCheckEnabled)
  const [diagnostics, setDiagnostics] = useState<SystemDiagnostics | null>(null)
  const [matrixStatus, setMatrixStatus] = useState<BackendStatus | null>(null)
  const [error, setError] = useState<unknown | null>(null)
  const [loading, setLoading] = useState(false)
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null)
  const [probeResults, setProbeResults] = useState<IceServerProbeResult[] | null>(null)
  const [probeLoading, setProbeLoading] = useState(false)
  const [supportBundle, setSupportBundle] = useState<string | null>(null)

  const runIceProbe = useCallback(async () => {
    setProbeLoading(true)
    try {
      const results = await probeIceServers()
      setProbeResults(results)
      setError(null)
    } catch (cause) {
      console.error('ICE reachability probe failed:', cause)
      setProbeResults(null)
      setError(cause)
    } finally {
      setProbeLoading(false)
    }
  }, [])

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      if (backendKind === 'matrix') {
        const status = await getBackendStatus()
        setMatrixStatus(status)
        setDiagnostics(null)
      } else {
        const data = await getDiagnostics()
        setDiagnostics(data)
        setMatrixStatus(null)
      }
      setError(null)
      setLastUpdated(new Date())
    } catch (err) {
      setError(err)
    } finally {
      setLoading(false)
    }
  }, [backendKind])

  useEffect(() => {
    if (!open || !signalCheckEnabled) return
    const initialRefresh = window.setTimeout(() => {
      void refresh()
    }, 0)
    return () => {
      window.clearTimeout(initialRefresh)
    }
  }, [open, refresh, signalCheckEnabled])

  useEffect(() => {
    if (!embedded || !open) return
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      event.preventDefault()
      onClose()
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [embedded, onClose, open])

  return (
    <DiagnosticsFrame
      embedded={embedded}
      open={open}
      onClose={onClose}
      title="Connection check"
      description={
        !signalCheckEnabled
          ? 'Off on this device.'
          : lastUpdated
          ? `Updated ${lastUpdated.toLocaleTimeString()}${loading ? ' · refreshing' : ''}`
          : 'Checking this connection...'
      }
      size="lg"
      closeLabel="Close connection check"
    >
      {!signalCheckEnabled && (
        <section
          className="mesh-diagnostics-consent border-y border-outline-variant p-4"
          aria-labelledby="signal-check-off-heading"
        >
          <h3 id="signal-check-off-heading" className="text-body-md font-semibold text-on-surface">
            Connection check is off
          </h3>
          <p className="mt-2 text-body-sm text-on-surface-variant">
            A check never shows account details, message content, or private local information.
          </p>
          <Button className="mt-3" size="sm" onClick={() => setSignalCheckEnabled(true)}>
            Turn on connection check
          </Button>
        </section>
      )}
      {signalCheckEnabled && (
      <>
      <div className="mesh-diagnostics-toolbar mb-4 flex min-h-8 flex-wrap items-center justify-end gap-2 border-b border-outline-variant pb-3">
        {(matrixStatus || diagnostics) && (
          <Button
            onClick={() => {
              const bundle = matrixStatus
                ? createMatrixSupportBundle(matrixStatus)
                : createLegacySupportBundle(diagnostics!)
              setSupportBundle(serializeSupportBundle(bundle))
            }}
            variant="secondary"
            size="sm"
            className="min-h-8"
          >
            Review support bundle
          </Button>
        )}
        <Button
          onClick={refresh}
          disabled={loading}
          variant="ghost"
          size="sm"
          className="min-h-8"
          aria-label="Refresh connection check"
        >
          <Icon name="refresh" size="xs" className={loading ? 'animate-spin' : undefined} />
          Refresh
        </Button>
      </div>

      <div className="mesh-diagnostics-scroll max-h-settings overflow-y-auto">
        {supportBundle && (
          <section
            aria-labelledby="support-bundle-title"
            className="mesh-diagnostics-support mb-4 border-y border-outline-variant p-3"
          >
            <h3 id="support-bundle-title" className="text-body-md font-semibold text-on-surface">
              Support bundle preview
            </h3>
            <p className="mt-1 text-body-sm text-on-surface-variant">
              Review every field before saving. Mesh never uploads this file.
            </p>
            <pre className="mesh-diagnostics-bundle mt-3 max-h-48 overflow-auto whitespace-pre-wrap break-all rounded-full bg-surface p-3 text-body-sm text-on-surface-variant">
              {supportBundle}
            </pre>
            <div className="mt-3 flex flex-wrap gap-2">
              <Button size="sm" onClick={() => saveSupportBundle(supportBundle)}>
                Save reviewed bundle
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setSupportBundle(null)}>
                Cancel
              </Button>
            </div>
          </section>
        )}
        {error != null && (
          <ErrorState
            error={error}
            context={{ operation: 'load connection details' }}
            onAction={refresh}
            className="mb-4"
            compact
          />
        )}

        {!diagnostics && !matrixStatus && !error && (
          <div
            className="space-y-3 py-3"
            role="status"
            aria-label="Loading connection details"
          >
            <span className="sr-only">Loading connection details...</span>
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-4/5" />
          </div>
        )}

        {matrixStatus && <MatrixDiagnosticsContent data={matrixStatus} onRetry={refresh} />}

        {diagnostics && (
          <DiagnosticsContent
            data={diagnostics}
            probeResults={probeResults}
            probeLoading={probeLoading}
            onRunProbe={runIceProbe}
          />
        )}
      </div>
      </>
      )}
    </DiagnosticsFrame>
  )
}

function DiagnosticsFrame({
  embedded,
  open,
  onClose,
  title,
  description,
  children,
  ...modalProps
}: ComponentProps<typeof Modal> & { embedded: boolean; children: ReactNode }) {
  if (embedded) {
    if (!open) return null
    return (
      <section
        aria-labelledby="embedded-signal-check-heading"
        className="mesh-diagnostics-frame mt-4 border-y border-outline-variant py-4"
        onKeyDown={(event) => {
          if (event.key !== 'Escape') return
          event.preventDefault()
          event.stopPropagation()
          onClose()
        }}
      >
        <header className="mesh-diagnostics-header mb-4 flex flex-wrap items-start justify-between gap-3 border-b border-outline-variant pb-3">
          <div>
            <h3 id="embedded-signal-check-heading" className="text-body-md font-semibold text-on-surface">
              {title}
            </h3>
            {description && <p className="mt-1 text-body-sm text-on-surface-variant">{description}</p>}
          </div>
              <Button variant="ghost" size="sm" onClick={onClose}>Close connection check</Button>
        </header>
        {children}
      </section>
    )
  }

  return (
    <Modal
      {...modalProps}
      open={open}
      onClose={onClose}
      title={title}
      description={description}
    >
      {children}
    </Modal>
  )
}

function MatrixDiagnosticsContent({
  data,
  onRetry,
}: {
  data: BackendStatus
  onRetry: () => void
}) {
  const connected = data.authenticated && data.syncRunning
  const voiceRoutesEnabled = shouldExposeVoiceRoutes(true, data)
  // A discovery failure and a build compiled without calling both arrive as
  // client-unavailable, so an unhealthy connection is the only honest signal
  // that Mesh could not check rather than that calling is absent. The frontend
  // gate keeps this state out of builds that genuinely ship without calling.
  const voiceCheckFailed =
    isMatrixVoiceFrontendEnabled() &&
    !connected &&
    data.voiceService.availability === 'client-unavailable'

  return (
    <div className="mesh-diagnostics-content space-y-5">
      {data.warnings.length > 0 && (
        <Section title="Warnings" tone="warning">
          <ul className="space-y-1.5">
            {data.warnings.map((_warning, index) => (
              <li key={index} className="flex items-start gap-2 text-body-sm text-marker">
                <Icon name="triangleAlert" size="xs" className="mt-0.5 flex-none" />
                <span>A service check needs attention.</span>
              </li>
            ))}
          </ul>
        </Section>
      )}

      <Section title="Account connection">
        <Grid>
          <StatusCell
            label="Connection service"
            value={data.authenticated ? 'Connected' : 'Sign-in required'}
            ok={data.authenticated}
          />
          <StatusCell
            label="Message updates"
            value={data.syncRunning ? 'Running' : 'Stopped'}
            ok={data.syncRunning}
          />
          <StatusCell
            label="Message protection"
            value={data.supportsE2ee ? 'Supported' : 'Unavailable'}
            ok={data.supportsE2ee}
          />
          <StatusCell
            label="Device protection"
            value={data.sessionE2eeReady ? 'Ready' : 'Not ready'}
            ok={data.sessionE2eeReady}
            warn={data.supportsE2ee && !data.sessionE2eeReady}
          />
          <StatusCell
            label="Message history"
            value={data.durableHistory ? 'Enabled' : 'Unavailable'}
            ok={data.durableHistory}
          />
        </Grid>
        {connected && data.warnings.length === 0 && (
          <p className="mt-2 text-body-sm text-primary">
            Your Mesh account is connected and up to date.
          </p>
        )}
      </Section>

      <Section title="Connection details">
        <div className="space-y-2">
          <DetailRow label="Account service" value={data.homeserver ?? 'Not configured'} />
          <DetailRow label="Support code" value={data.deviceId ?? 'Unavailable'} />
        </div>
      </Section>

      {voiceRoutesEnabled && (
      <Section title="Private calling">
        <Grid>
          <StatusCell
            label="Call connection"
            value={data.voiceService.provider === 'matrix-rtc' ? 'Connected' : 'Unavailable'}
            ok={data.voiceService.provider === 'matrix-rtc'}
          />
          <StatusCell
            label="Availability"
            value={voiceAvailabilityLabel(data.voiceService.availability)}
            ok={data.voiceService.availability === 'ready'}
            warn={data.voiceService.availability !== 'ready'}
          />
          <StatusCell
            label="Media protection support"
            value={data.voiceService.mediaE2eeReady ? 'Available' : 'Unavailable'}
            ok={data.voiceService.mediaE2eeReady}
            warn={!data.voiceService.mediaE2eeReady}
          />
          <StatusCell
            label="Call access"
            value={data.voiceService.cspReady ? 'Allowed' : 'Blocked'}
            ok={data.voiceService.cspReady}
            warn={!data.voiceService.cspReady}
          />
        </Grid>
        <details className="mesh-diagnostics-disclosure mt-3 rounded-full border border-outline-variant bg-surface-container-lowest px-3">
          <summary className="flex min-h-8 cursor-pointer items-center text-body-sm font-medium text-on-surface-variant focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus">
            Service details
          </summary>
          <div className="space-y-2 border-t border-outline-variant py-3">
            <DetailRow
              label="Call setup"
              value={data.voiceService.discoveryKey ? 'Configured' : 'Not configured'}
            />
            <DetailRow
              label="Call provider"
              value={data.voiceService.livekitServiceUrl ?? 'Not configured'}
            />
            <DetailRow
              label="Sign-in service"
              value={data.voiceService.tokenEndpoint ?? 'Not configured'}
            />
            <DetailRow
              label="Media service"
              value={data.voiceService.livekitSfuUrl ?? 'Not configured'}
            />
          </div>
        </details>
        <p className="mt-2 text-body-sm text-on-surface-variant">
          Calling stays disabled until account access, media delivery, and call protection are
          verified.
        </p>
      </Section>
      )}

      {voiceCheckFailed && (
        <Section title="Private calling">
          <p className="text-body-sm text-on-surface-variant">
            Mesh could not check private calling while this connection is down.
          </p>
          <Button className="mt-3" size="sm" variant="secondary" onClick={onRetry}>
            Check private calling again
          </Button>
        </Section>
      )}
    </div>
  )
}

function voiceAvailabilityLabel(availability: BackendStatus['voiceService']['availability']): string {
  switch (availability) {
    case 'ready':
      return 'Ready'
    case 'not-configured':
      return 'Not configured'
    case 'invalid-configuration':
      return 'Invalid configuration'
    case 'client-unavailable':
      return 'Client unavailable'
  }
}

function DiagnosticsContent({
  data,
  probeResults,
  probeLoading,
  onRunProbe,
}: {
  data: SystemDiagnostics
  probeResults: IceServerProbeResult[] | null
  probeLoading: boolean
  onRunProbe: () => void
}) {
  return (
    <div className="mesh-diagnostics-content space-y-5">
      {/* Warnings */}
      {data.warnings.length > 0 && (
        <Section title="Warnings" tone="warning">
          <ul className="space-y-1.5">
            {data.warnings.map((_warning, i) => (
              <li key={i} className="flex items-start gap-2 text-body-sm text-marker">
                <Icon name="triangleAlert" size="xs" className="mt-0.5 flex-none" />
                <span>A service check needs attention.</span>
              </li>
            ))}
          </ul>
        </Section>
      )}

      {/* Overview */}
      <Section title="Overview">
        <Grid>
          <StatusCell
            label="Connection"
            // The user IS a peer. networkPeerCount from the backend counts
            // OTHER peers. We show "You + N" so the framing matches the
            // user's mental model instead of libp2p's.
            value={
              data.networkConnected
                ? `You and ${data.networkPeerCount} other connection${data.networkPeerCount === 1 ? '' : 's'}`
                : 'Only this device'
            }
            ok={data.networkConnected}
            warn={false}
          />
          <StatusCell
            label="Account"
            value={data.identityLoaded ? 'Loaded' : 'Not loaded'}
            ok={data.identityLoaded}
          />
          <StatCell label="Communities" value={data.communityCount.toString()} />
          <StatCell label="Members" value={data.memberCount.toString()} />
          <StatCell label="Voice sessions" value={data.activeVoiceSessions.toString()} />
          <StatCell
            label="Pending messages"
            value={data.pendingMessageCount.toString()}
            // Only flag as a problem if we have peers AND still have pending.
            // Solo + pending is normal: they'll re-broadcast when peers arrive.
            ok={data.pendingMessageCount === 0 || !data.networkConnected}
          />
        </Grid>
        {!data.networkConnected && (
          <p className="mesh-diagnostics-note mt-2 text-body-sm text-on-surface-variant">
            This device is offline from other Mesh users.
          </p>
        )}
      </Section>

      {/* Network detail */}
      <Section title="Connection">
        <Grid>
          <StatCell
            label="Other connections"
            value={data.networkPeerCount.toString()}
          />
          <StatCell label="Version" value={data.version} />
        </Grid>
      </Section>

      {/* ICE / TURN */}
      <Section title="Call connection">
        <Grid>
          <StatusCell
            label="Direct connection"
            value={data.iceServerStatus.stunConfigured ? 'Configured' : 'Missing'}
            ok={data.iceServerStatus.stunConfigured}
          />
          <StatusCell
            label="Backup connection"
            value={data.iceServerStatus.turnConfigured ? 'Configured' : 'Missing'}
            ok={data.iceServerStatus.turnConfigured}
            warn={!data.iceServerStatus.turnConfigured}
          />
          <StatCell
            label="Setup"
            value={data.iceServerStatus.customServers ? 'Custom' : 'Defaults'}
          />
        </Grid>
        {!data.iceServerStatus.turnConfigured && (
          <p className="mesh-diagnostics-note mt-2 text-body-sm text-marker">
            A backup call connection is not configured. Some calls may fail. Ask the community
            operator to check the call service.
          </p>
        )}

        {/* Reachability probe */}
        <div className="mesh-diagnostics-test mt-3 border-t border-outline-variant pt-3">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-label-sm font-semibold lowercase tracking-label-md text-on-surface-variant">
              Connection test
            </span>
            <Button
              onClick={onRunProbe}
              disabled={probeLoading}
              variant="ghost"
              size="sm"
              className="min-h-8"
              aria-label="Run connection test"
              aria-describedby="ice-probe-description"
            >
              {probeLoading ? 'Testing...' : 'Run connection test'}
            </Button>
          </div>
          {probeResults === null && !probeLoading && (
            <p id="ice-probe-description" className="text-body-sm text-on-surface-variant">
              Checks whether the call connection services are available.
            </p>
          )}
          {(probeResults !== null || probeLoading) && (
            <p id="ice-probe-description" className="sr-only">
              Test whether the configured voice connection services are reachable.
            </p>
          )}
          {probeResults !== null && probeResults.length === 0 && (
            <p className="text-body-sm text-on-surface-variant">No call connection services are configured.</p>
          )}
          {probeResults !== null && probeResults.length > 0 && (
            <div className="space-y-1.5">
              {probeResults.map((r, i) => (
                <ProbeRow key={`${r.url}-${i}`} result={r} />
              ))}
            </div>
          )}
        </div>
      </Section>

      {/* Downloads */}
      <Section title={`Downloads (${data.activeDownloadCount})`}>
        {data.downloadStats.length === 0 ? (
          <p className="text-body-sm text-on-surface-variant">No active downloads.</p>
        ) : (
          <div className="space-y-2">
            {data.downloadStats.map((stats) => (
              <DownloadCard key={stats.fileHash} stats={stats} />
            ))}
          </div>
        )}
      </Section>
    </div>
  )
}

function Section({
  title,
  children,
  tone,
}: {
  title: string
  children: React.ReactNode
  tone?: 'warning'
}) {
  return (
    <div className="mesh-diagnostics-section">
      <h3
        className={`mb-2 text-label-sm font-semibold lowercase tracking-label-md ${
          tone === 'warning' ? 'text-marker' : 'text-on-surface-variant'
        }`}
      >
        {title}
      </h3>
      {children}
    </div>
  )
}

function Grid({ children }: { children: React.ReactNode }) {
  return <div className="mesh-diagnostics-grid grid grid-cols-2 gap-2 md:grid-cols-3">{children}</div>
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="mesh-diagnostics-cell px-3 py-2">
      <div className="text-label-sm lowercase tracking-label-md text-on-surface-variant">{label}</div>
      <div className="mt-0.5 break-all font-code text-body-sm text-on-surface">{value}</div>
    </div>
  )
}

function StatCell({ label, value, ok }: { label: string; value: string; ok?: boolean }) {
  return (
    <div className="mesh-diagnostics-cell px-3 py-2">
      <div className="text-label-sm lowercase tracking-label-md text-on-surface-variant">{label}</div>
      <div
        className={`tnum mt-0.5 font-code text-body-md ${
          ok === false ? 'text-error' : ok === true ? 'text-primary' : 'text-on-surface'
        }`}
      >
        {value}
      </div>
    </div>
  )
}

function StatusCell({
  label,
  value,
  ok,
  warn,
}: {
  label: string
  value: string
  ok: boolean
  warn?: boolean
}) {
  const state = warn ? 'degraded' : ok ? 'connected' : 'disconnected'
  return (
    <div className="mesh-diagnostics-cell px-3 py-2">
      <div className="text-label-sm lowercase tracking-label-md text-on-surface-variant">{label}</div>
      <div className="mt-0.5 flex items-center gap-1.5 text-body-md">
        <StatusDot state={state} label={`${label}: ${value}`} />
        <span className="text-on-surface">{value}</span>
      </div>
    </div>
  )
}

function DownloadCard({ stats }: { stats: SchedulerStats }) {
  const progress = stats.totalChunks > 0 ? stats.receivedChunks / stats.totalChunks : 0
  const statusLabel = stats.isFailed
    ? 'Failed'
    : stats.isStalled
      ? 'Stalled'
      : stats.isComplete
        ? 'Complete'
        : 'Active'
  const statusColor = stats.isFailed
    ? 'text-error'
    : stats.isStalled
      ? 'text-marker'
      : stats.isComplete
        ? 'text-primary'
        : 'text-primary'
  return (
    <div className="mesh-diagnostics-download px-3 py-2">
      <div className="mb-1 flex items-center justify-between text-body-sm">
        <span className="truncate font-code text-on-surface-variant" title={stats.fileHash}>
          {stats.fileHash.slice(0, 16)}…
        </span>
        <span className={statusColor}>{statusLabel}</span>
      </div>
      <div className="mb-2 h-1 overflow-hidden rounded-xl bg-surface-container-highest">
        <div
          className="h-full bg-primary transition-all"
          data-design-token-exception="data-driven-diagnostic-progress-width"
          style={{ width: `${Math.round(progress * 100)}%` }}
        />
      </div>
      <div className="grid grid-cols-4 gap-2 text-label-sm text-on-surface-variant">
        <div>
          <span className="text-on-surface-variant">{stats.receivedChunks}</span>/{stats.totalChunks}{' '}
          parts
        </div>
        <div>
          <span className="text-on-surface-variant">{stats.inFlightChunks}</span> active
        </div>
        <div>
          <span className="text-on-surface-variant">{stats.seederCount}</span> sources
        </div>
        <div>
          <span className="text-on-surface-variant">{Math.round(stats.avgSeederRttMs)}ms</span> delay
        </div>
      </div>
    </div>
  )
}

/// Map a probe outcome code to its UI classification (color, dot, label).
/// This centralizes the decision so tests and UI stay in sync with the
/// backend's outcome vocabulary.
type ProbeSeverity = 'success' | 'warning' | 'error'

function probeSeverity(outcome: string): ProbeSeverity {
  switch (outcome) {
    case 'ok':
    case 'allocation_ok':
      return 'success'
    case 'stun_reachable':
    case 'timeout':
    case 'unreachable':
    case 'dns_failed':
    case 'tls_error':
    case 'turn_protocol_err':
      return 'warning'
    case 'malformed':
    case 'no_credentials':
    case 'auth_rejected':
      return 'error'
    default:
      return 'warning'
  }
}

/// Human-readable label for a probe outcome. Shown next to the URL in the
/// diagnostics panel so operators don't have to memorize outcome codes.
function probeOutcomeLabel(outcome: string): string {
  switch (outcome) {
    case 'ok':
      return 'Available'
    case 'allocation_ok':
      return 'Backup connection available'
    case 'stun_reachable':
      return 'Direct connection only'
    case 'auth_rejected':
      return 'Sign-in rejected'
    case 'turn_protocol_err':
      return 'Connection service error'
    case 'unreachable':
      return 'Could not connect'
    case 'timeout':
      return 'Timed out'
    case 'dns_failed':
      return 'Address not found'
    case 'malformed':
      return 'Address not valid'
    case 'no_credentials':
      return 'Sign-in details missing'
    case 'tls_error':
      return 'Secure connection failed'
    default:
      return outcome
  }
}

function ProbeRow({ result }: { result: IceServerProbeResult }) {
  const severity = probeSeverity(result.outcome)
  const outcomeColor =
    severity === 'success'
      ? 'text-primary'
      : severity === 'error'
        ? 'text-error'
        : 'text-marker'
  const label = probeOutcomeLabel(result.outcome)
  const state = severity === 'success'
    ? 'connected'
    : severity === 'error'
      ? 'disconnected'
      : 'degraded'
  return (
    <div className="mesh-diagnostics-probe px-2 py-1.5 text-body-sm">
      <div className="flex items-center gap-1.5">
        <StatusDot state={state} label={`${result.url}: ${label}`} />
        <span className="truncate font-code text-on-surface-variant" title={result.url}>
          {result.url}
        </span>
        <span className={`ml-auto ${outcomeColor}`} title={result.outcome}>
          {label}
        </span>
      </div>
      <div className="mt-0.5 text-label-sm text-on-surface-variant">
        {result.latencyMs !== null ? `Responded in ${result.latencyMs}ms.` : 'No response time is available.'}
      </div>
    </div>
  )
}
