import { lazy, Suspense, useRef, useState, type MouseEvent } from 'react'
import { useIdentityStore } from '../../store/identity'
import { Avatar } from '../ui/Avatar'
import { matrixProfileIdentity, resolveSenderIdentity } from '../../lib/matrixIdentity'
import * as bridge from '../../lib/bridge'
import { DialogErrorBoundary } from '../ui/ScopedErrorBoundary'
import { Icon } from '../ui/Icon'
import { useShellStore } from '../../store/shell'
import { Modal, setNextModalRestoreFocusTarget } from '../ui/Modal'
import { useActiveCommunity } from '../../store/communities'
import { useChannelStore } from '../../store/channels'
import { isBackupReminderDue, useSettingsStore } from '../../store/settings'
import { Spinner } from '../ui/Spinner'
import { ModalLoadingFallback } from '../ui/ModalLoadingFallback'

const DiagnosticsPanel = lazy(() =>
  import('../settings/DiagnosticsPanel').then((module) => ({ default: module.DiagnosticsPanel })),
)
const UserSettingsPanel = lazy(() =>
  import('../settings/UserSettingsPanel').then((module) => ({ default: module.UserSettingsPanel })),
)
const SecurityDevicesPanel = lazy(() =>
  import('../settings/SecurityDevicesPanel').then((module) => ({ default: module.SecurityDevicesPanel })),
)
const LegacyMigrationPanel = lazy(() =>
  import('../community/LegacyMigrationPanel').then((module) => ({ default: module.LegacyMigrationPanel })),
)

export function UserPanel() {
  const storedIdentity = useIdentityStore((state) => state.identity)
  const setIdentity = useIdentityStore((state) => state.setIdentity)
  const matrixMode = bridge.isMatrixBackend()
  const matrixAccountId = matrixMode ? bridge.getMatrixUserId() : null
  const identity = resolveSenderIdentity(storedIdentity, matrixAccountId)
  const showSettings = useShellStore((state) => state.profileOpen)
  const setShowSettings = useShellStore((state) => state.setProfileOpen)
  const showSecurity = useShellStore((state) => state.securityOpen)
  const setShowSecurity = useShellStore((state) => state.setSecurityOpen)
  const [showDiagnostics, setShowDiagnostics] = useState(false)
  const [showImport, setShowImport] = useState(false)
  const activeCommunity = useActiveCommunity()
  const channels = useChannelStore((state) => state.channels)
  const backupReminderDue = useSettingsStore((state) => isBackupReminderDue(state.backup))
  const settingsTriggerRef = useRef<HTMLButtonElement | null>(null)

  const openSettings = (event: MouseEvent<HTMLButtonElement>) => {
    settingsTriggerRef.current = event.currentTarget
    setShowSettings(true)
  }

  const closeSettings = () => {
    setShowSettings(false)
    window.setTimeout(() => settingsTriggerRef.current?.focus(), 0)
  }

  const openSecurity = () => {
    setNextModalRestoreFocusTarget(settingsTriggerRef.current)
    setShowSettings(false)
    setShowSecurity(true)
  }

  const openDiagnostics = () => {
    setShowDiagnostics(true)
  }

  const openImport = () => {
    setShowSettings(false)
    setShowImport(true)
  }

  return (
    <>
      <div className="flex h-user-panel flex-shrink-0 items-center gap-2 bg-surface-sunken px-2">
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-2 rounded-control px-1 py-1 text-left transition-colors hover:bg-surface-hover"
          onClick={openSettings}
          aria-label={`User settings for ${identity.displayName}`}
        >
          <Avatar color={identity.avatarColor} size={32} name={identity.displayName} />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-medium leading-tight text-primary">
              {identity.displayName}
            </span>
            <span className="block truncate text-meta leading-tight text-muted">
              {matrixAccountId ? 'Mesh account' : 'Local identity'}
            </span>
          </span>
          <Icon name="settings" size="sm" className="flex-shrink-0 text-muted" />
        </button>
      </div>

      <DialogErrorBoundary
        open={showSettings}
        onClose={closeSettings}
        title="User Settings"
      >
        {showSettings && (
          <Suspense fallback={<ModalLoadingFallback title="User Settings" label="Loading settings" />}>
            <UserSettingsPanel
              open
              onClose={closeSettings}
              identity={identity}
              matrixAccountId={matrixAccountId}
              matrixMode={matrixMode}
              onUpdateDisplayName={async (displayName) => {
                const profile = await bridge.matrixUpdateProfileDisplayName(displayName)
                setIdentity(matrixProfileIdentity(profile))
              }}
              onOpenSecurity={openSecurity}
              backupReminderDue={backupReminderDue}
              onOpenDiagnostics={openDiagnostics}
              onOpenImport={openImport}
              onTestNotification={async () => {
                await bridge.sendTestNotification()
                const notifications = useSettingsStore.getState().notifications
                if (notifications.sound) {
                  bridge.playNotificationSound(notifications.soundId)
                }
              }}
            />
          </Suspense>
        )}
      </DialogErrorBoundary>
      <DialogErrorBoundary
        open={showSecurity}
        onClose={() => setShowSecurity(false)}
        title="Security & Devices"
      >
        {showSecurity && (
          <Suspense fallback={<ModalLoadingFallback title="Security & Devices" label="Loading security settings" />}>
            <SecurityDevicesPanel open onClose={() => setShowSecurity(false)} />
          </Suspense>
        )}
      </DialogErrorBoundary>
      <DialogErrorBoundary
        open={showDiagnostics}
        onClose={() => setShowDiagnostics(false)}
        title="System diagnostics"
      >
        {showDiagnostics && (
          <Suspense fallback={<ModalLoadingFallback title="System diagnostics" label="Loading diagnostics" />}>
            <DiagnosticsPanel
              open
              onClose={() => setShowDiagnostics(false)}
              backendKind={matrixMode ? 'matrix' : 'legacy-p2p'}
            />
          </Suspense>
        )}
      </DialogErrorBoundary>
      <DialogErrorBoundary
        open={showImport}
        onClose={() => setShowImport(false)}
        title="Import older Mesh data"
      >
        {showImport && (
          <Modal open onClose={() => setShowImport(false)} title="Import older Mesh data">
            <Suspense fallback={<div role="status" aria-label="Loading import tools" className="flex min-h-32 flex-col items-center justify-center gap-3 text-sm text-content-muted"><Spinner /><span>Loading import tools…</span></div>}>
              {activeCommunity ? (
                <LegacyMigrationPanel
                  communityId={activeCommunity.id}
                  channels={channels}
                  canManage={activeCommunity.role === 'owner' || activeCommunity.role === 'admin'}
                />
              ) : (
                <p className="text-sm text-content-secondary">
                  Choose a server before importing older Mesh data.
                </p>
              )}
            </Suspense>
          </Modal>
        )}
      </DialogErrorBoundary>
    </>
  )
}
