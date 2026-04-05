import { useState } from 'react'
import { useCommunityStore } from '../../store/communities'
import { useChannelStore } from '../../store/channels'
import { useVoiceStore } from '../../store/voice'
import { useIdentityStore } from '../../store/identity'
import { ChannelItem } from '../community/ChannelItem'
import { CommunitySettings } from '../community/CommunitySettings'
import { Avatar } from '../ui/Avatar'
import { Tooltip } from '../ui/Tooltip'

export function ChannelSidebar() {
  const { communities, activeCommunityId } = useCommunityStore()
  const { channels, activeChannelId, setActiveChannel } = useChannelStore()
  const { currentChannelId, currentCommunityId, setCurrentVoiceSession } = useVoiceStore()
  const identity = useIdentityStore((s) => s.identity)
  const [showSettings, setShowSettings] = useState(false)
  const [textCollapsed, setTextCollapsed] = useState(false)
  const [voiceCollapsed, setVoiceCollapsed] = useState(false)

  const activeCommunity = communities.find((c) => c.id === activeCommunityId)
  const communityChannels = channels.filter((c) => c.communityId === activeCommunityId)
  const textChannels = communityChannels.filter((c) => c.channelType === 'text')
  const voiceChannels = communityChannels.filter((c) => c.channelType === 'voice')

  if (!activeCommunity) {
    return (
      <div className="flex-1 flex items-center justify-center p-4">
        <p className="text-xs text-muted text-center">
          Select a community
        </p>
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
        <div className="flex h-[52px] flex-shrink-0 items-center gap-2 bg-[#232428] px-2">
          <div className="flex min-w-0 flex-1 items-center gap-2 rounded px-1 py-1 hover:bg-bg-modifier-hover cursor-pointer transition-colors">
            <Avatar
              color={identity?.avatarColor ?? '#5865f2'}
              size={32}
              name={identity?.displayName ?? 'User'}
            />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium text-primary leading-tight">
                {identity?.displayName || 'Anonymous'}
              </p>
              <p className="truncate text-[11px] text-muted leading-tight">
                Online
              </p>
            </div>
          </div>

          {/* Settings button */}
          <Tooltip content="User Settings" side="top">
            <button
              className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded text-muted hover:bg-bg-modifier-hover hover:text-secondary transition-colors"
              aria-label="Settings"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="12" cy="12" r="3" />
                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
              </svg>
            </button>
          </Tooltip>
        </div>
      </div>

      <CommunitySettings isOpen={showSettings} onClose={() => setShowSettings(false)} />
    </>
  )
}
