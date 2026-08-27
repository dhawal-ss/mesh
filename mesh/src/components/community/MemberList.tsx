import { memo, useCallback, useEffect, useMemo, useState } from 'react'
import { Avatar } from '../ui/Avatar'
import { serverName, serverRelation } from '../../lib/trust'
import { AmbientNote } from '../ui/QuietStructure'
import { useActiveCommunity, useCommunityStore } from '../../store/communities'
import { useIdentityStore } from '../../store/identity'
import { useMembershipStore } from '../../store/membership'
import { useDmStore } from '../../store/dms'
import * as bridge from '../../lib/bridge'
import { summarizeModerationResult } from '../../lib/moderation'
import { showToast } from '../ui/Toast'
import { Icon } from '../ui/Icon'
import { DropdownMenu, Popover, type MenuItem } from '../ui/InteractivePrimitives'
import { EmptyState, SectionHeader } from '../ui/Primitives'
import { useVirtualScroll, type VirtualItem } from '../../hooks/useVirtualScroll'
import { Modal } from '../ui/Modal'
import { Button } from '../ui/Button'
import { ErrorState } from '../ui/ErrorState'
import { describeError, errorLine } from '../../lib/errors'
import {
  sequenceCardPositionFromNeighbors,
  sequenceCardProps,
  type SequenceCardPosition,
} from '../ui/SequenceCard'
import {
  evaluateAuthoritativeCommunityRoleAssignment,
  type CommunityPermissionProjection,
  type CommunityRole,
} from '../../lib/community-permissions'
import {
  RolePermissionPreview,
  type RolePermissionEvidence,
} from './RolePermissionPreview'
import { memberDisambiguationHandle } from '../../lib/member-handle'

interface MemberEntry {
  publicKey: string
  displayName: string
  avatarColor: string
  avatarUrl?: string | null
  role: 'owner' | 'admin' | 'member'
  online: boolean
  joinStatus?: 'invited' | 'joined' | 'left'
  banStatus?: 'none' | 'banned'
}

interface MemberListProps {
  isOpen: boolean
  onClose: () => void
  members: MemberEntry[]
  embedded?: boolean
  rolePermissionProjection?: CommunityPermissionProjection
  rolePermissionsLoading?: boolean
  onRetryRolePermissions?: () => void
  onOpenPermissionDiagnostics?: () => void
}

const ROLE_ORDER = { owner: 0, admin: 1, member: 2 } as const
export const memberListRenderMetrics = {
  rows: 0,
  reset() { this.rows = 0 },
  record() { this.rows += 1 },
}
type MemberListEntry =
  | { key: string; kind: 'heading'; label: string; count: number }
  | { key: string; kind: 'member'; member: MemberEntry }
type PendingModeration = {
  action: 'remove' | 'ban' | 'unban'
  member: MemberEntry
}
const MODERATION_COPY = {
  remove: {
    verb: 'Remove',
    confirm: 'Remove member',
    operation: 'remove',
    description: 'They will lose access to this community but may be able to rejoin later.',
  },
  ban: {
    verb: 'Ban',
    confirm: 'Ban member',
    operation: 'ban',
    description: 'They will be removed and prevented from rejoining until an administrator lifts the ban.',
  },
  unban: {
    verb: 'Lift the ban on',
    confirm: 'Lift ban',
    operation: 'lift the ban on',
    description: 'They will be free to rejoin, but Mesh does not add them back.',
  },
} as const
type PendingRoleChange = {
  member: MemberEntry
  nextRole: Extract<CommunityRole, 'admin' | 'member'>
}
/** owner outranks admin outranks member. Higher acts on lower, never on equal. */
const ROLE_RANK: Record<string, number> = { owner: 3, admin: 2, member: 1 }

type MemberRowActions = {
  currentUserId?: string | null
  canModerate: boolean
  /** The acting account's own role, used to refuse peer moderation. */
  actorRole?: string | null
  canManageRoles: boolean
  /**
   * Explaining a permission is read-only, so it is deliberately not gated on
   * `canManageRoles`. D5 keeps Matrix role *changes* failing closed; it does
   * not stop Mesh from answering why someone cannot post.
   */
  canExplainPermissions: boolean
  directMessages: boolean
  onRole: (
    member: MemberEntry,
    role: PendingRoleChange['nextRole'],
  ) => Promise<void>
  onKick: (member: MemberEntry) => Promise<void>
  onBan: (member: MemberEntry) => Promise<void>
  onUnban: (member: MemberEntry) => Promise<void>
  onDm: (member: MemberEntry) => Promise<void>
  onRequestModeration: (action: PendingModeration['action'], member: MemberEntry) => void
  onRequestRole: (member: MemberEntry) => void
  onExplainPermissions: (member: MemberEntry) => void
}

export function MemberList({
  isOpen,
  members,
  embedded = false,
  rolePermissionProjection,
  rolePermissionsLoading = false,
  onRetryRolePermissions,
  onOpenPermissionDiagnostics,
}: MemberListProps) {
  const memberLabel = useCallback((member: MemberEntry) => {
    const handle = memberDisambiguationHandle(member, members)
    return handle ? `${member.displayName} (${handle})` : member.displayName
  }, [members])
  const activeCommunityId = useCommunityStore((state) => state.activeCommunityId)
  const activeCommunity = useActiveCommunity()
  const legacyUserId = useIdentityStore((state) => state.identity?.publicKey)
  const currentUserId = bridge.isMatrixBackend() ? bridge.getMatrixUserId() : legacyUserId
  const updateRole = useMembershipStore((state) => state.updateRole)
  const removeMember = useMembershipStore((state) => state.removeMember)
  const banMember = useMembershipStore((state) => state.banMember)
  const unbanMember = useMembershipStore((state) => state.unbanMember)
  const setRosterPage = useMembershipStore((state) => state.setRosterPage)
  const rosterNextCursor = useMembershipStore((state) => (
    activeCommunityId ? state.rosterNextCursor[activeCommunityId] ?? null : null
  ))
  const rosterStateComplete = useMembershipStore((state) => (
    activeCommunityId ? state.rosterStateComplete[activeCommunityId] ?? true : true
  ))
  const upsertConversation = useDmStore((state) => state.upsertConversation)
  const setActiveConversation = useDmStore((state) => state.setActiveConversation)
  const setDmMode = useDmStore((state) => state.setDmMode)
  const [pendingModeration, setPendingModeration] = useState<PendingModeration | null>(null)
  const [pendingRoleChange, setPendingRoleChange] = useState<PendingRoleChange | null>(null)
  const [permissionMember, setPermissionMember] = useState<MemberEntry | null>(null)
  const [moderationBusy, setModerationBusy] = useState(false)
  const [moderationError, setModerationError] = useState<unknown | null>(null)
  const [roleBusy, setRoleBusy] = useState(false)
  const [roleError, setRoleError] = useState<unknown | null>(null)
  const [rosterBusy, setRosterBusy] = useState(false)
  const [rosterError, setRosterError] = useState<unknown | null>(null)
  const [query, setQuery] = useState('')
  const canModerate = activeCommunity?.role === 'owner' || activeCommunity?.role === 'admin'
  // Owner decision D5 keeps Matrix administrator-role changes failing closed
  // until provider-backed reauthentication exists, and D17 requires that
  // behaviour to remain. The permission projection this control depends on only
  // ever loads on Matrix, so the control could only appear in the one build that
  // refuses it. Offering it was a guaranteed dead end, so it is not offered.
  // Remove this clause when D5 is satisfied; the backend path is already built.
  const canManageRoles = activeCommunity?.role === 'owner'
    && !bridge.isMatrixBackend()
    && Boolean(rolePermissionProjection && currentUserId)
  // Reading a permission is not changing one. This stays available on Matrix,
  // where the role control above is deliberately withheld, because "why can't
  // this person post here?" is exactly the question that has no other answer.
  const canExplainPermissions = Boolean(rolePermissionProjection) || rolePermissionsLoading
  const actions = useMemo<MemberRowActions | undefined>(() => activeCommunityId
    ? ({
        currentUserId,
        canModerate,
        actorRole: activeCommunity?.role ?? null,
        canManageRoles,
        canExplainPermissions,
        directMessages: bridge.isMatrixBackend() && bridge.getBackendCapabilities().directMessages,
        onRole: async (
          member: MemberEntry,
          role: PendingRoleChange['nextRole'],
        ) => {
          const result = await bridge.updateMemberRole(activeCommunityId, member.publicKey, role)
          const summary = summarizeModerationResult(
            result,
            `${memberLabel(member)} is now ${role === 'admin' ? 'an administrator' : 'a member'}`,
          )
          if (summary.serverSucceeded) {
            updateRole(activeCommunityId, member.publicKey, role)
          }
          showToast(summary.message, summary.tone)
          onRetryRolePermissions?.()
        },
        onKick: async (member: MemberEntry) => {
          const result = await bridge.kickUser(activeCommunityId, member.publicKey)
          const summary = summarizeModerationResult(result, `${memberLabel(member)} was removed`)
          if (summary.serverSucceeded) {
            removeMember(activeCommunityId, member.publicKey)
          }
          showToast(summary.message, summary.tone)
        },
        onBan: async (member: MemberEntry) => {
          const result = await bridge.banUser(activeCommunityId, member.publicKey)
          const summary = summarizeModerationResult(result, `${memberLabel(member)} was banned`)
          if (summary.serverSucceeded) {
            banMember(activeCommunityId, member.publicKey)
          }
          showToast(summary.message, summary.tone)
        },
        onUnban: async (member: MemberEntry) => {
          const result = await bridge.unbanUser(activeCommunityId, member.publicKey)
          const summary = summarizeModerationResult(
            result,
            `The ban on ${memberLabel(member)} was lifted`,
          )
          if (summary.serverSucceeded) {
            unbanMember(activeCommunityId, member.publicKey)
          }
          showToast(summary.message, summary.tone)
        },
        onDm: async (member: MemberEntry) => {
          try {
            const conversation = await bridge.ensureDm(member.publicKey)
            upsertConversation(conversation)
            setActiveConversation(conversation.id)
            setDmMode(true)
          } catch (error) {
            const description = describeError(error, {
              operation: `open a conversation with ${member.displayName}`,
              resource: 'conversation',
            })
            showToast(errorLine(description), 'error')
          }
        },
        onRequestModeration: (action: PendingModeration['action'], member: MemberEntry) => {
          setModerationError(null)
          setPendingModeration({ action, member })
        },
        onRequestRole: (member: MemberEntry) => {
          const nextRole = member.role === 'admin' ? 'member' : 'admin'
          setRoleError(null)
          setPendingRoleChange({ member, nextRole })
          onRetryRolePermissions?.()
        },
        onExplainPermissions: (member: MemberEntry) => {
          setPermissionMember(member)
          onRetryRolePermissions?.()
        },
      })
    : undefined, [
    activeCommunity?.role,
    activeCommunityId,
    banMember,
    canExplainPermissions,
    canManageRoles,
    canModerate,
    currentUserId,
    memberLabel,
    onRetryRolePermissions,
    removeMember,
    setActiveConversation,
    setDmMode,
    unbanMember,
    updateRole,
    upsertConversation,
  ])

  const confirmModeration = async () => {
    if (!pendingModeration || !actions) return
    setModerationBusy(true)
    setModerationError(null)
    try {
      if (pendingModeration.action === 'ban') {
        await actions.onBan(pendingModeration.member)
      } else if (pendingModeration.action === 'unban') {
        await actions.onUnban(pendingModeration.member)
      } else {
        await actions.onKick(pendingModeration.member)
      }
      setPendingModeration(null)
    } catch (error) {
      setModerationError(error)
    } finally {
      setModerationBusy(false)
    }
  }

  const confirmRoleChange = async () => {
    if (!pendingRoleChange || !actions) return
    if (!rolePermissionProjection || !currentUserId) {
      setRoleError(new Error('Unable to verify permissions before applying this role.'))
      return
    }
    const decision = evaluateAuthoritativeCommunityRoleAssignment({
      projection: rolePermissionProjection,
      actorUserId: currentUserId,
      targetUserId: pendingRoleChange.member.publicKey,
      nextRole: pendingRoleChange.nextRole,
    })
    if (!decision.allowed) {
      setRoleError(new Error(decision.reason ?? 'This role change is not permitted.'))
      return
    }
    setRoleBusy(true)
    setRoleError(null)
    try {
      await actions.onRole(pendingRoleChange.member, pendingRoleChange.nextRole)
      setPendingRoleChange(null)
    } catch (error) {
      setRoleError(error)
    } finally {
      setRoleBusy(false)
    }
  }

  const loadMoreMembers = async () => {
    if (!activeCommunityId || !rosterNextCursor || rosterBusy) return
    setRosterBusy(true)
    setRosterError(null)
    try {
      const page = await bridge.getMemberPage(activeCommunityId, rosterNextCursor)
      setRosterPage(
        activeCommunityId,
        page.members.map((member) => ({
          publicKey: member.publicKey,
          displayName: member.displayName,
          avatarColor: member.avatarColor,
          avatarUrl: member.avatarUrl,
          role: member.role as MemberEntry['role'],
          joinStatus: (member.joinStatus as 'invited' | 'joined' | 'left') ?? 'joined',
          banStatus: (member.banStatus as 'none' | 'banned') ?? 'none',
          lastSeen: member.lastSeen,
          online: member.online ?? false,
        })),
        page.nextCursor,
        page.stateComplete,
        true,
      )
    } catch (error) {
      setRosterError(error)
    } finally {
      setRosterBusy(false)
    }
  }

  const rolePermissionEvidence: RolePermissionEvidence = rolePermissionsLoading
    ? { kind: 'loading' }
    : rolePermissionProjection && pendingRoleChange
      ? {
          kind: 'proposed',
          projection: rolePermissionProjection,
          userId: pendingRoleChange.member.publicKey,
        }
      : {
          kind: 'unavailable',
          onRetry: onRetryRolePermissions,
          onDiagnostics: onOpenPermissionDiagnostics ?? (() => {
            setRoleError(new Error(
              'Permission details are unavailable. Try again once the connection is back.',
            ))
          }),
        }

  const permissionEvidence: RolePermissionEvidence = rolePermissionsLoading
    ? { kind: 'loading' }
    : rolePermissionProjection && permissionMember
      ? {
          kind: 'current',
          projection: rolePermissionProjection,
          userId: permissionMember.publicKey,
        }
      : {
          kind: 'unavailable',
          message: 'Mesh could not read this community’s permissions.',
          onRetry: onRetryRolePermissions,
          onDiagnostics: onOpenPermissionDiagnostics ?? (() => {}),
        }

  const currentMembers = useMemo(() => members.filter((member) => (
    (member.joinStatus ?? 'joined') === 'joined'
    && (member.banStatus ?? 'none') === 'none'
  )), [members])
  const memberHandles = useMemo(() => new Map(
    currentMembers.map((member) => [
      member.publicKey,
      memberDisambiguationHandle(member, currentMembers),
    ]),
  ), [currentMembers])
  const sorted = useMemo(() => [...currentMembers].sort((a, b) => {
    const roleSort = ROLE_ORDER[a.role] - ROLE_ORDER[b.role]
    if (roleSort !== 0) return roleSort
    if (a.online !== b.online) return a.online ? -1 : 1
    return a.displayName.localeCompare(b.displayName)
  }), [currentMembers])
  const filtered = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase()
    if (!normalizedQuery) return sorted
    return sorted.filter((member) => (
      member.displayName.toLocaleLowerCase().includes(normalizedQuery)
      || member.publicKey.toLocaleLowerCase().includes(normalizedQuery)
    ))
  }, [query, sorted])

  // Banned accounts are hidden from the everyday roster and listed only where an
  // administrator can act on them, so a ban never becomes silently permanent.
  const banned = useMemo(() => {
    if (!embedded || !canModerate) return []
    const normalizedQuery = query.trim().toLocaleLowerCase()
    return members
      .filter((member) => (member.banStatus ?? 'none') === 'banned')
      .filter((member) => !normalizedQuery
        || member.displayName.toLocaleLowerCase().includes(normalizedQuery)
        || member.publicKey.toLocaleLowerCase().includes(normalizedQuery))
      .sort((a, b) => a.displayName.localeCompare(b.displayName))
  }, [canModerate, embedded, members, query])

  // Group: online vs offline, then by role within each
  const { online, offline } = useMemo(() => ({
    online: filtered.filter((member) => member.online),
    offline: filtered.filter((member) => !member.online),
  }), [filtered])
  /*
    Whether the legend has anything to explain.

    Rendered from the same derivation the rings use, so the sentence cannot
    appear on a list with no rings on it, and cannot be missing from one that
    has them.
  */
  const hasRemoteMembers = useMemo(
    () => bridge.isMatrixBackend()
      && members.some((member) => serverRelation(member.publicKey, currentUserId) === 'remote'),
    [currentUserId, members],
  )

  const listEntries = useMemo<MemberListEntry[]>(() => {
    const entries: MemberListEntry[] = []
    if (online.length > 0) {
      entries.push({ key: 'heading:online', kind: 'heading', label: 'Online', count: online.length })
      for (const member of online) {
        entries.push({ key: `member:${member.publicKey}`, kind: 'member', member })
      }
    }
    if (offline.length > 0) {
      entries.push({ key: 'heading:offline', kind: 'heading', label: 'Offline', count: offline.length })
      for (const member of offline) {
        entries.push({ key: `member:${member.publicKey}`, kind: 'member', member })
      }
    }
    if (banned.length > 0) {
      entries.push({ key: 'heading:banned', kind: 'heading', label: 'Banned', count: banned.length })
      for (const member of banned) {
        entries.push({ key: `banned:${member.publicKey}`, kind: 'member', member })
      }
    }
    return entries
  }, [banned, offline, online])
  const virtualItems = useMemo<VirtualItem[]>(() => listEntries.map((entry) => ({
    key: entry.key,
    type: entry.kind === 'heading' ? 'gap' : 'message',
    // 32px is the shared SectionHeader row (`min-h-8`); keep the virtual
    // geometry and the rendered header in step or the list drifts as it scrolls.
    height: entry.kind === 'heading' ? 32 : 44,
  })), [listEntries])
  const {
    scrollContainerRef,
    topSpacerHeight,
    bottomSpacerHeight,
    visibleRange,
    handleScroll,
    scrollToItem,
  } = useVirtualScroll(virtualItems, {
    estimatedMessageHeight: 44,
    estimatedGapHeight: 32,
    overscanPx: 800,
    autoScrollToBottom: false,
  })
  const visibleEntries = useMemo(
    () => listEntries.length === 0
      ? []
      : listEntries.slice(visibleRange.start, visibleRange.end + 1),
    [listEntries, visibleRange.end, visibleRange.start],
  )

  useEffect(() => {
    const firstEntry = listEntries[0]
    if (firstEntry) scrollToItem(firstEntry.key, 'start')
  }, [listEntries, scrollToItem])

  if (!isOpen) return null

  return (
    <>
      <div
        className={
          embedded
            ? 'flex min-h-0 flex-1 flex-col overflow-hidden'
            : 'mesh-member-list flex w-member-list flex-shrink-0 flex-col overflow-hidden bg-surface-container-low'
        }
      >
        <div className="px-3 pt-3">
          <div className="flex min-h-9 items-center gap-2 rounded-full border border-outline bg-surface-container-lowest px-3">
            <Icon name="search" size="xs" className="flex-shrink-0 text-on-surface-variant" />
            <input
              type="search"
              aria-label="Find a community member"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Find a member"
              className="mesh-input min-w-0 flex-1 border-0 bg-transparent text-body-sm text-on-surface placeholder:text-on-surface-variant"
            />
          </div>
        </div>
        <div
          ref={scrollContainerRef}
          onScroll={() => void handleScroll()}
          className="flex-1 overflow-y-auto px-3 py-3"
          role="list"
          aria-label="Community members"
        >
          {currentMembers.length === 0 && banned.length === 0 ? (
            <EmptyState
              variant="compact"
              icon={<Icon name="users" size="lg" />}
              title="Invite someone to this room"
              description="People who join will appear here."
            />
          ) : filtered.length === 0 && banned.length === 0 ? (
            <EmptyState
              variant="compact"
              icon={<Icon name="search" size="lg" />}
              title="Try another member search"
              description="Try a different name or account address."
            />
          ) : (
            <div
              data-design-token-exception="data-driven-virtual-spacer-geometry"
              style={{
                paddingTop: `${topSpacerHeight}px`,
                paddingBottom: `${bottomSpacerHeight}px`,
              }}
            >
              {visibleEntries.map((entry, visibleIndex) => entry.kind === 'heading' ? (
                <div
                  key={entry.key}
                  role="listitem"
                  aria-posinset={visibleRange.start + visibleIndex + 1}
                  aria-setsize={listEntries.length}
                >
                  <SectionHeader
                    headingLevel={3}
                    title={entry.label}
                    count={entry.count}
                    className="px-2"
                  />
                </div>
              ) : (
                <MemberRow
                  key={entry.key}
                  member={entry.member}
                  shortHandle={memberHandles.get(entry.member.publicKey) ?? null}
                  actions={actions}
                  embedded={embedded}
                  position={visibleRange.start + visibleIndex + 1}
                  setSize={listEntries.length}
                  sequencePosition={sequenceCardPositionFromNeighbors(
                    listEntries[visibleRange.start + visibleIndex - 1]?.kind === 'member',
                    listEntries[visibleRange.start + visibleIndex + 1]?.kind === 'member',
                  )}
                />
              ))}
            </div>
          )}
        </div>
        {bridge.isMatrixBackend() && activeCommunityId && (
          rosterNextCursor || !rosterStateComplete || rosterError != null
        ) ? (
          <div className="space-y-2 border-t border-outline-variant px-3 py-3" aria-live="polite">
            {rosterError != null ? (
              <ErrorState
                error={rosterError}
                context={{ operation: 'load more members', resource: 'community' }}
                compact
              />
            ) : null}
            {!rosterStateComplete ? (
              <p className="text-body-sm text-on-surface-variant">
                More members appear as the community syncs.
              </p>
            ) : null}
            {rosterNextCursor ? (
              <Button
                type="button"
                variant="secondary"
                disabled={rosterBusy}
                onClick={() => void loadMoreMembers()}
              >
                {rosterBusy ? 'Loading…' : 'Load more members'}
              </Button>
            ) : null}
          </div>
        ) : null}
        {/*
          Every surface that draws rings owes this line.

          A ring is a colour, and the design contract is that a colour never
          carries a state alone. It is rendered only when at least one member
          here is actually on another server, so it explains a mark that is on
          screen rather than describing one that is not.
        */}
        {hasRemoteMembers && (
          <AmbientNote>Ringed marks are on another server</AmbientNote>
        )}
      </div>
      <Modal
        open={pendingModeration !== null}
        onClose={() => {
          if (moderationBusy) return
          setPendingModeration(null)
          setModerationError(null)
        }}
        title={pendingModeration
          ? `${MODERATION_COPY[pendingModeration.action].verb} ${memberLabel(pendingModeration.member)}?`
          : 'Confirm moderation action'}
        description={pendingModeration
          ? MODERATION_COPY[pendingModeration.action].description
          : undefined}
        size="sm"
      >
        <div className="space-y-3">
          {moderationError != null ? (
            <ErrorState
              error={moderationError}
              context={{
                operation: pendingModeration
                  ? `${MODERATION_COPY[pendingModeration.action].operation} ${memberLabel(pendingModeration.member)}`
                  : 'moderate this member',
                resource: 'community',
              }}
              compact
            />
          ) : null}
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="secondary"
              disabled={moderationBusy}
              onClick={() => {
                setPendingModeration(null)
                setModerationError(null)
              }}
            >
              Cancel
            </Button>
            <Button
              type="button"
              tone={pendingModeration?.action === 'unban' ? 'accent' : 'danger'}
              disabled={moderationBusy}
              onClick={() => void confirmModeration()}
            >
              {moderationBusy
                ? 'Working…'
                : pendingModeration ? MODERATION_COPY[pendingModeration.action].confirm : 'Confirm'}
            </Button>
          </div>
        </div>
      </Modal>
      <Modal
        open={pendingRoleChange !== null}
        onClose={() => {
          if (roleBusy) return
          setPendingRoleChange(null)
          setRoleError(null)
        }}
        title={pendingRoleChange
          ? pendingRoleChange.nextRole === 'admin'
            ? `Make ${memberLabel(pendingRoleChange.member)} an administrator?`
            : `Make ${memberLabel(pendingRoleChange.member)} a member?`
          : 'Confirm role change'}
        description="Review the permissions Mesh will apply before changing this role."
        size="sm"
      >
        {pendingRoleChange ? (
          <div className="space-y-3">
            <RolePermissionPreview
              role={pendingRoleChange.nextRole}
              previousRole={pendingRoleChange.member.role}
              memberName={pendingRoleChange.member.displayName}
              evidence={rolePermissionEvidence}
            />
            {roleError != null ? (
              <ErrorState
                error={roleError}
                context={{
                  operation: `change ${pendingRoleChange.member.displayName}'s role`,
                  resource: 'community',
                }}
                compact
              />
            ) : null}
            <div className="flex justify-end gap-2">
              <Button
                type="button"
                variant="secondary"
                disabled={roleBusy}
                onClick={() => {
                  setPendingRoleChange(null)
                  setRoleError(null)
                }}
              >
                Cancel
              </Button>
              <Button
                type="button"
                disabled={roleBusy || rolePermissionsLoading || !rolePermissionProjection || !currentUserId}
                onClick={() => void confirmRoleChange()}
              >
                {roleBusy ? 'Applying…' : 'Apply role'}
              </Button>
            </div>
          </div>
        ) : null}
      </Modal>
      <Modal
        open={permissionMember !== null}
        onClose={() => setPermissionMember(null)}
        title={permissionMember
          ? `What ${memberLabel(permissionMember)} can do`
          : 'Effective permissions'}
        description="Checked in each room Mesh could read."
        size="sm"
      >
        {permissionMember ? (
          <div className="space-y-3">
            <RolePermissionPreview
              role={permissionMember.role}
              memberName={permissionMember.displayName}
              evidence={permissionEvidence}
              nameRooms
              title="Effective permissions"
              caption={`Based on ${memberLabel(permissionMember)}’s current permissions.`}
            />
            <div className="flex justify-end">
              <Button type="button" variant="secondary" onClick={() => setPermissionMember(null)}>
                Close
              </Button>
            </div>
          </div>
        ) : null}
      </Modal>
    </>
  )
}

const MemberRow = memo(function MemberRow({
  member,
  shortHandle,
  actions,
  embedded,
  position,
  setSize,
  sequencePosition,
}: {
  member: MemberEntry
  shortHandle: string | null
  embedded: boolean
  position: number
  setSize: number
  sequencePosition: SequenceCardPosition
  actions?: MemberRowActions
}) {
  if (import.meta.env.DEV) memberListRenderMetrics.record()
  const sequence = sequenceCardProps(sequencePosition)
  /*
    Moderation is only offered against someone this account actually outranks.

    Matrix requires a strictly greater power level, and two administrators sit
    at the same one, so moderating a peer administrator fanned out across every
    room in the community, failed in all of them, and reported "Applied in 0 of
    N places. Try the failed rooms again." Retry advice for a permanent
    condition, at the moment an administrator most needs a straight answer.
  */
  /*
    Whether this member's account lives on another homeserver.

    Derived from the shared rule rather than compared here, so a ring in this
    list and a rail in the timeline can never disagree about the same person.
  */
  const isRemoteMember = bridge.isMatrixBackend()
    && serverRelation(member.publicKey, actions?.currentUserId) === 'remote'

  const actorRank = ROLE_RANK[actions?.actorRole ?? ''] ?? 0
  const subjectRank = ROLE_RANK[member.role] ?? 0
  const outranksSubject = actorRank > subjectRank
  const canAct = actions?.canModerate
    && actions.currentUserId !== member.publicKey
    && member.role !== 'owner'
    && outranksSubject
  const canDm = actions?.directMessages && actions.currentUserId !== member.publicKey
  // A banned account is already out of the community, so the only action that
  // can still change anything for them is lifting the ban.
  const isBanned = (member.banStatus ?? 'none') === 'banned'
  const moderationItems: MenuItem[] =
    actions && canAct
      ? isBanned
        ? [
            {
              id: 'unban',
              label: 'Lift ban',
              onSelect: () => actions.onRequestModeration('unban', member),
            },
          ]
        : [
          ...(actions.canManageRoles
            ? [
                {
                  id: 'role',
                  label: member.role === 'admin' ? 'Make member' : 'Make administrator',
                  onSelect: () => actions.onRequestRole(member),
                },
              ]
            : []),
          {
            id: 'remove',
            label: 'Remove from community',
            onSelect: () => actions.onRequestModeration('remove', member),
          },
          {
            id: 'ban',
            label: 'Ban from community',
            tone: 'danger' as const,
            onSelect: () => actions.onRequestModeration('ban', member),
          },
        ]
      : []

  const [profileOpen, setProfileOpen] = useState(false)
  const closeProfile = useCallback(() => setProfileOpen(false), [])

  /*
   * Blocking is account-wide (Matrix's m.ignored_user_list has no per-room or
   * per-community dimension) and is not a moderation permission, so unlike
   * ban/kick it is offered to any member viewing any other member, not gated
   * on canAct. It also has no representation in the roster the way
   * banStatus does, so its state is fetched fresh whenever the profile card
   * that offers it is actually open, mirroring DmView's block effect.
   */
  const matrixMode = bridge.isMatrixBackend()
  const canBlock = Boolean(matrixMode && actions?.currentUserId && actions.currentUserId !== member.publicKey)
  const [blockState, setBlockState] = useState<{ status: 'idle' | 'loading' | 'ready' | 'failed'; blocked: boolean }>(
    { status: 'idle', blocked: false },
  )
  const [blockBusy, setBlockBusy] = useState(false)
  const [blockError, setBlockError] = useState<unknown | null>(null)

  useEffect(() => {
    if (!profileOpen || !canBlock) return
    let active = true
    setBlockState({ status: 'loading', blocked: false })
    setBlockError(null)
    void bridge.matrixDmBlocked(member.publicKey)
      .then((blocked) => {
        if (active) setBlockState({ status: 'ready', blocked })
      })
      .catch((error) => {
        if (!active) return
        setBlockState({ status: 'failed', blocked: false })
        console.error('Failed to load block state:', error)
      })
    return () => {
      active = false
    }
  }, [profileOpen, canBlock, member.publicKey])

  const handleToggleBlock = async () => {
    if (blockBusy || blockState.status !== 'ready') return
    setBlockBusy(true)
    setBlockError(null)
    try {
      const blocked = await bridge.matrixSetDmBlocked(member.publicKey, !blockState.blocked)
      setBlockState({ status: 'ready', blocked })
      if (blocked) {
        useDmStore.getState().upsertBlockedAccount({ userId: member.publicKey })
      } else {
        useDmStore.getState().removeBlockedAccount(member.publicKey)
      }
    } catch (error) {
      console.error('Failed to update block state:', error)
      setBlockError(error)
    } finally {
      setBlockBusy(false)
    }
  }

  return (
    <div
      role="listitem"
      aria-posinset={position}
      aria-setsize={setSize}
      data-sequence-position={embedded ? undefined : sequence['data-sequence-position']}
      className={`${
        embedded
          ? 'rounded-full border border-transparent hover:border-outline-variant hover:bg-surface-container-high'
          : sequence.className
      } group flex min-h-11 items-center gap-3 px-2 transition-colors`}
    >
      <Popover
        side="left"
        align="start"
        open={profileOpen}
        onOpenChange={setProfileOpen}
        trigger={
          <button
            type="button"
            aria-label={`View ${member.displayName}'s profile`}
            className="flex min-w-0 flex-1 items-center gap-3 rounded-full py-1 text-left transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus"
          >
            <span className="relative flex-shrink-0">
              {/*
                The ring is how a member list says "another homeserver" without
                a rail to carry it. It is paired with the visible identifier
                beside the name and with the legend on the list's footer rule,
                so the colour is never the only thing saying it.
              */}
              <Avatar
                color={member.avatarColor}
                seed={member.publicKey}
                size={36}
                name={member.displayName}
                imageUrl={member.avatarUrl}
                className={`!rounded-lg ${isRemoteMember ? 'mesh-remote-mark' : ''}`}
              />
              {/* Status dot */}
              <span
                aria-hidden="true"
                className={`absolute -bottom-0.5 -right-0.5 h-3.5 w-3.5 rounded-round border-status border-surface-container-low ${
                  member.online ? 'bg-primary' : 'bg-offline'
                }`}
              />
            </span>
            <span className="flex min-w-0 flex-1 items-center gap-1">
              {/*
                min-w-0 so truncate can actually take effect on a flex child,
                and flex-1 so the name is what gets the room. Everything beside
                it was flex-shrink-0 while the name was not, so in a 220px
                column the owner of a community rendered as "M..." next to a
                full-width Owner pill. Whose row it is should be the last thing
                to go, not the first.
              */}
              <span className="min-w-0 flex-1 truncate text-body-md font-medium text-on-surface-variant">{member.displayName}</span>
              {(shortHandle || isRemoteMember) && (
                <span className="flex-shrink-0 text-label-sm text-on-surface-variant">
                  {shortHandle ?? serverName(member.publicKey)}
                </span>
              )}
              {member.role !== 'member' && (
                <span
                  className={`flex-shrink-0 rounded px-1.5 py-0.5 text-label-sm font-semibold ${
                    member.role === 'owner' ? 'bg-primary-container text-primary' : 'bg-surface-container-highest text-on-surface-variant'
                  }`}
                >
                  {member.role === 'owner' ? 'Owner' : 'Admin'}
                </span>
              )}
            </span>
          </button>
        }
      >
        <MemberProfileCard
          member={member}
          shortHandle={shortHandle}
          isRemoteMember={isRemoteMember}
          canDm={Boolean(canDm)}
          canAct={Boolean(canAct)}
          canManageRoles={Boolean(actions?.canManageRoles)}
          onExplainPermissions={actions?.canExplainPermissions
            ? () => { closeProfile(); actions.onExplainPermissions(member) }
            : undefined}
          onMessage={actions ? () => { closeProfile(); void actions.onDm(member) } : undefined}
          onToggleRole={actions && !isBanned ? () => { closeProfile(); actions.onRequestRole(member) } : undefined}
          onRemove={actions && !isBanned ? () => { closeProfile(); actions.onRequestModeration('remove', member) } : undefined}
          onBan={actions && !isBanned ? () => { closeProfile(); actions.onRequestModeration('ban', member) } : undefined}
          onUnban={actions && isBanned ? () => { closeProfile(); actions.onRequestModeration('unban', member) } : undefined}
          canBlock={canBlock}
          blockStatus={blockState.status}
          isBlocked={blockState.blocked}
          blockBusy={blockBusy}
          blockError={blockError}
          onToggleBlock={() => void handleToggleBlock()}
        />
      </Popover>
      {(canAct || canDm) && actions && (
        /*
          Revealed on hover or keyboard focus, the way the message toolbar
          already does it. Two 32px buttons on every row of a 220px column were
          spending a seventh of the roster's width, permanently, on actions
          nobody is reaching for while reading a member list. opacity rather
          than conditional rendering keeps them in the accessibility tree and in
          the tab order, and focus-within is what makes them reachable without a
          pointer.
        */
        <div className="pointer-events-none flex items-center gap-0.5 opacity-0 transition-opacity group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100">
          {canDm && (
            <button
              type="button"
              onClick={() => void actions.onDm(member)}
              className="flex h-8 w-8 items-center justify-center rounded-full text-on-surface-variant transition-colors hover:bg-surface-container-highest hover:text-on-surface"
              title="Message member"
              aria-label={`Message ${member.displayName}`}
            >
              <Icon name="messageCircle" size="sm" />
            </button>
          )}
          {canAct && (
            <DropdownMenu
              label={`Actions for ${member.displayName}`}
              items={moderationItems}
              trigger={
                <button
                  type="button"
                  className="flex h-8 w-8 items-center justify-center rounded-full text-on-surface-variant transition-colors hover:bg-surface-container-highest hover:text-on-surface"
                  aria-label={`More actions for ${member.displayName}`}
                >
                  <Icon name="ellipsis" size="sm" />
                </button>
              }
            />
          )}
        </div>
      )}
    </div>
  )
})

function MemberProfileCard({
  member,
  shortHandle,
  canDm,
  canAct,
  canManageRoles,
  onExplainPermissions,
  onMessage,
  onToggleRole,
  onRemove,
  onBan,
  onUnban,
  canBlock,
  blockStatus,
  isBlocked,
  blockBusy,
  blockError,
  onToggleBlock,
  isRemoteMember,
}: {
  member: MemberEntry
  shortHandle: string | null
  isRemoteMember: boolean
  canDm: boolean
  canAct: boolean
  canManageRoles: boolean
  onExplainPermissions?: () => void
  onMessage?: () => void
  onToggleRole?: () => void
  onRemove?: () => void
  onBan?: () => void
  onUnban?: () => void
  canBlock: boolean
  blockStatus: 'idle' | 'loading' | 'ready' | 'failed'
  isBlocked: boolean
  blockBusy: boolean
  blockError: unknown | null
  onToggleBlock: () => void
}) {
  const roleLabel = member.role === 'owner' ? 'Owner' : member.role === 'admin' ? 'Admin' : 'Member'
  const showActions = Boolean(
    (canDm && onMessage)
    || onExplainPermissions
    || (canAct && (onRemove || onBan || onUnban || (canManageRoles && onToggleRole)))
    || canBlock,
  )
  const actionClass =
    'flex min-h-8 w-full items-center gap-2 rounded-full px-2 text-left text-body-md text-on-surface-variant transition-colors hover:bg-surface-container-highest hover:text-on-surface focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus'

  return (
    <div className="flex flex-col">
      <div className="flex items-start gap-3">
        <div className="relative flex-shrink-0">
          <Avatar
            color={member.avatarColor}
            size={48}
            name={member.displayName}
            imageUrl={member.avatarUrl}
            className={`!rounded-lg ${isRemoteMember ? 'mesh-remote-mark' : ''}`}
          />
          {/* Status dot */}
          <span
            aria-hidden="true"
            className={`absolute -bottom-0.5 -right-0.5 h-3.5 w-3.5 rounded-round border-status border-surface-container-high ${
              member.online ? 'bg-primary' : 'bg-offline'
            }`}
          />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="truncate text-body-md font-semibold text-on-surface">{member.displayName}</span>
            {member.role !== 'member' && (
              <span
                className={`flex-shrink-0 rounded px-1.5 py-0.5 text-label-sm font-semibold ${
                  member.role === 'owner' ? 'bg-primary-container text-primary' : 'bg-surface-container-highest text-on-surface-variant'
                }`}
              >
                {roleLabel}
              </span>
            )}
          </div>
          <p className="mt-0.5 truncate text-body-sm text-on-surface-variant">{shortHandle ?? member.publicKey}</p>
          <p className="mt-1.5 inline-flex items-center gap-1.5 text-body-sm text-on-surface-variant">
            <span
              aria-hidden="true"
              className={`h-2 w-2 rounded-round ${member.online ? 'bg-primary' : 'bg-offline'}`}
            />
            {member.online ? 'Online' : 'Offline'}
          </p>
        </div>
      </div>
      {showActions ? (
        <>
          <div className="-mx-4 mt-4 border-t border-outline-variant" aria-hidden="true" />
          <div className="mt-3 flex flex-col gap-0.5">
            {canDm && onMessage ? (
              <button type="button" onClick={onMessage} className={actionClass}>
                <Icon name="messageCircle" size="sm" />
                Message
              </button>
            ) : null}
            {onExplainPermissions ? (
              <button type="button" onClick={onExplainPermissions} className={actionClass}>
                <Icon name="shieldCheck" size="sm" />
                What this member can do
              </button>
            ) : null}
            {canAct && canManageRoles && onToggleRole ? (
              <button type="button" onClick={onToggleRole} className={actionClass}>
                <Icon name="shieldCheck" size="sm" />
                {member.role === 'admin' ? 'Make member' : 'Make administrator'}
              </button>
            ) : null}
            {canAct && onRemove ? (
              <button type="button" onClick={onRemove} className={actionClass}>
                <Icon name="circleX" size="sm" />
                Remove from community
              </button>
            ) : null}
            {canAct && onBan ? (
              <button
                type="button"
                onClick={onBan}
                className="flex min-h-8 w-full items-center gap-2 rounded-full px-2 text-left text-body-md text-error transition-colors hover:bg-error-container-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus"
              >
                <Icon name="triangleAlert" size="sm" />
                Ban from community
              </button>
            ) : null}
            {canAct && onUnban ? (
              <button type="button" onClick={onUnban} className={actionClass}>
                <Icon name="shieldCheck" size="sm" />
                Lift ban
              </button>
            ) : null}
            {canBlock ? (
              <button
                type="button"
                onClick={onToggleBlock}
                disabled={blockStatus !== 'ready' || blockBusy}
                className="flex min-h-8 w-full items-center gap-2 rounded-full px-2 text-left text-body-md text-error transition-colors hover:bg-error-container-hover disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus"
              >
                <Icon name="userX" size="sm" />
                {blockStatus === 'loading' || blockStatus === 'idle'
                  ? 'Checking…'
                  : blockStatus === 'failed'
                    ? 'Block status unavailable'
                    : blockBusy
                      ? 'Saving…'
                      : isBlocked ? `Unblock ${member.displayName}` : `Block ${member.displayName}`}
              </button>
            ) : null}
            {canBlock && blockError != null && (
              <p className="px-2 text-label-sm text-error" role="alert">
                The block setting could not be changed. Try again.
              </p>
            )}
          </div>
        </>
      ) : null}
    </div>
  )
}
