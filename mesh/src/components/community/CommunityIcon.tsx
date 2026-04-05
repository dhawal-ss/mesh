import type { Community } from '../../types/ipc'
import { Avatar } from '../ui/Avatar'

interface CommunityIconProps {
  community: Community
  active: boolean
  onClick: () => void
}

export function CommunityIcon({ community, active, onClick }: CommunityIconProps) {
  return (
    <div className="relative flex items-center justify-center">
      {/* Left pill indicator */}
      <div
        className={`absolute -left-[4px] w-[4px] rounded-r-full bg-primary transition-all duration-200 ${
          active
            ? 'h-10'
            : 'h-0 group-hover:h-5'
        }`}
      />
      <button
        onClick={onClick}
        aria-label={community.name}
        aria-current={active ? 'true' : undefined}
        className={`group relative flex h-12 w-12 items-center justify-center overflow-hidden transition-all duration-200 ${
          active
            ? 'rounded-[16px] bg-accent'
            : 'rounded-[24px] bg-bg-primary hover:rounded-[16px] hover:bg-accent'
        }`}
      >
        <Avatar
          color={active ? '#d4c0a1' : '#5865f2'}
          size={48}
          name={community.name}
          className="!rounded-none"
        />
        {/* Hover indicator for non-active */}
        {!active && (
          <div className="absolute -left-[4px] top-1/2 h-0 w-[4px] -translate-y-1/2 rounded-r-full bg-primary transition-all duration-200 group-hover:h-5" />
        )}
      </button>
    </div>
  )
}
