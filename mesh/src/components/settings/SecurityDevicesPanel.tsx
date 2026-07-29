import { useEffect, useState } from 'react'
import { Modal } from '../ui/Modal'
import { Button } from '../ui/Button'
import { Input } from '../ui/Input'
import { Icon } from '../ui/Icon'
import { EmptyState } from '../ui/Primitives'
import * as bridge from '../../lib/bridge'
import { describeError } from '../../lib/errors'

interface SecurityDevicesPanelProps {
  open: boolean
  onClose: () => void
}

export function SecurityDevicesPanel({ open, onClose }: SecurityDevicesPanelProps) {
  const [status, setStatus] = useState<bridge.BackendStatus | null>(null)
  const [devices, setDevices] = useState<bridge.MatrixDevice[]>([])
  const [loadingDevices, setLoadingDevices] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [recoveryInput, setRecoveryInput] = useState('')
  const [recoveryTestInput, setRecoveryTestInput] = useState('')
  const [newRecoveryKey, setNewRecoveryKey] = useState<string | null>(null)
  const [recoveryHealth, setRecoveryHealth] = useState<bridge.MatrixRecoveryHealth | null>(null)
  const [verification, setVerification] = useState<bridge.MatrixVerificationSession | null>(null)
  const [revokeTarget, setRevokeTarget] = useState<bridge.MatrixDevice | null>(null)
  const [accountPassword, setAccountPassword] = useState('')
  const [lostDeviceOpen, setLostDeviceOpen] = useState(false)
  const [lostDeviceId, setLostDeviceId] = useState('')
  const [lostDeviceAcknowledged, setLostDeviceAcknowledged] = useState(false)
  const [confirmRemoval, setConfirmRemoval] = useState(false)
  const [exportResult, setExportResult] = useState<bridge.MatrixPersonalDataExport | null>(null)
  const [deactivationOpen, setDeactivationOpen] = useState(false)
  const [deactivationPassword, setDeactivationPassword] = useState('')
  const [deactivationPhrase, setDeactivationPhrase] = useState('')
  const [deactivationAcknowledged, setDeactivationAcknowledged] = useState(false)
  const verificationId = verification?.verificationId
  const verificationPhase = verification?.phase

  const loadDevices = async () => {
    setLoadingDevices(true)
    try {
      setDevices(await bridge.matrixDevices())
    } finally {
      setLoadingDevices(false)
    }
  }

  const loadRecoveryHealth = async () => {
    setRecoveryHealth(await bridge.matrixRecoveryHealth())
  }

  useEffect(() => {
    if (!open) return
    void bridge
      .getBackendStatus()
      .then(async (nextStatus) => {
        setStatus(nextStatus)
        if (nextStatus.authenticated && nextStatus.capabilities.deviceManagement) {
          await Promise.all([loadDevices(), loadRecoveryHealth()])
        } else {
          setDevices([])
        }
      })
      .catch((cause) => {
        setError(errorMessage(cause))
      })
  }, [open])

  useEffect(() => {
    if (!open || !verificationId || verificationPhase === 'done' || verificationPhase === 'cancelled') return
    const interval = window.setInterval(() => {
      void bridge
        .matrixDeviceVerificationStatus(verificationId)
        .then((next) => {
          setVerification(next)
          if (next.phase === 'done') void loadDevices()
        })
        .catch((cause) => {
          setError(errorMessage(cause))
          window.clearInterval(interval)
        })
    }, 1_000)
    return () => window.clearInterval(interval)
  }, [open, verificationId, verificationPhase])

  const enableRecovery = async () => {
    setBusy(true)
    setError(null)
    try {
      setNewRecoveryKey(await bridge.matrixEnableRecovery())
      await loadRecoveryHealth()
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setBusy(false)
    }
  }

  const recover = async () => {
    if (!recoveryInput.trim()) return
    setBusy(true)
    setError(null)
    try {
      await bridge.matrixRecover(recoveryInput.trim())
      setRecoveryInput('')
      await loadRecoveryHealth()
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setBusy(false)
    }
  }

  const testRecovery = async () => {
    if (!recoveryTestInput.trim()) return
    setBusy(true)
    setError(null)
    try {
      setRecoveryHealth(await bridge.matrixTestRecovery(recoveryTestInput.trim()))
      setRecoveryTestInput('')
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setBusy(false)
    }
  }

  const startVerification = async (device: bridge.MatrixDevice) => {
    setBusy(true)
    setError(null)
    try {
      setVerification(await bridge.matrixStartDeviceVerification(device.deviceId))
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setBusy(false)
    }
  }

  const confirmVerification = async (matches: boolean) => {
    if (!verification) return
    setBusy(true)
    setError(null)
    try {
      setVerification(await bridge.matrixConfirmDeviceVerification(verification.verificationId, matches))
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setBusy(false)
    }
  }

  const selectVerificationMethod = async (method: 'sas' | 'qr') => {
    if (!verification) return
    setBusy(true)
    setError(null)
    try {
      setVerification(await bridge.matrixSelectDeviceVerificationMethod(verification.verificationId, method))
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setBusy(false)
    }
  }

  const cancelVerification = async () => {
    if (!verification) return
    setBusy(true)
    try {
      await bridge.matrixCancelDeviceVerification(verification.verificationId)
      setVerification(null)
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setBusy(false)
    }
  }

  const revokeDevice = async () => {
    if (!revokeTarget || !accountPassword) return
    setBusy(true)
    setError(null)
    try {
      await bridge.matrixRevokeDevice(revokeTarget.deviceId, accountPassword)
      setRevokeTarget(null)
      setAccountPassword('')
      setLostDeviceId('')
      setLostDeviceAcknowledged(false)
      await loadDevices()
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setBusy(false)
    }
  }

  const signOut = async () => {
    setBusy(true)
    setError(null)
    try {
      await bridge.matrixLogout()
      onClose()
      window.location.reload()
    } catch (cause) {
      setError(errorMessage(cause))
      setBusy(false)
    }
  }

  const removeAccount = async () => {
    setBusy(true)
    setError(null)
    try {
      await bridge.matrixRemoveLocalAccount()
      onClose()
      window.location.reload()
    } catch (cause) {
      setError(errorMessage(cause))
      setBusy(false)
    }
  }

  const exportPersonalData = async () => {
    setBusy(true)
    setError(null)
    try {
      const result = await bridge.matrixExportPersonalData()
      if (result) setExportResult(result)
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setBusy(false)
    }
  }

  const deactivateAccount = async () => {
    if (
      !deactivationPassword
      || deactivationPhrase.trim().toUpperCase() !== 'DELETE MY ACCOUNT'
      || !deactivationAcknowledged
    ) {
      return
    }
    setBusy(true)
    setError(null)
    try {
      await bridge.matrixDeactivateAccount(deactivationPassword)
      setDeactivationPassword('')
      onClose()
      window.location.reload()
    } catch (cause) {
      setDeactivationPassword('')
      setError(errorMessage(cause))
      setBusy(false)
    }
  }

  const warningDevices = devices.filter((device) => device.newDevice || device.identityChanged)
  const revocableDevices = devices.filter((device) => !device.current)
  const lostDevice = revocableDevices.find((device) => device.deviceId === lostDeviceId) ?? null

  return (
    <Modal open={open} onClose={onClose} title="Your devices">
      <div className="max-h-settings space-y-5 overflow-y-auto pr-1">
        <section className="rounded-panel border border-border-subtle bg-surface-sunken p-4">
          <p className="text-2xs uppercase tracking-signal text-muted">This device</p>
          <dl className="mt-3 space-y-2 text-sm">
            <Row label="Account" value={status ? (status.userId ?? 'Not signed in') : 'Loading…'} />
            <Row label="Device code" value={status ? (status.deviceId ?? 'Unavailable') : 'Loading…'} mono />
            <Row label="Private messages" value={status?.endToEndEncryption ? 'Protected' : 'Unavailable'} />
          </dl>
          <p className="mt-3 text-xs leading-5 text-muted">
            Mesh protects message contents while they travel between your devices and the people you talk with.
          </p>
        </section>

        <section className="space-y-3 rounded-panel border border-border-subtle bg-surface-sunken p-4">
          <div>
            <p className="text-sm font-medium text-primary">Message backup</p>
            <p className="mt-1 text-xs leading-5 text-muted">
              Back up your messages or bring them back with your backup code or passphrase.
            </p>
          </div>
          {recoveryHealth && (
            <div
              className={`rounded-panel border p-3 ${recoveryHealth.healthy ? 'border-status-success/40 bg-status-success/10' : 'border-status-warning/40 bg-status-warning/10'}`}
            >
              <div className="flex items-center justify-between gap-3">
                <p className="text-xs font-medium text-primary">
                  {recoveryHealth.healthy ? 'Message backup is ready' : 'Message backup needs attention'}
                </p>
                <Button variant="ghost" size="sm" disabled={busy} onClick={() => void loadRecoveryHealth()}>
                  Check again
                </Button>
              </div>
              <dl className="mt-2 space-y-1 text-xs">
                <Row label="Backup setup" value={recoveryHealth.recoveryState} />
                <Row label="Message copy" value={recoveryHealth.backupState} />
                <Row label="Saved online" value={recoveryHealth.backupExistsOnServer ? 'Confirmed' : 'Not confirmed'} />
                <Row
                  label="Last tested"
                  value={
                    recoveryHealth.lastSuccessfulTestAt
                      ? formatLastSeen(recoveryHealth.lastSuccessfulTestAt)
                      : 'Never on this device'
                  }
                />
              </dl>
              {recoveryHealth.warnings.length > 0 && (
                <p className="mt-2 text-xs leading-5 text-muted">
                  Mesh found a problem with this backup. Check again, or use your saved backup code before relying on a
                  new device.
                </p>
              )}
            </div>
          )}
          <Button
            variant="secondary"
            size="sm"
            disabled={busy || !status?.capabilities.recovery}
            onClick={enableRecovery}
          >
            Create backup code
          </Button>
          {newRecoveryKey && (
            <div role="status" className="rounded-panel border border-status-warning/40 bg-status-warning/10 p-3">
              <p className="text-xs font-medium text-primary">
                Save this backup code somewhere private. It is shown here once.
              </p>
              <p className="mt-2 break-all font-mono text-xs text-secondary">{newRecoveryKey}</p>
            </div>
          )}
          <Input
            label="Backup code or passphrase"
            name="recovery-credential"
            type="password"
            value={recoveryInput}
            onChange={setRecoveryInput}
            autoComplete="off"
          />
          <Button variant="secondary" size="sm" disabled={busy || !recoveryInput.trim()} onClick={recover}>
            Restore messages
          </Button>
          <div className="space-y-2 border-t border-border-subtle pt-3">
            <p className="text-xs leading-5 text-muted">
              Check that your backup code works before you need it on another device.
            </p>
            <Input
              label="Backup code to check"
              name="recovery-test-credential"
              type="password"
              value={recoveryTestInput}
              onChange={setRecoveryTestInput}
              autoComplete="off"
            />
            <Button variant="secondary" size="sm" disabled={busy || !recoveryTestInput.trim()} onClick={testRecovery}>
              Check backup code
            </Button>
          </div>
        </section>

        <section className="space-y-3 rounded-panel border border-border-subtle bg-surface-sunken p-4">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-sm font-medium text-primary">Your devices</p>
              <p className="mt-1 text-xs leading-5 text-muted">
                Review the places where your Mesh account is signed in.
              </p>
            </div>
            <span className="font-mono text-meta text-content-muted">
              {devices.length} {devices.length === 1 ? 'device' : 'devices'}
            </span>
          </div>

          <div>
            <Button
              variant="secondary"
              size="sm"
              disabled={busy || loadingDevices}
              aria-expanded={lostDeviceOpen}
              aria-controls="lost-device-workflow"
              onClick={() => {
                setLostDeviceOpen((current) => !current)
                setLostDeviceId('')
                setLostDeviceAcknowledged(false)
                setRevokeTarget(null)
                setAccountPassword('')
                setError(null)
              }}
            >
              {lostDeviceOpen ? 'Close lost-device help' : 'I lost a device'}
            </Button>
          </div>

          {lostDeviceOpen && (
            <section
              id="lost-device-workflow"
              aria-labelledby="lost-device-title"
              className="space-y-3 rounded-panel border border-status-warning/50 bg-status-warning/5 p-3"
            >
              <div>
                <h3 id="lost-device-title" className="text-sm font-medium text-primary">
                  Sign out a lost device
                </h3>
                <p className="mt-1 text-xs leading-5 text-muted">
                  This signs that device out. It cannot delete messages, screenshots, or downloaded files already saved
                  on it.
                </p>
              </div>

              <ol className="list-decimal space-y-2 pl-5 text-xs leading-5 text-muted">
                <li>Select the device you no longer control.</li>
                <li>Make sure your message backup is ready before moving to a replacement device.</li>
                <li>Sign out the lost device. Only trust devices you still have and can compare directly.</li>
              </ol>

              <div
                role="status"
                className={`rounded-md border p-3 text-xs leading-5 ${
                  recoveryHealth?.healthy
                    ? 'border-status-success/40 bg-status-success/10 text-secondary'
                    : 'border-status-warning/50 bg-status-warning/10 text-muted'
                }`}
              >
                {recoveryHealth?.healthy
                  ? 'Your message backup is ready. Signing out still cannot erase anything already saved on the lost device.'
                  : 'Your message backup is not ready. Signing out protects your account, but older messages may not appear on a replacement device.'}
              </div>

              {revocableDevices.length > 0 ? (
                <fieldset className="space-y-2">
                  <legend className="text-xs font-medium text-primary">Which device was lost?</legend>
                  {revocableDevices.map((device) => (
                    <label
                      key={device.deviceId}
                      className="flex cursor-pointer items-start gap-2 rounded-control bg-surface-hover p-2 text-xs text-secondary"
                    >
                      <input
                        type="radio"
                        name="lost-device"
                        value={device.deviceId}
                        checked={lostDeviceId === device.deviceId}
                        onChange={() => {
                          setLostDeviceId(device.deviceId)
                          setLostDeviceAcknowledged(false)
                        }}
                        className="mt-0.5 h-4 w-4 accent-accent"
                      />
                      <span>
                        <span className="block font-medium text-primary">{device.displayName || 'Unnamed device'}</span>
                        <span className="block break-all font-mono text-meta text-muted">{device.deviceId}</span>
                      </span>
                    </label>
                  ))}
                </fieldset>
              ) : (
                <p className="text-xs leading-5 text-muted">
                  No other device is available to sign out. Check your account website if the lost device is missing
                  from this list.
                </p>
              )}

              {lostDevice && (
                <label className="flex cursor-pointer items-start gap-2 text-xs leading-5 text-muted">
                  <input
                    type="checkbox"
                    checked={lostDeviceAcknowledged}
                    onChange={(event) => setLostDeviceAcknowledged(event.target.checked)}
                    className="mt-0.5 h-4 w-4 accent-accent"
                  />
                  I understand that this signs the selected device out but cannot erase anything already saved on it or
                  guarantee that older messages can be restored.
                </label>
              )}

              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  disabled={busy || !lostDevice || !lostDeviceAcknowledged}
                  onClick={() => {
                    if (!lostDevice) return
                    setRevokeTarget(lostDevice)
                    setAccountPassword('')
                    setLostDeviceOpen(false)
                    setError(null)
                  }}
                >
                  Continue to sign out selected device
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busy}
                  onClick={() => {
                    setLostDeviceOpen(false)
                    setLostDeviceId('')
                    setLostDeviceAcknowledged(false)
                  }}
                >
                  Cancel
                </Button>
              </div>
            </section>
          )}

          {warningDevices.length > 0 && (
            <div role="alert" className="rounded-panel border border-status-warning/50 bg-status-warning/10 p-3">
              <p className="text-xs font-medium text-primary">Is this you?</p>
              <p className="mt-1 text-xs leading-5 text-muted">
                {warningDevices.length} new or changed sign-in
                {warningDevices.length === 1 ? '' : 's'} need your attention. Trust the ones you recognize and sign out
                anything you do not.
              </p>
            </div>
          )}

          {loadingDevices && (
            <p role="status" className="text-xs text-muted">
              Loading registered devices…
            </p>
          )}
          {!loadingDevices && devices.length === 0 && (
            <EmptyState
              variant="compact"
              icon={<Icon name="shieldCheck" size="lg" />}
              title="No registered devices"
              description="Devices linked to this account will appear here."
            />
          )}
          <ul className="space-y-2">
            {devices.map((device) => (
              <li
                key={device.deviceId}
                className={`rounded-md border p-3 ${
                  device.identityChanged
                    ? 'border-status-danger/50 bg-status-danger/5'
                    : device.newDevice
                      ? 'border-status-warning/40 bg-status-warning/5'
                      : 'border-transparent bg-surface-sunken'
                }`}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-primary">
                      {device.displayName || 'Unnamed device'}{' '}
                      {device.current && <span className="text-accent">(this device)</span>}
                    </p>
                    <p className="mt-1 break-all font-mono text-meta text-muted">{device.deviceId}</p>
                    <p className="mt-1 text-xs text-muted">
                      {trustLabel(device)} · Last seen {formatLastSeen(device.lastSeenAt)}
                      {device.lastSeenIp ? ` from ${device.lastSeenIp}` : ''}
                    </p>
                    {device.firstSeenAt && (
                      <p className="mt-1 text-xs text-muted">First seen by Mesh {formatLastSeen(device.firstSeenAt)}</p>
                    )}
                    {device.identityChanged && (
                      <p className="mt-2 text-xs font-medium text-status-danger">
                        This sign-in changed since you trusted it. Check it again or sign it out.
                      </p>
                    )}
                    {!device.identityChanged && device.newDevice && (
                      <p className="mt-2 text-xs font-medium text-status-warning">New sign-in. Is this you?</p>
                    )}
                  </div>
                  {!device.current && (
                    <div className="flex shrink-0 gap-1">
                      {!device.crossSigned && (
                        <Button
                          variant="secondary"
                          size="sm"
                          disabled={busy}
                          onClick={() => void startVerification(device)}
                        >
                          Check device
                        </Button>
                      )}
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={busy}
                        onClick={() => {
                          setRevokeTarget(device)
                          setAccountPassword('')
                          setError(null)
                        }}
                      >
                        Sign out
                      </Button>
                    </div>
                  )}
                </div>
              </li>
            ))}
          </ul>

          {verification && (
            <div className="space-y-3 rounded-md border border-accent/40 bg-accent/5 p-3">
              <div>
                <p className="text-sm font-medium text-primary">Is this you?</p>
                <p aria-live="polite" className="mt-1 text-xs leading-5 text-muted">
                  {verificationMessage(verification)}
                </p>
              </div>
              {verification.phase === 'compare' && verification.emojis.length > 0 && (
                <ol aria-label="Emoji to compare" className="grid grid-cols-4 gap-2 sm:grid-cols-7">
                  {verification.emojis.map((emoji, index) => (
                    <li
                      key={`${emoji.description}-${index}`}
                      className="rounded-control bg-surface-sunken p-2 text-center"
                    >
                      <span aria-hidden="true" className="block text-md">
                        {emoji.symbol}
                      </span>
                      <span className="mt-1 block text-caption text-muted">{emoji.description}</span>
                    </li>
                  ))}
                </ol>
              )}
              {verification.phase === 'compare' && verification.emojis.length === 0 && verification.decimals && (
                <p className="font-mono text-lg tracking-widest text-primary">{verification.decimals.join(' · ')}</p>
              )}
              {verification.phase === 'qr-show' && verification.qrSvg && (
                <div className="mx-auto w-full max-w-64 rounded-control bg-surface-qr p-3">
                  <img
                    src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(verification.qrSvg)}`}
                    alt="Code to scan with your other device"
                    className="aspect-square h-auto w-full"
                  />
                </div>
              )}
              <div className="flex flex-wrap gap-2">
                {verification.phase === 'choose-method' && (
                  <>
                    <Button size="sm" disabled={busy} onClick={() => void selectVerificationMethod('sas')}>
                      Compare emoji
                    </Button>
                    <Button
                      variant="secondary"
                      size="sm"
                      disabled={busy}
                      onClick={() => void selectVerificationMethod('qr')}
                    >
                      Scan with other device
                    </Button>
                  </>
                )}
                {verification.phase === 'compare' && (
                  <>
                    <Button size="sm" disabled={busy} onClick={() => void confirmVerification(true)}>
                      Yes, that's me
                    </Button>
                    <Button
                      variant="secondary"
                      size="sm"
                      disabled={busy}
                      onClick={() => void confirmVerification(false)}
                    >
                      No, they do not match
                    </Button>
                  </>
                )}
                {verification.phase === 'qr-scanned' && (
                  <>
                    <Button size="sm" disabled={busy} onClick={() => void confirmVerification(true)}>
                      Confirm scan
                    </Button>
                    <Button
                      variant="secondary"
                      size="sm"
                      disabled={busy}
                      onClick={() => void confirmVerification(false)}
                    >
                      Reject scan
                    </Button>
                  </>
                )}
                {verification.phase !== 'done' && verification.phase !== 'cancelled' && (
                  <Button variant="ghost" size="sm" disabled={busy} onClick={() => void cancelVerification()}>
                    Cancel check
                  </Button>
                )}
                {(verification.phase === 'done' || verification.phase === 'cancelled') && (
                  <Button variant="ghost" size="sm" onClick={() => setVerification(null)}>
                    Close
                  </Button>
                )}
              </div>
            </div>
          )}

          {revokeTarget && (
            <div className="space-y-3 rounded-panel border border-status-danger/40 bg-status-danger/5 p-3">
              <div>
                <p className="text-sm font-medium text-primary">
                  Sign out {revokeTarget.displayName || revokeTarget.deviceId}?
                </p>
                <p className="mt-1 text-xs leading-5 text-muted">
                  This signs that device out. It cannot delete what is already saved on it. Confirm your account
                  password to continue; Mesh does not save it. If you normally sign in through a browser, you can also
                  use your account website.
                </p>
              </div>
              <Input
                label="Account password"
                type="password"
                value={accountPassword}
                onChange={setAccountPassword}
                autoComplete="current-password"
              />
              <div className="flex gap-2">
                <Button size="sm" disabled={busy || !accountPassword} onClick={revokeDevice}>
                  Sign out device
                </Button>
                <Button variant="ghost" size="sm" disabled={busy} onClick={() => setRevokeTarget(null)}>
                  Cancel
                </Button>
              </div>
            </div>
          )}
        </section>

        {error && (
          <p role="alert" className="rounded-panel bg-status-danger/10 px-3 py-2 text-sm text-status-danger">
            {error}
          </p>
        )}

        <section className="space-y-3 border-t border-border-subtle pt-4" aria-labelledby="personal-data-heading">
          <div>
            <p id="personal-data-heading" className="text-sm font-medium text-primary">Your personal data</p>
            <p className="mt-1 text-xs leading-5 text-muted">
              Save messages you authored and local copies of their already-downloaded attachments. The export excludes
              other people's messages, account secrets, and service activity records.
            </p>
          </div>
          <Button variant="secondary" size="sm" disabled={busy} onClick={exportPersonalData}>
            {busy ? 'Workingâ€¦' : 'Export my data'}
          </Button>
          {exportResult && (
            <div role="status" className="rounded-panel border border-status-success/40 bg-status-success/10 p-3">
              <p className="text-xs font-medium text-primary">Your export is ready</p>
              <p className="mt-1 break-all font-mono text-meta text-muted">{exportResult.path}</p>
              <p className="mt-2 text-xs leading-5 text-muted">
                {exportResult.messageCount} message{exportResult.messageCount === 1 ? '' : 's'} across{' '}
                {exportResult.roomCount} conversation{exportResult.roomCount === 1 ? '' : 's'}, with{' '}
                {exportResult.mediaFileCount} local media file{exportResult.mediaFileCount === 1 ? '' : 's'}.
              </p>
              {exportResult.warnings.length > 0 && (
                <ul className="mt-2 list-disc space-y-1 pl-4 text-xs leading-5 text-status-warning">
                  {exportResult.warnings.map((warning) => <li key={warning}>{warning}</li>)}
                </ul>
              )}
              <p className="mt-2 text-xs leading-5 text-muted">
                This folder contains readable conversation content. Store and share it carefully.
              </p>
            </div>
          )}
        </section>

        <section className="space-y-3 border-t border-border-subtle pt-4" aria-labelledby="deactivate-account-heading">
          <div>
            <p id="deactivate-account-heading" className="text-sm font-medium text-primary">Delete your Mesh account</p>
            <p className="mt-1 text-xs leading-5 text-muted">
              This permanently disables the account and asks your service to erase its data where possible. Messages
              already shared may remain in conversation history, backups, exports, screenshots, or other people's
              downloaded files.
            </p>
          </div>
          {!deactivationOpen ? (
            <Button
              variant="outline"
              tone="danger"
              size="sm"
              disabled={busy}
              onClick={() => {
                setDeactivationOpen(true)
                setDeactivationPassword('')
                setDeactivationPhrase('')
                setDeactivationAcknowledged(false)
                setError(null)
              }}
            >
              Start account deletion
            </Button>
          ) : (
            <div className="space-y-3 rounded-panel border border-status-danger/40 bg-status-danger/5 p-3">
              <p className="text-xs font-medium text-status-danger">This cannot be undone.</p>
              <p className="text-xs leading-5 text-muted">
                Export anything you want to keep first. Mesh will also remove this account's local store and saved
                sign-in from this device after the service confirms deletion.
              </p>
              <Input
                label="Account password"
                type="password"
                value={deactivationPassword}
                onChange={setDeactivationPassword}
                autoComplete="current-password"
              />
              <Input
                label='Type "DELETE MY ACCOUNT" to confirm'
                value={deactivationPhrase}
                onChange={setDeactivationPhrase}
                autoComplete="off"
              />
              <label className="flex cursor-pointer items-start gap-2 text-xs leading-5 text-muted">
                <input
                  type="checkbox"
                  checked={deactivationAcknowledged}
                  onChange={(event) => setDeactivationAcknowledged(event.target.checked)}
                  className="mt-0.5 h-4 w-4 accent-accent"
                />
                I understand that shared copies may remain and that I will not be able to sign in again.
              </label>
              <p className="text-xs leading-5 text-muted">
                If you normally sign in through a browser, complete deletion from your account website until browser
                confirmation is available in Mesh.
              </p>
              <div className="flex flex-wrap gap-2">
                <Button
                  tone="danger"
                  size="sm"
                  disabled={
                    busy
                    || !deactivationPassword
                    || deactivationPhrase.trim().toUpperCase() !== 'DELETE MY ACCOUNT'
                    || !deactivationAcknowledged
                  }
                  onClick={deactivateAccount}
                >
                  Permanently delete my account
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busy}
                  onClick={() => {
                    setDeactivationOpen(false)
                    setDeactivationPassword('')
                    setDeactivationPhrase('')
                    setDeactivationAcknowledged(false)
                  }}
                >
                  Cancel
                </Button>
              </div>
            </div>
          )}
        </section>

        <section className="space-y-3 border-t border-border-subtle pt-4">
          <div>
            <p className="text-sm font-medium text-primary">Account on this device</p>
            <p className="mt-1 text-xs leading-5 text-muted">
              Sign out removes this account from Mesh but keeps downloaded messages on this device. Removing the account
              also deletes Mesh account data saved here.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" size="sm" disabled={busy} onClick={signOut}>
              Sign out
            </Button>
            {!confirmRemoval ? (
              <Button variant="ghost" size="sm" disabled={busy} onClick={() => setConfirmRemoval(true)}>
                Remove account and local data
              </Button>
            ) : (
              <div className="w-full space-y-3 rounded-panel border border-status-danger/40 bg-status-danger/5 p-3">
                <p className="text-xs leading-5 text-muted">
                  This cannot be undone. Mesh will sign this device out and delete its saved account data. If that
                  sign-out cannot finish, use another trusted device or your account website.
                </p>
                <div className="flex gap-2">
                  <Button size="sm" disabled={busy} onClick={removeAccount}>
                    Permanently remove local account
                  </Button>
                  <Button variant="ghost" size="sm" disabled={busy} onClick={() => setConfirmRemoval(false)}>
                    Cancel
                  </Button>
                </div>
              </div>
            )}
          </div>
        </section>
      </div>
    </Modal>
  )
}

function Row({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="grid grid-cols-[7rem_1fr] gap-3">
      <dt className="text-muted">{label}</dt>
      <dd className={`break-all text-secondary ${mono ? 'font-mono text-xs' : ''}`}>{value}</dd>
    </div>
  )
}

function trustLabel(device: bridge.MatrixDevice): string {
  if (device.identityChanged || device.newDevice) return 'Not verified yet'
  if (device.crossSigned || device.verified) return 'Trusted'
  return 'Not verified yet'
}

function verificationMessage(session: bridge.MatrixVerificationSession): string {
  switch (session.phase) {
    case 'waiting-for-device':
    case 'started':
    case 'accepted':
      return 'Open this request on your other device. Mesh will show the choices both devices support.'
    case 'choose-method':
      return 'Choose how to check. You can compare emoji or scan with your other device.'
    case 'compare':
      return 'Do these emoji match on the other device? Continue only if every item matches in the same order.'
    case 'qr-show':
      return 'Scan this with your other device. Do not share it or scan it with an app you do not trust.'
    case 'qr-scanned':
      return 'The other device scanned the code. Confirm only if you are holding or directly supervising that device.'
    case 'confirmed':
      return 'You confirmed the code. Waiting for the other device to finish.'
    case 'done':
      return 'This device is now trusted.'
    case 'cancelled':
      return session.cancellationReason ? 'The check was cancelled by the other device.' : 'The check was cancelled.'
  }
}

function formatLastSeen(value: string | null): string {
  if (!value) return 'time unavailable'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return 'time unavailable'
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date)
}

function errorMessage(cause: unknown): string {
  const description = describeError(cause)
  return `${description.title}. ${description.body}`
}
