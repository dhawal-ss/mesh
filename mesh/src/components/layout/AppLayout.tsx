import { useEffect, useState } from 'react'
import { CommunitySidebar } from './CommunitySidebar'
import { ChannelSidebar } from './ChannelSidebar'
import { ContentArea } from './ContentArea'
import { DmSidebar } from './DmSidebar'
import { DmView } from '../chat/DmView'
import { useCommunitySync } from '../../hooks/useCommunitySync'
import { useChannelStore } from '../../store/channels'
import { useCommunityStore } from '../../store/communities'
import { useDmStore } from '../../store/dms'
import { useIdentityStore } from '../../store/identity'
import { useSettingsStore } from '../../store/settings'
import * as bridge from '../../lib/bridge'
import { playNotificationSound } from '../../lib/bridge'
import type { NetworkStatus } from '../../types/ipc'

export function AppLayout() {
  useCommunitySync()
  const matrixMode = bridge.isMatrixBackend()
  const directMessagesAvailable = bridge.getBackendCapabilities().directMessages
  const activeChannelId = useChannelStore((state) => state.activeChannelId)
  const activeCommunityId = useCommunityStore((state) => state.activeCommunityId)
  const patchChannel = useChannelStore((state) => state.patchChannel)
  const isDmMode = useDmStore((state) => state.isDmMode)
  const setDmMode = useDmStore((state) => state.setDmMode)

  const myPublicKey = useIdentityStore((state) => state.identity?.publicKey)
  const [networkStatus, setNetworkStatus] = useState<NetworkStatus | null>(null)
  const [contextNavigationOpen, setContextNavigationOpen] = useState(false)

  useEffect(() => {
    if (!directMessagesAvailable && isDmMode) setDmMode(false)
  }, [directMessagesAvailable, isDmMode, setDmMode])

  useEffect(() => {
    setContextNavigationOpen(false)
  }, [activeChannelId, activeCommunityId, isDmMode])

  useEffect(() => {
    if (matrixMode) return
    const unlisten = bridge.onNetworkStatus((status) => {
      setNetworkStatus(status)
    })
    return () => { unlisten.then((fn) => fn()) }
  }, [matrixMode])

  useEffect(() => {
    if (matrixMode) return
    const unlisten = bridge.onMessageReceived((message) => {
      const isOwnMessage = myPublicKey && message.authorPublicKey === myPublicKey
      const isActiveChannel = message.channelId === activeChannelId && !isDmMode

      if (isActiveChannel) {
        return
      }

      const channel = useChannelStore
        .getState()
        .channels
        .find((entry) => entry.id === message.channelId)
      patchChannel(message.channelId, {
        unreadCount: (channel?.unreadCount ?? 0) + 1,
      })

      // Play notification sound for messages from other users in non-active channels
      if (!isOwnMessage) {
        const { notifications } = useSettingsStore.getState()
        const isMuted = notifications.mutedChannels.includes(message.channelId)
        if (notifications.enabled && notifications.sound && !isMuted) {
          playNotificationSound()
        }
      }
    })

    return () => {
      unlisten.then((fn) => fn())
    }
  }, [activeChannelId, isDmMode, matrixMode, patchChannel, myPublicKey])

  // The user IS a peer. A mesh of size 1 (just them) is a VALID working
  // state — they can send messages, create communities, queue things for
  // delivery. We only surface a banner when something actually blocks
  // them, not just because they're solo.
  //
  // Banner is NEVER shown for solo mode. If the swarm task hasn't started
  // at all (real failure), the user sees errors elsewhere. Solo is
  // advertised gently via the sidebar indicator instead.
  const remotePeerCount = networkStatus?.peerCount ?? 0
  const isRunningSolo = networkStatus !== null && remotePeerCount === 0

  return (
    <div className="relative flex h-screen flex-col overflow-hidden">
      <div className="flex flex-1 overflow-hidden">
        {/* Server icon bar — Discord: 72px, dark */}
        <nav
          className="mesh-community-rail flex flex-shrink-0 flex-col items-center overflow-y-auto bg-bg-tertiary pt-3"
          aria-label="Communities and DMs"
        >
          <CommunitySidebar />
          <div className="mt-auto pb-3 flex flex-col items-center">
            <div className="flex items-center gap-1.5 text-[10px] text-muted px-1 text-center"
              title={
                matrixMode
                  ? 'Connected through your Matrix homeserver'
                  : isRunningSolo
                  ? 'You are running as a solo peer. Messages are stored locally and will sync when other peers join.'
                  : `Connected to ${remotePeerCount} other peer${remotePeerCount === 1 ? '' : 's'}`
              }
            >
              <span
                className={`w-2 h-2 rounded-full flex-shrink-0 ${
                  // Solo = yellow (working but alone), connected = green, not started = red
                  matrixMode
                    ? 'bg-green'
                    : networkStatus === null
                    ? 'bg-red'
                    : isRunningSolo
                      ? 'bg-yellow'
                      : 'bg-green'
                }`}
                aria-hidden
              />
              <span>
                {matrixMode
                  ? 'Matrix'
                  : networkStatus === null
                  ? 'Starting'
                  : isRunningSolo
                    ? 'Solo (you)'
                    : `You + ${remotePeerCount}`}
              </span>
            </div>
          </div>
        </nav>

        {/* Channel/DM sidebar — Discord: 240px */}
        {contextNavigationOpen && (
          <button
            type="button"
            className="mesh-nav-backdrop"
            aria-label="Close channel navigation"
            onClick={() => setContextNavigationOpen(false)}
          />
        )}

        <aside
          id="mesh-context-sidebar"
          data-open={contextNavigationOpen ? 'true' : 'false'}
          className="mesh-context-sidebar flex flex-shrink-0 flex-col bg-bg-secondary"
          aria-label={isDmMode && directMessagesAvailable ? 'Direct message conversations' : 'Channel list'}
        >
          {isDmMode && directMessagesAvailable ? <DmSidebar /> : <ChannelSidebar />}
        </aside>

        {/* Main content area */}
        <main className="flex min-w-0 flex-1 flex-col bg-bg-primary" aria-label="Content area">
          <div className="mesh-compact-header">
            <button
              type="button"
              className="flex h-8 items-center gap-2 rounded px-2 text-sm font-medium text-secondary hover:bg-bg-modifier-hover hover:text-primary"
              aria-controls="mesh-context-sidebar"
              aria-expanded={contextNavigationOpen}
              onClick={() => setContextNavigationOpen((open) => !open)}
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                {contextNavigationOpen ? (
                  <>
                    <line x1="18" y1="6" x2="6" y2="18" />
                    <line x1="6" y1="6" x2="18" y2="18" />
                  </>
                ) : (
                  <>
                    <line x1="4" y1="6" x2="20" y2="6" />
                    <line x1="4" y1="12" x2="20" y2="12" />
                    <line x1="4" y1="18" x2="20" y2="18" />
                  </>
                )}
              </svg>
              {contextNavigationOpen ? 'Close' : isDmMode ? 'Conversations' : 'Channels'}
            </button>
            <span className="truncate text-xs text-muted">
              {matrixMode ? 'Encrypted Matrix session' : 'Local Mesh session'}
            </span>
          </div>
          <div className="flex min-h-0 flex-1">
            {isDmMode && directMessagesAvailable ? <DmView /> : <ContentArea />}
          </div>
        </main>
      </div>
    </div>
  )
}
