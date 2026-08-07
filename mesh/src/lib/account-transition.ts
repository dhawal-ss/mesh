import { useChannelStore } from '../store/channels'
import { useCommunityStore } from '../store/communities'
import { useServerEmojiStore } from '../store/custom-emoji'
import { useDmStore } from '../store/dms'
import { useDraftStore } from '../store/drafts'
import { useFileDownloadStore } from '../store/file-downloads'
import { useMembershipStore } from '../store/membership'
import { useMessageNavigationStore } from '../store/message-navigation'
import { useMessageStore } from '../store/messages'
import { resetNetworkStateForAccountTransition } from '../store/network'
import { useMeshNavigationStore } from '../store/navigation'
import { useRoomPinStore } from '../store/room-pins'
import { useShellStore } from '../store/shell'
import { useTypingStore } from '../store/typing'
import { useVoiceStore } from '../store/voice'
import { resetMatrixAccountPreferences } from '../store/settings'
import { roomTabStorageKey } from './room-tabs'
import { clearNewcomerChecklistsForAccount } from './onboarding-checklist'
import { safeLocalStorageRemove } from './safe-storage'

/**
 * Remove renderer-only state that belongs to the previously active account.
 *
 * Call this only after the native account transition succeeds and before the
 * next account's bootstrap starts. Authentication material never enters these
 * stores; native secure storage remains the session authority.
 */
export function clearRendererAccountState(removedAccountId?: string | null): void {
  if (removedAccountId) {
    safeLocalStorageRemove(roomTabStorageKey(removedAccountId))
    clearNewcomerChecklistsForAccount(removedAccountId)
  }
  useMeshNavigationStore.getState().resetForAccountTransition(removedAccountId)
  resetMatrixAccountPreferences()

  useServerEmojiStore.getState().clearAll()

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
    requests: [],
    blockedAccounts: [],
    blockedAccountsNextCursor: null,
    messageEntities: {},
    messageOrder: {},
    messages: {},
    activeConversationId: null,
    isDmMode: false,
    conversationLoad: { status: 'idle', error: null, generation: 0 },
    requestLoad: { status: 'idle', error: null, generation: 0 },
    blockedAccountLoad: { status: 'idle', error: null, generation: 0 },
    messageLoads: {},
  })
  useMembershipStore.setState({
    memberEntities: {},
    memberOrder: {},
    members: {},
    rosterNextCursor: {},
    rosterStateComplete: {},
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
  resetNetworkStateForAccountTransition()
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
