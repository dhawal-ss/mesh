import { useState } from 'react'
import { useChannelStore } from '../../store/channels'
import { useCommunityStore } from '../../store/communities'
import { usePresence } from '../../hooks/usePresence'
import { ChatView } from '../chat/ChatView'
import { VoiceView } from '../voice/VoiceView'
import { MemberList } from '../community/MemberList'
import { ErrorBoundary } from '../ui/ErrorBoundary'

export function ContentArea() {
  const { activeChannelId, channels } = useChannelStore()
  const communities = useCommunityStore((state) => state.communities)
  const activeCommunityId = useCommunityStore((state) => state.activeCommunityId)
  const activeChannel = channels.find((c) => c.id === activeChannelId)

  const [showMembers, setShowMembers] = useState(true)
  const { members } = usePresence()

  if (!activeChannel) {
    const hasCommunity = Boolean(activeCommunityId)
    const isFirstCommunity = communities.length === 0

    return (
      <div className="flex min-w-0 flex-1 items-center justify-center px-6 py-8">
        <div className="max-w-md text-center">
          <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-bg-modifier-hover">
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="text-muted">
              <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
            </svg>
          </div>
          <h3 className="mb-1 text-base font-semibold text-primary">
            {isFirstCommunity
              ? 'Welcome to Mesh'
              : hasCommunity
                ? 'Choose a channel'
                : 'Choose a community'}
          </h3>
          <p className="text-sm leading-6 text-muted">
            {isFirstCommunity
              ? 'Create your first community with the plus button, or use the compass to discover an existing Matrix community.'
              : hasCommunity
                ? 'Select a text channel to start messaging. Voice channels are shown only when your current backend supports calling.'
                : 'Select a community icon, then choose one of its available channels.'}
          </p>
          {isFirstCommunity && (
            <ol className="mx-auto mt-5 max-w-sm space-y-2 text-left text-xs leading-5 text-secondary">
              <li className="rounded-md bg-bg-secondary px-3 py-2">
                <span className="mr-2 font-semibold text-blue">1.</span>
                Create or discover a community.
              </li>
              <li className="rounded-md bg-bg-secondary px-3 py-2">
                <span className="mr-2 font-semibold text-blue">2.</span>
                Open a channel and invite people with their Matrix ID.
              </li>
              <li className="rounded-md bg-bg-secondary px-3 py-2">
                <span className="mr-2 font-semibold text-blue">3.</span>
                Review recovery and device verification in User Settings.
              </li>
            </ol>
          )}
        </div>
      </div>
    )
  }

  return (
    <div className="flex min-h-0 flex-1">
      <div className="flex min-w-0 flex-1 flex-col">
        <ErrorBoundary level="content">
          {activeChannel.channelType === 'voice' ? (
            <VoiceView channelId={activeChannel.id} channelName={activeChannel.name} />
          ) : (
            <ChatView
              channel={activeChannel}
              showMembersToggle
              isMembersOpen={showMembers}
              onToggleMembers={() => setShowMembers(!showMembers)}
            />
          )}
        </ErrorBoundary>
      </div>

      {/* Member list — always-visible right sidebar */}
      {activeChannel.channelType === 'text' && (
        <MemberList
          isOpen={showMembers}
          onClose={() => setShowMembers(false)}
          members={members}
        />
      )}
    </div>
  )
}
