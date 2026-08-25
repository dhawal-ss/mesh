import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useChannelStore } from './channels'
import { useCommunityStore } from './communities'
import { useDmStore } from './dms'
import { useMembershipStore, type MemberRecord } from './membership'
import { useMessageStore } from './messages'
import type {
  Channel,
  Community,
  DirectMessage,
  DmConversation,
  Message,
} from '../types/ipc'

const community: Community = {
  id: 'community-1',
  name: 'Gaming',
  description: 'Friends',
  avatarUrl: null,
  memberCount: 4,
  role: 'owner',
  joinedAt: '2026-07-25T00:00:00.000Z',
}

const secondCommunity: Community = {
  ...community,
  id: 'community-2',
  name: 'Design',
}

const channel: Channel = {
  id: 'channel-1',
  communityId: community.id,
  name: 'general',
  topic: '',
  channelType: 'text',
  unreadCount: 0,
  joined: true,
}

const secondChannel: Channel = {
  ...channel,
  id: 'channel-2',
  name: 'random',
}

const conversation: DmConversation = {
  id: 'dm-1',
  peers: [{ userId: '@friend:example.test', displayName: 'Friend', avatarColor: '#000000' }],
  lastMessageAt: null,
  unreadCount: 0,
  createdAt: '2026-07-25T00:00:00.000Z',
}

const secondConversation: DmConversation = {
  ...conversation,
  id: 'dm-2',
  peers: [{ userId: '@second:example.test', displayName: 'Second', avatarColor: '#000000' }],
}

const member: MemberRecord = {
  publicKey: '@friend:example.test',
  displayName: 'Friend',
  avatarColor: '#000000',
  role: 'member',
  joinStatus: 'joined',
  banStatus: 'none',
  lastSeen: null,
}

const secondMember: MemberRecord = {
  ...member,
  publicKey: '@second:example.test',
  displayName: 'Second',
}

const directMessage: DirectMessage = {
  id: 'message-1',
  conversationId: conversation.id,
  authorPublicKey: member.publicKey,
  authorDisplayName: member.displayName,
  authorAvatarColor: member.avatarColor,
  content: 'Hello',
  timestamp: '2026-07-25T00:00:00.000Z',
  signature: '',
  attachments: [],
  reactions: {},
}

const channelMessage: Message = {
  id: '$channel-message',
  channelId: channel.id,
  authorPublicKey: member.publicKey,
  authorDisplayName: member.displayName,
  authorAvatarColor: member.avatarColor,
  content: 'Hello',
  timestamp: '2026-07-25T00:00:00.000Z',
  signature: '',
  attachments: [{
    fileHash: 'hash-1',
    filename: 'photo.png',
    size: 12,
    chunks: 1,
    sourcePeerId: 'peer-1',
    contentType: 'image/png',
    thumbnail: {
      fileHash: 'thumb-1',
      size: 4,
      width: 8,
      height: 8,
      contentType: 'image/png',
    },
  }],
  reactions: { '👍': [member.publicKey] },
}

describe('normalized entity stores', () => {
  beforeEach(() => {
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
    })
    useDmStore.setState({
      conversationEntities: {},
      conversationOrder: [],
      conversations: [],
      messageEntities: {},
      messageOrder: {},
      messages: {},
      // The pagination flags have to be cleared with the timeline they describe.
      // addMessage diverts to the gap counter while a conversation is marked as
      // browsing older history, so a leftover flag from an earlier test silently
      // drops the seeded message and the next test reads an empty store.
      messageLoads: {},
      loadingOlder: {},
      hasMoreOlder: {},
      browsingOlder: {},
      newerGapCount: {},
      conversationRecency: [],
      activeConversationId: null,
      isDmMode: true,
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
      hasAuthoredMessage: false,
      matrixQueueStates: {},
    })

    useCommunityStore.getState().setCommunities([community, secondCommunity])
    useChannelStore.getState().setChannels([channel, secondChannel])
    useDmStore.getState().setConversations([conversation, secondConversation])
    useDmStore.getState().addMessage(directMessage)
    useMembershipStore.getState().setRoster(community.id, [member, secondMember])
    useMessageStore.getState().setMessages(channel.id, [channelMessage])
  })

  // A real IPC response is freshly JSON-deserialized, so every nested array
  // and record arrives as a new object even when nothing changed. Reference
  // equality alone therefore reported a change on every poll and disabled
  // identity preservation everywhere. This is the regression gate for that.
  it('preserves entity identity when a refresh returns a deep-cloned payload', () => {
    const messageBefore = useMessageStore.getState().messageEntities[channel.id][
      channelMessage.id
    ]
    const channelBefore = useChannelStore.getState().channelEntities[channel.id]
    const conversationBefore = useDmStore.getState().conversationEntities[conversation.id]
    const dmMessageBefore = useDmStore.getState().messageEntities[conversation.id][
      directMessage.id
    ]
    const communityBefore = useCommunityStore.getState().communityEntities[community.id]

    useMessageStore.getState().setMessages(channel.id, [structuredClone(channelMessage)])
    useChannelStore.getState().setChannels([
      structuredClone(channel),
      structuredClone(secondChannel),
    ])
    useDmStore.getState().setConversations([
      structuredClone(conversation),
      structuredClone(secondConversation),
    ])
    useDmStore.getState().mergeHistoricalMessages(conversation.id, [
      structuredClone(directMessage),
    ])
    useCommunityStore.getState().setCommunities([
      structuredClone(community),
      structuredClone(secondCommunity),
    ])

    expect(useMessageStore.getState().messageEntities[channel.id][channelMessage.id]).toBe(
      messageBefore,
    )
    expect(useMessageStore.getState().messages[channel.id][0]).toBe(messageBefore)
    expect(useChannelStore.getState().channelEntities[channel.id]).toBe(channelBefore)
    expect(useDmStore.getState().conversationEntities[conversation.id]).toBe(
      conversationBefore,
    )
    expect(useDmStore.getState().messageEntities[conversation.id][directMessage.id]).toBe(
      dmMessageBefore,
    )
    expect(useCommunityStore.getState().communityEntities[community.id]).toBe(
      communityBefore,
    )
  })

  it('still replaces an entity when a nested collection actually changes', () => {
    const messageBefore = useMessageStore.getState().messageEntities[channel.id][
      channelMessage.id
    ]

    useMessageStore.getState().setMessages(channel.id, [{
      ...structuredClone(channelMessage),
      reactions: { '👍': [member.publicKey, secondMember.publicKey] },
    }])

    const after = useMessageStore.getState().messageEntities[channel.id][channelMessage.id]
    expect(after).not.toBe(messageBefore)
    expect(after.reactions['👍']).toEqual([member.publicKey, secondMember.publicKey])
  })

  it('does not publish new state or entity identities for no-op patches and refreshes', () => {
    const communityBefore = useCommunityStore.getState()
    const channelBefore = useChannelStore.getState()
    const dmBefore = useDmStore.getState()
    const membershipBefore = useMembershipStore.getState()
    const listener = vi.fn()
    const unsubscribe = useCommunityStore.subscribe(listener)

    communityBefore.patchCommunity(community.id, { memberCount: community.memberCount })
    channelBefore.patchChannel(channel.id, { unreadCount: channel.unreadCount })
    dmBefore.patchConversation(conversation.id, { unreadCount: conversation.unreadCount })
    dmBefore.patchMessage(conversation.id, directMessage.id, { content: directMessage.content })
    membershipBefore.upsertMember(community.id, { ...member })
    membershipBefore.updateRole(community.id, member.publicKey, member.role)
    communityBefore.setCommunities([{ ...community }, { ...secondCommunity }])

    expect(useCommunityStore.getState()).toBe(communityBefore)
    expect(useChannelStore.getState()).toBe(channelBefore)
    expect(useDmStore.getState()).toBe(dmBefore)
    expect(useMembershipStore.getState()).toBe(membershipBefore)
    expect(useCommunityStore.getState().communityEntities[community.id]).toBe(community)
    expect(useChannelStore.getState().channelEntities[channel.id]).toBe(channel)
    expect(useDmStore.getState().conversationEntities[conversation.id]).toBe(conversation)
    expect(useDmStore.getState().messageEntities[conversation.id][directMessage.id]).toBe(
      directMessage,
    )
    expect(useMembershipStore.getState().memberEntities[community.id][member.publicKey]).toBe(
      member,
    )
    expect(listener).not.toHaveBeenCalled()
    unsubscribe()
  })

  it('patches one record without replacing order or unrelated entities', () => {
    const before = useCommunityStore.getState()
    const orderBefore = before.communityOrder
    const unrelatedBefore = before.communityEntities[secondCommunity.id]

    before.patchCommunity(community.id, { memberCount: 5 })

    const after = useCommunityStore.getState()
    expect(after.communityOrder).toBe(orderBefore)
    expect(after.communityEntities[secondCommunity.id]).toBe(unrelatedBefore)
    expect(after.communityEntities[community.id]).not.toBe(community)
    expect(after.communityEntities[community.id].memberCount).toBe(5)
    expect(after.communities.map((entry) => entry.id)).toEqual([
      community.id,
      secondCommunity.id,
    ])
  })

  it('preserves explicit collection order and uses documented insertion positions', () => {
    useCommunityStore.getState().setCommunities([secondCommunity, community])
    useChannelStore.getState().setChannels([secondChannel, channel])

    const newCommunity = { ...community, id: 'community-3', name: 'Music' }
    const newChannel = { ...channel, id: 'channel-3', name: 'music' }
    const newConversation = {
      ...conversation,
      id: 'dm-3',
      peers: [{ userId: '@new:example.test', displayName: 'Friend', avatarColor: '#000000' }],
    }
    useCommunityStore.getState().addCommunity(newCommunity)
    useChannelStore.getState().addChannel(newChannel)
    useDmStore.getState().upsertConversation(newConversation)

    expect(useCommunityStore.getState().communityOrder).toEqual([
      secondCommunity.id,
      community.id,
      newCommunity.id,
    ])
    expect(useChannelStore.getState().channelOrder).toEqual([
      secondChannel.id,
      channel.id,
      newChannel.id,
    ])
    expect(useDmStore.getState().conversationOrder).toEqual([
      newConversation.id,
      conversation.id,
      secondConversation.id,
    ])
  })

  it('keeps roster order stable while updating one normalized member', () => {
    const before = useMembershipStore.getState()
    const orderBefore = before.memberOrder[community.id]
    const unrelatedBefore = before.memberEntities[community.id][secondMember.publicKey]

    before.updateRole(community.id, member.publicKey, 'admin')

    const after = useMembershipStore.getState()
    expect(after.memberOrder[community.id]).toBe(orderBefore)
    expect(after.memberEntities[community.id][secondMember.publicKey]).toBe(unrelatedBefore)
    expect(after.memberEntities[community.id][member.publicKey].role).toBe('admin')
    expect(after.members[community.id].map((entry) => entry.publicKey)).toEqual([
      member.publicKey,
      secondMember.publicKey,
    ])
  })
})
