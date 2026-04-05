import { useState } from 'react'
import { useChannelStore } from '../../store/channels'
import { usePresence } from '../../hooks/usePresence'
import { ChatView } from '../chat/ChatView'
import { VoiceView } from '../voice/VoiceView'
import { MemberList } from '../community/MemberList'
import { ErrorBoundary } from '../ui/ErrorBoundary'

export function ContentArea() {
  const { activeChannelId, channels } = useChannelStore()
  const activeChannel = channels.find((c) => c.id === activeChannelId)

  const [showMembers, setShowMembers] = useState(true)
  const { members } = usePresence()

  if (!activeChannel) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <div className="text-center">
          <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-bg-modifier-hover">
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="text-muted">
              <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
            </svg>
          </div>
          <h3 className="text-base font-semibold text-primary mb-1">No channel selected</h3>
          <p className="text-sm text-muted">
            Select a channel from the sidebar to start chatting
          </p>
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
