import { useChannelStore } from '../store/channels'
import { useCommunityStore } from '../store/communities'
import { useServerEmojiStore } from '../store/custom-emoji'
import { useDmStore } from '../store/dms'
import { useDraftStore } from '../store/drafts'
import { useFileDownloadStore } from '../store/file-downloads'
import { useMembershipStore } from '../store/membership'
import { useMessageNavigationStore } from '../store/message-navigation'
import { useMessageStore } from '../store/messages'
import { useNetworkStore } from '../store/network'
import { useRoomPinStore } from '../store/room-pins'
import { useShellStore } from '../store/shell'
import { useTypingStore } from '../store/typing'
import { useVoiceStore } from '../store/voice'
import { resetMatrixAccountPreferences } from '../store/settings'
import { roomTabStorageKey } from './room-tabs'
import { safeLocalStorageRemove } from './safe-storage'

/**
 * Remove renderer-only state that belongs to the previously active account.
 *
 * Call this only after the native account transition succeeds and before the
 * next account's bootstrap starts. Authentication material never enters these
 * stores; native secure storage remains the session authority.
 */
export function clearRendererAccountState(removedAccountId?: string | null): void {
  if (removedAccountId) safeLocalStorageRemove(roomTabStorageKey(removedAccountId))
  resetMatrixAccountPreferences()

  const emojiCommunities = Object.keys(useServerEmojiStore.getState().byCommunity)
  for (const communityId of emojiCommunities) {
    useServerEmojiStore.getState().clear(communityId)
  }

  useRoomPinStore.getState().clear()
  useVoiceStore.getState().resetVoiceState()

  useCommunityStore.setState({
    communityEntities: {},
    communityOrder: [],
    communities: [],
    activeCommunityId: null,
  })
  useChannelStore.setState({
    channelEntities: {},
    channelOrder: [],
    channels: [],
    activeChannelId: null,
    refreshByCommunity: {},
    refreshRequests: {},
  })
  useDmStore.setState({
    conversationEntities: {},
    conversationOrder: [],
    conversations: [],
    messageEntities: {},
    messageOrder: {},
    messages: {},
    activeConversationId: null,
    isDmMode: false,
    conversationLoad: { status: 'idle', error: null, generation: 0 },
    messageLoads: {},
  })
  useMembershipStore.setState({
    memberEntities: {},
    memberOrder: {},
    members: {},
  })
  useMessageStore.setState({
    messageEntities: {},
    messageOrder: {},
    messages: {},
    loadingOlder: {},
    hasMoreOlder: {},
    browsingOlder: {},
    newerGapCount: {},
    channelRecency: [],
    matrixQueueStates: {},
  })
  useTypingStore.setState({ typingByChannel: {} })
  useDraftStore.setState({ drafts: {} })
  useFileDownloadStore.setState({ downloads: {} })
  useMessageNavigationStore.setState({ pending: null })
  useNetworkStore.setState({
    status: {
      state: 'connecting',
      peerCount: 0,
      averageLatency: 0,
    },
  })
  useVoiceStore.setState({
    localPublicKey: null,
    matrixRtcMembersByRoom: {},
  })
  useShellStore.setState({
    serverModalOpen: false,
    profileOpen: false,
    securityOpen: false,
  })
}
