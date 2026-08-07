import { useMemo } from 'react'
import { canStartMatrixVoice, shouldActivateVoiceSession } from '../../lib/voice-runtime'
import { openCommandPalette, openPeopleCommandPalette } from '../../lib/command-palette'
import * as bridge from '../../lib/bridge'
import { useChannelStore } from '../../store/channels'
import { useCommunityStore } from '../../store/communities'
import { useDmStore } from '../../store/dms'
import { useIdentityStore } from '../../store/identity'
import { useMessageStore } from '../../store/messages'
import { useMeshNavigationStore } from '../../store/navigation'
import { useSettingsStore } from '../../store/settings'
import { useShellStore } from '../../store/shell'
import { useVoiceStore } from '../../store/voice'
import type { MeshRecentDestination, MeshRoute } from '../../lib/mesh-navigation'
import { Avatar } from '../ui/Avatar'
import { Button } from '../ui/Button'
import { Icon } from '../ui/Icon'
import { showToast } from '../ui/Toast'
import { EmptyState } from '../ui/Primitives'

const PARTICIPANT_COLORS = [
  'var(--avatar-violet)',
  'var(--avatar-orange)',
  'var(--avatar-emerald)',
  'var(--avatar-cyan)',
] as const

export function HomeSurface() {
  const identity = useIdentityStore((state) => state.identity)
  const communities = useCommunityStore((state) => state.communityEntities)
  const channels = useChannelStore((state) => state.channels)
  const channelEntities = useChannelStore((state) => state.channelEntities)
  const setActiveChannel = useChannelStore((state) => state.setActiveChannel)
  const setActiveCommunity = useCommunityStore((state) => state.setActiveCommunity)
  const conversations = useDmStore((state) => state.conversationEntities)
  const setActiveConversation = useDmStore((state) => state.setActiveConversation)
  const setDmMode = useDmStore((state) => state.setDmMode)
  const channelMessages = useMessageStore((state) => state.messages)
  const directMessages = useDmStore((state) => state.messages)
  const membersByRoom = useVoiceStore((state) => state.matrixRtcMembersByRoom)
  const currentVoiceRoom = useVoiceStore((state) => state.currentChannelId)
  const voicePeers = useVoiceStore((state) => state.peers)
  const voiceConnectionState = useVoiceStore((state) => state.connectionState)
  const setCurrentVoiceSession = useVoiceStore((state) => state.setCurrentVoiceSession)
  const pendingInvitation = useShellStore((state) => state.pendingInvitation)
  const foregroundPendingInvitation = useShellStore(
    (state) => state.foregroundPendingInvitation,
  )
  const showMessageContent = useSettingsStore(
    (state) => state.notifications.showMessageContent,
  )
  const recents = useMeshNavigationStore((state) => state.recents)
  const navigate = useMeshNavigationStore((state) => state.navigate)
  const matrixMode = bridge.isMatrixBackend()
  const voiceReady = canStartMatrixVoice(bridge.getBackendStatusSnapshot())
  const joinedCommunities = Object.values(communities)
  const firstVoiceRoom = channels.find((channel) => channel.channelType === 'voice')
  const firstTextRoom = channels.find((channel) => channel.channelType === 'text')

  const liveParties = useMemo(() => channels
    .filter((channel) => channel.channelType === 'voice')
    .map((channel) => {
      const matrixMembers = membersByRoom[channel.id] ?? []
      const connectedSession = channel.id === currentVoiceRoom
        && ['connected', 'reconnecting', 'degraded'].includes(voiceConnectionState)
      const members = matrixMembers.length > 0
        ? matrixMembers.map((member, index) => ({
            key: `${member.userId}:${member.deviceId}:${member.sessionId}`,
            name: member.displayName || member.userId,
            imageUrl: member.avatarUrl,
            color: PARTICIPANT_COLORS[index % PARTICIPANT_COLORS.length],
          }))
        : connectedSession
          ? [
              ...(identity ? [{
                key: identity.publicKey,
                name: identity.displayName,
                imageUrl: identity.avatarUrl ?? null,
                color: identity.avatarColor,
              }] : []),
              ...voicePeers.map((peer, index) => ({
                key: peer.publicKey,
                name: peer.displayName,
                imageUrl: null,
                color: peer.avatarColor || PARTICIPANT_COLORS[index % PARTICIPANT_COLORS.length],
              })),
            ]
          : []
      return {
        channel,
        community: communities[channel.communityId],
        members,
      }
    })
    .filter((party) => party.community && party.members.length > 0)
    .sort((left, right) => right.members.length - left.members.length), [
    channels,
    communities,
    currentVoiceRoom,
    identity,
    membersByRoom,
    voiceConnectionState,
    voicePeers,
  ])

  const recentRows = useMemo(() => {
    const seen = new Set<string>()
    return recents.flatMap((recent) => {
      const row = resolveRecentRow(
        recent,
        communities,
        channelEntities,
        conversations,
        channelMessages,
        directMessages,
        showMessageContent,
      )
      if (!row || seen.has(row.key)) return []
      seen.add(row.key)
      return [row]
    })
  }, [
    channelEntities,
    channelMessages,
    communities,
    conversations,
    directMessages,
    recents,
    showMessageContent,
  ])

  const openRoute = (route: MeshRoute) => {
    if (route.kind === 'room') {
      setDmMode(false)
      setActiveCommunity(route.communityId)
      setActiveChannel(route.roomId)
    } else if (route.kind === 'direct') {
      setDmMode(true)
      setActiveConversation(route.conversationId)
    } else if (route.kind === 'voice' || route.kind === 'community') {
      setDmMode(false)
      setActiveCommunity(route.communityId)
      if (route.kind === 'voice') setActiveChannel(route.roomId)
    }
    navigate(route)
  }

  return (
    <section className="mesh-home-surface flex min-h-0 flex-1 flex-col overflow-hidden" aria-labelledby="mesh-home-heading">
      <header className="mesh-route-header mesh-home-header flex flex-shrink-0 items-center gap-3 border-b border-border-subtle px-party-gutter py-2">
        <div className="min-w-0 flex-1">
          <h1
            id="mesh-home-heading"
            data-mesh-route-heading
            tabIndex={-1}
            className="text-title font-semibold tracking-tight text-primary outline-none"
          >
            Home
          </h1>
          <p className="truncate text-meta text-muted">
            {identity?.displayName ? `Ready when you are, ${identity.displayName}.` : 'Ready when you are.'}
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={openCommandPalette}>
          <Icon name="search" size="sm" />
          Jump to…
          <span className="font-mono text-meta text-muted">Ctrl K</span>
        </Button>
      </header>

      <div className="mesh-home-body min-h-0 flex-1 overflow-y-auto pb-3 sm:pb-5">
        {joinedCommunities.length === 0 ? (
          <div className="mesh-home-empty-wrap flex min-h-full items-center justify-center p-6 sm:p-10">
            <EmptyState
              className="mesh-home-empty-state w-full max-w-2xl rounded-lg border border-border-subtle bg-surface-raised"
              icon={<Icon name="headphones" size="lg" />}
              title="Your next party starts here"
              description="Open an invitation or find a community built around the games you play."
              action={(
                <Button
                  onClick={() => {
                    if (pendingInvitation) {
                      foregroundPendingInvitation()
                      navigate({ kind: 'invitation', handle: pendingInvitation.handle })
                    } else {
                      navigate({ kind: 'communities', mode: 'join' })
                    }
                  }}
                >
                  Open an invitation
                </Button>
              )}
            />
          </div>
        ) : liveParties.length === 0 && !pendingInvitation && recentRows.length === 0 ? (
          <div className="mesh-home-empty-wrap flex min-h-full items-center justify-center p-6 sm:p-10">
            <EmptyState
              className="mesh-home-empty-state w-full max-w-2xl rounded-lg border border-border-subtle bg-surface-raised"
              icon={<Icon name="headphones" size="lg" />}
              title="Quiet for now"
              description="Recent rooms, invitations, and live parties will collect here."
              action={(
                <div className="flex flex-wrap justify-center gap-2">
                  <Button
                    onClick={() => openRoute({ kind: 'community', communityId: joinedCommunities[0].id })}
                  >
                    Open {joinedCommunities[0].name}
                  </Button>
                  <Button
                    variant="secondary"
                    onClick={openPeopleCommandPalette}
                  >
                    Start a direct message
                  </Button>
                </div>
              )}
            />
          </div>
        ) : (
        <>
        <div className="grid items-stretch lg:grid-cols-2">
        <HomeSection title="Live now" count={liveParties.length}>
          {liveParties.length === 0 ? (
            <HomeEmpty
              title="No parties live right now"
              detail="Open a voice room and your crew can drop in."
              action={firstVoiceRoom && shouldActivateVoiceSession(matrixMode, voiceReady) ? (
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => openRoute({
                    kind: 'voice',
                    communityId: firstVoiceRoom.communityId,
                    roomId: firstVoiceRoom.id,
                  })}
                >
                  Open {firstVoiceRoom.name}
                </Button>
              ) : firstTextRoom ? (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => openRoute({
                    kind: 'room',
                    communityId: firstTextRoom.communityId,
                    roomId: firstTextRoom.id,
                  })}
                >
                  Keep chatting
                </Button>
              ) : undefined}
            />
          ) : liveParties.map(({ channel, community, members }) => {
            const alreadyConnected = currentVoiceRoom === channel.id
            const canJoin = shouldActivateVoiceSession(matrixMode, voiceReady)
            return (
              <div key={channel.id} className="mesh-home-row">
                <div className="min-w-0 flex-1">
                  <p className="truncate font-semibold text-primary">{channel.name}</p>
                  <p className="truncate text-meta text-muted">
                    {community.name} · {members.length} in party
                  </p>
                </div>
                <div className="flex -space-x-1" aria-label={`${members.length} in ${channel.name}`}>
                  {members.slice(0, 4).map((member) => (
                    <Avatar
                      key={member.key}
                      color={member.color}
                      size={28}
                      name={member.name}
                      imageUrl={member.imageUrl}
                    />
                  ))}
                </div>
                <Button
                  size="sm"
                  variant={alreadyConnected || canJoin ? 'primary' : 'outline'}
                  onClick={() => {
                    setDmMode(false)
                    setActiveCommunity(channel.communityId)
                    setActiveChannel(channel.id)
                    if (!alreadyConnected && canJoin) {
                      setCurrentVoiceSession(channel.communityId, channel.id)
                    }
                    navigate({
                      kind: 'voice',
                      communityId: channel.communityId,
                      roomId: channel.id,
                    })
                  }}
                >
                  {alreadyConnected ? 'Open' : canJoin ? 'Join' : 'Voice unavailable'}
                </Button>
              </div>
            )
          })}
        </HomeSection>

        <HomeSection title="Invitations" count={pendingInvitation ? 1 : 0}>
          {pendingInvitation ? (
            <div className="mesh-home-row">
              <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center border border-border-subtle text-accent">
                <Icon name="messageCircle" size="md" />
              </div>
              <div className="min-w-0 flex-1">
                <p className="truncate font-semibold text-primary">
                  {pendingInvitation.communityName?.trim() || 'Saved community invitation'}
                </p>
                <p className="truncate text-meta text-muted">
                  Review the destination and choose where your account lives.
                </p>
              </div>
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  foregroundPendingInvitation()
                  navigate({ kind: 'invitation', handle: pendingInvitation.handle })
                }}
              >
                Review
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  const handle = pendingInvitation.handle
                  void discardSavedInvitation(handle).then((discarded) => {
                    if (discarded) showToast('Invitation discarded.', 'success')
                  }).catch(() => {
                    showToast('Mesh could not discard this invitation. Try again.', 'error')
                  })
                }}
              >
                Discard
              </Button>
            </div>
          ) : (
            <HomeEmpty
              title="No saved invitations"
              detail="Invitations you keep for later will stay here without exposing their private link."
            />
          )}
        </HomeSection>
        </div>

        <HomeSection title="Recent conversations" count={recentRows.length}>
          {recentRows.length === 0 ? (
            <HomeEmpty
              title="Nothing recent yet"
              detail="Rooms and private conversations you open will stay close at hand."
            />
          ) : recentRows.map((row) => (
            <button
              key={row.key}
              type="button"
              className="mesh-home-row w-full text-left hover:bg-surface-hover"
              onClick={() => openRoute(row.route)}
            >
              <span className="flex h-9 w-9 flex-shrink-0 items-center justify-center border border-border-subtle text-secondary">
                <Icon name={row.route.kind === 'direct' ? 'messageCircle' : row.route.kind === 'voice' ? 'volume' : 'hash'} size="md" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate font-semibold text-primary">{row.title}</span>
                <span className="block truncate text-meta text-muted">{row.detail}</span>
              </span>
              {row.unread > 0 && (
                <span className="font-mono text-meta text-accent">{Math.min(row.unread, 999)}</span>
              )}
              <time className="font-mono text-meta text-muted" dateTime={new Date(row.lastOpenedAt).toISOString()}>
                {formatRecentTime(row.lastOpenedAt)}
              </time>
            </button>
          ))}
        </HomeSection>
        </>
        )}
      </div>
    </section>
  )
}

export async function discardSavedInvitation(handle: string): Promise<boolean> {
  await bridge.clearPendingInvitation(handle)
  if (useShellStore.getState().pendingInvitation?.handle !== handle) return false
  useShellStore.getState().setPendingInvitation(null)
  return true
}

function HomeSection({
  title,
  count,
  children,
}: {
  title: string
  count: number
  children: React.ReactNode
}) {
  return (
    <section
      className="mx-3 mt-3 overflow-hidden rounded-lg border border-border-subtle bg-surface-raised sm:mx-5 sm:mt-5"
      aria-labelledby={`mesh-home-${title.toLocaleLowerCase().replace(/\s+/g, '-')}`}
    >
      <div className="flex items-center gap-2 border-b border-border-subtle px-party-gutter py-2">
        <h2
          id={`mesh-home-${title.toLocaleLowerCase().replace(/\s+/g, '-')}`}
          className="text-caption font-semibold uppercase tracking-eyebrow text-secondary"
        >
          {title}
        </h2>
        <span className="font-mono text-meta text-muted">{count}</span>
      </div>
      <div>{children}</div>
    </section>
  )
}

function HomeEmpty({
  title,
  detail,
  action,
}: {
  title: string
  detail: string
  action?: React.ReactNode
}) {
  return (
    <div className="border-b border-border-subtle px-party-gutter py-4">
      <p className="font-semibold text-secondary">{title}</p>
      <p className="mt-1 text-sm text-muted">{detail}</p>
      {action ? <div className="mt-3">{action}</div> : null}
    </div>
  )
}

interface ResolvedRecentRow {
  key: string
  route: MeshRecentDestination['route']
  title: string
  detail: string
  unread: number
  lastOpenedAt: number
}

function resolveRecentRow(
  recent: MeshRecentDestination,
  communities: ReturnType<typeof useCommunityStore.getState>['communityEntities'],
  channels: ReturnType<typeof useChannelStore.getState>['channelEntities'],
  conversations: ReturnType<typeof useDmStore.getState>['conversationEntities'],
  channelMessages: ReturnType<typeof useMessageStore.getState>['messages'],
  directMessages: ReturnType<typeof useDmStore.getState>['messages'],
  showMessageContent: boolean,
): ResolvedRecentRow | null {
  const { route, lastOpenedAt } = recent
  if (route.kind === 'direct') {
    const conversation = conversations[route.conversationId]
    if (!conversation) return null
    const conversationMessages = directMessages[conversation.id] ?? []
    const latest = conversationMessages[conversationMessages.length - 1]
    return {
      key: `direct:${conversation.id}`,
      route,
      title: conversation.peerDisplayName || 'Private conversation',
      detail: safeActivitySummary(
        showMessageContent,
        conversation.unreadCount,
        latest?.content,
        latest?.authorDisplayName,
      ),
      unread: conversation.unreadCount,
      lastOpenedAt,
    }
  }

  if (route.kind === 'community') {
    const community = communities[route.communityId]
    if (!community) return null
    return {
      key: `community:${community.id}`,
      route,
      title: community.name,
      detail: `${community.memberCount} members · Choose a room`,
      unread: 0,
      lastOpenedAt,
    }
  }

  const channel = channels[route.roomId]
  const community = channel ? communities[channel.communityId] : undefined
  if (!channel || !community) return null
  const roomMessages = channelMessages[channel.id] ?? []
  const latest = roomMessages[roomMessages.length - 1]
  return {
    key: `${route.kind}:${channel.id}`,
    route,
    title: channel.name,
    detail: route.kind === 'voice'
      ? `${community.name} · Voice room`
      : `${community.name} · ${safeActivitySummary(
          showMessageContent,
          channel.unreadCount,
          latest?.content,
          latest?.authorDisplayName,
        )}`,
    unread: channel.unreadCount,
    lastOpenedAt,
  }
}

export function safeActivitySummary(
  showMessageContent: boolean,
  unreadCount: number,
  content?: string,
  author?: string,
): string {
  if (unreadCount > 0 && !showMessageContent) return 'New activity'
  const summary = content?.replace(/\s+/g, ' ').trim()
  if (!summary) return unreadCount > 0 ? 'New activity' : 'Open conversation'
  const bounded = summary.slice(0, 120)
  return author ? `${author}: ${bounded}` : bounded
}

function formatRecentTime(timestamp: number): string {
  const date = new Date(timestamp)
  const now = new Date()
  if (date.toDateString() === now.toDateString()) {
    return new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(date)
  }
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(date)
}
