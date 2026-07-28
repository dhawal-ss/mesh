import { useState } from 'react'
import { useActiveChannel } from '../../store/channels'
import { useCommunityStore } from '../../store/communities'
import { usePresence } from '../../hooks/usePresence'
import { ChatView } from '../chat/ChatView'
import { VoiceView } from '../voice/VoiceView'
import {
  RoomContextPanel,
  type RoomContextTab,
} from '../community/RoomContextPanel'
import { ErrorBoundary } from '../ui/ErrorBoundary'
import { ScopedErrorBoundary } from '../ui/ScopedErrorBoundary'
import { Icon } from '../ui/Icon'
import { useShellStore } from '../../store/shell'
import { useDmStore } from '../../store/dms'
import { useRoomTrust } from '../../hooks/useRoomTrust'

export function ContentArea() {
  const activeChannel = useActiveChannel()
  const communityCount = useCommunityStore((state) => state.communityOrder.length)
  const activeCommunityId = useCommunityStore((state) => state.activeCommunityId)
  const openServerModal = useShellStore((state) => state.openServerModal)
  const setDmMode = useDmStore((state) => state.setDmMode)

  const [showContext, setShowContext] = useState(true)
  const [contextTab, setContextTab] = useState<RoomContextTab>('people')
  const [inviteDraft, setInviteDraft] = useState('')
  const { members } = usePresence()
  const trust = useRoomTrust(activeChannel?.id, members)

  if (!activeChannel) {
    const hasCommunity = Boolean(activeCommunityId)
    const isFirstCommunity = communityCount === 0

    return (
      <div className="flex min-w-0 flex-1 items-center justify-center px-6 py-8">
        <div className="max-w-md text-center">
          <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-bg-modifier-hover">
            <Icon name="messageCircle" size="lg" className="text-muted" />
          </div>
          <h3 className="mb-1 text-base font-semibold text-primary">
            {isFirstCommunity
              ? 'Welcome to Mesh'
              : hasCommunity
                ? 'Choose a channel'
                : 'Choose a server'}
          </h3>
          <p className="text-sm leading-6 text-muted">
            {isFirstCommunity
              ? 'Create your first server with the plus button, or join one with an invite.'
              : hasCommunity
                ? 'Select a text channel to start messaging. Voice channels appear when calling is available.'
                : 'Select a server icon, then choose one of its available channels.'}
          </p>
          {isFirstCommunity && (
            <div className="mt-5 space-y-4">
              <p className="text-sm font-medium text-secondary">You're in. What first?</p>
              <div className="grid gap-2 sm:grid-cols-3">
                <FirstAction label="Join a server" icon="userPlus" onClick={() => openServerModal('join')} />
                <FirstAction label="Make a server" icon="plus" onClick={() => openServerModal('create')} />
                <FirstAction label="Message a friend" icon="send" onClick={() => setDmMode(true)} />
              </div>
              <form
                className="mx-auto max-w-sm text-left"
                onSubmit={(event) => {
                  event.preventDefault()
                  if (inviteDraft.trim()) openServerModal('join', inviteDraft.trim())
                }}
              >
                <label htmlFor="first-run-invite" className="text-xs font-medium text-secondary">
                  Have an invite link? Paste it here
                </label>
                <div className="mt-1 flex gap-2">
                  <input
                    id="first-run-invite"
                    value={inviteDraft}
                    onChange={(event) => setInviteDraft(event.target.value)}
                    className="h-control-md min-w-0 flex-1 rounded-md border border-border-subtle bg-surface-raised px-3 text-sm text-content outline-none focus:border-accent"
                  />
                  <button
                    type="submit"
                    disabled={!inviteDraft.trim()}
                    className="rounded-md bg-accent px-3 text-sm font-medium text-content-on-accent disabled:opacity-40"
                  >
                    Join
                  </button>
                </div>
              </form>
            </div>
          )}
        </div>
      </div>
    )
  }

  return (
    <div className="flex min-h-0 flex-1">
      <div className="flex min-w-0 flex-1 flex-col">
        <ErrorBoundary scope="content">
          {activeChannel.channelType === 'voice' ? (
            <VoiceView channelId={activeChannel.id} channelName={activeChannel.name} />
          ) : (
            <ChatView
              channel={activeChannel}
              trust={trust}
              showContextToggle
              isContextOpen={showContext}
              activeContextTab={contextTab}
              onToggleContext={() => setShowContext(!showContext)}
              onOpenContext={(tab) => {
                setContextTab(tab)
                setShowContext(true)
              }}
            />
          )}
        </ErrorBoundary>
      </div>

      {activeChannel.channelType === 'text' && showContext && (
        <ScopedErrorBoundary
          name="Room context"
          description="Room context could not be displayed. Messaging is unaffected."
          className="m-2 w-content-error"
          resetKey={activeCommunityId}
        >
          <RoomContextPanel
            channel={activeChannel}
            members={members}
            trust={trust}
            activeTab={contextTab}
            onTabChange={setContextTab}
            onClose={() => setShowContext(false)}
          />
        </ScopedErrorBoundary>
      )}
    </div>
  )
}

function FirstAction({
  label,
  icon,
  onClick,
}: {
  label: string
  icon: 'userPlus' | 'plus' | 'send'
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex min-h-24 flex-col items-center justify-center gap-2 rounded-lg bg-surface-raised p-3 text-sm font-medium text-content transition-colors hover:bg-surface-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
    >
      <Icon name={icon} />
      {label}
    </button>
  )
}
