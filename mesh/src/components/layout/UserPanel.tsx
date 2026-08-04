import { lazy, Suspense, useRef, type MouseEvent } from 'react'
import { useIdentityStore } from '../../store/identity'
import { Avatar } from '../ui/Avatar'
import { matrixProfileIdentity, resolveSenderIdentity } from '../../lib/matrixIdentity'
import * as bridge from '../../lib/bridge'
import { DialogErrorBoundary } from '../ui/ScopedErrorBoundary'
import { Icon } from '../ui/Icon'
import { useShellStore } from '../../store/shell'
import { setNextModalRestoreFocusTarget } from '../ui/Modal'
import { useChannelStore } from '../../store/channels'
import { useDmStore } from '../../store/dms'
import { isBackupReminderDue, useSettingsStore } from '../../store/settings'
import { playInterfaceSound } from '../../lib/interface-sounds'
import { ModalLoadingFallback } from '../ui/ModalLoadingFallback'
import { useVoiceStore } from '../../store/voice'
import { IconButton } from '../ui/IconButton'

const DiagnosticsPanel = lazy(() =>
  import('../settings/DiagnosticsPanel').then((module) => ({
    default: module.DiagnosticsPanel,
  })),
)
const UserSettingsPanel = lazy(() =>
  import('../settings/UserSettingsPanel').then((module) => ({
    default: module.UserSettingsPanel,
  })),
)
const SecurityDevicesPanel = lazy(() =>
  import('../settings/SecurityDevicesPanel').then((module) => ({
    default: module.SecurityDevicesPanel,
  })),
)
export function UserPanel({ controls = true }: { controls?: boolean } = {}) {
  const storedIdentity = useIdentityStore((state) => state.identity)
  const setIdentity = useIdentityStore((state) => state.setIdentity)
  const matrixMode = bridge.isMatrixBackend()
  const matrixAccountId = matrixMode ? bridge.getMatrixUserId() : null
  const identity = resolveSenderIdentity(storedIdentity, matrixAccountId)
  const showSettings = useShellStore((state) => state.profileOpen)
  const setShowSettings = useShellStore((state) => state.setProfileOpen)
  const showSecurity = useShellStore((state) => state.securityOpen)
  const setShowSecurity = useShellStore((state) => state.setSecurityOpen)
  const showDiagnostics = useShellStore((state) => state.diagnosticsOpen)
  const setShowDiagnostics = useShellStore((state) => state.setDiagnosticsOpen)
  const activeChannelId = useChannelStore((state) => state.activeChannelId)
  const activeChannelName = useChannelStore((state) =>
    state.activeChannelId ? state.channelEntities[state.activeChannelId]?.name : undefined,
  )
  const isDmMode = useDmStore((state) => state.isDmMode)
  const activeConversationId = useDmStore((state) => state.activeConversationId)
  const activeConversationName = useDmStore((state) =>
    state.activeConversationId
      ? state.conversationEntities[state.activeConversationId]?.peerDisplayName
      : undefined,
  )
  const activePrivacyRoomId = isDmMode ? activeConversationId : activeChannelId
  const activePrivacyRoomName = isDmMode ? activeConversationName : activeChannelName
  const backupReminderDue = useSettingsStore((state) => isBackupReminderDue(state.backup))
  const currentVoiceChannelId = useVoiceStore((state) => state.currentChannelId)
  const isMuted = useVoiceStore((state) => state.isMuted)
  const isDeafened = useVoiceStore((state) => state.isDeafened)
  const setMuted = useVoiceStore((state) => state.setMuted)
  const setDeafened = useVoiceStore((state) => state.setDeafened)
  const settingsTriggerRef = useRef<HTMLButtonElement | null>(null)

  const openSettings = (event: MouseEvent<HTMLButtonElement>) => {
    settingsTriggerRef.current = event.currentTarget
    setShowSettings(true)
  }

  const closeSettings = () => {
    setShowSettings(false)
    window.setTimeout(() => {
      const fallback = document.querySelector<HTMLButtonElement>(
        'button[aria-label="You and settings"]',
      )
      ;(settingsTriggerRef.current ?? fallback)?.focus()
    }, 0)
  }

  const openSecurity = () => {
    setNextModalRestoreFocusTarget(settingsTriggerRef.current)
    setShowSettings(false)
    setShowSecurity(true)
  }

  const openDiagnostics = () => {
    setShowDiagnostics(true)
  }

  return (
    <>
      {controls && <div className="mesh-user-panel flex h-user-panel flex-shrink-0 items-center gap-1 bg-surface-sunken px-2">
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-2 rounded-control px-1 py-1 text-left transition-colors hover:bg-surface-hover"
          onClick={openSettings}
          aria-label={`User settings for ${identity.displayName}`}
        >
          <Avatar
            color={identity.avatarColor}
            size={32}
            name={identity.displayName}
            imageUrl={identity.avatarUrl}
          />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-medium leading-tight text-primary">
              {identity.displayName}
            </span>
            <span className="block truncate text-meta leading-tight text-muted">
              {matrixAccountId ? 'Mesh account' : 'Local identity'}
            </span>
          </span>
        </button>
        <div className="flex flex-shrink-0 items-center" role="toolbar" aria-label="Voice and account controls">
          <IconButton
            size="sm"
            disabled={!currentVoiceChannelId}
            aria-label={isMuted ? 'Unmute microphone' : 'Mute microphone'}
            aria-pressed={isMuted}
            onClick={() => setMuted(!isMuted)}
          >
            <Icon name={isMuted ? 'micOff' : 'mic'} size="sm" />
          </IconButton>
          <IconButton
            size="sm"
            disabled={!currentVoiceChannelId}
            aria-label={isDeafened ? 'Restore call audio' : 'Mute call audio'}
            aria-pressed={isDeafened}
            onClick={() => setDeafened(!isDeafened)}
          >
            <Icon name={isDeafened ? 'headphoneOff' : 'headphones'} size="sm" />
          </IconButton>
          <IconButton
            ref={settingsTriggerRef}
            size="sm"
            aria-label={`Open settings for ${identity.displayName}`}
            onClick={openSettings}
          >
            <Icon name="settings" size="sm" />
          </IconButton>
        </div>
      </div>}

      <DialogErrorBoundary open={showSettings} onClose={closeSettings} title="User Settings">
        {showSettings && (
          <Suspense
            fallback={<ModalLoadingFallback title="User Settings" label="Loading settings" />}
          >
            <UserSettingsPanel
              open
              onClose={closeSettings}
              identity={identity}
              matrixAccountId={matrixAccountId}
              matrixMode={matrixMode}
              activeConversationId={activePrivacyRoomId}
              activeConversationName={activePrivacyRoomName ?? null}
              onUpdateDisplayName={async (displayName) => {
                const profile = await bridge.matrixUpdateProfileDisplayName(displayName)
                setIdentity(matrixProfileIdentity(profile))
              }}
              onOpenSecurity={openSecurity}
              backupReminderDue={backupReminderDue}
              onOpenDiagnostics={openDiagnostics}
              onTestNotification={async () => {
                await bridge.sendTestNotification()
                await playInterfaceSound('message-direct', { preview: true })
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
          <Suspense
            fallback={
              <ModalLoadingFallback title="Security & Devices" label="Loading security settings" />
            }
          >
            <SecurityDevicesPanel open onClose={() => setShowSecurity(false)} />
          </Suspense>
        )}
      </DialogErrorBoundary>
      <DialogErrorBoundary
        open={showDiagnostics}
        onClose={() => setShowDiagnostics(false)}
        title="Signal Check"
      >
        {showDiagnostics && (
          <Suspense
            fallback={
              <ModalLoadingFallback title="Signal Check" label="Opening Signal Check" />
            }
          >
            <DiagnosticsPanel
              open
              onClose={() => setShowDiagnostics(false)}
              backendKind={matrixMode ? 'matrix' : 'legacy-p2p'}
            />
          </Suspense>
        )}
      </DialogErrorBoundary>
    </>
  )
}
