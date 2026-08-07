import { useCallback, useEffect, useState, type ComponentProps, type ReactNode } from 'react'
import { Modal } from '../ui/Modal'
import { Button } from '../ui/Button'
import { Input } from '../ui/Input'
import { Icon } from '../ui/Icon'
import { EmptyState } from '../ui/Primitives'
import { StatusDot } from '../ui/StatusDot'
import { ErrorState } from '../ui/ErrorState'
import * as bridge from '../../lib/bridge'
import { describeError, normalizeError } from '../../lib/errors'
import { clearRegistrationContinuation } from '../../lib/registration-continuation'
import { clearRendererAccountState } from '../../lib/account-transition'
import { PUBLIC_SERVICES } from '../../config/public-services'
import { BackupCodeScreen } from '../onboarding/BackupCodeScreen'
import { copyText } from '../../lib/notifications'
import { useSettingsStore } from '../../store/settings'

interface SecurityDevicesPanelProps {
  open: boolean
  onClose: () => void
  embedded?: boolean
}

export function SecurityDevicesPanel({
  open,
  onClose,
  embedded = false,
}: SecurityDevicesPanelProps) {
  const [status, setStatus] = useState<bridge.BackendStatus | null>(null)
  const [devices, setDevices] = useState<bridge.MatrixDevice[]>([])
  const [loadingDevices, setLoadingDevices] = useState(false)
  const [loadingRecovery, setLoadingRecovery] = useState(false)
  const [statusError, setStatusError] = useState<unknown | null>(null)
  const [devicesError, setDevicesError] = useState<unknown | null>(null)
  const [recoveryError, setRecoveryError] = useState<unknown | null>(null)
  const [recoveryAttentionNotice, setRecoveryAttentionNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [recoveryInput, setRecoveryInput] = useState('')
  const [recoveryTestInput, setRecoveryTestInput] = useState('')
  const [newRecovery, setNewRecovery] = useState<bridge.MatrixRecoverySetupResult | null>(null)
  const [recoveryHealth, setRecoveryHealth] = useState<bridge.MatrixRecoveryHealth | null>(null)
  const [verification, setVerification] = useState<bridge.MatrixVerificationSession | null>(null)
  const [revokeTarget, setRevokeTarget] = useState<bridge.MatrixDevice | null>(null)
  const [accountPassword, setAccountPassword] = useState('')
  const [lostDeviceOpen, setLostDeviceOpen] = useState(false)
  const [lostDeviceId, setLostDeviceId] = useState('')
  const [lostDeviceAcknowledged, setLostDeviceAcknowledged] = useState(false)
  const [confirmRemoval, setConfirmRemoval] = useState(false)
  const [localRemovalPhrase, setLocalRemovalPhrase] = useState('')
  const [localRemovalAcknowledged, setLocalRemovalAcknowledged] = useState(false)
  const [exportResult, setExportResult] = useState<bridge.MatrixPersonalDataExport | null>(null)
  const [deactivationOpen, setDeactivationOpen] = useState(false)
  const [deactivationPassword, setDeactivationPassword] = useState('')
  const [deactivationPhrase, setDeactivationPhrase] = useState('')
  const [deactivationAcknowledged, setDeactivationAcknowledged] = useState(false)
  const setBackupConfigured = useSettingsStore((state) => state.setBackupConfigured)
  const scheduleBackupReminder = useSettingsStore((state) => state.scheduleBackupReminder)
  const verificationId = verification?.verificationId
  const verificationPhase = verification?.phase

  const loadDevices = useCallback(async () => {
    setLoadingDevices(true)
    setDevicesError(null)
    try {
      setDevices(await bridge.matrixDevices())
    } catch (cause) {
      setDevices([])
      setDevicesError(cause)
    } finally {
      setLoadingDevices(false)
    }
  }, [])

  const loadRecoveryHealth = useCallback(async (verifyStoredIfDue = false) => {
    setLoadingRecovery(true)
    setRecoveryError(null)
    try {
      const health = await bridge.matrixRecoveryHealth()
      const testedAt = health.lastSuccessfulTestAt
        ? Date.parse(health.lastSuccessfulTestAt)
        : Number.NaN
      const testIsDue =
        !Number.isFinite(testedAt) || testedAt < Date.now() - 90 * 24 * 60 * 60 * 1_000
      if (verifyStoredIfDue && health.secureStorageState === 'saved' && testIsDue) {
        try {
          const verified = await bridge.matrixTestStoredRecovery()
          setRecoveryHealth(verified)
          if (verified.healthy) {
            setBackupConfigured(true)
            setRecoveryAttentionNotice(null)
          }
          return
        } catch {
          setRecoveryHealth({
            ...health,
            healthy: false,
            warnings: [
              ...health.warnings,
              'The saved backup code could not be verified. Open Your devices and try again.',
            ],
          })
          return
        }
      }
      setRecoveryHealth(health)
      if (health.healthy) {
        setBackupConfigured(true)
        setRecoveryAttentionNotice(null)
      }
    } catch (cause) {
      setRecoveryHealth(null)
      setRecoveryError(cause)
    } finally {
      setLoadingRecovery(false)
    }
  }, [setBackupConfigured])

  const loadSecurityData = useCallback(async () => {
    setStatusError(null)
    setDevicesError(null)
    setRecoveryError(null)
    try {
      const nextStatus = await bridge.getBackendStatus()
      setStatus(nextStatus)
      if (nextStatus.authenticated && nextStatus.capabilities.deviceManagement) {
        await Promise.all([loadDevices(), loadRecoveryHealth(true)])
      } else {
        setDevices([])
        setRecoveryHealth(null)
      }
    } catch (cause) {
      setStatus(null)
      setDevices([])
      setRecoveryHealth(null)
      setStatusError(cause)
    }
  }, [loadDevices, loadRecoveryHealth])

  useEffect(() => {
    if (!open) return
    void Promise.resolve().then(loadSecurityData)
  }, [loadSecurityData, open])

  useEffect(() => {
    if (
      !open ||
      !verificationId ||
      verificationPhase === 'done' ||
      verificationPhase === 'cancelled'
    )
      return
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
  }, [loadDevices, open, verificationId, verificationPhase])

  const enableRecovery = async () => {
    setBusy(true)
    setError(null)
    setRecoveryAttentionNotice(null)
    try {
      setNewRecovery(await bridge.matrixEnableRecovery())
      await loadRecoveryHealth()
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setBusy(false)
    }
  }

  const finishNewRecovery = () => {
    const strictlyHealthy = newRecovery?.secureStorageState === 'saved'
      && newRecovery.verificationState === 'verified'
      && recoveryHealth?.healthy === true
    if (strictlyHealthy) {
      setBackupConfigured(true)
      setRecoveryAttentionNotice(null)
    } else {
      scheduleBackupReminder()
      setRecoveryAttentionNotice(
        'Your backup code was saved, but Mesh has not confirmed that message backup is ready. Keep the code private, then use Check again or Test saved copy.',
      )
    }
    setNewRecovery(null)
  }

  const deferNewRecovery = () => {
    scheduleBackupReminder()
    setNewRecovery(null)
  }

  const closePanel = () => {
    if (newRecovery) {
      scheduleBackupReminder()
      setNewRecovery(null)
    }
    setRecoveryInput('')
    setRecoveryTestInput('')
    onClose()
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

  const testStoredRecovery = async () => {
    setBusy(true)
    setError(null)
    try {
      setRecoveryHealth(await bridge.matrixTestStoredRecovery())
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
      setVerification(
        await bridge.matrixConfirmDeviceVerification(verification.verificationId, matches),
      )
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
      setVerification(
        await bridge.matrixSelectDeviceVerificationMethod(verification.verificationId, method),
      )
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
      const revoked = await bridge.matrixRevokeDevice(revokeTarget.deviceId, accountPassword)
      if (!revoked) {
        setAccountPassword('')
        return
      }
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
    if (
      localRemovalPhrase.trim().toUpperCase() !== 'REMOVE LOCAL DATA' ||
      !localRemovalAcknowledged
    ) {
      return
    }
    setBusy(true)
    setError(null)
    const removedAccountId = status?.userId ?? bridge.getMatrixUserId()
    try {
      const removed = await bridge.matrixRemoveLocalAccount()
      if (!removed) {
        setBusy(false)
        return
      }
    } catch (cause) {
      setError(errorMessage(cause))
      setBusy(false)
      return
    }
    try {
      clearRegistrationContinuation()
      clearRendererAccountState(removedAccountId)
    } catch (cleanupError) {
      console.warn('The account was removed, but optional renderer cleanup was incomplete.', cleanupError)
    } finally {
      setLocalRemovalPhrase('')
      setLocalRemovalAcknowledged(false)
      onClose()
      window.location.reload()
    }
  }

  const exportPersonalData = async () => {
    setExporting(true)
    setError(null)
    try {
      const result = await bridge.matrixExportPersonalData()
      if (result) setExportResult(result)
    } catch (cause) {
      if (normalizeError(cause).code !== 'cancelled') setError(errorMessage(cause))
    } finally {
      setExporting(false)
    }
  }

  const cancelPersonalDataExport = async () => {
    try {
      await bridge.matrixCancelPersonalDataExport()
    } catch (cause) {
      setError(errorMessage(cause))
    }
  }

  const deactivateAccount = async () => {
    if (
      !deactivationPassword ||
      deactivationPhrase.trim().toUpperCase() !== 'DELETE MY ACCOUNT' ||
      !deactivationAcknowledged
    ) {
      return
    }
    setBusy(true)
    setError(null)
    const removedAccountId = status?.userId ?? bridge.getMatrixUserId()
    try {
      const deactivated = await bridge.matrixDeactivateAccount(deactivationPassword)
      if (!deactivated) {
        setDeactivationPassword('')
        setBusy(false)
        return
      }
    } catch (cause) {
      setDeactivationPassword('')
      setError(errorMessage(cause))
      setBusy(false)
      return
    }
    try {
      clearRendererAccountState(removedAccountId)
    } catch (cleanupError) {
      console.warn('The account was deactivated, but optional renderer cleanup was incomplete.', cleanupError)
    } finally {
      setDeactivationPassword('')
      onClose()
      window.location.reload()
    }
  }

  const warningDevices = devices.filter((device) => device.newDevice || device.identityChanged)
  const revocableDevices = devices.filter((device) => !device.current)
  const lostDevice = revocableDevices.find((device) => device.deviceId === lostDeviceId) ?? null
  const accountDomain = status?.userId
    ? status.userId.split(':').slice(1).join(':').trim().toLowerCase() || null
    : null
  const publicAccountService = PUBLIC_SERVICES.find((service) => (
    service.accountDomain.toLowerCase() === accountDomain
    || sameHttpsOrigin(service.homeserverUrl, status?.homeserver)
  )) ?? null
  const serviceSite = safeHttpsOrigin(status?.homeserver)
  const accountServiceName = publicAccountService?.displayName
    ?? accountDomain
    ?? serviceSite?.hostname
    ?? 'your account service'
  const accountHelp = publicAccountService
    ? {
        href: publicAccountService.accountHelpUrl ?? publicAccountService.supportUrl,
        label: publicAccountService.accountHelpUrl
          ? `Manage account on ${publicAccountService.displayName}`
          : `Contact ${publicAccountService.displayName} support`,
      }
    : serviceSite
      ? { href: serviceSite.href, label: `Open ${accountServiceName} service site` }
      : null

  return (
    <SecurityDevicesFrame embedded={embedded} open={open} onClose={closePanel} title="Your devices">
      <div className="max-h-settings space-y-5 overflow-y-auto pr-1">
        {statusError != null && (
          <ErrorState
            error={statusError}
            context={{ operation: 'open safety and devices' }}
            actionLabel="Retry safety check"
            onAction={() => void loadSecurityData()}
            compact
          />
        )}

        <section className="rounded-panel border border-border-subtle bg-surface-sunken p-4">
          <p className="text-2xs uppercase tracking-signal text-muted">This device</p>
          <dl className="mt-3 space-y-2 text-sm">
            <Row label="Account" value={status ? (status.userId ?? 'Not signed in') : 'Loading…'} />
            <Row
              label="Device code"
              value={status ? (status.deviceId ?? 'Unavailable') : 'Loading…'}
              mono
            />
            <Row
              label="Private messages"
              value={status?.sessionE2eeReady ? 'Protected' : 'Unavailable'}
            />
          </dl>
          <p className="mt-3 text-xs leading-5 text-muted">
            Mesh protects message contents while they travel between your devices and the people you
            talk with.
          </p>
        </section>

        <section className="space-y-3 rounded-panel border border-border-subtle bg-surface-sunken p-4">
          <div>
            <p className="text-sm font-medium text-primary">Message backup</p>
            <p className="mt-1 text-xs leading-5 text-muted">
              Back up your messages or bring them back with your backup code or passphrase.
            </p>
          </div>
          {loadingRecovery && !recoveryHealth && !recoveryError && (
            <p role="status" className="text-xs text-muted">
              Checking message backup…
            </p>
          )}
          {recoveryError != null && (
            <ErrorState
              error={recoveryError}
              context={{ operation: 'check your message backup' }}
              actionLabel="Retry backup check"
              onAction={() => void loadRecoveryHealth()}
              compact
            />
          )}
          {recoveryAttentionNotice && (
            <p
              role="status"
              className="rounded-panel border border-status-warning/40 bg-status-warning/10 p-3 text-xs leading-5 text-secondary"
            >
              {recoveryAttentionNotice}
            </p>
          )}
          {recoveryHealth && (
            <div
              className={`rounded-panel border p-3 ${recoveryHealth.healthy ? 'border-status-success/40 bg-status-success/10' : 'border-status-warning/40 bg-status-warning/10'}`}
            >
              <div className="flex items-center justify-between gap-3">
                <p className="text-xs font-medium text-primary">
                  {recoveryHealth.healthy
                    ? 'Message backup is ready'
                    : 'Message backup needs attention'}
                </p>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busy}
                  onClick={() => void loadRecoveryHealth()}
                >
                  Check again
                </Button>
              </div>
              <dl className="mt-2 space-y-1 text-xs">
                <Row label="Backup setup" value={recoveryHealth.recoveryState} />
                <Row label="Message copy" value={recoveryHealth.backupState} />
                <Row
                  label="Saved online"
                  value={recoveryHealth.backupExistsOnServer ? 'Confirmed' : 'Not confirmed'}
                />
                <Row
                  label="Saved on this device"
                  value={recoveryStorageLabel(recoveryHealth.secureStorageState)}
                />
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
                  Mesh found a problem with this backup. Check again, or use your saved backup code
                  before relying on a new device.
                </p>
              )}
            </div>
          )}
          {newRecovery ? (
            <div className="rounded-panel border border-status-warning/40 bg-status-warning/10 p-3">
              <BackupCodeScreen
                backupCode={newRecovery.recoveryKey}
                secureStorageState={newRecovery.secureStorageState}
                verificationState={newRecovery.verificationState}
                onCopy={copyText}
                onContinue={finishNewRecovery}
                onSkip={deferNewRecovery}
                embedded
              />
            </div>
          ) : (
            <>
              {recoveryHealth && !recoveryHealth.backupEnabled && (
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={busy || loadingRecovery || !status?.capabilities.recovery}
                  onClick={enableRecovery}
                >
                  Create backup code
                </Button>
              )}
              <Button
                variant="secondary"
                size="sm"
                disabled={busy || loadingRecovery || recoveryHealth?.secureStorageState !== 'saved'}
                onClick={testStoredRecovery}
              >
                Test saved copy
              </Button>
              <Input
                label="Backup code or passphrase"
                name="recovery-credential"
                type="password"
                value={recoveryInput}
                onChange={setRecoveryInput}
                autoComplete="off"
              />
              <Button
                variant="secondary"
                size="sm"
                disabled={busy || !recoveryInput.trim()}
                onClick={recover}
              >
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
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={busy || !recoveryTestInput.trim()}
                  onClick={testRecovery}
                >
                  Check backup code
                </Button>
              </div>
            </>
          )}
        </section>

        <section className="space-y-3 rounded-panel border border-border-subtle bg-surface-sunken p-4">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-sm font-medium text-primary">Your devices</p>
              <p className="mt-1 text-xs leading-5 text-muted">
                Review the places where your Mesh account is signed in.
              </p>
              <p className="mt-2 text-xs leading-5 text-muted">
                Mesh shares new private-message keys only with trusted devices. A device marked “Not
                verified yet” needs a check before it can receive new encrypted messages.
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
                <p id="revoke-device-description" className="mt-1 text-xs leading-5 text-muted">
                  This signs that device out. It cannot delete messages, screenshots, or downloaded
                  files already saved on it.
                </p>
              </div>

              <ol className="list-decimal space-y-2 pl-5 text-xs leading-5 text-muted">
                <li>Select the device you no longer control.</li>
                <li>
                  Make sure your message backup is ready before moving to a replacement device.
                </li>
                <li>
                  Sign out the lost device. Only trust devices you still have and can compare
                  directly.
                </li>
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
                  <legend className="text-xs font-medium text-primary">
                    Which device was lost?
                  </legend>
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
                        <span className="block font-medium text-primary">
                          {device.displayName || 'Unnamed device'}
                        </span>
                        <span className="block break-all font-mono text-meta text-muted">
                          {device.deviceId}
                        </span>
                      </span>
                    </label>
                  ))}
                </fieldset>
              ) : (
                <div className="space-y-1 text-xs leading-5 text-muted">
                  <p>
                    No other device is available to sign out. If the lost device is missing, manage
                    it through {accountServiceName}.
                  </p>
                  <AccountHelpLink action={accountHelp} serviceName={accountServiceName} />
                </div>
              )}

              {lostDevice && (
                <label className="flex cursor-pointer items-start gap-2 text-xs leading-5 text-muted">
                  <input
                    type="checkbox"
                    checked={lostDeviceAcknowledged}
                    onChange={(event) => setLostDeviceAcknowledged(event.target.checked)}
                    className="mt-0.5 h-4 w-4 accent-accent"
                  />
                  I understand that this signs the selected device out but cannot erase anything
                  already saved on it or guarantee that older messages can be restored.
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
            <div
              role="alert"
              className="rounded-panel border border-status-warning/50 bg-status-warning/10 p-3"
            >
              <p className="text-xs font-medium text-primary">Is this you?</p>
              <p className="mt-1 text-xs leading-5 text-muted">
                {warningDevices.length} new or changed sign-in
                {warningDevices.length === 1 ? '' : 's'} need your attention. Trust the ones you
                recognize and sign out anything you do not.
              </p>
            </div>
          )}

          {loadingDevices && (
            <p role="status" className="text-xs text-muted">
              Loading registered devices…
            </p>
          )}
          {!loadingDevices && devicesError != null && (
            <ErrorState
              error={devicesError}
              context={{ operation: 'load your devices' }}
              actionLabel="Retry device list"
              onAction={() => void loadDevices()}
              compact
            />
          )}
          {!loadingDevices && !statusError && !devicesError && devices.length === 0 && (
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
                    <div className="flex min-w-0 items-center gap-2">
                      <StatusDot
                        state={
                          device.identityChanged
                            ? 'disconnected'
                            : device.newDevice || !device.verified
                              ? 'degraded'
                              : 'connected'
                        }
                        label={`${device.displayName || 'Unnamed device'}: ${trustLabel(device)}`}
                      />
                      <p className="truncate text-sm font-medium text-primary">
                        {device.displayName || 'Unnamed device'}{' '}
                        {device.current && <span className="text-accent">(this device)</span>}
                      </p>
                    </div>
                    <p className="mt-1 break-all font-mono text-meta text-muted">
                      {device.deviceId}
                    </p>
                    <p className="mt-1 text-xs text-muted">
                      {trustLabel(device)} · Last seen {formatLastSeen(device.lastSeenAt)}
                      {device.lastSeenIp ? ` from ${device.lastSeenIp}` : ''}
                    </p>
                    {device.firstSeenAt && (
                      <p className="mt-1 text-xs text-muted">
                        First seen by Mesh {formatLastSeen(device.firstSeenAt)}
                      </p>
                    )}
                    {device.identityChanged && (
                      <p className="mt-2 text-xs font-medium text-status-danger">
                        This sign-in changed since you trusted it. Check it again or sign it out.
                      </p>
                    )}
                    {!device.identityChanged && device.newDevice && (
                      <p className="mt-2 text-xs font-medium text-status-warning">
                        New sign-in. Is this you?
                      </p>
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
                      <span className="mt-1 block text-caption text-muted">
                        {emoji.description}
                      </span>
                    </li>
                  ))}
                </ol>
              )}
              {verification.phase === 'compare' &&
                verification.emojis.length === 0 &&
                verification.decimals && (
                  <p className="font-mono text-lg tracking-widest text-primary">
                    {verification.decimals.join(' · ')}
                  </p>
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
                    <Button
                      size="sm"
                      disabled={busy}
                      onClick={() => void selectVerificationMethod('sas')}
                    >
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
                    <Button
                      size="sm"
                      disabled={busy}
                      onClick={() => void confirmVerification(true)}
                    >
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
                    <Button
                      size="sm"
                      disabled={busy}
                      onClick={() => void confirmVerification(true)}
                    >
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
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={busy}
                    onClick={() => void cancelVerification()}
                  >
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
                  This signs that device out. It cannot delete what is already saved on it. Confirm
                  your account password to continue; Mesh does not save it.
                </p>
                <div className="mt-1 text-xs leading-5 text-muted">
                  <AccountHelpLink action={accountHelp} serviceName={accountServiceName} />
                </div>
              </div>
              <Input
                label="Account password"
                id="revoke-device-password"
                aria-describedby="revoke-device-description"
                type="password"
                value={accountPassword}
                onChange={setAccountPassword}
                autoComplete="current-password"
              />
              <div className="flex gap-2">
                <Button
                  tone="danger"
                  size="sm"
                  disabled={busy || !accountPassword}
                  onClick={revokeDevice}
                >
                  Sign out device
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busy}
                  onClick={() => setRevokeTarget(null)}
                >
                  Cancel
                </Button>
              </div>
            </div>
          )}
        </section>

        {error && (
          <p
            role="alert"
            className="rounded-panel bg-status-danger/10 px-3 py-2 text-sm text-status-danger"
          >
            {error}
          </p>
        )}

        <section
          className="space-y-3 border-t border-border-subtle pt-4"
          aria-labelledby="personal-data-heading"
        >
          <div>
            <p id="personal-data-heading" className="text-sm font-medium text-primary">
              Your personal data
            </p>
            <p className="mt-1 text-xs leading-5 text-muted">
              Save messages you authored and local copies of their already-downloaded attachments.
              The export excludes other people's messages, account secrets, and service activity
              records.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="secondary"
              size="sm"
              disabled={busy || exporting}
              onClick={exportPersonalData}
            >
              {exporting ? 'Working…' : 'Export my data'}
            </Button>
            {exporting && (
              <Button variant="secondary" size="sm" onClick={cancelPersonalDataExport}>
                Cancel export
              </Button>
            )}
          </div>
          {exportResult && (
            <div
              role="status"
              className="rounded-panel border border-status-success/40 bg-status-success/10 p-3"
            >
              <p className="text-xs font-medium text-primary">Your export is ready</p>
              <p className="mt-1 break-all font-mono text-meta text-muted">{exportResult.path}</p>
              <p className="mt-2 text-xs leading-5 text-muted">
                {exportResult.messageCount} message
                {exportResult.messageCount === 1 ? '' : 's'} across {exportResult.roomCount}{' '}
                conversation
                {exportResult.roomCount === 1 ? '' : 's'}, with {exportResult.mediaFileCount} local
                media file
                {exportResult.mediaFileCount === 1 ? '' : 's'}.
              </p>
              {exportResult.warnings.length > 0 && (
                <ul className="mt-2 list-disc space-y-1 pl-4 text-xs leading-5 text-status-warning">
                  {exportResult.warnings.map((warning) => (
                    <li key={warning}>{warning}</li>
                  ))}
                </ul>
              )}
              <p className="mt-2 text-xs leading-5 text-muted">
                This folder contains readable conversation content. Store and share it carefully.
              </p>
            </div>
          )}
        </section>

        <section
          className="space-y-3 border-t border-border-subtle pt-4"
          aria-labelledby="deactivate-account-heading"
        >
          <div>
            <p id="deactivate-account-heading" className="text-sm font-medium text-primary">
              Delete your Mesh account
            </p>
            <p className="mt-1 text-xs leading-5 text-muted">
              This permanently disables the account and asks your service to erase its data where
              possible. Messages already shared may remain in conversation history, backups,
              exports, screenshots, or other people's downloaded files.
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
              <p id="deactivation-description" className="text-xs leading-5 text-muted">
                Export anything you want to keep first. Mesh will also remove this account's local
                store and saved sign-in from this device after the service confirms deletion.
              </p>
              <Input
                label="Account password"
                id="deactivation-password"
                aria-describedby="deactivation-description"
                type="password"
                value={deactivationPassword}
                onChange={setDeactivationPassword}
                autoComplete="current-password"
              />
              <Input
                label='Type "DELETE MY ACCOUNT" to confirm'
                id="deactivation-confirmation"
                aria-describedby="deactivation-description"
                aria-invalid={
                  deactivationPhrase.length > 0 &&
                  deactivationPhrase.trim().toUpperCase() !== 'DELETE MY ACCOUNT'
                }
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
                I understand that shared copies may remain and that I will not be able to sign in
                again.
              </label>
              <div className="space-y-1 text-xs leading-5 text-muted">
                <p>
                  If you normally sign in through a browser, use {accountServiceName} account help
                  if Mesh asks you to finish there.
                </p>
                <AccountHelpLink action={accountHelp} serviceName={accountServiceName} />
              </div>
              <div className="flex flex-wrap gap-2">
                <Button
                  tone="danger"
                  size="sm"
                  disabled={
                    busy ||
                    !deactivationPassword ||
                    deactivationPhrase.trim().toUpperCase() !== 'DELETE MY ACCOUNT' ||
                    !deactivationAcknowledged
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
              Sign out removes this account from Mesh but keeps downloaded messages on this device.
              Removing the account also deletes only this account's Mesh data saved here. Neither
              action deletes the account at its service or erases message history already shared
              with other people and services.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" size="sm" disabled={busy} onClick={signOut}>
              Sign out
            </Button>
            {!confirmRemoval ? (
              <Button
                variant="outline"
                tone="danger"
                size="sm"
                disabled={busy}
                onClick={() => {
                  setConfirmRemoval(true)
                  setLocalRemovalPhrase('')
                  setLocalRemovalAcknowledged(false)
                  setError(null)
                }}
              >
                Remove account and local data
              </Button>
            ) : (
              <div className="w-full space-y-3 rounded-panel border border-status-danger/40 bg-status-danger/5 p-3">
                <p id="local-removal-description" className="text-xs leading-5 text-muted">
                  This cannot be undone. Mesh will sign this device out and delete its saved account
                  data. If that sign-out cannot finish, use another trusted device.
                </p>
                <div className="text-xs leading-5 text-muted">
                  <AccountHelpLink action={accountHelp} serviceName={accountServiceName} />
                </div>
                <Input
                  label='Type "REMOVE LOCAL DATA" to confirm'
                  id="local-removal-confirmation"
                  aria-describedby="local-removal-description"
                  aria-invalid={
                    localRemovalPhrase.length > 0 &&
                    localRemovalPhrase.trim().toUpperCase() !== 'REMOVE LOCAL DATA'
                  }
                  value={localRemovalPhrase}
                  onChange={setLocalRemovalPhrase}
                  autoComplete="off"
                />
                <label className="flex cursor-pointer items-start gap-2 text-xs leading-5 text-muted">
                  <input
                    type="checkbox"
                    checked={localRemovalAcknowledged}
                    onChange={(event) => setLocalRemovalAcknowledged(event.target.checked)}
                    className="mt-0.5 h-4 w-4 accent-accent"
                  />
                  I understand that this permanently deletes this account's messages and settings
                  saved on this device.
                </label>
                <div className="flex gap-2">
                  <Button
                    tone="danger"
                    size="sm"
                    disabled={
                      busy ||
                      localRemovalPhrase.trim().toUpperCase() !== 'REMOVE LOCAL DATA' ||
                      !localRemovalAcknowledged
                    }
                    onClick={removeAccount}
                  >
                    Permanently remove local account
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={busy}
                    onClick={() => {
                      setConfirmRemoval(false)
                      setLocalRemovalPhrase('')
                      setLocalRemovalAcknowledged(false)
                    }}
                  >
                    Cancel
                  </Button>
                </div>
              </div>
            )}
          </div>
        </section>
      </div>
    </SecurityDevicesFrame>
  )
}

function SecurityDevicesFrame({
  embedded,
  open,
  onClose,
  title,
  children,
  ...modalProps
}: ComponentProps<typeof Modal> & { embedded: boolean; children: ReactNode }) {
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

  if (embedded) {
    if (!open) return null
    return (
      <section
        aria-labelledby="embedded-security-devices-heading"
        className="mt-4 rounded-panel border border-border-subtle bg-surface-base p-4"
      >
        <header className="mb-4 flex flex-wrap items-start justify-between gap-3 border-b border-border-subtle pb-3">
          <div>
            <h2 id="embedded-security-devices-heading" className="text-sm font-semibold text-primary">
              Safety and devices
            </h2>
            <p className="mt-1 text-xs text-muted">
              Review sessions, message backup, recovery, exports, and account actions without leaving You.
            </p>
          </div>
          <Button variant="ghost" size="sm" onClick={onClose}>Close devices</Button>
        </header>
        {children}
      </section>
    )
  }

  return (
    <Modal {...modalProps} open={open} onClose={onClose} title={title}>
      {children}
    </Modal>
  )
}

function safeHttpsOrigin(value: string | null | undefined): URL | null {
  if (!value) return null
  try {
    const parsed = new URL(value)
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password) return null
    return new URL(parsed.origin)
  } catch {
    return null
  }
}

function sameHttpsOrigin(left: string, right: string | null | undefined): boolean {
  const leftOrigin = safeHttpsOrigin(left)
  const rightOrigin = safeHttpsOrigin(right)
  return leftOrigin !== null && rightOrigin !== null && leftOrigin.origin === rightOrigin.origin
}

function AccountHelpLink({
  action,
  serviceName,
}: {
  action: { href: string; label: string } | null
  serviceName: string
}) {
  if (!action) {
    return (
      <p>
        Mesh can&apos;t open account management for this service. Contact {serviceName} support
        from another trusted device.
      </p>
    )
  }
  return (
    <a
      href={action.href}
      target="_blank"
      rel="noreferrer noopener"
      className="font-medium text-accent underline-offset-2 hover:underline"
    >
      {action.label}
    </a>
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

function recoveryStorageLabel(state: bridge.MatrixRecoveryHealth['secureStorageState']): string {
  switch (state) {
    case 'saved':
      return 'Protected copy saved'
    case 'missing':
      return 'No protected copy'
    case 'unavailable':
      return 'Protected storage unavailable'
  }
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
      return session.cancellationReason
        ? 'The check was cancelled by the other device.'
        : 'The check was cancelled.'
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
