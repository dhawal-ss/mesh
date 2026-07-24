import { useState } from 'react'
import { useCommunityStore } from '../../store/communities'
import { useDmStore } from '../../store/dms'
import { Tooltip } from '../ui/Tooltip'
import { CommunityIcon } from '../community/CommunityIcon'
import { CreateCommunityModal } from '../community/CreateCommunityModal'
import { ServerDiscovery } from '../community/ServerDiscovery'
import { DiagnosticsPanel } from '../settings/DiagnosticsPanel'
import { SecurityDevicesPanel } from '../settings/SecurityDevicesPanel'
import * as bridge from '../../lib/bridge'

export function CommunitySidebar() {
  const backendKind = bridge.isMatrixBackend() ? 'matrix' : 'legacy-p2p'
  const directMessagesAvailable = bridge.getBackendCapabilities().directMessages
  const { communities, activeCommunityId, setActiveCommunity } = useCommunityStore()
  const { isDmMode, setDmMode } = useDmStore()
  const [showCreateModal, setShowCreateModal] = useState(false)
  const [showDiscovery, setShowDiscovery] = useState(false)
  const [showDiagnostics, setShowDiagnostics] = useState(false)
  const [showSecurity, setShowSecurity] = useState(false)

  const handleDmClick = () => {
    if (!directMessagesAvailable) return
    setDmMode(!isDmMode)
  }

  const handleCommunityClick = (id: string) => {
    setDmMode(false)
    setActiveCommunity(id)
  }

  return (
    <>
      <div className="flex flex-col items-center gap-2 pb-3">
        {/* Home / DM button */}
        {directMessagesAvailable ? <Tooltip content="Direct Messages" side="right">
          <button
            onClick={handleDmClick}
            className={`group relative flex h-12 w-12 items-center justify-center rounded-[24px] transition-all duration-200 ${
              isDmMode
                ? 'rounded-[16px] bg-accent text-bg-tertiary'
                : 'bg-bg-primary text-muted hover:rounded-[16px] hover:bg-accent hover:text-bg-tertiary'
            }`}
            aria-label="Direct Messages"
          >
            <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
              <path d="M19.73 4.87l-15.5 6.37a.5.5 0 00.01.95l5.25 1.68 7.09-5.45c.15-.12.33.04.22.18L10.7 15.4l-.03 4.63a.5.5 0 00.84.34l2.85-2.82 5.27 1.68a.5.5 0 00.64-.38l2.53-13.03a.5.5 0 00-.73-.53l.16-.42-.16.42z" />
            </svg>
            {/* Active pill indicator */}
            {isDmMode && (
              <div className="absolute -left-[4px] top-1/2 h-10 w-[4px] -translate-y-1/2 rounded-r-full bg-primary" />
            )}
          </button>
        </Tooltip> : null}

        {/* Separator */}
        <div className="mx-auto h-[2px] w-8 rounded-full bg-bg-modifier-active" />

        {/* Community icons */}
        {communities.map((c) => (
          <Tooltip key={c.id} content={c.name} side="right">
            <CommunityIcon
              community={c}
              active={c.id === activeCommunityId && !isDmMode}
              onClick={() => handleCommunityClick(c.id)}
            />
          </Tooltip>
        ))}

        {/* Separator */}
        {communities.length > 0 && (
          <div className="mx-auto h-[2px] w-8 rounded-full bg-bg-modifier-active" />
        )}

        {/* Add community */}
        <Tooltip content="Add a Community" side="right">
          <button
            onClick={() => setShowCreateModal(true)}
            className="group flex h-12 w-12 items-center justify-center rounded-[24px] bg-bg-primary text-green transition-all duration-200 hover:rounded-[16px] hover:bg-green hover:text-white"
            aria-label="Add a community"
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <line x1="12" y1="5" x2="12" y2="19" />
              <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
          </button>
        </Tooltip>

        {/* Discover communities */}
        <Tooltip content="Discover Communities" side="right">
          <button
            onClick={() => setShowDiscovery(true)}
            className="group flex h-12 w-12 items-center justify-center rounded-[24px] bg-bg-primary text-muted transition-all duration-200 hover:rounded-[16px] hover:bg-accent hover:text-white"
            aria-label="Discover Communities"
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="11" cy="11" r="8" />
              <line x1="21" y1="21" x2="16.65" y2="16.65" />
            </svg>
          </button>
        </Tooltip>

        {/* System diagnostics */}
        {backendKind === 'matrix' && (
          <Tooltip content="Security & Devices" side="right">
            <button
              onClick={() => setShowSecurity(true)}
              className="group flex h-12 w-12 items-center justify-center rounded-[24px] bg-bg-primary text-muted transition-all duration-200 hover:rounded-[16px] hover:bg-accent hover:text-white"
              aria-label="Security and devices"
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z" />
                <path d="m9 12 2 2 4-4" />
              </svg>
            </button>
          </Tooltip>
        )}

        {/* System diagnostics */}
        <Tooltip content="System Diagnostics" side="right">
          <button
            onClick={() => setShowDiagnostics(true)}
            className="group flex h-12 w-12 items-center justify-center rounded-[24px] bg-bg-primary text-muted transition-all duration-200 hover:rounded-[16px] hover:bg-accent hover:text-white"
            aria-label="System Diagnostics"
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M22 12h-4l-3 9L9 3l-3 9H2" />
            </svg>
          </button>
        </Tooltip>
      </div>

      <CreateCommunityModal isOpen={showCreateModal} onClose={() => setShowCreateModal(false)} />
      <ServerDiscovery open={showDiscovery} onClose={() => setShowDiscovery(false)} />
      <DiagnosticsPanel
        open={showDiagnostics}
        onClose={() => setShowDiagnostics(false)}
        backendKind={backendKind}
      />
      <SecurityDevicesPanel open={showSecurity} onClose={() => setShowSecurity(false)} />
    </>
  )
}
