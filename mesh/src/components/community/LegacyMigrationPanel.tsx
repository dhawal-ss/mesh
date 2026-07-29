import { useMemo, useState } from 'react'
import { open } from '@tauri-apps/plugin-dialog'
import { Button } from '../ui/Button'
import { Input } from '../ui/Input'
import * as bridge from '../../lib/bridge'
import { describeError } from '../../lib/errors'
import type {
  Channel,
  LegacyArchiveSummary,
  LegacyDryRunReport,
  LegacyImportRequest,
} from '../../types/ipc'

interface LegacyMigrationPanelProps {
  communityId: string
  channels: Channel[]
  canManage: boolean
}

export function LegacyMigrationPanel({
  communityId,
  channels,
  canManage,
}: LegacyMigrationPanelProps) {
  const matrixMode = bridge.isMatrixBackend()
  const [archivePaths, setArchivePaths] = useState<string[]>([])
  const [summaries, setSummaries] = useState<LegacyArchiveSummary[]>([])
  const [legacyCommunityId, setLegacyCommunityId] = useState('')
  const [channelRooms, setChannelRooms] = useState<Record<string, string>>({})
  const [resolutions, setResolutions] = useState<Record<string, string>>({})
  const [report, setReport] = useState<LegacyDryRunReport | null>(null)
  const [approvalPhrase, setApprovalPhrase] = useState('')
  const [status, setStatus] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [legacyFileCandidates, setLegacyFileCandidates] = useState<string[]>([])

  const archivedCommunities = useMemo(() => {
    const byId = new Map<string, LegacyArchiveSummary['communities'][number]>()
    for (const summary of summaries) {
      for (const community of summary.communities) {
        if (!byId.has(community.id)) byId.set(community.id, community)
      }
    }
    return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name))
  }, [summaries])

  const targetChannels = channels.filter((channel) => channel.communityId === communityId)

  const selectLegacyCommunity = (
    selected: LegacyArchiveSummary['communities'][number] | undefined,
  ) => {
    setLegacyCommunityId(selected?.id ?? '')
    const inferred: Record<string, string> = {}
    for (const legacyChannel of selected?.channels ?? []) {
      const matches = targetChannels.filter(
        (channel) => channel.name.toLowerCase() === legacyChannel.name.toLowerCase(),
      )
      if (matches.length === 1) inferred[legacyChannel.id] = matches[0].id
    }
    setChannelRooms(inferred)
    setResolutions({})
    setReport(null)
    setApprovalPhrase('')
  }
  const selectedLegacyCommunity = archivedCommunities.find(
    (community) => community.id === legacyCommunityId,
  )

  if (!canManage) return null

  const buildRequest = (): LegacyImportRequest => ({
    archivePaths,
    includeCommunityIds: legacyCommunityId ? [legacyCommunityId] : [],
    mappings: legacyCommunityId
      ? [{ legacyCommunityId, matrixSpaceId: communityId, channelRooms }]
      : [],
    resolutions: Object.entries(resolutions).map(
      ([conflictKey, selectedRecordSha256]) => ({ conflictKey, selectedRecordSha256 }),
    ),
  })

  const selectArchives = async () => {
    setError('')
    setStatus('')
    const selected = await open({
      multiple: true,
      directory: false,
      filters: [{ name: 'Mesh legacy archive', extensions: ['json'] }],
    })
    const paths = Array.isArray(selected) ? selected : selected ? [selected] : []
    if (paths.length === 0) return
    setBusy(true)
    try {
      const inspected = await bridge.inspectLegacyArchives(paths)
      setArchivePaths(paths)
      setSummaries(inspected)
      const firstCommunity = inspected.flatMap((summary) => summary.communities)[0]
      selectLegacyCommunity(firstCommunity)
      setStatus(`Loaded ${inspected.length} independently hashed peer archive${inspected.length === 1 ? '' : 's'}.`)
    } catch (cause) {
      console.error('Could not inspect the selected archives:', cause)
      setError(friendlyMigrationError(cause, 'inspect the selected archives'))
    } finally {
      setBusy(false)
    }
  }

  const exportArchive = async () => {
    setBusy(true)
    setError('')
    setStatus('')
    try {
      const result = await bridge.exportLegacyArchive({
        communityId,
        filePaths: {},
        fileCandidates: legacyFileCandidates,
      })
      setStatus(`Archive written to ${result.archivePath}. ${result.summary.missingFileCount} file payload(s) need a source path before they can be embedded.`)
    } catch (cause) {
      console.error('Legacy export failed:', cause)
      setError(friendlyMigrationError(cause, 'export the legacy archive'))
    } finally {
      setBusy(false)
    }
  }

  const runDryRun = async () => {
    setBusy(true)
    setError('')
    setStatus('')
    setApprovalPhrase('')
    try {
      const next = await bridge.dryRunLegacyImport(buildRequest())
      setReport(next)
      setStatus(
        next.errors.length === 0 && next.unresolvedConflictCount === 0
          ? 'Dry run is ready for explicit approval.'
          : 'Dry run found issues that must be resolved before import.',
      )
    } catch (cause) {
      console.error('Legacy import dry run failed:', cause)
      setError(friendlyMigrationError(cause, 'validate the legacy import'))
    } finally {
      setBusy(false)
    }
  }

  const approveImport = async () => {
    if (!report?.approvalToken || !report.approvalPhrase) return
    setBusy(true)
    setError('')
    setStatus('')
    try {
      const result = await bridge.approveLegacyImport(
        buildRequest(),
        report.approvalToken,
        approvalPhrase,
      )
      setStatus(
        `Imported ${result.importedEvents} encrypted provenance event(s); ${result.previouslyImportedEvents} were already recorded on this device.`,
      )
    } catch (cause) {
      console.error('Approved legacy import failed:', cause)
      setError(friendlyMigrationError(cause, 'import the approved legacy archive'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mb-6">
      <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">
        Legacy archive migration
      </h3>
      <div className="space-y-4">
        {!matrixMode ? (
          <>
            <p className="text-xs text-muted">
              Export this community from each legacy peer. The archive preserves signatures,
              timestamps, record hashes, memberships, control events, and available file bytes.
            </p>
            <Button
              onClick={async () => {
                const selected = await open({ multiple: true, directory: false })
                setLegacyFileCandidates(
                  Array.isArray(selected) ? selected : selected ? [selected] : [],
                )
              }}
              disabled={busy}
              variant="secondary"
              className="w-full"
            >
              {legacyFileCandidates.length > 0
                ? `${legacyFileCandidates.length} local file${legacyFileCandidates.length === 1 ? '' : 's'} selected`
                : 'Select available attachment files'}
            </Button>
            <Button onClick={exportArchive} disabled={busy} className="w-full">
              {busy ? 'Exporting…' : 'Export this peer archive'}
            </Button>
          </>
        ) : (
          <>
            <p className="text-xs text-muted">
              Select archives from every available peer. Mesh compares their histories and will
              not choose a divergent record without an explicit resolution.
            </p>
            <Button onClick={selectArchives} disabled={busy} variant="secondary" className="w-full">
              {archivePaths.length > 0
                ? `${archivePaths.length} archive${archivePaths.length === 1 ? '' : 's'} selected`
                : 'Select peer archives'}
            </Button>

            {archivedCommunities.length > 0 && (
              <div>
                <label className="mb-1.5 block text-xs font-semibold uppercase text-muted">
                  Legacy community
                </label>
                <select
                  value={legacyCommunityId}
                  onChange={(event) => selectLegacyCommunity(
                    archivedCommunities.find((community) => community.id === event.target.value),
                  )}
                  className="w-full rounded-control border border-border bg-surface-sunken px-3 py-2.5 text-sm text-primary focus:border-accent focus:outline-none"
                >
                  {archivedCommunities.map((community) => (
                    <option key={community.id} value={community.id}>
                      {community.name} · {community.id}
                    </option>
                  ))}
                </select>
              </div>
            )}

            {selectedLegacyCommunity?.channels.map((legacyChannel) => (
              <div key={legacyChannel.id}>
                <label className="mb-1.5 block text-xs font-semibold uppercase text-muted">
                  #{legacyChannel.name} target
                </label>
                <select
                  value={channelRooms[legacyChannel.id] ?? ''}
                  onChange={(event) => {
                    setChannelRooms((current) => ({
                      ...current,
                      [legacyChannel.id]: event.target.value,
                    }))
                    setReport(null)
                  }}
                  className="w-full rounded-control border border-border bg-surface-sunken px-3 py-2.5 text-sm text-primary focus:border-accent focus:outline-none"
                >
                  <option value="">Choose a Matrix room…</option>
                  {targetChannels.map((channel) => (
                    <option key={channel.id} value={channel.id}>#{channel.name}</option>
                  ))}
                </select>
              </div>
            ))}

            {archivePaths.length > 0 && (
              <Button onClick={runDryRun} disabled={busy || !legacyCommunityId} className="w-full">
                {busy ? 'Checking…' : report ? 'Run dry run again' : 'Run dry run'}
              </Button>
            )}

            {report && (
              <div className="space-y-3 rounded-panel border border-border-subtle bg-surface-raised p-3">
                <p className="text-xs text-secondary">
                  {report.peerCount} peer{report.peerCount === 1 ? '' : 's'} · {report.recordGroupCount} records · {report.variantCount} variants
                </p>
                {report.errors.map((message) => (
                  <p key={message} className="text-xs text-status-danger">{message}</p>
                ))}
                {report.warnings.map((message) => (
                  <p key={message} className="text-xs text-status-warning">{message}</p>
                ))}

                {report.conflicts.map((conflict) => (
                  <fieldset key={conflict.conflictKey} className="rounded-panel border border-border-subtle p-2">
                    <legend className="px-1 text-xs font-semibold text-primary">
                      {conflict.kind} · {conflict.entityId}
                    </legend>
                    <p className="mb-2 break-all text-caption text-muted">{conflict.conflictKey}</p>
                    {conflict.variants.map((variant) => (
                      <label key={variant.recordSha256} className="mb-2 flex cursor-pointer gap-2 text-xs text-secondary">
                        <input
                          type="radio"
                          name={conflict.conflictKey}
                          checked={resolutions[conflict.conflictKey] === variant.recordSha256}
                          onChange={() => {
                            setResolutions((current) => ({
                              ...current,
                              [conflict.conflictKey]: variant.recordSha256,
                            }))
                            setReport(null)
                          }}
                        />
                        <span>
                          <span className="block text-primary">{variant.preview || '(empty record)'}</span>
                          <span className="block text-caption text-muted">
                            {variant.recordSha256.slice(0, 12)} · {variant.sourcePeerIds.length} peer(s)
                          </span>
                        </span>
                      </label>
                    ))}
                  </fieldset>
                ))}

                {report.approvalPhrase && (
                  <>
                    <p className="text-xs text-muted">
                      Type <span className="select-text font-mono text-primary">{report.approvalPhrase}</span> to authorize this exact plan.
                    </p>
                    <Input
                      value={approvalPhrase}
                      onChange={setApprovalPhrase}
                      placeholder="Approval phrase"
                      autoComplete="off"
                    />
                    <Button
                      onClick={approveImport}
                      disabled={busy || approvalPhrase !== report.approvalPhrase}
                      className="w-full"
                    >
                      {busy ? 'Importing…' : 'Approve encrypted import'}
                    </Button>
                  </>
                )}
              </div>
            )}
          </>
        )}

        {status && <p className="break-words text-xs text-secondary">{status}</p>}
        {error && <p className="text-xs text-status-danger">{error}</p>}
      </div>
    </div>
  )
}

function friendlyMigrationError(cause: unknown, operation: string): string {
  const description = describeError(cause, { operation })
  return `${description.title}. ${description.body}`
}
