import { useEffect, useState, type FormEvent } from 'react'
import { Modal } from '../ui/Modal'
import { Button } from '../ui/Button'
import { Input } from '../ui/Input'
import { useSettingsStore } from '../../store/settings'
import type { Identity } from '../../types/ipc'

interface UserSettingsPanelProps {
  open: boolean
  onClose: () => void
  identity: Identity
  matrixAccountId: string | null
  matrixMode: boolean
  onUpdateDisplayName?: (displayName: string) => Promise<void>
  onOpenSecurity: () => void
}

export function UserSettingsPanel({
  open,
  onClose,
  identity,
  matrixAccountId,
  matrixMode,
  onUpdateDisplayName,
  onOpenSecurity,
}: UserSettingsPanelProps) {
  const notifications = useSettingsStore((state) => state.notifications)
  const setNotificationsEnabled = useSettingsStore((state) => state.setNotificationsEnabled)
  const setNotificationSound = useSettingsStore((state) => state.setNotificationSound)
  const [displayName, setDisplayName] = useState(identity.displayName)
  const [profileError, setProfileError] = useState<string | null>(null)
  const [profileSaved, setProfileSaved] = useState(false)
  const [savingProfile, setSavingProfile] = useState(false)

  useEffect(() => {
    if (!open) return
    setDisplayName(identity.displayName)
    setProfileError(null)
    setProfileSaved(false)
  }, [identity.displayName, open])

  const saveDisplayName = async (event: FormEvent) => {
    event.preventDefault()
    const normalized = displayName.trim()
    if (!normalized) {
      setProfileError('Display name cannot be empty.')
      return
    }
    if (Array.from(normalized).length > 100) {
      setProfileError('Display name must be 100 characters or fewer.')
      return
    }
    if (!onUpdateDisplayName) {
      setProfileError('Matrix profile editing is unavailable in this build.')
      return
    }

    setSavingProfile(true)
    setProfileError(null)
    setProfileSaved(false)
    try {
      await onUpdateDisplayName(normalized)
      setDisplayName(normalized)
      setProfileSaved(true)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setProfileError(message || 'Mesh could not update your Matrix profile.')
    } finally {
      setSavingProfile(false)
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="User Settings">
      <div className="max-h-[75vh] space-y-4 overflow-y-auto pr-1">
        <section className="rounded-lg bg-bg-primary p-4">
          <p className="text-2xs uppercase tracking-[0.25em] text-muted">Account</p>
          <div className="mt-3 min-w-0">
            <p className="truncate text-base font-semibold text-primary">{identity.displayName}</p>
            <p className="truncate font-mono text-xs text-muted">
              {matrixAccountId ?? identity.publicKey}
            </p>
          </div>
          <p className="mt-3 text-xs leading-5 text-muted">
            {matrixMode
              ? 'Mesh uses your Matrix account identity across communities and direct messages.'
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
                  <span role="status" className="text-xs text-green">
                    Profile updated
                  </span>
                )}
              </div>
              {profileError && (
                <p role="alert" className="rounded-md bg-red/10 px-3 py-2 text-xs text-red">
                  {profileError}
                </p>
              )}
              <p className="text-xs leading-5 text-muted">
                Profile avatars are currently read-only in Mesh. Matrix profile media is public,
                so Mesh will not upload an avatar while promising end-to-end encryption.
              </p>
            </form>
          )}
        </section>

        <section className="space-y-3 rounded-lg bg-bg-primary p-4" aria-labelledby="notification-settings-heading">
          <div>
            <p id="notification-settings-heading" className="text-sm font-medium text-primary">
              Notifications
            </p>
            <p className="mt-1 text-xs leading-5 text-muted">
              These preferences are saved locally and sync to your Matrix account when available.
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
            <p className="text-sm font-medium text-primary">Security & Devices</p>
            <p className="mt-1 text-xs leading-5 text-muted">
              Review signed-in devices, verification status, encrypted-history recovery, and account controls.
            </p>
            <Button className="mt-3" variant="secondary" size="sm" onClick={onOpenSecurity}>
              Open Security & Devices
            </Button>
          </section>
        )}
      </div>
    </Modal>
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
