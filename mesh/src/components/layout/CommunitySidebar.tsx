import { useState } from 'react'
import { useCommunityStore } from '../../store/communities'
import { useDmStore } from '../../store/dms'
import { Tooltip } from '../ui/Tooltip'
import { CommunityIcon } from '../community/CommunityIcon'
import { CreateCommunityModal } from '../community/CreateCommunityModal'

export function CommunitySidebar() {
  const { communities, activeCommunityId, setActiveCommunity } = useCommunityStore()
  const { isDmMode, setDmMode } = useDmStore()
  const [showCreateModal, setShowCreateModal] = useState(false)

  const handleDmClick = () => {
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
        <Tooltip content="Direct Messages" side="right">
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
        </Tooltip>

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
      </div>

      <CreateCommunityModal isOpen={showCreateModal} onClose={() => setShowCreateModal(false)} />
    </>
  )
}
