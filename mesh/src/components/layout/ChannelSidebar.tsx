import { useState } from 'react'
import { useCommunityStore } from '../../store/communities'
import { useChannelStore } from '../../store/channels'
import { useVoiceStore } from '../../store/voice'
import { ChannelItem } from '../community/ChannelItem'
import { CommunitySettings } from '../community/CommunitySettings'
import { UserPanel } from './UserPanel'

export function ChannelSidebar() {
  const { communities, activeCommunityId } = useCommunityStore()
  const { channels, activeChannelId, setActiveChannel } = useChannelStore()
  const { currentChannelId, currentCommunityId, setCurrentVoiceSession } = useVoiceStore()
  const [showSettings, setShowSettings] = useState(false)
  const [textCollapsed, setTextCollapsed] = useState(false)
  const [voiceCollapsed, setVoiceCollapsed] = useState(false)

  const activeCommunity = communities.find((c) => c.id === activeCommunityId)
  const communityChannels = channels.filter((c) => c.communityId === activeCommunityId)
  const textChannels = communityChannels.filter((c) => c.channelType === 'text')
  const voiceChannels = communityChannels.filter((c) => c.channelType === 'voice')

  if (!activeCommunity) {
    return (
      <div className="flex flex-col h-full">
        <div className="flex h-12 flex-shrink-0 items-center border-b border-black/30 px-4 shadow-elevation-low">
          <h2 className="text-sm font-semibold text-primary">Your communities</h2>
        </div>
        <div className="flex flex-1 items-center px-5 py-8 text-center">
          <div>
            <p className="text-sm font-medium text-primary">
              {communities.length > 0 ? 'Choose a community' : 'Find your people'}
            </p>
            <p className="mt-2 text-xs leading-5 text-muted">
              {communities.length > 0
                ? 'Select a community icon to view its channels.'
                : 'Use the plus button to create a community, or the compass to discover one you can join.'}
            </p>
          </div>
        </div>
        <UserPanel />
      </div>
    )
  }

  return (
    <>
      <div className="flex flex-col h-full">
        {/* Server name header */}
        <button
          className="flex h-12 flex-shrink-0 items-center justify-between border-b border-black/30 px-4 shadow-elevation-low hover:bg-bg-modifier-hover transition-colors"
          onClick={() => setShowSettings(true)}
          data-tauri-drag-region
        >
          <h2 className="min-w-0 flex-1 truncate text-left text-sm font-semibold text-primary">
            {activeCommunity.name}
          </h2>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-muted flex-shrink-0">
            <polyline points="6 9 12 15 18 9" />
          </svg>
        </button>

        {/* Channel list */}
        <div className="flex-1 overflow-y-auto px-2 py-4">
          {/* Text Channels category */}
          {textChannels.length > 0 && (
            <div className="mb-1">
              <button
                onClick={() => setTextCollapsed(!textCollapsed)}
                className="group flex w-full items-center gap-0.5 px-0.5 pb-1 text-left"
              >
                <svg
                  width="10"
                  height="10"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="3"
                  className={`text-muted transition-transform duration-150 ${textCollapsed ? '-rotate-90' : ''}`}
                >
                  <polyline points="6 9 12 15 18 9" />
                </svg>
                <span className="text-[11px] font-semibold uppercase tracking-[0.02em] text-muted group-hover:text-secondary">
                  Text Channels
                </span>
              </button>
              {!textCollapsed && (
                <div className="space-y-0.5">
                  {textChannels.map((channel) => (
                    <ChannelItem
                      key={channel.id}
                      channel={channel}
                      active={channel.id === activeChannelId}
                      onClick={() => setActiveChannel(channel.id)}
                    />
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Voice Channels category */}
          {voiceChannels.length > 0 && (
            <div className="mb-1 mt-3">
              <button
                onClick={() => setVoiceCollapsed(!voiceCollapsed)}
                className="group flex w-full items-center gap-0.5 px-0.5 pb-1 text-left"
              >
                <svg
                  width="10"
                  height="10"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="3"
                  className={`text-muted transition-transform duration-150 ${voiceCollapsed ? '-rotate-90' : ''}`}
                >
                  <polyline points="6 9 12 15 18 9" />
                </svg>
                <span className="text-[11px] font-semibold uppercase tracking-[0.02em] text-muted group-hover:text-secondary">
                  Voice Channels
                </span>
              </button>
              {!voiceCollapsed && (
                <div className="space-y-0.5">
                  {voiceChannels.map((channel) => (
                    <ChannelItem
                      key={channel.id}
                      channel={channel}
                      active={
                        channel.id === activeChannelId ||
                        (channel.id === currentChannelId && channel.communityId === currentCommunityId)
                      }
                      onClick={() => {
                        setActiveChannel(channel.id)
                        setCurrentVoiceSession(activeCommunityId, channel.id)
                      }}
                    />
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        {/* User panel — Discord-style bottom bar */}
        <UserPanel />
      </div>

      <CommunitySettings isOpen={showSettings} onClose={() => setShowSettings(false)} />
    </>
  )
}
