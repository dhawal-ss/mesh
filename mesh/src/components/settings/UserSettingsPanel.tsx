import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Modal } from '../ui/Modal'
import { Button } from '../ui/Button'
import { Input } from '../ui/Input'
import { ErrorState } from '../ui/ErrorState'
import {
  effectiveConversationPrivacy,
  retryMatrixPreferenceSync,
  useSettingsStore,
} from '../../store/settings'
import { sequenceCardProps, type SequenceCardPosition } from '../ui/SequenceCard'
import { Icon } from '../ui/Icon'
import { PixelMark } from '../ui/PixelMark'
import type {
  AppearanceAccent,
  AppearanceDensity,
  AppearanceTheme,
  AppearanceTransparency,
  NotificationSoundId,
  ReadReceiptMode,
} from '../../store/settings'
import type { Identity } from '../../types/ipc'

interface UserSettingsPanelProps {
  open: boolean
  onClose: () => void
  identity: Identity
  matrixAccountId: string | null
  matrixMode: boolean
  activeConversationId?: string | null
  activeConversationName?: string | null
  onUpdateDisplayName?: (displayName: string) => Promise<void>
  onOpenSecurity: () => void
  backupReminderDue?: boolean
  onTestNotification?: () => Promise<void> | void
  onOpenDiagnostics?: () => void
  onOpenImport?: () => void
}

const ACCENT_CHOICES = [
  { id: 'violet', label: 'Violet', description: 'Mesh default' },
  { id: 'sand', label: 'Sand', description: 'Low-contrast warmth' },
  { id: 'ocean', label: 'Ocean', description: 'Cool blue' },
  { id: 'forest', label: 'Forest', description: 'Muted green' },
  { id: 'ember', label: 'Ember', description: 'Burnt orange' },
  { id: 'rose', label: 'Rose', description: 'Soft magenta' },
] as const satisfies ReadonlyArray<{
  id: AppearanceAccent
  label: string
  description: string
}>

type UserSettingsTab = 'account' | 'appearance' | 'notifications' | 'privacy' | 'devices'

const SETTINGS_TABS = [
  ['account', 'Account'],
  ['appearance', 'Appearance'],
  ['notifications', 'Notifications'],
  ['privacy', 'Privacy'],
  ['devices', 'Devices'],
] as const satisfies ReadonlyArray<readonly [UserSettingsTab, string]>

export function UserSettingsPanel({
  open,
  onClose,
  identity,
  matrixAccountId,
  matrixMode,
  activeConversationId = null,
  activeConversationName = null,
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
  const setShowMessageContent = useSettingsStore((state) => state.setShowMessageContent)
  const setDoNotDisturb = useSettingsStore((state) => state.setDoNotDisturb)
  const setQuietHoursEnabled = useSettingsStore((state) => state.setQuietHoursEnabled)
  const setQuietHours = useSettingsStore((state) => state.setQuietHours)
  const setAppearanceTheme = useSettingsStore((state) => state.setAppearanceTheme)
  const setAppearanceDensity = useSettingsStore((state) => state.setAppearanceDensity)
  const setAppearanceAccent = useSettingsStore((state) => state.setAppearanceAccent)
  const setAppearanceTransparency = useSettingsStore((state) => state.setAppearanceTransparency)
  const setReadReceiptMode = useSettingsStore((state) => state.setReadReceiptMode)
  const setSendTypingIndicators = useSettingsStore((state) => state.setSendTypingIndicators)
  const setConversationReadReceiptMode = useSettingsStore(
    (state) => state.setConversationReadReceiptMode,
  )
  const setConversationTypingIndicators = useSettingsStore(
    (state) => state.setConversationTypingIndicators,
  )
  const setSharePresence = useSettingsStore((state) => state.setSharePresence)
  const setInvisibleMode = useSettingsStore((state) => state.setInvisibleMode)
  const [displayName, setDisplayName] = useState(identity.displayName)
  const [profileValidation, setProfileValidation] = useState<string | null>(null)
  const [profileError, setProfileError] = useState<unknown | null>(null)
  const [profileSaved, setProfileSaved] = useState(false)
  const [savingProfile, setSavingProfile] = useState(false)
  const [testingNotification, setTestingNotification] = useState(false)
  const [testNotificationStatus, setTestNotificationStatus] = useState<'sent' | 'failed' | null>(
    null,
  )
  const [advancedUnlocked, setAdvancedUnlocked] = useState(false)
  const [activeTab, setActiveTab] = useState<UserSettingsTab>('appearance')
  const versionTapCount = useRef(0)
  const settingsScrollRef = useRef<HTMLDivElement>(null)
  const tabRefs = useRef<Partial<Record<UserSettingsTab, HTMLButtonElement>>>({})
  const visibleSettingsTabs = matrixMode
    ? SETTINGS_TABS
    : SETTINGS_TABS.filter(([id]) => id !== 'privacy')
  const conversationPrivacy = activeConversationId
    ? privacy.conversationPrivacy[activeConversationId]
    : undefined
  const effectivePrivacy = activeConversationId
    ? effectiveConversationPrivacy(privacy, activeConversationId)
    : privacy

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
    const unlockAdvanced = (event: KeyboardEvent) => {
      if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === 'd') {
        event.preventDefault()
        setAdvancedUnlocked(true)
      }
    }
    document.addEventListener('keydown', unlockAdvanced)
    return () => document.removeEventListener('keydown', unlockAdvanced)
  }, [open])

  const activateTab = (id: UserSettingsTab, focus = false) => {
    if (focus) tabRefs.current[id]?.focus()
    setActiveTab(id)
    window.requestAnimationFrame(() => {
      if (settingsScrollRef.current) settingsScrollRef.current.scrollTop = 0
      const tab = tabRefs.current[id]
      tab?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' })
    })
  }

  const navigateTabs = (event: React.KeyboardEvent<HTMLButtonElement>, current: UserSettingsTab) => {
    const ids = visibleSettingsTabs.map(([id]) => id)
    const currentIndex = ids.indexOf(current)
    let nextIndex: number | null = null
    if (event.key === 'ArrowRight') nextIndex = (currentIndex + 1) % ids.length
    if (event.key === 'ArrowLeft') nextIndex = (currentIndex - 1 + ids.length) % ids.length
    if (event.key === 'Home') nextIndex = 0
    if (event.key === 'End') nextIndex = ids.length - 1
    if (nextIndex === null) return
    event.preventDefault()
    activateTab(ids[nextIndex], true)
  }

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
    <Modal
      open={open}
      onClose={onClose}
      title="User Settings"
      description="Make Mesh feel like yours."
      size="lg"
      className="overflow-hidden"
      closeLabel="Close user settings"
    >
      <div className="-mx-4 border-b border-border-subtle px-4">
        <label className="block py-2 text-xs font-medium text-secondary sm:hidden">
          Settings section
          <select
            value={activeTab}
            onChange={(event) => activateTab(event.target.value as UserSettingsTab)}
            className="mt-1 block min-h-11 w-full rounded-control border border-border bg-surface-sunken px-3 text-sm text-primary"
          >
            {visibleSettingsTabs.map(([id, label]) => (
              <option key={id} value={id}>{label}</option>
            ))}
          </select>
        </label>
        <div className="relative hidden sm:block">
          <div
            role="tablist"
            aria-label="User settings"
            className="flex min-w-0 gap-1 overflow-x-auto pr-8"
          >
          {visibleSettingsTabs.map(([id, label]) => (
            <button
              key={id}
              ref={(element) => { tabRefs.current[id] = element ?? undefined }}
              id={`user-settings-tab-${id}`}
              type="button"
              role="tab"
              aria-selected={activeTab === id}
              aria-controls={`user-settings-panel-${id}`}
              tabIndex={activeTab === id ? 0 : -1}
              className={`relative min-h-11 flex-shrink-0 px-3 text-sm font-medium transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent ${
                activeTab === id ? 'text-accent' : 'text-muted hover:text-primary'
              }`}
              onClick={() => activateTab(id)}
              onKeyDown={(event) => navigateTabs(event, id)}
            >
              {label}
              {activeTab === id && (
                <span className="absolute inset-x-1 bottom-0 h-0.5 rounded-full bg-accent" aria-hidden="true" />
              )}
            </button>
          ))}
          </div>
          <div
            className="pointer-events-none absolute inset-y-0 right-0 w-8 bg-gradient-to-l from-surface-raised to-transparent"
            aria-hidden="true"
          />
        </div>
      </div>

      <div ref={settingsScrollRef} className="mesh-settings-scroll overflow-y-auto py-5 pr-1">
        <div
          id={`user-settings-panel-${activeTab}`}
          role="tabpanel"
          aria-labelledby={`user-settings-tab-${activeTab}`}
          tabIndex={0}
        >
        {activeTab === 'account' && (
        <section className="border-b border-border-subtle pb-5">
          <p className="text-2xs uppercase tracking-signal text-muted">Account</p>
          <div className="mt-3 min-w-0">
            <p className="truncate text-base font-semibold text-primary">{identity.displayName}</p>
            <p className="truncate font-mono text-xs text-muted">
              {matrixAccountId ? 'Mesh account' : identity.publicKey}
            </p>
          </div>
          <p className="mt-3 text-xs leading-5 text-muted">
            {matrixMode
              ? 'Mesh uses this account across communities and direct messages.'
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
                  <span
                    role="status"
                    aria-label="Display name save status"
                    className="text-xs text-green"
                  >
                    Profile updated
                  </span>
                )}
              </div>
              {profileValidation && (
                <p
                  role="alert"
                  className="rounded-panel bg-status-danger/10 px-3 py-2 text-xs text-status-danger"
                >
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
        )}

        {activeTab === 'appearance' && (
        <section
          id="user-settings-panel-appearance"
          role="tabpanel"
          className="space-y-5"
          aria-labelledby="appearance-settings-heading"
        >
          <div>
            <p id="appearance-settings-heading" className="text-sm font-medium text-primary">
              Appearance
            </p>
            <p className="mt-1 text-xs leading-5 text-muted">
              Changes preview instantly and stay on this device.
            </p>
          </div>

          <div className="space-y-4">
            <AppearanceSegmentedControl
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
            <AppearanceSegmentedControl
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
            <AppearanceSegmentedControl
              id="appearance-transparency"
              label="Window transparency"
              value={appearance.transparency}
              options={[
                ['readable', 'Subtle'],
                ['opaque', 'Opaque'],
              ]}
              onChange={(value) => setAppearanceTransparency(value as AppearanceTransparency)}
            />
          </div>

          <fieldset>
            <legend className="text-xs font-medium text-muted">Accent color</legend>
            <div className="mt-2 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {ACCENT_CHOICES.map((choice) => {
                const selected = appearance.accent === choice.id
                return (
                  <label
                    key={choice.id}
                    className={`group flex min-h-16 cursor-pointer items-center gap-3 rounded-control border px-3 py-2.5 transition-colors ${
                      selected
                        ? 'border-accent bg-accent/10'
                        : 'border-border-subtle bg-surface-sunken hover:border-border-emphasis hover:bg-surface-hover'
                    }`}
                  >
                    <input
                      type="radio"
                      name="appearance-accent"
                      value={choice.id}
                      checked={selected}
                      onChange={() => setAppearanceAccent(choice.id)}
                      className="sr-only"
                    />
                    <span
                      className="mesh-accent-choice flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-control"
                      data-accent-preview={choice.id}
                      aria-hidden="true"
                    >
                      <PixelMark variant="community" className="h-9 w-9" />
                    </span>
                    <span className="min-w-0">
                      <span className="block text-sm font-medium text-primary">{choice.label}</span>
                      <span className="mt-0.5 block text-caption text-muted">{choice.description}</span>
                    </span>
                    {selected && (
                      <span className="ml-auto flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full bg-accent text-content-on-accent" aria-hidden="true">
                        <Icon name="check" size="xs" />
                      </span>
                    )}
                  </label>
                )
              })}
            </div>
            <p className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-caption leading-5 text-muted">
              <span className="h-2 w-2 rounded-full bg-status-success" aria-hidden="true" />
              Status colors stay consistent. Connected, warning, and destructive actions do not change with your accent.
            </p>
          </fieldset>

          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border-subtle pt-4">
            <button
              type="button"
              className="min-h-9 rounded-control px-2 text-sm font-medium text-accent hover:bg-accent/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
              onClick={() => {
                setAppearanceTheme('dark')
                setAppearanceDensity('default')
                setAppearanceAccent('violet')
                setAppearanceTransparency('readable')
              }}
            >
              Reset to Mesh default
            </button>
            <div className="ml-auto flex items-center gap-3">
              <span className="flex items-center gap-2 text-caption text-muted">
                <span className="h-2 w-2 rounded-full bg-status-success" aria-hidden="true" />
                Saved on this device
              </span>
              <Button variant="primary" onClick={onClose}>Done</Button>
            </div>
          </div>
        </section>
        )}

        {matrixMode && activeTab === 'privacy' && (
          <section
            className="space-y-4 border-b border-border-subtle pb-5"
            aria-labelledby="privacy-center-heading"
          >
            <div>
              <p id="privacy-center-heading" className="text-sm font-medium text-primary">
                Privacy Center
              </p>
              <p className="mt-1 text-xs leading-5 text-muted">
                Mesh protects message and file contents before they leave your device. Your service
                still handles the information needed to connect you and deliver them.
              </p>
            </div>

            <div aria-live="polite" aria-busy={matrixPreferenceSync.status === 'saving'}>
              {matrixPreferenceSync.status === 'saving' && (
                <p
                  role="status"
                  aria-label="Privacy settings save status"
                  className="rounded-control bg-surface-hover px-3 py-2 text-xs text-muted"
                >
                  Applying privacy settings…
                </p>
              )}
              {matrixPreferenceSync.status === 'saved' && (
                <p
                  role="status"
                  aria-label="Privacy settings save status"
                  className="rounded-control bg-surface-hover px-3 py-2 text-xs text-green"
                >
                  Privacy settings saved to your account.
                </p>
              )}
              {matrixPreferenceSync.status === 'failed' && (
                <>
                  <p className="mb-2 rounded-control bg-surface-hover px-3 py-2 text-xs leading-5 text-muted">
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

            <div
              className="overflow-x-auto rounded-control border border-border-subtle"
              role="region"
              aria-label="Service visibility details"
              tabIndex={0}
            >
              <table className="w-full min-w-privacy-table text-left text-xs">
                <caption className="sr-only">What your service can see</caption>
                <thead className="bg-surface-hover text-muted">
                  <tr>
                    <th scope="col" className="px-3 py-2 font-medium">
                      Information
                    </th>
                    <th scope="col" className="px-3 py-2 font-medium">
                      Can the service see it?
                    </th>
                    <th scope="col" className="px-3 py-2 font-medium">
                      Why
                    </th>
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
                    visible={
                      effectivePrivacy.sendTypingIndicators
                        ? 'Yes, while enabled'
                        : 'No, disabled now'
                    }
                    explanation="Shared only when the typing control below is on."
                    private={!effectivePrivacy.sendTypingIndicators}
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

            <div className="sequence-card-group" aria-label="Privacy controls">
              <SelectRow
                id="read-receipts"
                label="Read receipts"
                description="Choose whether people in a conversation can see when you have read their messages."
                value={privacy.readReceiptMode}
                options={[
                  ['public', 'Public: show when I have read messages'],
                  ['private', 'Private: keep receipts between my devices'],
                  ['off', 'Off: do not send read receipts'],
                ]}
                onChange={(value) => setReadReceiptMode(value as ReadReceiptMode)}
                sequencePosition="first"
              />
              <ToggleRow
                label="Show when I am typing"
                description="Lets people in the conversation see you composing; turning it off can make replies feel less immediate."
                checked={privacy.sendTypingIndicators}
                onChange={setSendTypingIndicators}
                sequencePosition="middle"
              />
              <ToggleRow
                label="Share my online status"
                description="Lets people see when you are online; the service can still see connection times when this is off."
                checked={privacy.sharePresence}
                onChange={setSharePresence}
                sequencePosition="middle"
              />
              <ToggleRow
                label="Invisible mode"
                description="Makes you appear offline without disconnecting and temporarily overrides online-status sharing."
                checked={privacy.invisibleMode}
                onChange={setInvisibleMode}
                sequencePosition="last"
              />
            </div>

            {activeConversationId && (
              <div className="space-y-3 rounded-control border border-border-subtle bg-surface-sunken p-3">
                <div>
                  <p className="text-sm font-medium text-primary">
                    This conversation
                    {activeConversationName ? `: ${activeConversationName}` : ''}
                  </p>
                  <p className="mt-1 text-xs leading-5 text-muted">
                    Override the account defaults only for this conversation. Inherit follows the
                    controls above.
                  </p>
                </div>
                <div
                  className="sequence-card-group"
                  aria-label="Current conversation privacy controls"
                >
                  <SelectRow
                    id="conversation-read-receipts"
                    label="Read receipts for this conversation"
                    description="Controls what Mesh sends here and whether it displays other people's public receipts."
                    value={conversationPrivacy?.readReceiptMode ?? ''}
                    options={[
                      ['', `Inherit account setting (${privacy.readReceiptMode})`],
                      ['public', 'Public'],
                      ['private', 'Private between my devices'],
                      ['off', 'Off'],
                    ]}
                    onChange={(value) =>
                      setConversationReadReceiptMode(
                        activeConversationId,
                        value ? (value as ReadReceiptMode) : null,
                      )
                    }
                    sequencePosition="first"
                  />
                  <SelectRow
                    id="conversation-typing"
                    label="Typing status for this conversation"
                    description="Controls whether Mesh tells people here when you are composing."
                    value={
                      conversationPrivacy?.sendTypingIndicators === undefined
                        ? ''
                        : conversationPrivacy.sendTypingIndicators
                          ? 'on'
                          : 'off'
                    }
                    options={[
                      [
                        '',
                        `Inherit account setting (${privacy.sendTypingIndicators ? 'on' : 'off'})`,
                      ],
                      ['on', 'On'],
                      ['off', 'Off'],
                    ]}
                    onChange={(value) =>
                      setConversationTypingIndicators(
                        activeConversationId,
                        value === '' ? null : value === 'on',
                      )
                    }
                    sequencePosition="last"
                  />
                </div>
                <p className="text-xs leading-5 text-muted">
                  Mesh can control only what it sends and shows. Other compatible apps may publish
                  or display activity differently.
                </p>
              </div>
            )}

            <div className="rounded-control bg-surface-hover px-3 py-3 text-xs leading-5 text-muted">
              <p>
                Each conversation header checks its current protection and shows “Protected end to
                end” before you send.
              </p>
              <p className="mt-2">
                Unlike standard Discord messages, Mesh keeps conversation content unreadable to the
                service. Both services can still observe operational details such as network
                addresses, devices, membership, and timing.
              </p>
            </div>
          </section>
        )}

        {activeTab === 'notifications' && (
        <section
          className="space-y-3 border-b border-border-subtle pb-5"
          aria-labelledby="notification-settings-heading"
        >
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
          <ToggleRow
            label="Show message text"
            description="Include message text in notifications. It may appear on lock screens, mirrored displays, and notification history."
            checked={notifications.showMessageContent}
            disabled={!notifications.enabled}
            onChange={setShowMessageContent}
          />
          <label
            htmlFor="notification-sound"
            className={`block rounded-control bg-surface-hover px-3 py-3 text-xs font-medium text-muted ${
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
              className="grid gap-3 rounded-control bg-surface-hover px-3 py-3 sm:grid-cols-2"
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
              <span
                role="status"
                aria-label="Test notification status"
                className="text-xs text-green"
              >
                Test notification sent
              </span>
            )}
            {testNotificationStatus === 'failed' && (
              <span role="alert" className="text-xs text-status-danger">
                Mesh could not send the test notification.
              </span>
            )}
          </div>

          {(notifications.mutedChannels.length > 0 ||
            notifications.mutedCommunities.length > 0) && (
            <p className="rounded-control bg-surface-hover px-3 py-2 text-xs text-muted">
              Muted: {notifications.mutedCommunities.length} communit
              {notifications.mutedCommunities.length === 1 ? 'y' : 'ies'} and{' '}
              {notifications.mutedChannels.length} channel
              {notifications.mutedChannels.length === 1 ? '' : 's'}.
            </p>
          )}
        </section>
        )}

        {matrixMode && activeTab === 'devices' && (
          <section className="border-b border-border-subtle pb-5">
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

        {matrixMode && activeTab === 'privacy' && (
          <section
            className="border-b border-border-subtle pb-5"
            aria-labelledby="call-privacy-heading"
          >
            <p id="call-privacy-heading" className="text-sm font-medium text-primary">
              Call privacy
            </p>
            <p className="mt-1 text-xs leading-5 text-muted">
              Voice, video, and screen sharing are relayed through the call service. The service can
              see who connects, network addresses, call timing, and traffic volume.
            </p>
            <p className="mt-2 text-xs leading-5 text-muted">
              Mesh encrypts call media between participating devices only after call encryption is
              verified. If verification or membership key rotation fails, your microphone, camera,
              screen, and incoming media stay off. Call encryption is newer and has a different
              security model from encrypted messages.
            </p>
          </section>
        )}

        {activeTab === 'devices' && advancedUnlocked && (
          <section
            className="rounded-panel border border-border-subtle bg-surface-sunken p-4"
            aria-labelledby="advanced-settings-heading"
          >
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

        {activeTab === 'devices' && (
        <button
          type="button"
          className="mx-auto flex min-h-8 items-center rounded-control px-2 text-caption text-muted hover:bg-surface-hover hover:text-secondary focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
          aria-label="Mesh version 0.1.0"
          onClick={() => {
            versionTapCount.current += 1
            if (versionTapCount.current >= 5) setAdvancedUnlocked(true)
          }}
        >
          Mesh 0.1.0
        </button>
        )}
        </div>
        {visibleSettingsTabs
          .filter(([id]) => id !== activeTab)
          .map(([id]) => (
            <div
              key={id}
              id={`user-settings-panel-${id}`}
              role="tabpanel"
              aria-labelledby={`user-settings-tab-${id}`}
              hidden
            />
          ))}
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
      <th scope="row" className="px-3 py-2 font-medium text-primary">
        {information}
      </th>
      <td className={`px-3 py-2 font-medium ${isPrivate ? 'text-green' : 'text-status-warning'}`}>
        {visible}
      </td>
      <td className="px-3 py-2">{explanation}</td>
    </tr>
  )
}

function AppearanceSegmentedControl({
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
    <fieldset>
      <legend className="text-xs font-medium text-primary">{label}</legend>
      <div
        id={id}
        className="mt-2 grid overflow-hidden rounded-control border border-border-subtle bg-surface-sunken"
        style={{ gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))` }}
      >
        {options.map(([optionValue, optionLabel]) => (
          <label
            key={optionValue}
            className={`relative flex min-h-9 cursor-pointer items-center justify-center border-l border-border-subtle px-3 text-center text-xs font-medium first:border-l-0 ${
              value === optionValue
                ? 'bg-accent/10 text-accent outline outline-1 -outline-offset-1 outline-accent'
                : 'text-muted hover:bg-surface-hover hover:text-primary'
            }`}
          >
            <input
              type="radio"
              name={id}
              value={optionValue}
              checked={value === optionValue}
              onChange={() => onChange(optionValue)}
              className="sr-only"
            />
            {optionLabel}
          </label>
        ))}
      </div>
    </fieldset>
  )
}

function ToggleRow({
  label,
  description,
  checked,
  disabled = false,
  onChange,
  sequencePosition,
}: {
  label: string
  description: string
  checked: boolean
  disabled?: boolean
  onChange: (checked: boolean) => void
  sequencePosition?: SequenceCardPosition
}) {
  const sequence = sequencePosition ? sequenceCardProps(sequencePosition) : null
  return (
    <label
      data-sequence-position={sequence?.['data-sequence-position']}
      className={`${sequence?.className ?? 'rounded-control bg-surface-hover'} flex items-start justify-between gap-4 px-3 py-3 ${disabled ? 'opacity-50' : 'cursor-pointer'}`}
    >
      <span>
        <span className="block text-sm font-medium text-primary">{label}</span>
        <span className="mt-0.5 block text-xs leading-5 text-muted">{description}</span>
      </span>
      <input
        type="checkbox"
        className="mt-0.5 h-4 w-4 flex-shrink-0 accent-accent"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
    </label>
  )
}

function SelectRow({
  id,
  label,
  description,
  value,
  options,
  onChange,
  sequencePosition,
}: {
  id: string
  label: string
  description: string
  value: string
  options: Array<[string, string]>
  onChange: (value: string) => void
  sequencePosition?: SequenceCardPosition
}) {
  const sequence = sequencePosition ? sequenceCardProps(sequencePosition) : null
  return (
    <div
      data-sequence-position={sequence?.['data-sequence-position']}
      className={`${sequence?.className ?? 'rounded-control bg-surface-hover'} flex items-start justify-between gap-4 px-3 py-3`}
    >
      <span>
        <label htmlFor={id} className="block text-sm font-medium text-primary">
          {label}
        </label>
        <span id={`${id}-description`} className="mt-0.5 block text-xs leading-5 text-muted">
          {description}
        </span>
      </span>
      <select
        id={id}
        aria-describedby={`${id}-description`}
        className="min-h-control-sm max-w-xs rounded-control border border-border bg-surface-sunken px-2 text-xs text-primary outline-none focus:border-accent"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      >
        {options.map(([optionValue, optionLabel]) => (
          <option key={optionValue} value={optionValue}>
            {optionLabel}
          </option>
        ))}
      </select>
    </div>
  )
}
