import { useEffect, useState, useCallback } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
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
import { Spinner } from '../ui/Spinner'
import { ErrorState } from '../ui/ErrorState'

interface DiagnosticsPanelProps {
  open: boolean
  onClose: () => void
  backendKind?: BackendKind
}

/// Auto-refresh interval when the panel is open (milliseconds).
const REFRESH_INTERVAL_MS = 3000

/// Diagnostics panel — consumes the `get_diagnostics` command and renders a
/// compact operational health view. Designed for operators and support to
/// answer "is the app working?" without parsing logs.
export function DiagnosticsPanel({ open, onClose, backendKind = 'legacy-p2p' }: DiagnosticsPanelProps) {
  const [diagnostics, setDiagnostics] = useState<SystemDiagnostics | null>(null)
  const [matrixStatus, setMatrixStatus] = useState<BackendStatus | null>(null)
  const [error, setError] = useState<unknown | null>(null)
  const [loading, setLoading] = useState(false)
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null)
  const [probeResults, setProbeResults] = useState<IceServerProbeResult[] | null>(null)
  const [probeLoading, setProbeLoading] = useState(false)

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
    if (!open) return
    refresh()
    const interval = setInterval(refresh, REFRESH_INTERVAL_MS)
    return () => clearInterval(interval)
  }, [open, refresh])

  useEffect(() => {
    if (!open) return
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handleEscape)
    return () => document.removeEventListener('keydown', handleEscape)
  }, [open, onClose])

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="fixed inset-0 z-modal flex items-center justify-center bg-scrim px-6"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          onClick={(e) => {
            if (e.target === e.currentTarget) onClose()
          }}
        >
          <motion.div
            className="flex max-h-modal w-full max-w-2xl flex-col overflow-hidden rounded-lg bg-bg-secondary shadow-overlay"
            initial={{ opacity: 0, scale: 0.95, y: 10 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: 10 }}
          >
            {/* Header */}
            <div className="flex items-center justify-between border-b border-border px-5 py-4">
              <div>
                <h2 className="text-base font-semibold text-primary">System Diagnostics</h2>
                <p className="text-xs text-muted">
                  {lastUpdated ? `Updated ${lastUpdated.toLocaleTimeString()}` : 'Loading...'}
                  {loading && ' • refreshing'}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={refresh}
                  disabled={loading}
                  className="rounded px-3 py-1.5 text-xs text-secondary hover:bg-bg-tertiary disabled:opacity-50"
                  aria-label="Refresh diagnostics"
                >
                  Refresh
                </button>
                <button
                  onClick={onClose}
                  className="rounded px-3 py-1.5 text-xs text-muted hover:bg-bg-tertiary hover:text-primary"
                  aria-label="Close diagnostics"
                >
                  Close
                </button>
              </div>
            </div>

            {/* Body */}
            <div className="flex-1 overflow-y-auto px-5 py-4">
              {error != null && (
                <ErrorState
                  error={error}
                  context={{ operation: 'load diagnostics' }}
                  onAction={refresh}
                  className="mb-4"
                  compact
                />
              )}

              {!diagnostics && !matrixStatus && !error && (
                <div className="flex h-32 items-center justify-center">
                  <Spinner />
                </div>
              )}

              {matrixStatus && <MatrixDiagnosticsContent data={matrixStatus} />}

              {diagnostics && (
                <DiagnosticsContent
                  data={diagnostics}
                  probeResults={probeResults}
                  probeLoading={probeLoading}
                  onRunProbe={runIceProbe}
                />
              )}
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}

function MatrixDiagnosticsContent({ data }: { data: BackendStatus }) {
  const connected = data.authenticated && data.syncRunning

  return (
    <div className="space-y-5">
      {data.warnings.length > 0 && (
        <Section title="Warnings" tone="warning">
          <ul className="space-y-1.5">
            {data.warnings.map((warning, index) => (
              <li key={index} className="flex items-start gap-2 text-xs text-yellow">
                <span aria-hidden>⚠</span>
                <span>{warning}</span>
              </li>
            ))}
          </ul>
        </Section>
      )}

      <Section title="Matrix account">
        <Grid>
          <StatusCell
            label="Homeserver"
            value={data.authenticated ? 'Connected' : 'Sign-in required'}
            ok={data.authenticated}
          />
          <StatusCell
            label="Sync"
            value={data.syncRunning ? 'Running' : 'Stopped'}
            ok={data.syncRunning}
          />
          <StatusCell
            label="Encryption"
            value={data.endToEndEncryption ? 'Enabled' : 'Unavailable'}
            ok={data.endToEndEncryption}
          />
          <StatusCell
            label="Durable history"
            value={data.durableHistory ? 'Enabled' : 'Unavailable'}
            ok={data.durableHistory}
          />
        </Grid>
        {connected && data.warnings.length === 0 && (
          <p className="mt-2 text-xs text-green">
            Your Matrix account is connected and syncing normally.
          </p>
        )}
      </Section>

      <Section title="Session">
        <div className="space-y-2">
          <DetailRow label="User" value={data.userId ?? 'Not signed in'} />
          <DetailRow label="Homeserver URL" value={data.homeserver ?? 'Not configured'} />
          <DetailRow label="Device" value={data.deviceId ?? 'Unavailable'} />
        </div>
      </Section>

      <Section title="MatrixRTC calling">
        <Grid>
          <StatusCell
            label="Provider"
            value="MatrixRTC + LiveKit"
            ok={data.voiceService.provider === 'matrix-rtc'}
          />
          <StatusCell
            label="Availability"
            value={voiceAvailabilityLabel(data.voiceService.availability)}
            ok={data.voiceService.availability === 'ready'}
            warn={data.voiceService.availability !== 'ready'}
          />
          <StatusCell
            label="Media E2EE"
            value={data.voiceService.mediaE2eeVerified ? 'Verified' : 'Not verified'}
            ok={data.voiceService.mediaE2eeVerified}
            warn={!data.voiceService.mediaE2eeVerified}
          />
          <StatusCell
            label="Tauri CSP"
            value={data.voiceService.cspReady ? 'Origins allowed' : 'Origins blocked'}
            ok={data.voiceService.cspReady}
            warn={!data.voiceService.cspReady}
          />
        </Grid>
        <div className="mt-2 space-y-2">
          <DetailRow
            label=".well-known discovery key"
            value={data.voiceService.discoveryKey ?? 'Not applicable'}
          />
          <DetailRow
            label="livekit_service_url"
            value={data.voiceService.livekitServiceUrl ?? 'Not configured'}
          />
          <DetailRow
            label="MSC4195 token exchange"
            value={data.voiceService.tokenEndpoint ?? 'Not configured (/get_token)'}
          />
          <DetailRow
            label="Expected LiveKit SFU"
            value={data.voiceService.livekitSfuUrl ?? 'Not configured'}
          />
        </div>
        {data.voiceService.reason && (
          <p className="mt-2 rounded bg-bg-primary px-3 py-2 text-xs leading-5 text-yellow">
            {data.voiceService.reason}
          </p>
        )}
        <p className="mt-2 text-xs leading-5 text-muted">
          Configured endpoints do not prove authorization, SFU reachability, or media E2EE.
          Calling remains disabled until all three are exercised by live acceptance tests.
        </p>
      </Section>
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
    <div className="space-y-5">
      {/* Warnings */}
      {data.warnings.length > 0 && (
        <Section title="Warnings" tone="warning">
          <ul className="space-y-1.5">
            {data.warnings.map((warning, i) => (
              <li key={i} className="flex items-start gap-2 text-xs text-yellow">
                <span aria-hidden>⚠</span>
                <span>{warning}</span>
              </li>
            ))}
          </ul>
        </Section>
      )}

      {/* Overview */}
      <Section title="Overview">
        <Grid>
          <StatusCell
            label="Network"
            // The user IS a peer. networkPeerCount from the backend counts
            // OTHER peers. We show "You + N" so the framing matches the
            // user's mental model instead of libp2p's.
            value={
              data.networkConnected
                ? `You + ${data.networkPeerCount} peer${data.networkPeerCount === 1 ? '' : 's'}`
                : 'Running solo'
            }
            ok={data.networkConnected}
            warn={false}
          />
          <StatusCell
            label="Identity"
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
            // Solo + pending is normal — they'll re-broadcast when peers arrive.
            ok={data.pendingMessageCount === 0 || !data.networkConnected}
          />
        </Grid>
        {!data.networkConnected && (
          <p className="mt-2 text-xs text-muted">
            Running as a solo peer. Your messages, communities, and settings are
            stored locally and visible to you immediately. They'll automatically
            sync to other peers when someone joins the mesh — either via a local
            network (mDNS) or by configuring{' '}
            <code className="rounded bg-bg-tertiary px-1">MESH_BOOTSTRAP_PEERS</code>.
          </p>
        )}
      </Section>

      {/* Network detail */}
      <Section title="Network">
        <Grid>
          <StatCell
            label="Other peers"
            value={data.networkPeerCount.toString()}
          />
          <StatCell label="Version" value={data.version} />
        </Grid>
      </Section>

      {/* ICE / TURN */}
      <Section title="Voice connectivity (ICE / TURN)">
        <Grid>
          <StatusCell
            label="STUN"
            value={data.iceServerStatus.stunConfigured ? 'Configured' : 'Missing'}
            ok={data.iceServerStatus.stunConfigured}
          />
          <StatusCell
            label="TURN"
            value={data.iceServerStatus.turnConfigured ? 'Configured' : 'Missing'}
            ok={data.iceServerStatus.turnConfigured}
            warn={!data.iceServerStatus.turnConfigured}
          />
          <StatCell
            label="Source"
            value={data.iceServerStatus.customServers ? 'Custom' : 'Defaults'}
          />
        </Grid>
        {!data.iceServerStatus.turnConfigured && (
          <p className="mt-2 text-xs text-yellow">
            No TURN server configured. Voice calls may fail for users behind symmetric NATs.
            Configure one in Settings → Voice & Audio.
          </p>
        )}

        {/* Reachability probe */}
        <div className="mt-3 border-t border-border pt-3">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-meta font-semibold uppercase tracking-wider text-muted">
              Reachability probe
            </span>
            <button
              onClick={onRunProbe}
              disabled={probeLoading}
              className="rounded bg-bg-tertiary px-2 py-1 text-meta text-secondary hover:bg-bg-primary disabled:opacity-50"
              aria-label="Run ICE reachability probe"
            >
              {probeLoading ? 'Probing…' : 'Run probe'}
            </button>
          </div>
          {probeResults === null && !probeLoading && (
            <p className="text-xs text-muted">
              Click "Run probe" to test whether configured ICE servers are reachable.
            </p>
          )}
          {probeResults !== null && probeResults.length === 0 && (
            <p className="text-xs text-muted">No ICE servers configured.</p>
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
          <p className="text-xs text-muted">No active downloads.</p>
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
    <div>
      <h3
        className={`mb-2 text-meta font-semibold uppercase tracking-wider ${
          tone === 'warning' ? 'text-yellow' : 'text-muted'
        }`}
      >
        {title}
      </h3>
      {children}
    </div>
  )
}

function Grid({ children }: { children: React.ReactNode }) {
  return <div className="grid grid-cols-2 gap-2 md:grid-cols-3">{children}</div>
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded bg-bg-primary px-3 py-2">
      <div className="text-caption uppercase tracking-wide text-muted">{label}</div>
      <div className="mt-0.5 break-all font-mono text-xs text-primary">{value}</div>
    </div>
  )
}

function StatCell({ label, value, ok }: { label: string; value: string; ok?: boolean }) {
  return (
    <div className="rounded bg-bg-primary px-3 py-2">
      <div className="text-caption uppercase tracking-wide text-muted">{label}</div>
      <div
        className={`tnum mt-0.5 font-mono text-sm ${
          ok === false ? 'text-red' : ok === true ? 'text-green' : 'text-primary'
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
  const color = warn ? 'text-yellow' : ok ? 'text-green' : 'text-red'
  const dotColor = warn ? 'bg-yellow' : ok ? 'bg-green' : 'bg-red'
  return (
    <div className="rounded bg-bg-primary px-3 py-2">
      <div className="text-caption uppercase tracking-wide text-muted">{label}</div>
      <div className="mt-0.5 flex items-center gap-1.5 text-sm">
        <span className={`inline-block h-2 w-2 rounded-full ${dotColor}`} aria-hidden />
        <span className={color}>{value}</span>
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
    ? 'text-red'
    : stats.isStalled
      ? 'text-yellow'
      : stats.isComplete
        ? 'text-green'
        : 'text-accent'
  return (
    <div className="rounded bg-bg-primary px-3 py-2">
      <div className="mb-1 flex items-center justify-between text-xs">
        <span className="truncate font-mono text-muted" title={stats.fileHash}>
          {stats.fileHash.slice(0, 16)}…
        </span>
        <span className={statusColor}>{statusLabel}</span>
      </div>
      <div className="mb-2 h-1 overflow-hidden rounded-full bg-bg-tertiary">
        <div
          className="h-full bg-accent transition-all"
          data-design-token-exception="data-driven-diagnostic-progress-width"
          style={{ width: `${Math.round(progress * 100)}%` }}
        />
      </div>
      <div className="grid grid-cols-4 gap-2 text-caption text-muted">
        <div>
          <span className="text-secondary">{stats.receivedChunks}</span>/{stats.totalChunks}{' '}
          chunks
        </div>
        <div>
          <span className="text-secondary">{stats.inFlightChunks}</span> in-flight
        </div>
        <div>
          <span className="text-secondary">{stats.seederCount}</span> seeders
        </div>
        <div>
          <span className="text-secondary">{Math.round(stats.avgSeederRttMs)}ms</span> rtt
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
      return 'Reachable'
    case 'allocation_ok':
      return 'TURN Allocate OK'
    case 'stun_reachable':
      return 'STUN reachable (TURN failed)'
    case 'auth_rejected':
      return 'Auth rejected'
    case 'turn_protocol_err':
      return 'TURN protocol error'
    case 'unreachable':
      return 'Unreachable'
    case 'timeout':
      return 'Timeout'
    case 'dns_failed':
      return 'DNS failed'
    case 'malformed':
      return 'Malformed URL'
    case 'no_credentials':
      return 'Missing credentials'
    case 'tls_error':
      return 'TLS error'
    default:
      return outcome
  }
}

function ProbeRow({ result }: { result: IceServerProbeResult }) {
  const severity = probeSeverity(result.outcome)
  const outcomeColor =
    severity === 'success' ? 'text-green' : severity === 'error' ? 'text-red' : 'text-yellow'
  const dot =
    severity === 'success' ? 'bg-green' : severity === 'error' ? 'bg-red' : 'bg-yellow'
  const label = probeOutcomeLabel(result.outcome)
  return (
    <div className="rounded bg-bg-primary px-2 py-1.5 text-meta">
      <div className="flex items-center gap-1.5">
        <span className={`inline-block h-2 w-2 rounded-full ${dot}`} aria-hidden />
        <span className="truncate font-mono text-secondary" title={result.url}>
          {result.url}
        </span>
        <span className={`ml-auto ${outcomeColor}`} title={result.outcome}>
          {label}
        </span>
      </div>
      <div className="mt-0.5 text-caption text-muted">
        {result.detail}
        {result.latencyMs !== null && <span> · {result.latencyMs}ms</span>}
      </div>
    </div>
  )
}
