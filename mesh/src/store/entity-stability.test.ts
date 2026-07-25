import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useChannelStore } from './channels'
import { useCommunityStore } from './communities'
import { useDmStore } from './dms'
import { useMembershipStore, type MemberRecord } from './membership'
import type { Channel, Community, DirectMessage, DmConversation } from '../types/ipc'

const community: Community = {
  id: 'community-1',
  name: 'Gaming',
  description: 'Friends',
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
  channelType: 'text',
  unreadCount: 0,
}

const secondChannel: Channel = {
  ...channel,
  id: 'channel-2',
  name: 'random',
}

const conversation: DmConversation = {
  id: 'dm-1',
  peerPublicKey: '@friend:example.test',
  peerDisplayName: 'Friend',
  peerAvatarColor: '#000000',
  lastMessageAt: null,
  unreadCount: 0,
  createdAt: '2026-07-25T00:00:00.000Z',
}

const secondConversation: DmConversation = {
  ...conversation,
  id: 'dm-2',
  peerPublicKey: '@second:example.test',
  peerDisplayName: 'Second',
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
      activeConversationId: null,
      isDmMode: true,
    })
    useMembershipStore.setState({
      memberEntities: {},
      memberOrder: {},
      members: {},
    })

    useCommunityStore.getState().setCommunities([community, secondCommunity])
    useChannelStore.getState().setChannels([channel, secondChannel])
    useDmStore.getState().setConversations([conversation, secondConversation])
    useDmStore.getState().addMessage(directMessage)
    useMembershipStore.getState().setRoster(community.id, [member, secondMember])
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
      peerPublicKey: '@new:example.test',
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
