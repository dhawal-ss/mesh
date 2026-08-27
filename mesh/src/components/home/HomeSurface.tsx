import { useEffect, useMemo, useState } from 'react'
import { shouldExposeVoiceRoutes } from '../../lib/voice-runtime'
import { openCommandPalette, openPeopleCommandPalette } from '../../lib/command-palette'
import * as bridge from '../../lib/bridge'
import { useChannelStore } from '../../store/channels'
import { useCommunityStore } from '../../store/communities'
import { useDmStore } from '../../store/dms'
import { useIdentityStore } from '../../store/identity'
import { useMessageStore } from '../../store/messages'
import { useMeshNavigationStore } from '../../store/navigation'
import { isRoomSilenced, useSettingsStore } from '../../store/settings'
import { attentionFirst, calloutsFirst } from '../../lib/attention-ranking'
import { useShellStore } from '../../store/shell'
import { useNetworkStore, type MatrixLinkPhase } from '../../store/network'
import { useVoiceStore } from '../../store/voice'
import type { MeshRecentDestination, MeshRoute } from '../../lib/mesh-navigation'
import type { CommunityInviteDto } from '../../types/ipc'
import { dmPrimaryPeer } from '../../types/ipc'
import {
  resolveWaitingDirectRow,
  resolveWaitingRoomRow,
  rowAccessibleName,
  detailLine,
  safeActivitySummary,
  type ResolvedRecentRow,
} from '../../lib/inbox-rows'
import { Avatar } from '../ui/Avatar'
import { Button } from '../ui/Button'
import { Icon } from '../ui/Icon'
import { AmbientCard, SectionLabel } from '../ui/Primitives'
import { serverReach } from '../../lib/trust'
import { showToast } from '../ui/Toast'
import { EmptyState, SectionHeader } from '../ui/Primitives'

const PARTICIPANT_COLORS = [
  'var(--avatar-violet)',
  'var(--avatar-orange)',
  'var(--avatar-emerald)',
  'var(--avatar-cyan)',
] as const

/**
 * One sentence a screen reader can act on: who is asking, into what, and
 * whether Mesh will join it.
 */
export function communityInviteLabel(invite: CommunityInviteDto): string {
  const base = `${invite.inviterDisplayName} invited you to ${invite.name}`
  return invite.canAccept
    ? base
    : `${base}. This community is not end-to-end encrypted, so Mesh can only decline.`
}

/**
 * Invitations for this account to join a community.
 *
 * These come from the invited-rooms set, which nothing else surfaces: the DM
 * request list deliberately discards spaces, and the community rail lists only
 * joined rooms. The refetch key is the same membership event that keeps the
 * rail current, so an invitation appears when it arrives and leaves on
 * whichever device answered it.
 */
function useCommunityInvites() {
  const [invites, setInvites] = useState<CommunityInviteDto[]>([])
  const [busy, setBusy] = useState<{ roomId: string, action: 'accept' | 'decline' } | null>(null)

  useEffect(() => {
    if (!bridge.isTauriRuntime() || !bridge.isMatrixBackend()) return
    let disposed = false
    // A membership event landing while a fetch is in flight must trigger one
    // more fetch after it settles, or the event's change is silently missed. A
    // sequence number keeps a slower older snapshot from overwriting a newer
    // one, including the optimistic removals accept and decline perform.
    let inFlight = false
    let dirty = false
    let sequence = 0
    const refresh = () => {
      if (inFlight) {
        dirty = true
        return
      }
      inFlight = true
      const fetchSequence = ++sequence
      void bridge.getCommunityInvites()
        .then((next) => {
          if (!disposed && fetchSequence === sequence) setInvites(next)
        })
        .catch(() => {
          // Keep whatever was on screen; the next membership event retries.
        })
        .finally(() => {
          inFlight = false
          if (dirty && !disposed) {
            dirty = false
            refresh()
          }
        })
    }
    refresh()
    const unlisten = bridge.onMatrixCommunitiesChanged(refresh)
    return () => {
      disposed = true
      void unlisten.then((dispose) => dispose()).catch(() => {})
    }
  }, [])

  const accept = async (invite: CommunityInviteDto) => {
    setBusy({ roomId: invite.roomId, action: 'accept' })
    try {
      await bridge.acceptCommunityInvite(invite.roomId)
      setInvites((current) => current.filter((entry) => entry.roomId !== invite.roomId))
      showToast(`Joined ${invite.name}.`, 'success')
    } catch {
      showToast(`Mesh could not join ${invite.name}. Try again.`, 'error')
    } finally {
      setBusy(null)
    }
  }

  const decline = async (invite: CommunityInviteDto) => {
    setBusy({ roomId: invite.roomId, action: 'decline' })
    try {
      await bridge.declineCommunityInvite(invite.roomId)
      setInvites((current) => current.filter((entry) => entry.roomId !== invite.roomId))
    } catch {
      showToast(`Mesh could not decline this invitation. Try again.`, 'error')
    } finally {
      setBusy(null)
    }
  }

  return { invites, busy, accept, decline }
}

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
  const matrixLinkPhase = useNetworkStore((state) => state.matrixLink?.phase ?? null)
  const { invites, busy: inviteBusy, accept, decline } = useCommunityInvites()
  const emptyReason = homeEmptyReason(pendingInvitation != null, matrixLinkPhase)
  const foregroundPendingInvitation = useShellStore(
    (state) => state.foregroundPendingInvitation,
  )
  const showMessageContent = useSettingsStore(
    (state) => state.notifications.showMessageContent,
  )
  const notifications = useSettingsStore((state) => state.notifications)
  const recents = useMeshNavigationStore((state) => state.recents)
  const navigate = useMeshNavigationStore((state) => state.navigate)
  const matrixMode = bridge.isMatrixBackend()
  const voiceRoutesEnabled = shouldExposeVoiceRoutes(
    matrixMode,
    bridge.getBackendStatusSnapshot(),
  )
  const linkPhase = useNetworkStore((state) => state.matrixLink?.phase ?? null)
  const joinedCommunities = Object.values(communities)

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
        notifications,
      )
      if (
        !row
        || (!voiceRoutesEnabled && row.route.kind === 'voice')
        || seen.has(row.key)
      ) return []
      seen.add(row.key)
      return [row]
    })
  }, [
    channelEntities,
    channelMessages,
    communities,
    conversations,
    directMessages,
    notifications,
    recents,
    showMessageContent,
    voiceRoutesEnabled,
  ])

  /**
   * Rooms and conversations that are waiting on this person but have never been
   * opened on this device. Navigation recency is device-local, so without this
   * a fresh install, a reinstall, or a second device shows an empty Home while
   * the community rail carries unread badges.
   */
  const waitingRows = useMemo(() => {
    const alreadyListed = new Set(recentRows.map((row) => row.key))
    return [
      ...Object.values(channelEntities).flatMap((channel) => {
        if (channel.channelType !== 'text') return []
        const row = resolveWaitingRoomRow(
          channel,
          communities,
          channelMessages,
          showMessageContent,
          notifications,
        )
        return row && !alreadyListed.has(row.key) ? [row] : []
      }),
      ...Object.values(conversations).flatMap((conversation) => {
        const row = resolveWaitingDirectRow(
          conversation,
          directMessages,
          showMessageContent,
          notifications,
        )
        return row && !alreadyListed.has(row.key) ? [row] : []
      }),
    ].slice(0, MAX_WAITING_ROWS)
  }, [
    channelEntities,
    channelMessages,
    communities,
    conversations,
    directMessages,
    notifications,
    recentRows,
    showMessageContent,
  ])

  // Recents keep their navigation recency; only a callout jumps that queue.
  // Never-opened destinations follow, ordered by what is actually waiting.
  const homeRows = useMemo(() => [
    ...calloutsFirst(recentRows, isRowSilenced),
    ...attentionFirst(waitingRows, isRowSilenced),
  ], [recentRows, waitingRows])
  const [featuredRecent, ...remainingRecentRows] = homeRows

  const openRoute = (route: MeshRoute) => {
    if (route.kind === 'voice' && !voiceRoutesEnabled) return
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

  const leadsWithMessage = Boolean(featuredRecent?.preview)

  return (
    <section className="mesh-home-surface flex min-h-0 flex-1 flex-col overflow-hidden" aria-labelledby="mesh-home-heading">
      <header className="mesh-route-header mesh-home-header flex flex-shrink-0 items-center gap-3 border-b border-outline-variant px-5 py-2">
        <div className="min-w-0 flex-1">
          <SectionLabel className="mesh-surface-kicker block">Start here</SectionLabel>
          <h1
            id="mesh-home-heading"
            data-mesh-route-heading
            tabIndex={-1}
            className="mt-1 text-display-sm font-semibold text-on-surface outline-none"
          >
            Home
          </h1>
        </div>
        <Button variant="outline" size="sm" onClick={openCommandPalette}>
          <Icon name="search" size="sm" />
          Jump to…
          <span className="mesh-home-shortcut text-body-sm text-on-surface-variant">Ctrl K</span>
        </Button>
      </header>

      <div className="mesh-home-body min-h-0 flex-1 overflow-y-auto bg-surface pb-3 sm:pb-5">
        {invites.length > 0 && (
          /* Titled apart from the saved-invitation section below, which already
             owns the name "Invitations": HomeSection derives its heading id
             from the title, and two identical titles meant duplicate ids. */
          <HomeSection title="Community invitations" count={invites.length}>
            <div role="list">
              {invites.map((invite) => (
                /* listitem, because a plain div is not allowed an accessible
                   name and every screen reader would ignore the label. */
                <div
                  key={invite.roomId}
                  role="listitem"
                  className="flex items-center gap-3 border-b border-outline-variant px-5 py-3"
                  aria-label={communityInviteLabel(invite)}
                >
                  <Avatar color={invite.inviterAvatarColor} size={32} name={invite.name} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-semibold text-on-surface">{invite.name}</span>
                    <span className="mt-0.5 block truncate text-body-md text-on-surface-variant">
                      {invite.canAccept
                        ? `Invited by ${invite.inviterDisplayName}`
                        : `Invited by ${invite.inviterDisplayName}. Not end-to-end encrypted, so Mesh cannot join it.`}
                    </span>
                  </span>
                  {invite.canAccept && (
                    <Button
                      size="sm"
                      loading={inviteBusy?.roomId === invite.roomId && inviteBusy.action === 'accept'}
                      disabled={inviteBusy != null}
                      onClick={() => void accept(invite)}
                      aria-label={`Join ${invite.name}`}
                    >
                      Join
                    </Button>
                  )}
                  <Button
                    size="sm"
                    variant="ghost"
                    loading={inviteBusy?.roomId === invite.roomId && inviteBusy.action === 'decline'}
                    disabled={inviteBusy != null}
                    onClick={() => void decline(invite)}
                    aria-label={`Decline the invitation to ${invite.name}`}
                  >
                    Decline
                  </Button>
                </div>
              ))}
            </div>
          </HomeSection>
        )}
        {joinedCommunities.length === 0 ? (
          <div className="mesh-home-empty-wrap px-3 py-3 sm:px-5 sm:py-5">
            <EmptyState
              className="mesh-home-empty-state w-full max-w-2xl"
              eyebrow="Communities"
              markSeed={pendingInvitation?.handle ?? 'mesh-home'}
              markVariant={pendingInvitation ? 'community' : 'brand'}
              title={emptyReason === 'not-connected'
                ? 'Your communities have not loaded'
                : 'Start a conversation'}
              description={emptyReason === 'not-connected'
                ? 'Mesh is still reaching your account service.'
                : emptyReason === 'invitation'
                  ? 'Open your invitation to begin.'
                  : 'Join a community to begin.'}
              action={emptyReason === 'not-connected' ? undefined : (
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
                  {pendingInvitation ? 'Open invitation' : 'Join a community'}
                </Button>
              )}
            />
          </div>
        ) : (!voiceRoutesEnabled || liveParties.length === 0)
          && !pendingInvitation
          && homeRows.length === 0 ? (
          <div className="mesh-home-empty-wrap px-3 py-3 sm:px-5 sm:py-5">
            <EmptyState
              className="mesh-home-empty-state w-full max-w-2xl"
              eyebrow="Recent"
              markSeed={joinedCommunities[0].id}
              title="Quiet for now"
              description="Recent rooms, invitations, and live parties will collect here."
              action={(
                <div className="mesh-home-actions flex flex-wrap gap-2">
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
        <div>
        {/*
          Only when somebody actually is live. Nobody is in a call almost all of
          the time, and this section used to spend the top of the surface saying
          so, under a heading and a zero, offering "Keep chatting" as its action
          when the section immediately below is named exactly that.
        */}
        {voiceRoutesEnabled && liveParties.length > 0 && <HomeSection title="Live now" count={liveParties.length}>
          {liveParties.map(({ channel, community, members }) => {
            const alreadyConnected = currentVoiceRoom === channel.id
            return (
              <div key={channel.id} className="mesh-home-row flex items-center gap-3 border-b border-outline-variant">
                <div className="min-w-0 flex-1">
                  <p className="truncate font-semibold text-on-surface">{channel.name}</p>
                  <p className="truncate text-body-sm text-on-surface-variant">
                    {community.name} · {members.length} in call
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
                  variant="primary"
                  onClick={() => {
                    setDmMode(false)
                    setActiveCommunity(channel.communityId)
                    setActiveChannel(channel.id)
                    if (!alreadyConnected) {
                      setCurrentVoiceSession(channel.communityId, channel.id)
                    }
                    navigate({
                      kind: 'voice',
                      communityId: channel.communityId,
                      roomId: channel.id,
                    })
                  }}
                >
                  {alreadyConnected ? 'Open' : 'Join'}
                </Button>
              </div>
            )
          })}
        </HomeSection>}

        {/*
          A section that exists only to say it is empty outranks the strongest
          content on the surface, so it collapses instead. This matches the
          Live now section above, which has always been guarded this way.
        */}
        {pendingInvitation && <HomeSection title="Invitations" count={1}>
          <div className="mesh-home-row flex items-center gap-3 border-b border-outline-variant">
              <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center border border-outline-variant text-on-surface-variant">
                <Icon name="messageCircle" size="md" />
              </div>
              <div className="min-w-0 flex-1">
                <p className="truncate font-semibold text-on-surface">
                  {pendingInvitation.communityName?.trim() || 'Saved community invitation'}
                </p>
                <p className="truncate text-body-sm text-on-surface-variant">
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
        </HomeSection>}
        </div>

        {/*
          The pair switches together. When there is something worth quoting the
          message leads and the room supports it; when there is not, the room
          leads and the activity supports it. Mixing the two repeated the room
          name on both lines.
        */}
        {featuredRecent && (
          <button
            type="button"
            /*
              The one oversized target on the screen.

              Everything else on Home is a ledger row at 8px of vertical
              padding, which is what makes this one thing read as the answer to
              "where was I". It is the only place the accent appears on this
              surface.
            */
            className="mesh-home-feature grid gap-4 border-y border-outline-variant px-5 py-6 text-left transition-colors hover:bg-state-hover"
            onClick={() => openRoute(featuredRecent.route)}
          >
            <SectionLabel accent className="mesh-home-feature-index">
              {featuredRecent.lastOpenedAt === null ? 'Waiting' : 'Continue'}
              {featuredRecent.route.kind === 'direct'
                ? ' · Direct message'
                : featuredRecent.route.kind === 'voice'
                  ? ' · Voice'
                  : featuredRecent.route.kind === 'community'
                    ? ' · Community'
                    : ''}
            </SectionLabel>
            {/*
              The lead carries what was said, not what the room is called.
              `preview` is the same string `detail` is built from, already
              through the privacy gate, so turning previews off still reads
              "New activity" here rather than leaking content.
            */}
            <span className="mesh-home-feature-copy min-w-0">
              <span className="mesh-home-feature-title block truncate text-headline-md font-semibold text-on-surface">
                {leadsWithMessage ? featuredRecent.preview : featuredRecent.title}
              </span>
              <span
                data-home-feature-source
                className="mt-1 block truncate text-body-sm text-on-surface-variant"
              >
                {leadsWithMessage ? featuredRecent.source : featuredRecent.detail}
              </span>
            </span>
            <span className="mesh-home-feature-action inline-flex min-h-control-sm items-center gap-1.5 justify-self-start rounded-full bg-primary px-3 text-label-md font-semibold text-on-primary">
              Open
              <Icon name="arrowRight" size="sm" />
            </span>
            <span className="mesh-home-feature-meta flex items-center gap-3 text-label-sm text-on-surface-variant">
              {featuredRecent.unreadMentions > 0 && (
                <span className="text-error">
                  <span aria-hidden="true">@</span>
                  {Math.min(featuredRecent.unreadMentions, 999)}
                </span>
              )}
              {featuredRecent.unreadCount > 0 && (
                <span className="text-primary">{Math.min(featuredRecent.unreadCount, 999)} unread</span>
              )}
              {featuredRecent.lastOpenedAt !== null && (
                <time dateTime={new Date(featuredRecent.lastOpenedAt).toISOString()}>
                  {formatRecentTime(featuredRecent.lastOpenedAt)}
                </time>
              )}
            </span>
          </button>
        )}

        {/*
          The index collapses behind the continuation card rather than drawing a
          heading, a zero, and an empty state under the only thing on the
          surface. It still stands in when there is no card at all, which is the
          branch a live party or a saved invitation reaches.
        */}
        {(featuredRecent === undefined || remainingRecentRows.length > 0) && <HomeSection
          title={featuredRecent ? 'Also going on' : 'Recently open'}
          count={remainingRecentRows.length}
        >
          {remainingRecentRows.length === 0 ? (
            <HomeEmpty
              title={featuredRecent ? 'You are caught up' : 'Open a conversation'}
              detail={featuredRecent ? 'More recent rooms and direct messages will collect here.' : 'Rooms and direct messages you open will appear here.'}
            />
          ) : remainingRecentRows.map((row) => (
            <button
              key={row.key}
              type="button"
              className="mesh-home-row group flex w-full items-center gap-3 border-b border-outline-variant text-left transition-colors hover:bg-state-hover"
              onClick={() => openRoute(row.route)}
              aria-label={rowAccessibleName(row)}
            >
              {/*
                The number replaces the bordered icon tile. A ledger's rows are
                told apart by where they are, and the type glyph beside the name
                still says what kind of thing each one is.
              */}
              <Icon
                name={row.route.kind === 'direct' ? 'messageCircle' : row.route.kind === 'voice' ? 'volume' : 'hash'}
                size="xs"
                className="flex-none text-outline"
              />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-title-md font-medium text-on-surface">{row.title}</span>
                <span className="block truncate text-body-sm text-on-surface-variant">{row.detail}</span>
              </span>
              {/*
                Mentions and ordinary unreads stay separate indicators, and the
                mention badge carries an @ glyph, so neither the count nor the
                distinction depends on colour. This matches ChannelItem.
              */}
              {row.unreadMentions > 0 && (
                <span className="text-label-sm font-semibold text-error">
                  <span aria-hidden="true">@</span>
                  {Math.min(row.unreadMentions, 999)}
                </span>
              )}
              {row.unreadCount > 0 && (
                <span className="text-label-sm font-semibold text-primary">
                  {Math.min(row.unreadCount, 999)}
                </span>
              )}
              {row.lastOpenedAt !== null && (
                <time className="text-label-sm text-on-surface-variant" dateTime={new Date(row.lastOpenedAt).toISOString()}>
                  {formatRecentTime(row.lastOpenedAt)}
                </time>
              )}
            </button>
          ))}
        </HomeSection>}
        </>
        )}
      </div>

      {/*
        Home's ambient line states identity and reach.

        It is the one place in the product that answers "who am I here and how
        far does this account see", and it answers with values rather than
        prose: the account, its link state, and the number of servers and
        communities behind the ledger above.
      */}
      <AmbientCard className="">
        {[
          identity?.publicKey ?? null,
          LINK_PHASE_LABEL[linkPhase ?? 'online'],
          (() => {
            const reach = serverReach([
              identity?.publicKey ?? null,
              ...joinedCommunities.map((community) => community.id),
            ])
            return `${reach} ${reach === 1 ? 'server' : 'servers'}`
          })(),
          `${joinedCommunities.length} ${joinedCommunities.length === 1 ? 'community' : 'communities'}`,
        ].filter(Boolean).join(' \u00b7 ')}
      </AmbientCard>
    </section>
  )
}

export async function discardSavedInvitation(handle: string): Promise<boolean> {
  await bridge.clearPendingInvitation(handle)
  if (useShellStore.getState().pendingInvitation?.handle !== handle) return false
  useShellStore.getState().setPendingInvitation(null)
  return true
}

/*
  The link states, named the way a person would say them.

  A null phase is the legacy backend, which has no Matrix link to be in a state
  about, so it reads as connected rather than as an unknown.
*/
const LINK_PHASE_LABEL: Record<MatrixLinkPhase, string> = {
  online: 'Connected',
  reconnecting: 'Reconnecting',
  unreachable: 'Offline',
  'signed-out': 'Signed out',
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
  const headingId = `mesh-home-${title.toLocaleLowerCase().replace(/\s+/g, '-')}`
  return (
    <section
      className="mesh-home-section mt-5 overflow-hidden"
      aria-labelledby={headingId}
    >
      <SectionHeader
        id={headingId}
        headingLevel={2}
        title={title}
        count={count}
        className="border-b border-outline-variant px-5 py-2"
      />
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
  /** Only when a reader would act differently for having read it. */
  detail?: string
  action?: React.ReactNode
}) {
  return (
    <div className="border-b border-outline-variant px-5 py-4">
      <p className="font-semibold text-on-surface-variant">{title}</p>
      {detail && <p className="mt-1 text-body-md text-on-surface-variant">{detail}</p>}
      {action ? <div className="mt-3">{action}</div> : null}
    </div>
  )
}

/** Bounds how much never-opened work Home will surface behind the recents. */
const MAX_WAITING_ROWS = 8

const isRowSilenced = (row: ResolvedRecentRow) => row.silenced

function resolveRecentRow(
  recent: MeshRecentDestination,
  communities: ReturnType<typeof useCommunityStore.getState>['communityEntities'],
  channels: ReturnType<typeof useChannelStore.getState>['channelEntities'],
  conversations: ReturnType<typeof useDmStore.getState>['conversationEntities'],
  channelMessages: ReturnType<typeof useMessageStore.getState>['messages'],
  directMessages: ReturnType<typeof useDmStore.getState>['messages'],
  showMessageContent: boolean,
  notifications: ReturnType<typeof useSettingsStore.getState>['notifications'],
): ResolvedRecentRow | null {
  const { route, lastOpenedAt } = recent
  if (route.kind === 'direct') {
    const conversation = conversations[route.conversationId]
    if (!conversation) return null
    const conversationMessages = directMessages[conversation.id] ?? []
    const latest = conversationMessages[conversationMessages.length - 1]
    const summary = safeActivitySummary(
      showMessageContent,
      conversation.unreadCount,
      latest?.content,
      latest?.authorDisplayName,
    )
    return {
      key: `direct:${conversation.id}`,
      route,
      title: dmPrimaryPeer(conversation).displayName || 'Unknown account',
      detail: summary,
      preview: summary,
      source: dmPrimaryPeer(conversation).displayName || 'Unknown account',
      unreadCount: conversation.unreadCount,
      unreadMentions: conversation.unreadMentions ?? 0,
      unreadMarked: Boolean(conversation.unreadMarked),
      silenced: isRoomSilenced(notifications, conversation.id),
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
      detail: `${community.memberCount} members`,
      /*
        A community has no last message, so it has nothing to quote and the card
        leads with its name. This used to say "Choose a room", which is constant
        across every community and, being non-empty, made the feature card set an
        instruction in reading type and pushed the name down to the support line.
      */
      preview: '',
      source: `${community.name} · ${community.memberCount} members`,
      unreadCount: 0,
      unreadMentions: 0,
      unreadMarked: false,
      silenced: isRoomSilenced(notifications, community.id, community.id),
      lastOpenedAt,
    }
  }

  const channel = channels[route.roomId]
  const community = channel ? communities[channel.communityId] : undefined
  if (!channel || !community) return null
  const roomMessages = channelMessages[channel.id] ?? []
  const latest = roomMessages[roomMessages.length - 1]
  const activity = route.kind === 'voice'
    ? 'Voice room'
    : safeActivitySummary(
        showMessageContent,
        channel.unreadCount,
        latest?.content,
        latest?.authorDisplayName,
      )
  return {
    key: `${route.kind}:${channel.id}`,
    route,
    title: channel.name,
    detail: detailLine(community.name, activity),
    /*
      Empty when there is nothing real to quote. A row leaves the slot out, but
      the feature sets this in display type, where filler outranks the room
      name and says less than it does.
    */
    preview: activity,
    source: `${channel.name} in ${community.name}`,
    unreadCount: channel.unreadCount,
    unreadMentions: channel.unreadMentions ?? 0,
    unreadMarked: Boolean(channel.unreadMarked),
    silenced: isRoomSilenced(notifications, channel.id, channel.communityId),
    lastOpenedAt,
  }
}

/**
 * Why the community list is empty.
 *
 * An empty list is ambiguous. The account may genuinely have joined nothing, or
 * this device may not have reached the account service yet: `restore_session`
 * turns a network failure into a successful-but-empty local store, so an
 * offline start looks exactly like a brand new account. Telling someone to
 * "join a community to begin" in that case says their communities do not exist.
 */
export function homeEmptyReason(
  hasPendingInvitation: boolean,
  matrixLinkPhase: MatrixLinkPhase | null,
): 'not-connected' | 'invitation' | 'no-communities' {
  // `null` means the Matrix backend has published nothing yet, which is also
  // the legacy backend's permanent state, so it is not evidence of trouble.
  if (matrixLinkPhase != null && matrixLinkPhase !== 'online') return 'not-connected'
  if (hasPendingInvitation) return 'invitation'
  return 'no-communities'
}

function formatRecentTime(timestamp: number): string {
  const date = new Date(timestamp)
  const now = new Date()
  if (date.toDateString() === now.toDateString()) {
    return new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(date)
  }
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(date)
}
