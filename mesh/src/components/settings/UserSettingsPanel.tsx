import { lazy, Suspense, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { Modal } from '../ui/Modal'
import { Button } from '../ui/Button'
import { Input } from '../ui/Input'
import { ErrorState } from '../ui/ErrorState'
import { Notice, SectionHeader } from '../ui/Primitives'
import {
  effectiveConversationPrivacy,
  retryMatrixPreferenceSync,
  useSettingsStore,
} from '../../store/settings'
import { sequenceCardProps, type SequenceCardPosition } from '../ui/SequenceCard'
import { Icon, type IconName } from '../ui/Icon'
import { PixelMark } from '../ui/PixelMark'
import { AmbientNote, Eyebrow, StateTick, rowNumber } from '../ui/QuietStructure'
import { Avatar } from '../ui/Avatar'
import type {
  AppearanceAccent,
  AppearanceDensity,
  AppearanceTextScale,
  AppearanceTheme,

  ReadReceiptMode,
} from '../../store/settings'
import type { Identity } from '../../types/ipc'
import { INTERFACE_SOUND_SETTINGS, type InterfaceSoundId } from '../../lib/interface-sound-contract'
import { playInterfaceSound } from '../../lib/interface-sounds'
import { PUBLIC_SERVICES } from '../../config/public-services'
import {
  clearRuntimeErrorRecords,
  getRuntimeErrorSummary,
  saveRuntimeErrorReport,
} from '../../lib/runtime-error-reporting'
import { GovernedCommitmentsPanel } from './GovernedCommitmentsPanel'
import { BetaInfoPanel } from './BetaCenter'
import { MESH_APP_VERSION } from '../../lib/beta-release'
import {
  getBackendStatusSnapshot,
  isTauriRuntime,
  matrixClearProfileAvatar,
  matrixLoadProfileAvatar,
  matrixUpdateProfileAvatar,
  notificationPermissionState,
} from '../../lib/bridge'
import { normalizeError } from '../../lib/errors'
import { shouldExposeVoiceRoutes } from '../../lib/voice-runtime'
import { useOnboardingChecklist } from '../../hooks/useOnboardingChecklist'
import { matrixProfileIdentity } from '../../lib/matrixIdentity'
import { useIdentityStore } from '../../store/identity'
import { useOnboardingChecklistStore } from '../../store/onboarding-checklist'
import { useRoomOrganizationStore } from '../../store/room-organization'

const DiagnosticsPanel = lazy(() =>
  import('./DiagnosticsPanel').then((module) => ({ default: module.DiagnosticsPanel })),
)

const SecurityDevicesPanel = lazy(() =>
  import('./SecurityDevicesPanel').then((module) => ({ default: module.SecurityDevicesPanel })),
)

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
  onOpenFeedback?: () => void
  /** Route-owned You uses the same controls without creating a nested settings dialog. */
  embedded?: boolean
  activeSection?: UserSettingsTab
  onSectionChange?: (section: UserSettingsTab) => void
}

/*
 * Every appearance choice is a visually hidden radio inside a styled label, so
 * focus lands on something nobody can see. High contrast is the option a
 * low-vision user comes here for, so the label has to carry the ring itself.
 */
const APPEARANCE_FOCUS_RING =
  'has-[input:focus-visible]:outline has-[input:focus-visible]:outline-2 has-[input:focus-visible]:outline-focus'

/*
  The six accents, in lineage order.

  Ultramarine is the structural one: it is what an active row, a plane chip
  and a selected segment are made of, and it is the default. The other five are
  identity rather than structure, and the mono lineage label says which
  tradition each one comes from -- Bauhaus for the primary-adjacent pair,
  Memphis for the three that are unapologetically loud.

  The ids are the stored values and do not change with the names.
*/
const ACCENT_CHOICES = [
  { id: 'ocean', label: 'Ultramarine', lineage: 'Structural', description: 'The system\u2019s own colour' },
  { id: 'ember', label: 'Vermilion', lineage: 'Bauhaus', description: 'Primary red' },
  { id: 'sand', label: 'Chrome', lineage: 'Bauhaus', description: 'Primary yellow' },
  { id: 'violet', label: 'Magenta', lineage: 'Memphis', description: 'Postmodern pink' },
  { id: 'forest', label: 'Lime', lineage: 'Memphis', description: 'Postmodern green' },
  { id: 'rose', label: 'Cyan', lineage: 'Memphis', description: 'Postmodern blue' },
] as const satisfies ReadonlyArray<{
  id: AppearanceAccent
  label: string
  lineage: string
  description: string
}>

export type UserSettingsTab =
  | 'profile'
  | 'account'
  | 'appearance'
  | 'notifications'
  | 'privacy'
  | 'audio-video'
  | 'devices'
  | 'beta'
  | 'advanced'

const PRIMARY_SETTINGS_TABS = [
  ['account', 'Account'],
  ['notifications', 'Notifications'],
  ['appearance', 'Appearance'],
  ['audio-video', 'Audio and video'],
] as const satisfies ReadonlyArray<readonly [UserSettingsTab, string]>

const PRIMARY_SETTINGS_TAB_IDS = new Set<UserSettingsTab>(
  PRIMARY_SETTINGS_TABS.map(([id]) => id),
)

function accountServiceFromMatrixId(matrixAccountId: string | null) {
  const separator = matrixAccountId?.indexOf(':') ?? -1
  const accountDomain = separator >= 0
    ? matrixAccountId?.slice(separator + 1).trim().toLowerCase() || null
    : null
  if (!accountDomain) return null

  const publicService = PUBLIC_SERVICES.find(
    (service) => service.accountDomain.toLowerCase() === accountDomain,
  )
  return {
    accountDomain,
    displayName: publicService?.displayName ?? accountDomain,
  }
}

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
  onOpenFeedback,
  embedded = false,
  activeSection,
  onSectionChange,
}: UserSettingsPanelProps) {
  const accountService = matrixMode ? accountServiceFromMatrixId(matrixAccountId) : null
  const notifications = useSettingsStore((state) => state.notifications)
  const appearance = useSettingsStore((state) => state.appearance)
  const privacy = useSettingsStore((state) => state.privacy)
  const matrixPreferenceSync = useSettingsStore((state) => state.matrixPreferenceSync)
  const signalCheckEnabled = useSettingsStore((state) => state.signalCheckEnabled)
  const runtimeErrorReportingEnabled = useSettingsStore(
    (state) => state.runtimeErrorReportingEnabled,
  )
  const setNotificationsEnabled = useSettingsStore((state) => state.setNotificationsEnabled)
  const setNotificationSound = useSettingsStore((state) => state.setNotificationSound)
  const setInterfaceSoundVolume = useSettingsStore((state) => state.setInterfaceSoundVolume)
  const setInterfaceSoundEnabled = useSettingsStore((state) => state.setInterfaceSoundEnabled)
  const setShowMessageContent = useSettingsStore((state) => state.setShowMessageContent)
  const setDoNotDisturb = useSettingsStore((state) => state.setDoNotDisturb)
  const setQuietHoursEnabled = useSettingsStore((state) => state.setQuietHoursEnabled)
  const setQuietHours = useSettingsStore((state) => state.setQuietHours)
  const setAppearanceTheme = useSettingsStore((state) => state.setAppearanceTheme)
  const setAppearanceDensity = useSettingsStore((state) => state.setAppearanceDensity)
  const setAppearanceTextScale = useSettingsStore((state) => state.setAppearanceTextScale)
  const setAppearanceAccent = useSettingsStore((state) => state.setAppearanceAccent)
  const restoreRoomOrganizationDefaults = useRoomOrganizationStore((state) => state.restoreDefaults)
  const [confirmingRoomOrganizationReset, setConfirmingRoomOrganizationReset] = useState(false)
  const setIdentity = useIdentityStore((state) => state.setIdentity)
  const checklistFinished = useOnboardingChecklist().finished
  const checklistDismissed = useOnboardingChecklistStore((state) => state.dismissed)
  const showChecklist = useOnboardingChecklistStore((state) => state.show)
  const dismissChecklist = useOnboardingChecklistStore((state) => state.dismiss)

  const setReduceMotion = useSettingsStore((state) => state.setReduceMotion)
  const setSignalCheckEnabled = useSettingsStore((state) => state.setSignalCheckEnabled)
  const setRuntimeErrorReportingEnabled = useSettingsStore(
    (state) => state.setRuntimeErrorReportingEnabled,
  )
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
  const [runtimeErrorRecordCount, setRuntimeErrorRecordCount] = useState(
    () => getRuntimeErrorSummary().storedCount,
  )
  const [showAccountAddress, setShowAccountAddress] = useState(false)
  const [testingNotification, setTestingNotification] = useState(false)
  const [showEmbeddedDiagnostics, setShowEmbeddedDiagnostics] = useState(false)
  const [showEmbeddedSecurity, setShowEmbeddedSecurity] = useState(false)
  const [testNotificationStatus, setTestNotificationStatus] = useState<
    'sent' | 'blocked' | 'failed' | null
  >(null)
  // Mesh's own switch records what the user asked for. If the OS has denied the
  // permission, every notification is dropped in silence and the switch still
  // reads as on, so the panel has to ask the OS rather than trust itself.
  const [osNotificationsDenied, setOsNotificationsDenied] = useState(false)
  const [localActiveTab, setLocalActiveTab] = useState<UserSettingsTab>('appearance')
  const settingsScrollRef = useRef<HTMLDivElement>(null)
  const tabRefs = useRef<Partial<Record<UserSettingsTab, HTMLButtonElement>>>({})
  const diagnosticsTriggerRef = useRef<HTMLButtonElement>(null)
  const securityReturnFocusRef = useRef<HTMLButtonElement | null>(null)
  // Audio and video is call copy and nothing else, so it only exists where a
  // call can actually be opened.
  const voiceRoutesEnabled = matrixMode
    && shouldExposeVoiceRoutes(matrixMode, getBackendStatusSnapshot())
  const visibleSettingsTabs = voiceRoutesEnabled
    ? PRIMARY_SETTINGS_TABS
    : PRIMARY_SETTINGS_TABS.filter(([id]) => id !== 'audio-video')
  const requestedTab = activeSection ?? localActiveTab
  // A destination that just disappeared must not strand the panel on a blank pane.
  const activeTab = requestedTab === 'audio-video' && !voiceRoutesEnabled ? 'account' : requestedTab
  const activeTabIsPrimary = PRIMARY_SETTINGS_TAB_IDS.has(activeTab)
  const conversationPrivacy = activeConversationId
    ? privacy.conversationPrivacy[activeConversationId]
    : undefined
  const effectivePrivacy = activeConversationId
    ? effectiveConversationPrivacy(privacy, activeConversationId)
    : privacy

  const openSecurity = (trigger: HTMLButtonElement) => {
    if (!embedded) {
      onOpenSecurity()
      return
    }
    securityReturnFocusRef.current = trigger
    setShowEmbeddedSecurity(true)
  }

  const closeEmbeddedSecurity = () => {
    setShowEmbeddedSecurity(false)
    window.requestAnimationFrame(() => securityReturnFocusRef.current?.focus())
  }

  useEffect(() => {
    if (activeTab !== 'notifications' || !isTauriRuntime()) return
    let active = true
    void notificationPermissionState()
      .then((permission) => {
        if (active) setOsNotificationsDenied(permission === 'denied')
      })
      // A permission we cannot read is not a permission we can claim is denied.
      .catch(() => {})
    return () => { active = false }
  }, [activeTab])

  const testNotification = async () => {
    if (!onTestNotification || testingNotification) return
    setTestingNotification(true)
    setTestNotificationStatus(null)
    try {
      await onTestNotification()
      setTestNotificationStatus('sent')
    } catch (error) {
      // A denied OS permission is the one failure the user can act on, and the
      // backend already names it, so the panel never has to guess.
      setTestNotificationStatus(
        normalizeError(error).code === 'permission_denied' ? 'blocked' : 'failed',
      )
    } finally {
      setTestingNotification(false)
    }
  }

  const activateTab = (id: UserSettingsTab, focus = false) => {
    setShowEmbeddedDiagnostics(false)
    setShowEmbeddedSecurity(false)
    if (focus) tabRefs.current[id]?.focus()
    if (onSectionChange) onSectionChange(id)
    else setLocalActiveTab(id)
    window.requestAnimationFrame(() => {
      if (settingsScrollRef.current) settingsScrollRef.current.scrollTop = 0
      const tab = tabRefs.current[id]
      tab?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' })
    })
  }

  const navigateTabs = (event: React.KeyboardEvent<HTMLButtonElement>, current: UserSettingsTab) => {
    const ids: UserSettingsTab[] = visibleSettingsTabs.map(([id]) => id)
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

  /*
    Profile pictures had no writer anywhere in the product: update_profile_display_name
    was the only profile write that existed, so this field could only be non-null
    if the person had set an avatar from a different Matrix client.
  */
  const avatarInputRef = useRef<HTMLInputElement>(null)
  const [avatarBusy, setAvatarBusy] = useState(false)
  const [avatarPreview, setAvatarPreview] = useState<string | null>(null)

  useEffect(() => () => {
    // A blob URL outlives the element that used it until it is revoked.
    if (avatarPreview) URL.revokeObjectURL(avatarPreview)
  }, [avatarPreview])

  const chooseAvatar = async (file: File) => {
    setAvatarBusy(true)
    setProfileError(null)
    setProfileValidation(null)
    setProfileSaved(false)
    try {
      const bytes = new Uint8Array(await file.arrayBuffer())
      const profile = await matrixUpdateProfileAvatar(file.name, file.type, bytes)
      /*
       * The store, not only this panel. A local preview covers the two avatars
       * on this screen, and every other place a person sees their own picture
       * reads the identity store: the user panel, home, the call dock, and the
       * message rows an optimistic send projects. Without this the picture
       * appeared here and nowhere else until the next launch, and Avatar draws
       * the generated mark whenever it has no image, so a picture that never
       * arrived looked exactly like a picture that was never set. Matches how
       * the display name has always been saved.
       */
      setIdentity(matrixProfileIdentity(profile))
      if (profile.avatarUrl) {
        const loaded = await matrixLoadProfileAvatar(profile.avatarUrl)
        setAvatarPreview(URL.createObjectURL(new Blob([loaded], { type: 'image/png' })))
      }
      setProfileSaved(true)
    } catch (error) {
      setProfileError(error)
    } finally {
      setAvatarBusy(false)
      if (avatarInputRef.current) avatarInputRef.current.value = ''
    }
  }

  const removeAvatar = async () => {
    setAvatarBusy(true)
    setProfileError(null)
    setProfileSaved(false)
    try {
      // Removing has the same reach as setting: without the store, the old
      // picture stayed on this account's own message rows until relaunch.
      setIdentity(matrixProfileIdentity(await matrixClearProfileAvatar()))
      setAvatarPreview(null)
      setProfileSaved(true)
    } catch (error) {
      setProfileError(error)
    } finally {
      setAvatarBusy(false)
    }
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
      setProfileValidation('Profile editing is unavailable in this version of Mesh.')
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
    <SettingsFrame
      embedded={embedded}
      open={open}
      onClose={onClose}
      title="User settings"
      size="xl"
      className="mesh-settings-dialog overflow-hidden"
      closeLabel="Close user settings"
    >
      <div className={`mesh-settings-layout grid min-h-0 ${embedded ? 'h-full grid-cols-1' : '-mx-5 -mb-5 sm:grid-cols-settings'}`}>
      {!embedded && (
      <div className="mesh-settings-navigation border-b border-border-subtle bg-surface-sunken px-3 py-3 sm:border-b-0 sm:border-r">
        <div className="block py-2 sm:hidden">
          <label htmlFor="user-settings-section" className="block text-xs font-medium text-secondary">
            Settings section
          </label>
          <select
            id="user-settings-section"
            value={activeTabIsPrimary ? activeTab : 'account'}
            onChange={(event) => activateTab(event.target.value as UserSettingsTab)}
            className="mt-1 block min-h-11 w-full rounded-control border border-border bg-surface-sunken px-3 text-sm text-primary"
          >
            {visibleSettingsTabs.map(([id, label]) => (
              <option key={id} value={id}>{label}</option>
            ))}
          </select>
        </div>
        <div className="hidden sm:flex sm:h-full sm:flex-col">
          <div className="mb-4 flex items-center gap-2.5 rounded-control border border-border-subtle bg-surface-raised px-2.5 py-2.5">
            <Avatar
              color={identity.avatarColor}
              size={32}
              name={identity.displayName}
              imageUrl={identity.avatarUrl}
            />
            <span className="min-w-0 truncate text-sm font-semibold text-primary">
              {identity.displayName}
            </span>
          </div>
          <Eyebrow className="mb-2 block px-shell-gutter">Settings</Eyebrow>
          <div
            role="tablist"
            aria-label="User settings"
            className="flex min-w-0 flex-col overflow-y-auto"
          >
          {visibleSettingsTabs.map(([id, label], position) => (
            <button
              key={id}
              ref={(element) => { tabRefs.current[id] = element ?? undefined }}
              id={`user-settings-tab-${id}`}
              type="button"
              role="tab"
              aria-selected={activeTab === id}
              aria-controls={`user-settings-panel-${id}`}
              /*
                The row number is positional decoration for the eye. Without an
                explicit name the tab announces as "01 Account", which is a
                position read out as if it were part of the label.
              */
              aria-label={label}
              tabIndex={activeTab === id ? 0 : -1}
              /*
                A numbered ledger, and the active tab is a flat plane rather
                than a tinted pill with a dot on the end. The dot is gone
                because aria-selected already carries the state and the plane
                already shows it.
              */
              className={`group relative flex min-h-10 flex-shrink-0 items-center gap-2 rounded-plane px-shell-gutter text-left text-row font-medium transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus ${
                activeTab === id
                  ? 'bg-accent text-content-on-accent'
                  : 'text-content-secondary hover:bg-surface-fill hover:text-content-primary'
              }`}
              onClick={() => activateTab(id)}
              onKeyDown={(event) => navigateTabs(event, id)}
            >
              <span
                aria-hidden="true"
                className={`w-row-index flex-none font-mono text-count font-semibold transition-colors duration-instant ${
                  activeTab === id
                    ? 'text-content-on-accent'
                    : 'text-content-secondary group-hover:text-content-primary'
                }`}
              >
                {rowNumber(position)}
              </span>
              <Icon name={settingsTabIcon(id)} size="xs" className="flex-none" />
              {label}
            </button>
          ))}
          </div>
        </div>
      </div>
      )}

      <div className={`mesh-settings-content min-w-0 px-5 ${embedded ? '' : 'pb-5'}`}>
      <div ref={settingsScrollRef} className={`${embedded ? 'h-full' : 'mesh-settings-scroll'} mx-auto w-full max-w-5xl overflow-y-auto py-5 pr-1`}>
        <div
          id={embedded ? undefined : `user-settings-panel-${activeTab}`}
          role={embedded ? undefined : 'tabpanel'}
          aria-labelledby={embedded ? undefined : `user-settings-tab-${activeTab}`}
          tabIndex={embedded ? undefined : 0}
        >
        {!embedded && !activeTabIsPrimary && (
          <Button
            variant="ghost"
            size="sm"
            className="mb-4"
            onClick={() => activateTab('account')}
          >
            Back to account
          </Button>
        )}
        {activeTab === 'profile' && (
        <section className="border-b border-border-subtle pb-5" aria-labelledby="profile-settings-heading">
          <h3 id="profile-settings-heading" className="text-md font-semibold text-content-primary">Profile</h3>
          {/*
            The name, and nothing under it. The mono slot here held the words
            "Mesh account", and the address that would have belonged in it is
            deliberately kept behind "Show account address" in the Account
            section, which also names the service openly.
          */}
          <p className="mt-3 min-w-0 truncate text-base font-semibold text-primary">
            {identity.displayName}
          </p>

          {matrixMode && (
            <div className="mt-4 space-y-3 border-t border-border pt-4">
              <p className="text-caption font-semibold lowercase tracking-eyebrow text-content-secondary">
                Profile picture
              </p>
              <div className="flex items-center gap-3">
                <Avatar
                  color={identity.avatarColor}
                  size={56}
                  name={identity.displayName}
                  imageUrl={avatarPreview ?? identity.avatarUrl}
                />
                <div className="flex flex-wrap gap-2">
                  <Button
                    type="button"
                    size="sm"
                    variant="secondary"
                    disabled={avatarBusy}
                    onClick={() => avatarInputRef.current?.click()}
                  >
                    {avatarBusy ? 'Working...' : 'Choose picture'}
                  </Button>
                  {(avatarPreview ?? identity.avatarUrl) ? (
                    <Button type="button" size="sm" variant="ghost" disabled={avatarBusy} onClick={() => void removeAvatar()}>
                      Remove
                    </Button>
                  ) : null}
                </div>
                <input
                  ref={avatarInputRef}
                  type="file"
                  accept="image/png,image/jpeg,image/webp"
                  className="sr-only"
                  aria-label="Choose a profile picture"
                  onChange={(event) => {
                    const file = event.target.files?.[0]
                    if (file) void chooseAvatar(file)
                  }}
                />
              </div>
              <p className="text-xs text-muted">
                PNG, JPEG or WebP. Up to 1 MB.
              </p>
            </div>
          )}

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
                  className="rounded-panel bg-container-danger px-3 py-2 text-xs text-status-danger"
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
            </form>
          )}
        </section>
        )}

        {activeTab === 'account' && (
          <section className="space-y-4 border-b border-border-subtle pb-5" aria-labelledby="account-settings-heading">
            <h3 id="account-settings-heading" className="text-md font-semibold text-content-primary">Account</h3>
            <div className="rounded-control border border-border-subtle bg-surface-sunken px-3 py-3">
              <SectionHeader title="Current account service" headingLevel={4} />
              <p className="mt-1 text-sm font-medium text-primary">
                {matrixMode
                  ? accountService?.displayName ?? 'Account service unavailable'
                  : 'This device'}
              </p>
              {matrixMode && accountService && accountService.displayName !== accountService.accountDomain && (
                <p className="mt-0.5 text-xs text-secondary">{accountService.accountDomain}</p>
              )}
              {matrixMode && (
                <>
                  <button
                    type="button"
                    className="mt-3 min-h-9 rounded-control px-2 text-sm font-semibold text-accent hover:bg-container-accent-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus"
                    aria-expanded={showAccountAddress}
                    onClick={() => setShowAccountAddress((shown) => !shown)}
                  >
                    {showAccountAddress ? 'Hide account address' : 'Show account address'}
                  </button>
                  {showAccountAddress && (
                    <p className="mt-2 break-all font-mono text-xs text-secondary">
                      {matrixAccountId}
                    </p>
                  )}
                </>
              )}
            </div>
            <div className="flex flex-wrap gap-2">
              {matrixMode && (
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={(event) => openSecurity(event.currentTarget)}
                >
                  Review recovery and sign-out
                </Button>
              )}
              <Button
                variant="ghost"
                size="sm"
                onClick={(event) => openSecurity(event.currentTarget)}
              >
                Use another service
              </Button>
            </div>
            <p className="text-xs text-muted">
              Switching accounts signs you out and ends any active call.
            </p>
            <SectionHeader title="More account settings" headingLevel={4} />
            <div className="sequence-card-group" aria-label="Account settings">
              <AccountSettingsLink
                title="Profile"
                onClick={() => activateTab('profile')}
                sequencePosition="first"
              />
              {matrixMode && (
                <AccountSettingsLink
                  title="Privacy"
                  onClick={() => activateTab('privacy')}
                  sequencePosition="middle"
                />
              )}
              {matrixMode && (
                <AccountSettingsLink
                  title="Safety and devices"
                  onClick={() => activateTab('devices')}
                  sequencePosition="middle"
                />
              )}
              <AccountSettingsLink
                title="Connection check"
                onClick={() => activateTab('advanced')}
                sequencePosition="last"
              />
            </div>
          </section>
        )}

        {activeTab === 'appearance' && (
        <section
          className="space-y-5"
          aria-labelledby="appearance-settings-heading"
        >
          <h3 id="appearance-settings-heading" className="text-md font-semibold text-content-primary">
            Appearance
          </h3>

          <div className="space-y-4">
            <SectionHeader title="Display" headingLevel={4} />
            <AppearanceSegmentedControl
              id="appearance-theme"
              label="Theme"
              value={appearance.theme}
              options={[
                ['system', 'Match Windows'],
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
            {/*
              Density moves spacing and leading but never type size, so it was
              never an answer for anyone who needs larger text. This control is,
              and it is the only one in the product: the window ships with zoom
              hotkeys disabled and every type step is a fixed pixel value.
            */}
            <AppearanceSegmentedControl
              id="appearance-text-size"
              label="Text size"
              value={String(appearance.textScale)}
              options={[
                ['100', 'Default'],
                ['110', 'Large'],
                ['125', 'Larger'],
                ['150', 'Largest'],
              ]}
              onChange={(value) => setAppearanceTextScale(Number(value) as AppearanceTextScale)}
            />

            <ToggleRow
              label="Reduce motion"
              description="Remove movement, fades, and looping effects."
              checked={appearance.reduceMotion}
              onChange={setReduceMotion}
            />
          </div>

          <fieldset>
            <legend className="font-mono text-eyebrow font-medium uppercase text-content-secondary">Accent color</legend>
            <div className="mt-2 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {ACCENT_CHOICES.map((choice) => {
                const selected = appearance.accent === choice.id
                return (
                  <label
                    key={choice.id}
                    /*
                      Selection is a double ring on the swatch, not a tinted
                      card with a checkmark bubble. The swatch is the thing
                      being chosen, so the selection sits on it.
                    */
                    className={`mesh-accent-option group flex min-h-16 cursor-pointer items-center gap-3 rounded-plane px-3 py-2.5 transition-colors ${APPEARANCE_FOCUS_RING} has-[input:focus-visible]:-outline-offset-2 ${
                      selected ? '' : 'hover:bg-surface-fill'
                    }`}
                    data-selected={selected ? 'true' : undefined}
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
                      className="mesh-accent-choice flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-tile"
                      data-accent-preview={choice.id}
                      aria-hidden="true"
                    >
                      <PixelMark variant="community" className="h-9 w-9" />
                    </span>
                    <span className="min-w-0">
                      <span className="block text-row font-medium text-content-primary">{choice.label}</span>
                      <span className="mt-0.5 block font-mono text-eyebrow uppercase text-content-secondary">
                        {choice.lineage}
                      </span>
                    </span>
                  </label>
                )
              })}
            </div>
            <p className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-caption text-content-secondary">
              <StateTick state="ok" label="Unchanged" />
              Status colors stay consistent. Connected, warning, and destructive actions do not change with your accent.
            </p>
          </fieldset>

          {/*
            Appearance's one ambient line. Everything on this screen is stored
            on the device rather than on the account, and that is worth saying
            once at the bottom rather than beside each control.
          */}
          <AmbientNote className="-mx-shell-gutter mt-2">
            Appearance is stored on this device only
          </AmbientNote>

          <div className="space-y-2 border-t border-rule border-border-structural pt-4">
            <SectionHeader title="Sidebar" headingLevel={4} />
            <p className="text-xs text-muted">
              Room order, pins, and hidden rooms are saved on this device only.
            </p>
            <button
              type="button"
              className="min-h-9 rounded-control px-2 text-sm font-medium text-accent hover:bg-container-accent-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus"
              onClick={() => {
                if (!confirmingRoomOrganizationReset) {
                  setConfirmingRoomOrganizationReset(true)
                  return
                }
                restoreRoomOrganizationDefaults()
                setConfirmingRoomOrganizationReset(false)
              }}
              onBlur={() => setConfirmingRoomOrganizationReset(false)}
            >
              {confirmingRoomOrganizationReset
                ? 'Click again to restore server order everywhere'
                : 'Restore default room order'}
            </button>
            {/*
              The only way back to a hidden settling in list. It reads as a
              toggle rather than a "show again" button because the off state is
              a real preference: somebody who hid it does not want it back on
              the next device that syncs nothing.

              Disabled once every step is done, because the list has nothing left
              to show and turning it on could not produce one. A live control
              wired to nothing is the same defect as a wire field carrying a
              value the backend cannot send, and the anatomy contract already
              says what to do instead: suppress activation, keep enough contrast
              to explain the control.
            */}
            <div className="pt-1">
              <ToggleRow
                label="Settling in list"
                description={checklistFinished
                  ? 'Every first step is done.'
                  : "Show first steps above a community's rooms."}
                checked={!checklistDismissed}
                disabled={checklistFinished}
                onChange={(enabled) => {
                  if (enabled) showChecklist()
                  else dismissChecklist()
                }}
              />
            </div>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border-subtle pt-4">
            <button
              type="button"
              className="min-h-9 rounded-control px-2 text-sm font-medium text-accent hover:bg-container-accent-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus"
              onClick={() => {
                setAppearanceTheme('dark')
                setAppearanceDensity('default')
                setAppearanceTextScale(100)
                setAppearanceAccent('ember')

                setReduceMotion(false)
              }}
            >
              Reset display choices
            </button>
            <div className="ml-auto flex items-center gap-3">
              <span className="flex items-center gap-2 text-caption text-muted">
                <span className="h-2 w-2 rounded-round bg-status-success" aria-hidden="true" />
                Saved on this device
              </span>
              {!embedded && <Button variant="primary" onClick={onClose}>Done</Button>}
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
              <h3 id="privacy-center-heading" className="text-md font-semibold text-content-primary">
                Privacy center
              </h3>
              <p className="mt-1 text-xs text-muted">
                Mesh protects message and file contents before they leave your device.
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
                  <p className="mb-2 rounded-control bg-surface-hover px-3 py-2 text-xs text-muted">
                    Mesh could not confirm them on your account, so other devices may still use the
                    previous settings.
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

            <SectionHeader title="What your service can see" headingLevel={4} id="service-visibility-heading" />
            <div
              className="overflow-x-auto rounded-control border border-border-subtle"
              role="region"
              aria-labelledby="service-visibility-heading"
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

            <SectionHeader title="Privacy controls" headingLevel={4} />
            <div className="sequence-card-group" aria-label="Privacy controls">
              <SelectRow
                id="read-receipts"
                label="Read receipts"
                description="Whether people in a conversation see when you have read their messages."
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
                description="Lets people in the conversation see you composing."
                checked={privacy.sendTypingIndicators}
                onChange={setSendTypingIndicators}
                sequencePosition="middle"
              />
              <ToggleRow
                label="Share my online status"
                description="Your service still sees connection times when this is off."
                checked={privacy.sharePresence}
                onChange={setSharePresence}
                sequencePosition="middle"
              />
              <ToggleRow
                label="Invisible mode"
                description="Appear offline without disconnecting."
                checked={privacy.invisibleMode}
                onChange={setInvisibleMode}
                sequencePosition="last"
              />
            </div>

            {activeConversationId && (
              <div className="space-y-3 rounded-control border border-border-subtle bg-surface-sunken p-3">
                <div>
                  <h4 className="text-sm font-semibold text-content-primary">
                    This conversation
                    {activeConversationName ? `: ${activeConversationName}` : ''}
                  </h4>
                  <p className="mt-1 text-xs text-muted">
                    Overrides the controls above for this conversation only.
                  </p>
                </div>
                <div
                  className="sequence-card-group"
                  aria-label="Current conversation privacy controls"
                >
                  <SelectRow
                    id="conversation-read-receipts"
                    label="Read receipts for this conversation"
                    description="Receipts Mesh sends and shows in this conversation."
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
                    description="Typing status Mesh sends in this conversation."
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
                <p className="text-xs text-muted">
                  Other compatible apps may publish or display activity differently.
                </p>
              </div>
            )}

            {/*
              The table above already states what the service can and cannot
              see, so this block kept only the one fact the table does not
              carry: both services still observe operational detail.
            */}
            <p className="rounded-control bg-surface-hover px-3 py-3 text-xs text-muted">
              Both services can still see internet addresses, devices, membership, and timing.
            </p>
          </section>
        )}

        {matrixMode && activeTab === 'privacy' && (
          <section
            className="space-y-4 border-b border-border-subtle pb-5"
            aria-label="Mesh commitments"
          >
            <GovernedCommitmentsPanel />
          </section>
        )}

        {activeTab === 'notifications' && (
        <section
          className="space-y-3 border-b border-border-subtle pb-5"
          aria-labelledby="notification-settings-heading"
        >
          <h3 id="notification-settings-heading" className="text-md font-semibold text-content-primary">
            Notifications
          </h3>

          <ToggleRow
            label="Desktop notifications"
            description="Show alerts for new messages outside the active conversation."
            checked={notifications.enabled}
            onChange={setNotificationsEnabled}
          />
          <ToggleRow
            label="Interface sounds"
            description="Play short sounds for calls and notifications."
            checked={notifications.sound}
            onChange={setNotificationSound}
          />
          <label
            htmlFor="interface-sound-volume"
            className={`block rounded-control bg-surface-hover px-3 py-3 text-xs font-medium text-muted ${
              notifications.sound ? '' : 'opacity-50'
            }`}
          >
            <span className="flex items-center justify-between gap-3">
              <span>Sound volume</span>
              <span className="font-mono text-primary">{Math.round(notifications.soundVolume * 100)}%</span>
            </span>
            <input
              id="interface-sound-volume"
              type="range"
              min="0"
              max="100"
              step="1"
              value={Math.round(notifications.soundVolume * 100)}
              disabled={!notifications.sound}
              onChange={(event) => setInterfaceSoundVolume(Number(event.target.value) / 100)}
              className="mt-2 block w-full accent-accent"
            />
          </label>
          <SectionHeader title="Interface sound events" headingLevel={4} />
          <div className="sequence-card-group" aria-label="Interface sound events">
            {INTERFACE_SOUND_SETTINGS.map((setting, index) => (
              <SoundEventRow
                key={setting.id}
                sound={setting.id}
                label={setting.label}
                description={setting.description}
                previewLabel={setting.previewLabel}
                checked={notifications.soundEvents[setting.id]}
                volume={notifications.soundVolume}
                sequencePosition={
                  index === 0
                    ? 'first'
                    : index === INTERFACE_SOUND_SETTINGS.length - 1
                      ? 'last'
                      : 'middle'
                }
                onChange={(enabled) => setInterfaceSoundEnabled(setting.id, enabled)}
              />
            ))}
          </div>
          <ToggleRow
            label="Show message text"
            description="Text may appear on lock screens, mirrored displays, and notification history."
            checked={notifications.showMessageContent}
            disabled={!notifications.enabled}
            onChange={setShowMessageContent}
          />
          <ToggleRow
            label="Do not disturb"
            description="Pause notifications, sounds, unread badges, and taskbar alerts until turned off."
            checked={notifications.doNotDisturb}
            disabled={!notifications.enabled}
            onChange={setDoNotDisturb}
          />
          <ToggleRow
            label="Quiet hours"
            description="Pause notifications during a daily local-time window."
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
                Mesh could not send the test notification. Try again.
              </span>
            )}
          </div>
          {(testNotificationStatus === 'blocked' || osNotificationsDenied) && (
            <Notice
              role="alert"
              tone="warning"
              action={(
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setTestNotificationStatus(null)
                    setOsNotificationsDenied(false)
                  }}
                >
                  Dismiss
                </Button>
              )}
            >
              Windows is blocking notifications for Mesh. Allow them in Windows Settings, under
              System and then Notifications.
            </Notice>
          )}

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

        {matrixMode && activeTab === 'devices' && (!embedded || !showEmbeddedSecurity) && (
          <section className="border-b border-border-subtle pb-5" aria-labelledby="devices-settings-heading">
            <div className="flex items-center gap-2">
              <h3 id="devices-settings-heading" className="text-md font-semibold text-content-primary">Your devices</h3>
              {backupReminderDue && (
                <span
                  className="h-2 w-2 rounded-round bg-status-warning"
                  aria-label="Message backup needs attention"
                />
              )}
            </div>
            {backupReminderDue && (
              <p className="mt-1 text-xs text-status-warning">
                Message backup needs attention.
              </p>
            )}
            <Button
              className="mt-3"
              variant="secondary"
              size="sm"
              onClick={(event) => openSecurity(event.currentTarget)}
            >
              Open your devices
            </Button>
          </section>
        )}

        {embedded
          && matrixMode
          && showEmbeddedSecurity
          && (activeTab === 'account' || activeTab === 'devices') && (
            <Suspense
              fallback={(
                <p role="status" className="rounded-control bg-surface-hover px-3 py-2 text-xs text-muted">
                  Opening safety and devices…
                </p>
              )}
            >
              <SecurityDevicesPanel
                embedded
                open
                onClose={closeEmbeddedSecurity}
              />
            </Suspense>
        )}

        {activeTab === 'audio-video' && (
          <section
            className="border-b border-border-subtle pb-5"
            aria-labelledby="call-privacy-heading"
          >
            <h3 id="call-privacy-heading" className="text-md font-semibold text-content-primary">
              Audio and video
            </h3>
            <p className="mt-1 text-xs text-muted">
              Choose your microphone, speakers, and camera from Voice settings after you join a call.
            </p>
            <div className="mt-3 rounded-control bg-surface-hover px-3 py-3 text-xs text-muted">
              <h4 className="text-sm font-semibold text-content-primary">Call privacy</h4>
              <p className="mt-1">
                The service can see who connects, internet addresses, call timing, and traffic
                volume. If private call protection is not verified, your microphone, camera, and
                incoming media stay off.
              </p>
            </div>
          </section>
        )}

        {activeTab === 'beta' && (
          <BetaInfoPanel onOpenFeedback={onOpenFeedback} callingAvailable={voiceRoutesEnabled} />
        )}

        {activeTab === 'advanced' && (
          <section
            className="mesh-advanced-settings border-y border-border-subtle p-4"
            aria-labelledby="advanced-settings-heading"
          >
            <h3 id="advanced-settings-heading" className="text-md font-semibold text-content-primary">
              Advanced
            </h3>
            <SectionHeader className="mt-4" title="Optional support controls" headingLevel={4} />
            <div className="sequence-card-group" aria-label="Optional support controls">
              <ToggleRow
                label="Show connection check"
                description="Allow redacted connection checks and reviewed support files on this device."
                checked={signalCheckEnabled}
                sequencePosition="first"
                onChange={(enabled) => {
                  setSignalCheckEnabled(enabled)
                  if (!enabled) setShowEmbeddedDiagnostics(false)
                }}
              />
              <ToggleRow
                label="Record app errors"
                description="Keeps up to 20 redacted error records on this device, never message text or account details."
                checked={runtimeErrorReportingEnabled}
                sequencePosition="last"
                onChange={(enabled) => {
                  setRuntimeErrorReportingEnabled(enabled)
                  if (!enabled) setRuntimeErrorRecordCount(0)
                }}
              />
            </div>
            <div className="mesh-advanced-actions mt-3 flex flex-wrap gap-2">
              {signalCheckEnabled && (embedded || onOpenDiagnostics) && (
                <Button
                  ref={diagnosticsTriggerRef}
                  variant="secondary"
                  size="sm"
                  onClick={embedded
                    ? () => setShowEmbeddedDiagnostics((shown) => !shown)
                    : onOpenDiagnostics}
                  aria-expanded={embedded ? showEmbeddedDiagnostics : undefined}
                >
                  Review connection check
                </Button>
              )}
              {runtimeErrorReportingEnabled && runtimeErrorRecordCount > 0 && (
                <>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => saveRuntimeErrorReport()}
                  >
                    Save app error report
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      clearRuntimeErrorRecords()
                      setRuntimeErrorRecordCount(0)
                    }}
                  >
                    Clear app error records
                  </Button>
                </>
              )}
            </div>
            {/*
              The section intro used to repeat this. One statement of the
              redaction rule is the disclosure; two was a lecture.
            */}
            <p className="mesh-advanced-privacy mt-4 border-t border-border-subtle pt-3 text-xs text-muted">
              A check never shows account details, message content, or private local information,
              and never uploads a support file on its own.
            </p>
            {embedded && signalCheckEnabled && showEmbeddedDiagnostics && (
              <Suspense
                fallback={(
                  <p role="status" className="mesh-advanced-loading mt-4 px-3 py-2 text-xs text-muted">
                    Opening connection check...
                  </p>
                )}
              >
                <DiagnosticsPanel
                  embedded
                  open
                  onClose={() => {
                    setShowEmbeddedDiagnostics(false)
                    window.requestAnimationFrame(() => diagnosticsTriggerRef.current?.focus())
                  }}
                  backendKind={matrixMode ? 'matrix' : 'legacy-p2p'}
                />
              </Suspense>
            )}
            <p className="mesh-advanced-version mt-3 text-caption text-muted">Mesh {MESH_APP_VERSION}</p>
          </section>
        )}
        </div>
        {!embedded && visibleSettingsTabs
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
      </div>
      </div>
    </SettingsFrame>
  )
}

function SettingsFrame({
  embedded,
  children,
  ...modalProps
}: React.ComponentProps<typeof Modal> & { embedded: boolean; children: ReactNode }) {
  if (embedded) {
    return (
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        {/*
          The dialog supplies this title as an h2. Embedded mode dropped it, so
          the panel's h3 sections followed the route's own h1 with nothing
          between them and skipped a level. Visually hidden because the route
          already shows the name; the outline needs it, the screen does not.
        */}
        <h2 className="sr-only">{modalProps.title}</h2>
        {children}
      </div>
    )
  }
  return <Modal {...modalProps}>{children}</Modal>
}

/*
  A settings list row is a label. Every row here used to carry a sentence
  underneath restating what the destination is, which is the one thing a person
  finds out by opening it.
*/
function AccountSettingsLink({
  title,
  onClick,
  sequencePosition,
}: {
  title: string
  onClick: () => void
  sequencePosition: SequenceCardPosition
}) {
  const sequence = sequenceCardProps(sequencePosition)
  return (
    <button
      type="button"
      data-sequence-position={sequence['data-sequence-position']}
      className={`${sequence.className} flex min-h-11 w-full items-center justify-between gap-4 px-3 py-2.5 text-left transition-colors hover:bg-surface-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus`}
      onClick={onClick}
    >
      <span className="min-w-0 truncate text-sm font-medium text-primary">{title}</span>
      <Icon name="chevronDown" size="sm" className="shrink-0 -rotate-90 text-muted" aria-hidden="true" />
    </button>
  )
}

function settingsTabIcon(tab: UserSettingsTab): IconName {
  if (tab === 'profile') return 'users'
  if (tab === 'account') return 'users'
  if (tab === 'appearance') return 'image'
  if (tab === 'notifications') return 'activity'
  if (tab === 'audio-video') return 'volume'
  if (tab === 'privacy') return 'shieldCheck'
  if (tab === 'beta') return 'messageCircle'
  if (tab === 'advanced') return 'settings'
  return 'settings'
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
      <legend className="text-row font-medium text-content-primary">{label}</legend>
      {/*
        The group carries a 7px outer radius and the selection keeps square
        inner corners. That is the radius rule in miniature: the group is a
        control you touch, the selection inside it is a structural mark.
      */}
      <div
        id={id}
        className="mt-2 grid overflow-hidden rounded-segment border border-rule border-border-control"
        style={{ gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))` }}
      >
        {options.map(([optionValue, optionLabel]) => (
          <label
            key={optionValue}
            className={`relative flex min-h-9 cursor-pointer items-center justify-center rounded-plane border-l border-rule border-border-structural px-3 text-center text-row font-medium first:border-l-0 ${APPEARANCE_FOCUS_RING} has-[input:focus-visible]:-outline-offset-2 ${
              value === optionValue
                ? 'bg-accent text-content-on-accent'
                : 'text-content-secondary hover:bg-surface-fill hover:text-content-primary'
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

function SoundEventRow({
  sound,
  label,
  description,
  previewLabel,
  checked,
  volume,
  sequencePosition,
  onChange,
}: {
  sound: InterfaceSoundId
  label: string
  description: string
  previewLabel: string
  checked: boolean
  volume: number
  sequencePosition: SequenceCardPosition
  onChange: (checked: boolean) => void
}) {
  const sequence = sequenceCardProps(sequencePosition)
  return (
    <div
      data-sequence-position={sequence['data-sequence-position']}
      className={`${sequence.className} flex items-start justify-between gap-4 px-3 py-3`}
    >
      <div className="min-w-0">
        <p className="text-sm font-medium text-primary">{label}</p>
        <p className="mt-0.5 text-xs text-muted">{description}</p>
        <button
          type="button"
          className="mt-2 min-h-8 rounded-control px-2 text-xs font-semibold text-accent hover:bg-container-accent-hover"
          aria-label={previewLabel}
          onClick={() => void playInterfaceSound(sound, { preview: true, masterVolume: volume })}
        >
          Preview
        </button>
      </div>
      <label className="flex min-h-8 flex-shrink-0 cursor-pointer items-center gap-2 text-xs text-muted">
        <span className="sr-only">{label}</span>
        <input
          type="checkbox"
          className="h-4 w-4 accent-accent"
          checked={checked}
          onChange={(event) => onChange(event.target.checked)}
        />
      </label>
    </div>
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
        <span className="mt-0.5 block text-xs text-muted">{description}</span>
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
      className={`${sequence?.className ?? 'rounded-control bg-surface-hover'} flex flex-col items-stretch gap-3 px-3 py-3 sm:flex-row sm:items-start sm:justify-between sm:gap-4`}
    >
      <span className="min-w-0">
        <label htmlFor={id} className="block text-sm font-medium text-primary">
          {label}
        </label>
        <span id={`${id}-description`} className="mt-0.5 block text-xs text-muted">
          {description}
        </span>
      </span>
      <select
        id={id}
        aria-describedby={`${id}-description`}
        className="min-h-control-sm w-full min-w-0 rounded-control border border-border bg-surface-sunken px-2 text-xs text-primary outline-none focus:border-accent sm:w-auto sm:max-w-xs"
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
