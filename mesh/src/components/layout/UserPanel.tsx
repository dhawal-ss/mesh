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
import { dmPrimaryPeerName } from '../../types/ipc'
import { isBackupReminderDue, useSettingsStore } from '../../store/settings'
import { playInterfaceSound } from '../../lib/interface-sounds'
import { ModalLoadingFallback } from '../ui/ModalLoadingFallback'
import { useVoiceStore } from '../../store/voice'
import { IconButton } from '../ui/IconButton'
import { detectFeedbackPlatform } from '../../lib/beta-release'
import { shouldExposeVoiceRoutes } from '../../lib/voice-runtime'

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
const BetaFeedbackDialog = lazy(() =>
  import('../settings/BetaCenter').then((module) => ({
    default: module.BetaFeedbackDialog,
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
  const showFeedback = useShellStore((state) => state.feedbackOpen)
  const setShowFeedback = useShellStore((state) => state.setFeedbackOpen)
  const activeChannelId = useChannelStore((state) => state.activeChannelId)
  const activeChannelName = useChannelStore((state) =>
    state.activeChannelId ? state.channelEntities[state.activeChannelId]?.name : undefined,
  )
  const isDmMode = useDmStore((state) => state.isDmMode)
  const activeConversationId = useDmStore((state) => state.activeConversationId)
  const activeConversationName = useDmStore((state) =>
    state.activeConversationId
      ? dmPrimaryPeerName(state.conversationEntities[state.activeConversationId])
      : undefined,
  )
  const activePrivacyRoomId = isDmMode ? activeConversationId : activeChannelId
  const activePrivacyRoomName = isDmMode ? activeConversationName : activeChannelName
  const backupReminderDue = useSettingsStore((state) => isBackupReminderDue(state.backup))
  const currentVoiceChannelId = useVoiceStore((state) => state.currentChannelId)
  const voiceRoutesEnabled = shouldExposeVoiceRoutes(matrixMode, bridge.getBackendStatusSnapshot())
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
      {controls && <div className="mesh-user-panel flex h-user-panel flex-shrink-0 items-center gap-1 bg-surface-container-lowest px-2">
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-2 rounded-full px-1 py-1 text-left transition-colors hover:bg-surface-container-high"
          onClick={openSettings}
          aria-label={`User settings for ${identity.displayName}`}
        >
          <Avatar
            color={identity.avatarColor}
            size={32}
            name={identity.displayName}
            imageUrl={identity.avatarUrl}
          />
          {/*
            The name alone. This slot read "Mesh account" under every name it
            has ever shown, so it never said which account. The address would
            say it, but the address is deliberately behind "Show account
            address" in settings, and permanent chrome is in every screenshot
            and every screen share; the account service is named there too.
          */}
          <span className="min-w-0 flex-1 truncate text-body-md font-medium leading-tight text-on-surface">
            {identity.displayName}
          </span>
        </button>
        <div
          className="flex flex-shrink-0 items-center"
          role="toolbar"
          aria-label={voiceRoutesEnabled ? 'Voice and account controls' : 'Account controls'}
        >
          {voiceRoutesEnabled && <VoiceQuickControls />}
          <IconButton
            size="sm"
            aria-label="Send beta feedback"
            onClick={() => setShowFeedback(true)}
          >
            <Icon name="messageCircle" size="sm" />
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

      <DialogErrorBoundary open={showSettings} onClose={closeSettings} title="User settings">
        {showSettings && (
          <Suspense
            fallback={<ModalLoadingFallback title="User settings" label="Loading settings" size="xl" />}
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
              onOpenFeedback={() => setShowFeedback(true)}
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
        title="Security and devices"
      >
        {showSecurity && (
          <Suspense
            fallback={
              <ModalLoadingFallback title="Security and devices" label="Loading security settings" />
            }
          >
            <SecurityDevicesPanel open onClose={() => setShowSecurity(false)} />
          </Suspense>
        )}
      </DialogErrorBoundary>
      <DialogErrorBoundary
        open={showDiagnostics}
        onClose={() => setShowDiagnostics(false)}
        title="Connection check"
      >
        {showDiagnostics && (
          <Suspense
            fallback={
              <ModalLoadingFallback title="Connection check" label="Opening connection check" size="lg" />
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
      <DialogErrorBoundary
        open={showFeedback}
        onClose={() => setShowFeedback(false)}
        title="Send beta feedback"
      >
        {showFeedback && (
          <Suspense fallback={<ModalLoadingFallback title="Send beta feedback" label="Opening feedback" size="lg" />}>
            <BetaFeedbackDialog
              open
              onClose={() => setShowFeedback(false)}
              context={{
                area: isDmMode ? 'Direct messages' : activeChannelId ? 'Community channel' : 'Home',
                callActive: Boolean(currentVoiceChannelId),
                platform: detectFeedbackPlatform(navigator.userAgent),
              }}
            />
          </Suspense>
        )}
      </DialogErrorBoundary>
    </>
  )
}

/**
 * Separate component so the mute and deafen subscriptions only exist in builds
 * that can actually open a call. Voice state changes must not re-render the
 * persistent account bar when calling is not part of the product.
 */
function VoiceQuickControls() {
  const inCall = useVoiceStore((state) => state.currentChannelId !== null)
  const isMuted = useVoiceStore((state) => state.isMuted)
  const isDeafened = useVoiceStore((state) => state.isDeafened)
  const setMuted = useVoiceStore((state) => state.setMuted)
  const setDeafened = useVoiceStore((state) => state.setDeafened)

  return (
    <>
      <IconButton
        size="sm"
        disabled={!inCall}
        aria-label={isMuted ? 'Unmute microphone' : 'Mute microphone'}
        aria-pressed={isMuted}
        onClick={() => setMuted(!isMuted)}
      >
        <Icon name={isMuted ? 'micOff' : 'mic'} size="sm" />
      </IconButton>
      <IconButton
        size="sm"
        disabled={!inCall}
        aria-label={isDeafened ? 'Restore call audio' : 'Mute call audio'}
        aria-pressed={isDeafened}
        onClick={() => setDeafened(!isDeafened)}
      >
        <Icon name={isDeafened ? 'headphoneOff' : 'headphones'} size="sm" />
      </IconButton>
    </>
  )
}
