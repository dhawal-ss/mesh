import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Modal } from '../ui/Modal'
import { Button } from '../ui/Button'
import { Input } from '../ui/Input'
import { ErrorState } from '../ui/ErrorState'
import { retryMatrixPreferenceSync, useSettingsStore } from '../../store/settings'
import type {
  AppearanceAccent,
  AppearanceDensity,
  AppearanceTheme,
  NotificationSoundId,
} from '../../store/settings'
import type { Identity } from '../../types/ipc'

interface UserSettingsPanelProps {
  open: boolean
  onClose: () => void
  identity: Identity
  matrixAccountId: string | null
  matrixMode: boolean
  onUpdateDisplayName?: (displayName: string) => Promise<void>
  onOpenSecurity: () => void
  backupReminderDue?: boolean
  onTestNotification?: () => Promise<void> | void
  onOpenDiagnostics?: () => void
  onOpenImport?: () => void
}

export function UserSettingsPanel({
  open,
  onClose,
  identity,
  matrixAccountId,
  matrixMode,
  onUpdateDisplayName,
  onOpenSecurity,
  backupReminderDue = false,
  onTestNotification,
  onOpenDiagnostics,
  onOpenImport,
}: UserSettingsPanelProps) {
  const notifications = useSettingsStore((state) => state.notifications)
  const appearance = useSettingsStore((state) => state.appearance)
  const privacy = useSettingsStore((state) => state.privacy)
  const matrixPreferenceSync = useSettingsStore((state) => state.matrixPreferenceSync)
  const setNotificationsEnabled = useSettingsStore((state) => state.setNotificationsEnabled)
  const setNotificationSound = useSettingsStore((state) => state.setNotificationSound)
  const setNotificationSoundId = useSettingsStore((state) => state.setNotificationSoundId)
  const setDoNotDisturb = useSettingsStore((state) => state.setDoNotDisturb)
  const setQuietHoursEnabled = useSettingsStore((state) => state.setQuietHoursEnabled)
  const setQuietHours = useSettingsStore((state) => state.setQuietHours)
  const setAppearanceTheme = useSettingsStore((state) => state.setAppearanceTheme)
  const setAppearanceDensity = useSettingsStore((state) => state.setAppearanceDensity)
  const setAppearanceAccent = useSettingsStore((state) => state.setAppearanceAccent)
  const setSendReadReceipts = useSettingsStore((state) => state.setSendReadReceipts)
  const setSendTypingIndicators = useSettingsStore((state) => state.setSendTypingIndicators)
  const setSharePresence = useSettingsStore((state) => state.setSharePresence)
  const setInvisibleMode = useSettingsStore((state) => state.setInvisibleMode)
  const [displayName, setDisplayName] = useState(identity.displayName)
  const [profileValidation, setProfileValidation] = useState<string | null>(null)
  const [profileError, setProfileError] = useState<unknown | null>(null)
  const [profileSaved, setProfileSaved] = useState(false)
  const [savingProfile, setSavingProfile] = useState(false)
  const [testingNotification, setTestingNotification] = useState(false)
  const [testNotificationStatus, setTestNotificationStatus] = useState<
    'sent' | 'failed' | null
  >(null)
  const [advancedUnlocked, setAdvancedUnlocked] = useState(false)
  const versionTapCount = useRef(0)

  const testNotification = async () => {
    if (!onTestNotification || testingNotification) return
    setTestingNotification(true)
    setTestNotificationStatus(null)
    try {
      await onTestNotification()
      setTestNotificationStatus('sent')
    } catch {
      setTestNotificationStatus('failed')
    } finally {
      setTestingNotification(false)
    }
  }

  useEffect(() => {
    if (!open) return
    setDisplayName(identity.displayName)
    setProfileError(null)
    setProfileValidation(null)
    setProfileSaved(false)
  }, [identity.displayName, open])

  useEffect(() => {
    if (!open) return
    const unlockAdvanced = (event: KeyboardEvent) => {
      if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === 'd') {
        event.preventDefault()
        setAdvancedUnlocked(true)
      }
    }
    document.addEventListener('keydown', unlockAdvanced)
    return () => document.removeEventListener('keydown', unlockAdvanced)
  }, [open])

  const saveDisplayName = async (event?: FormEvent) => {
    event?.preventDefault()
    const normalized = displayName.trim()
    if (!normalized) {
      setProfileValidation('Display name cannot be empty.')
      return
    }
    if (Array.from(normalized).length > 100) {
      setProfileValidation('Display name must be 100 characters or fewer.')
      return
    }
    if (!onUpdateDisplayName) {
      setProfileValidation('Profile editing is unavailable in this build.')
      return
    }

    setSavingProfile(true)
    setProfileError(null)
    setProfileValidation(null)
    setProfileSaved(false)
    try {
      await onUpdateDisplayName(normalized)
      setDisplayName(normalized)
      setProfileSaved(true)
    } catch (error) {
      setProfileError(error)
    } finally {
      setSavingProfile(false)
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="User Settings">
      <div className="max-h-settings space-y-4 overflow-y-auto pr-1">
        <section className="rounded-lg bg-bg-primary p-4">
          <p className="text-2xs uppercase tracking-signal text-muted">Account</p>
          <div className="mt-3 min-w-0">
            <p className="truncate text-base font-semibold text-primary">{identity.displayName}</p>
            <p className="truncate font-mono text-xs text-muted">
              {matrixAccountId ? 'Mesh account' : identity.publicKey}
            </p>
          </div>
          <p className="mt-3 text-xs leading-5 text-muted">
            {matrixMode
              ? 'Mesh uses this account across servers and direct messages.'
              : 'This is your local Mesh identity.'}
          </p>

          {matrixMode && (
            <form className="mt-4 space-y-3 border-t border-border pt-4" onSubmit={saveDisplayName}>
              <Input
                label="Display name"
                value={displayName}
                maxLength={100}
                autoComplete="nickname"
                disabled={savingProfile}
                onChange={(value: string) => {
                  setDisplayName(value)
                  setProfileError(null)
                  setProfileValidation(null)
                  setProfileSaved(false)
                }}
              />
              <div className="flex items-center gap-3">
                <Button
                  type="submit"
                  size="sm"
                  disabled={savingProfile || displayName.trim() === identity.displayName}
                >
                  {savingProfile ? 'Saving…' : 'Save display name'}
                </Button>
                {profileSaved && (
                  <span role="status" aria-label="Display name save status" className="text-xs text-green">
                    Profile updated
                  </span>
                )}
              </div>
              {profileValidation && (
                <p role="alert" className="rounded-md bg-red/10 px-3 py-2 text-xs text-red">
                  {profileValidation}
                </p>
              )}
              {profileError != null && (
                <ErrorState
                  error={profileError}
                  context={{ operation: 'update your display name' }}
                  onAction={() => void saveDisplayName()}
                  compact
                />
              )}
              <p className="text-xs leading-5 text-muted">
                Profile pictures are currently read-only in Mesh. They may be visible outside
                private conversations, so Mesh will not upload one without explaining that first.
              </p>
            </form>
          )}
        </section>

        <section
          className="space-y-3 rounded-lg bg-surface-base p-4"
          aria-labelledby="appearance-settings-heading"
        >
          <div>
            <p id="appearance-settings-heading" className="text-sm font-medium text-primary">
              Appearance
            </p>
            <p className="mt-1 text-xs leading-5 text-muted">
              Choose how Mesh looks and how much space its controls use. These preferences are
              saved on this device.
            </p>
          </div>

          <div className="grid gap-3 sm:grid-cols-3">
            <AppearanceSelect
              id="appearance-theme"
              label="Theme"
              value={appearance.theme}
              options={[
                ['dark', 'Dark'],
                ['light', 'Light'],
                ['high-contrast', 'High contrast'],
              ]}
              onChange={(value) => setAppearanceTheme(value as AppearanceTheme)}
            />
            <AppearanceSelect
              id="appearance-density"
              label="Density"
              value={appearance.density}
              options={[
                ['default', 'Cozy'],
                ['compact', 'Compact'],
                ['comfortable', 'Comfortable'],
              ]}
              onChange={(value) => setAppearanceDensity(value as AppearanceDensity)}
            />
            <AppearanceSelect
              id="appearance-accent"
              label="Accent"
              value={appearance.accent}
              options={[
                ['sand', 'Sand'],
                ['ocean', 'Ocean'],
                ['violet', 'Violet'],
                ['forest', 'Forest'],
                ['ember', 'Ember'],
                ['rose', 'Rose'],
              ]}
              onChange={(value) => setAppearanceAccent(value as AppearanceAccent)}
            />
          </div>
        </section>

        {matrixMode && (
          <section
            className="space-y-4 rounded-lg bg-bg-primary p-4"
            aria-labelledby="privacy-center-heading"
          >
            <div>
              <p id="privacy-center-heading" className="text-sm font-medium text-primary">
                Privacy Center
              </p>
              <p className="mt-1 text-xs leading-5 text-muted">
                Mesh protects message and file contents before they leave your device. Your
                service still handles the information needed to connect you and deliver them.
              </p>
            </div>

            <div aria-live="polite" aria-busy={matrixPreferenceSync.status === 'saving'}>
              {matrixPreferenceSync.status === 'saving' && (
                <p
                  role="status"
                  aria-label="Privacy settings save status"
                  className="rounded-md bg-bg-tertiary px-3 py-2 text-xs text-muted"
                >
                  Applying privacy settings…
                </p>
              )}
              {matrixPreferenceSync.status === 'saved' && (
                <p
                  role="status"
                  aria-label="Privacy settings save status"
                  className="rounded-md bg-bg-tertiary px-3 py-2 text-xs text-green"
                >
                  Privacy settings saved to your account.
                </p>
              )}
              {matrixPreferenceSync.status === 'failed' && (
                <>
                  <p className="mb-2 rounded-md bg-bg-tertiary px-3 py-2 text-xs leading-5 text-muted">
                    Mesh is using these choices on this device, but could not confirm them on your
                    account. Other devices may still use the previous settings.
                  </p>
                  <ErrorState
                    error={matrixPreferenceSync.error}
                    context={{ operation: 'save your privacy settings' }}
                    actionLabel="Retry saving privacy settings"
                    onAction={() => void retryMatrixPreferenceSync()}
                    compact
                  />
                </>
              )}
            </div>

            <div className="overflow-x-auto rounded-md border border-border-subtle">
              <table className="w-full min-w-privacy-table text-left text-xs">
                <caption className="sr-only">What your service can see</caption>
                <thead className="bg-bg-tertiary text-muted">
                  <tr>
                    <th scope="col" className="px-3 py-2 font-medium">Information</th>
                    <th scope="col" className="px-3 py-2 font-medium">Can the service see it?</th>
                    <th scope="col" className="px-3 py-2 font-medium">Why</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border-subtle text-secondary">
                  <PrivacyVisibilityRow
                    information="Message and file content"
                    visible="No"
                    explanation="Protected end to end before upload."
                    private
                  />
                  <PrivacyVisibilityRow
                    information="Communities and conversations"
                    visible="Yes"
                    explanation="Needed to route messages and manage access."
                  />
                  <PrivacyVisibilityRow
                    information="Connection and online times"
                    visible="Yes"
                    explanation="The service sees connections even in Invisible mode."
                  />
                  <PrivacyVisibilityRow
                    information="Typing activity"
                    visible={privacy.sendTypingIndicators ? 'Yes, while enabled' : 'No, disabled now'}
                    explanation="Shared only when the typing control below is on."
                    private={!privacy.sendTypingIndicators}
                  />
                  <PrivacyVisibilityRow
                    information="Network address"
                    visible="Yes"
                    explanation="Needed for your device to connect."
                  />
                  <PrivacyVisibilityRow
                    information="Signed-in device list"
                    visible="Yes"
                    explanation="Needed to deliver and recover protected messages."
                  />
                </tbody>
              </table>
            </div>

            <div className="space-y-3" aria-label="Privacy controls">
              <ToggleRow
                label="Send read receipts"
                description="Helps your devices agree on what you read; other people never receive this private receipt."
                checked={privacy.sendReadReceipts}
                onChange={setSendReadReceipts}
              />
              <ToggleRow
                label="Show when I am typing"
                description="Lets people in the conversation see you composing; turning it off can make replies feel less immediate."
                checked={privacy.sendTypingIndicators}
                onChange={setSendTypingIndicators}
              />
              <ToggleRow
                label="Share my online status"
                description="Lets people see when you are online; the service can still see connection times when this is off."
                checked={privacy.sharePresence}
                onChange={setSharePresence}
              />
              <ToggleRow
                label="Invisible mode"
                description="Makes you appear offline without disconnecting and temporarily overrides online-status sharing."
                checked={privacy.invisibleMode}
                onChange={setInvisibleMode}
              />
            </div>

            <div className="rounded-md bg-bg-tertiary px-3 py-3 text-xs leading-5 text-muted">
              <p>
                Each conversation header checks its current protection and shows
                “Protected end to end” before you send.
              </p>
              <p className="mt-2">
                Unlike standard Discord messages, Mesh keeps conversation content unreadable to
                the service. Both services can still observe operational details such as network
                addresses, devices, membership, and timing.
              </p>
            </div>
          </section>
        )}

        <section className="space-y-3 rounded-lg bg-bg-primary p-4" aria-labelledby="notification-settings-heading">
          <div>
            <p id="notification-settings-heading" className="text-sm font-medium text-primary">
              Notifications
            </p>
            <p className="mt-1 text-xs leading-5 text-muted">
              These preferences are saved here and sync across your devices when available.
            </p>
          </div>

          <ToggleRow
            label="Desktop notifications"
            description="Show alerts for new messages outside the active conversation."
            checked={notifications.enabled}
            onChange={setNotificationsEnabled}
          />
          <ToggleRow
            label="Notification sounds"
            description="Play a sound when an enabled notification arrives."
            checked={notifications.sound}
            disabled={!notifications.enabled}
            onChange={setNotificationSound}
          />
          <label
            htmlFor="notification-sound"
            className={`block rounded-md bg-bg-tertiary px-3 py-3 text-xs font-medium text-muted ${
              !notifications.enabled || !notifications.sound ? 'opacity-50' : ''
            }`}
          >
            Sound
            <select
              id="notification-sound"
              className="mt-1 block h-control-md w-full rounded-md border border-border-subtle bg-surface-raised px-2 text-sm text-content outline-none transition-colors focus:border-accent"
              value={notifications.soundId}
              disabled={!notifications.enabled || !notifications.sound}
              onChange={(event) =>
                setNotificationSoundId(event.target.value as NotificationSoundId)
              }
            >
              <option value="mesh">Mesh default</option>
              <option value="chime">Chime</option>
              <option value="pulse">Pulse</option>
              <option value="soft">Soft</option>
            </select>
          </label>
          <ToggleRow
            label="Do not disturb"
            description="Pause notifications, sounds, unread badges, and taskbar alerts until turned off."
            checked={notifications.doNotDisturb}
            disabled={!notifications.enabled}
            onChange={setDoNotDisturb}
          />
          <ToggleRow
            label="Quiet hours"
            description="Pause notification surfaces during a daily local-time window."
            checked={notifications.quietHours.enabled}
            disabled={!notifications.enabled}
            onChange={setQuietHoursEnabled}
          />

          {notifications.quietHours.enabled && (
            <div
              className="grid gap-3 rounded-md bg-bg-tertiary px-3 py-3 sm:grid-cols-2"
              aria-label="Quiet hours schedule"
            >
              <label htmlFor="quiet-hours-start" className="text-xs font-medium text-muted">
                Starts
                <input
                  id="quiet-hours-start"
                  type="time"
                  className="mt-1 block h-control-md w-full rounded-md border border-border-subtle bg-surface-raised px-2 text-sm text-content outline-none transition-colors focus:border-accent"
                  value={notifications.quietHours.start}
                  onChange={(event) =>
                    setQuietHours(event.target.value, notifications.quietHours.end)
                  }
                />
              </label>
              <label htmlFor="quiet-hours-end" className="text-xs font-medium text-muted">
                Ends
                <input
                  id="quiet-hours-end"
                  type="time"
                  className="mt-1 block h-control-md w-full rounded-md border border-border-subtle bg-surface-raised px-2 text-sm text-content outline-none transition-colors focus:border-accent"
                  value={notifications.quietHours.end}
                  onChange={(event) =>
                    setQuietHours(notifications.quietHours.start, event.target.value)
                  }
                />
              </label>
            </div>
          )}

          <div className="flex flex-wrap items-center gap-3">
            <Button
              variant="secondary"
              size="sm"
              disabled={!notifications.enabled || !onTestNotification || testingNotification}
              onClick={() => void testNotification()}
            >
              {testingNotification ? 'Sending…' : 'Test notification'}
            </Button>
            {testNotificationStatus === 'sent' && (
              <span role="status" aria-label="Test notification status" className="text-xs text-green">
                Test notification sent
              </span>
            )}
            {testNotificationStatus === 'failed' && (
              <span role="alert" className="text-xs text-red">
                Mesh could not send the test notification.
              </span>
            )}
          </div>

          {(notifications.mutedChannels.length > 0 || notifications.mutedCommunities.length > 0) && (
            <p className="rounded-md bg-bg-tertiary px-3 py-2 text-xs text-muted">
              Muted: {notifications.mutedCommunities.length} communit
              {notifications.mutedCommunities.length === 1 ? 'y' : 'ies'} and{' '}
              {notifications.mutedChannels.length} channel
              {notifications.mutedChannels.length === 1 ? '' : 's'}.
            </p>
          )}
        </section>

        {matrixMode && (
          <section className="rounded-lg bg-bg-primary p-4">
            <div className="flex items-center gap-2">
              <p className="text-sm font-medium text-primary">Your devices</p>
              {backupReminderDue && (
                <span
                  className="h-2 w-2 rounded-full bg-status-warning"
                  aria-label="Message backup needs attention"
                />
              )}
            </div>
            <p className="mt-1 text-xs leading-5 text-muted">
              {backupReminderDue
                ? 'Your messages are not backed up yet. Save a backup code so a lost device does not mean lost messages.'
                : 'Review where you are signed in, trust devices you recognize, and manage your message backup.'}
            </p>
            <Button className="mt-3" variant="secondary" size="sm" onClick={onOpenSecurity}>
              Open your devices
            </Button>
          </section>
        )}

        {matrixMode && (
          <section
            className="rounded-lg bg-bg-primary p-4"
            aria-labelledby="call-privacy-heading"
          >
            <p id="call-privacy-heading" className="text-sm font-medium text-primary">
              Call privacy
            </p>
            <p className="mt-1 text-xs leading-5 text-muted">
              Voice, video, and screen sharing are relayed through the call service. The
              service can see who connects, network addresses, call timing, and traffic
              volume.
            </p>
            <p className="mt-2 text-xs leading-5 text-muted">
              Mesh encrypts call media between participating devices only after call
              encryption is verified. If verification or membership key rotation fails,
              your microphone, camera, screen, and incoming media stay off. Call encryption
              is newer and has a different security model from encrypted messages.
            </p>
          </section>
        )}

        {advancedUnlocked && (
          <section className="rounded-lg bg-bg-primary p-4" aria-labelledby="advanced-settings-heading">
            <p id="advanced-settings-heading" className="text-sm font-medium text-primary">
              Advanced
            </p>
            <p className="mt-1 text-xs leading-5 text-muted">
              Support and import tools for troubleshooting or moving older Mesh data.
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              {onOpenDiagnostics && (
                <Button variant="secondary" size="sm" onClick={onOpenDiagnostics}>
                  System diagnostics
                </Button>
              )}
              {matrixMode && onOpenImport && (
                <Button variant="secondary" size="sm" onClick={onOpenImport}>
                  Import older Mesh data
                </Button>
              )}
            </div>
          </section>
        )}

        <button
          type="button"
          className="mx-auto block rounded px-2 py-1 text-caption text-muted hover:text-secondary focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
          aria-label="Mesh version 0.1.0"
          onClick={() => {
            versionTapCount.current += 1
            if (versionTapCount.current >= 5) setAdvancedUnlocked(true)
          }}
        >
          Mesh 0.1.0
        </button>
      </div>
    </Modal>
  )
}

function PrivacyVisibilityRow({
  information,
  visible,
  explanation,
  private: isPrivate = false,
}: {
  information: string
  visible: string
  explanation: string
  private?: boolean
}) {
  return (
    <tr>
      <th scope="row" className="px-3 py-2 font-medium text-primary">{information}</th>
      <td className={`px-3 py-2 font-medium ${isPrivate ? 'text-green' : 'text-status-warning'}`}>
        {visible}
      </td>
      <td className="px-3 py-2">{explanation}</td>
    </tr>
  )
}

function AppearanceSelect({
  id,
  label,
  value,
  options,
  onChange,
}: {
  id: string
  label: string
  value: string
  options: ReadonlyArray<readonly [value: string, label: string]>
  onChange: (value: string) => void
}) {
  return (
    <label htmlFor={id} className="block text-xs font-medium text-muted">
      {label}
      <select
        id={id}
        className="mt-1 block h-control-md w-full rounded-md border border-border-subtle bg-surface-raised px-2 text-sm text-content outline-none transition-colors focus:border-accent"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      >
        {options.map(([optionValue, optionLabel]) => (
          <option key={optionValue} value={optionValue}>
            {optionLabel}
          </option>
        ))}
      </select>
    </label>
  )
}

function ToggleRow({
  label,
  description,
  checked,
  disabled = false,
  onChange,
}: {
  label: string
  description: string
  checked: boolean
  disabled?: boolean
  onChange: (checked: boolean) => void
}) {
  return (
    <label className={`flex items-start justify-between gap-4 rounded-md bg-bg-tertiary px-3 py-3 ${disabled ? 'opacity-50' : 'cursor-pointer'}`}>
      <span>
        <span className="block text-sm font-medium text-primary">{label}</span>
        <span className="mt-0.5 block text-xs leading-5 text-muted">{description}</span>
      </span>
      <input
        type="checkbox"
        className="mt-0.5 h-4 w-4 flex-shrink-0 accent-blue"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
    </label>
  )
}
