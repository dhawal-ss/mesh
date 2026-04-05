import { useEffect } from 'react'
import { CommunitySidebar } from './CommunitySidebar'
import { ChannelSidebar } from './ChannelSidebar'
import { ContentArea } from './ContentArea'
import { DmSidebar } from './DmSidebar'
import { DmView } from '../chat/DmView'
import { useCommunitySync } from '../../hooks/useCommunitySync'
import { useChannelStore } from '../../store/channels'
import { useDmStore } from '../../store/dms'
import * as bridge from '../../lib/bridge'

export function AppLayout() {
  useCommunitySync()
  const activeChannelId = useChannelStore((state) => state.activeChannelId)
  const patchChannel = useChannelStore((state) => state.patchChannel)
  const isDmMode = useDmStore((state) => state.isDmMode)

  useEffect(() => {
    const unlisten = bridge.onMessageReceived((message) => {
      if (message.channelId === activeChannelId && !isDmMode) {
        return
      }

      const channel = useChannelStore
        .getState()
        .channels
        .find((entry) => entry.id === message.channelId)
      patchChannel(message.channelId, {
        unreadCount: (channel?.unreadCount ?? 0) + 1,
      })
    })

    return () => {
      unlisten.then((fn) => fn())
    }
  }, [activeChannelId, isDmMode, patchChannel])

  return (
    <div className="flex h-screen overflow-hidden">
      {/* Server icon bar — Discord: 72px, dark */}
      <nav
        className="flex w-[72px] flex-shrink-0 flex-col items-center bg-bg-tertiary pt-3 overflow-y-auto"
        aria-label="Communities and DMs"
      >
        <CommunitySidebar />
      </nav>

      {/* Channel/DM sidebar — Discord: 240px */}
      <aside
        className="flex w-[240px] flex-shrink-0 flex-col bg-bg-secondary"
        aria-label={isDmMode ? 'Direct message conversations' : 'Channel list'}
      >
        {isDmMode ? <DmSidebar /> : <ChannelSidebar />}
      </aside>

      {/* Main content area */}
      <main className="flex min-w-0 flex-1 flex-col bg-bg-primary" aria-label="Content area">
        {isDmMode ? <DmView /> : <ContentArea />}
      </main>
    </div>
  )
}
