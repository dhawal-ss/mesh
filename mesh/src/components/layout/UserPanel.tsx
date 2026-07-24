import { useState } from 'react'
import { useIdentityStore } from '../../store/identity'
import { Avatar } from '../ui/Avatar'
import { Tooltip } from '../ui/Tooltip'
import { UserSettingsPanel } from '../settings/UserSettingsPanel'
import { SecurityDevicesPanel } from '../settings/SecurityDevicesPanel'
import { matrixProfileIdentity, resolveSenderIdentity } from '../../lib/matrixIdentity'
import * as bridge from '../../lib/bridge'

export function UserPanel() {
  const storedIdentity = useIdentityStore((state) => state.identity)
  const setIdentity = useIdentityStore((state) => state.setIdentity)
  const matrixMode = bridge.isMatrixBackend()
  const matrixAccountId = matrixMode ? bridge.getMatrixUserId() : null
  const identity = resolveSenderIdentity(storedIdentity, matrixAccountId)
  const [showSettings, setShowSettings] = useState(false)
  const [showSecurity, setShowSecurity] = useState(false)

  const openSecurity = () => {
    setShowSettings(false)
    setShowSecurity(true)
  }

  return (
    <>
      <div className="flex h-[52px] flex-shrink-0 items-center gap-2 bg-[#232428] px-2">
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-2 rounded px-1 py-1 text-left transition-colors hover:bg-bg-modifier-hover"
          onClick={() => setShowSettings(true)}
          aria-label={`Open settings for ${identity.displayName}`}
        >
          <Avatar color={identity.avatarColor} size={32} name={identity.displayName} />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-medium leading-tight text-primary">
              {identity.displayName}
            </span>
            <span className="block truncate text-[11px] leading-tight text-muted">
              {matrixAccountId ?? 'Local identity'}
            </span>
          </span>
        </button>

        <Tooltip content="User Settings" side="top">
          <button
            type="button"
            className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded text-muted transition-colors hover:bg-bg-modifier-hover hover:text-secondary"
            aria-label="User settings"
            onClick={() => setShowSettings(true)}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
            </svg>
          </button>
        </Tooltip>
      </div>

      <UserSettingsPanel
        open={showSettings}
        onClose={() => setShowSettings(false)}
        identity={identity}
        matrixAccountId={matrixAccountId}
        matrixMode={matrixMode}
        onUpdateDisplayName={async (displayName) => {
          const profile = await bridge.matrixUpdateProfileDisplayName(displayName)
          setIdentity(matrixProfileIdentity(profile))
        }}
        onOpenSecurity={openSecurity}
      />
      <SecurityDevicesPanel open={showSecurity} onClose={() => setShowSecurity(false)} />
    </>
  )
}
