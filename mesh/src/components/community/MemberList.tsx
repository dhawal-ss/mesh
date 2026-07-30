import { useMemo } from 'react'
import { Avatar } from '../ui/Avatar'
import { useActiveCommunity, useCommunityStore } from '../../store/communities'
import { useIdentityStore } from '../../store/identity'
import { useMembershipStore } from '../../store/membership'
import { useDmStore } from '../../store/dms'
import * as bridge from '../../lib/bridge'
import { summarizeModerationResult } from '../../lib/moderation'
import { showToast } from '../ui/Toast'
import { Icon } from '../ui/Icon'
import { DropdownMenu, type MenuItem } from '../ui/InteractivePrimitives'
import { EmptyState } from '../ui/Primitives'
import { useVirtualScroll, type VirtualItem } from '../../hooks/useVirtualScroll'

interface MemberEntry {
  publicKey: string
  displayName: string
  avatarColor: string
  role: 'owner' | 'admin' | 'member'
  online: boolean
}

interface MemberListProps {
  isOpen: boolean
  onClose: () => void
  members: MemberEntry[]
  embedded?: boolean
}

const ROLE_ORDER = { owner: 0, admin: 1, member: 2 } as const
type MemberListEntry =
  | { key: string; kind: 'heading'; label: string }
  | { key: string; kind: 'member'; member: MemberEntry }

export function MemberList({ isOpen, members, embedded = false }: MemberListProps) {
  const activeCommunityId = useCommunityStore((state) => state.activeCommunityId)
  const activeCommunity = useActiveCommunity()
  const legacyUserId = useIdentityStore((state) => state.identity?.publicKey)
  const currentUserId = bridge.isMatrixBackend() ? bridge.getMatrixUserId() : legacyUserId
  const updateRole = useMembershipStore((state) => state.updateRole)
  const removeMember = useMembershipStore((state) => state.removeMember)
  const banMember = useMembershipStore((state) => state.banMember)
  const upsertConversation = useDmStore((state) => state.upsertConversation)
  const setActiveConversation = useDmStore((state) => state.setActiveConversation)
  const setDmMode = useDmStore((state) => state.setDmMode)
  const canModerate = activeCommunity?.role === 'owner' || activeCommunity?.role === 'admin'
  const canManageRoles = activeCommunity?.role === 'owner'
  const actions = activeCommunityId
    ? {
        currentUserId,
        canModerate,
        canManageRoles,
        directMessages: bridge.isMatrixBackend() && bridge.getBackendCapabilities().directMessages,
        onRole: async (member: MemberEntry) => {
          const role = member.role === 'admin' ? 'member' : 'admin'
          const result = await bridge.updateMemberRole(activeCommunityId, member.publicKey, role)
          const summary = summarizeModerationResult(
            result,
            `${member.displayName} is now ${role === 'admin' ? 'an administrator' : 'a member'}`,
          )
          if (summary.serverSucceeded) {
            updateRole(activeCommunityId, member.publicKey, role)
          }
          showToast(summary.message, summary.tone)
        },
        onKick: async (member: MemberEntry) => {
          const result = await bridge.kickUser(activeCommunityId, member.publicKey)
          const summary = summarizeModerationResult(result, `${member.displayName} was removed`)
          if (summary.serverSucceeded) {
            removeMember(activeCommunityId, member.publicKey)
          }
          showToast(summary.message, summary.tone)
        },
        onBan: async (member: MemberEntry) => {
          const result = await bridge.banUser(activeCommunityId, member.publicKey)
          const summary = summarizeModerationResult(result, `${member.displayName} was banned`)
          if (summary.serverSucceeded) {
            banMember(activeCommunityId, member.publicKey)
          }
          showToast(summary.message, summary.tone)
        },
        onDm: async (member: MemberEntry) => {
          const conversation = await bridge.ensureDm(member.publicKey)
          upsertConversation(conversation)
          setActiveConversation(conversation.id)
          setDmMode(true)
        },
      }
    : undefined

  const sorted = useMemo(() => [...members].sort((a, b) => {
    const roleSort = ROLE_ORDER[a.role] - ROLE_ORDER[b.role]
    if (roleSort !== 0) return roleSort
    if (a.online !== b.online) return a.online ? -1 : 1
    return a.displayName.localeCompare(b.displayName)
  }), [members])

  // Group: online vs offline, then by role within each
  const { online, offline } = useMemo(() => ({
    online: sorted.filter((member) => member.online),
    offline: sorted.filter((member) => !member.online),
  }), [sorted])
  const listEntries = useMemo<MemberListEntry[]>(() => {
    const entries: MemberListEntry[] = []
    if (online.length > 0) {
      entries.push({ key: 'heading:online', kind: 'heading', label: `Online — ${online.length}` })
      for (const member of online) {
        entries.push({ key: `member:${member.publicKey}`, kind: 'member', member })
      }
    }
    if (offline.length > 0) {
      entries.push({ key: 'heading:offline', kind: 'heading', label: `Offline — ${offline.length}` })
      for (const member of offline) {
        entries.push({ key: `member:${member.publicKey}`, kind: 'member', member })
      }
    }
    return entries
  }, [offline, online])
  const virtualItems = useMemo<VirtualItem[]>(() => listEntries.map((entry) => ({
    key: entry.key,
    type: entry.kind === 'heading' ? 'gap' : 'message',
    height: entry.kind === 'heading' ? 28 : 40,
  })), [listEntries])
  const {
    scrollContainerRef,
    topSpacerHeight,
    bottomSpacerHeight,
    visibleRange,
    handleScroll,
  } = useVirtualScroll(virtualItems, {
    estimatedMessageHeight: 40,
    estimatedGapHeight: 28,
    overscanPx: 800,
  })
  const visibleEntries = useMemo(
    () => listEntries.length === 0
      ? []
      : listEntries.slice(visibleRange.start, visibleRange.end + 1),
    [listEntries, visibleRange.end, visibleRange.start],
  )

  if (!isOpen) return null

  return (
    <div
      className={
        embedded
          ? 'flex min-h-0 flex-1 flex-col overflow-hidden'
          : 'mesh-member-list flex w-member-list flex-shrink-0 flex-col overflow-hidden bg-surface-sidebar'
      }
    >
      <div
        ref={scrollContainerRef}
        onScroll={() => void handleScroll()}
        className="flex-1 overflow-y-auto px-2 py-4"
        role="list"
        aria-label="Community members"
      >
        {members.length === 0 ? (
          <EmptyState
            variant="compact"
            icon={<Icon name="users" size="lg" />}
            title="No members yet"
            description="People who join will appear here."
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
                <p
                  role="heading"
                  aria-level={3}
                  className="flex h-7 items-end px-2 pb-1 text-meta font-semibold uppercase text-muted"
                >
                  {entry.label}
                </p>
              </div>
            ) : (
              <MemberRow
                key={entry.key}
                member={entry.member}
                actions={actions}
                position={visibleRange.start + visibleIndex + 1}
                setSize={listEntries.length}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function MemberRow({
  member,
  actions,
  position,
  setSize,
}: {
  member: MemberEntry
  position: number
  setSize: number
  actions?: {
    currentUserId?: string | null
    canModerate: boolean
    canManageRoles: boolean
    directMessages: boolean
    onRole: (member: MemberEntry) => Promise<void>
    onKick: (member: MemberEntry) => Promise<void>
    onBan: (member: MemberEntry) => Promise<void>
    onDm: (member: MemberEntry) => Promise<void>
  }
}) {
  const canAct = actions?.canModerate && actions.currentUserId !== member.publicKey && member.role !== 'owner'
  const canDm = actions?.directMessages && actions.currentUserId !== member.publicKey
  const moderationItems: MenuItem[] =
    actions && canAct
      ? [
          ...(actions.canManageRoles
            ? [
                {
                  id: 'role',
                  label: member.role === 'admin' ? 'Make member' : 'Make administrator',
                  onSelect: () => {
                    void actions.onRole(member).catch((error) => console.error('Role update failed:', error))
                  },
                },
              ]
            : []),
          {
            id: 'remove',
            label: 'Remove from community',
            onSelect: () => {
              void actions.onKick(member).catch((error) => console.error('Member removal failed:', error))
            },
          },
          {
            id: 'ban',
            label: 'Ban from community',
            tone: 'danger' as const,
            onSelect: () => {
              void actions.onBan(member).catch((error) => console.error('Member ban failed:', error))
            },
          },
        ]
      : []

  return (
    <div
      role="listitem"
      aria-posinset={position}
      aria-setsize={setSize}
      className={`group flex min-h-10 items-center gap-3 rounded-control px-2 transition-colors hover:bg-surface-hover focus-within:bg-surface-hover ${
        !member.online ? 'opacity-40' : ''
      }`}
    >
      <div className="relative flex-shrink-0">
        <Avatar color={member.avatarColor} size={32} name={member.displayName} />
        {/* Status dot */}
        <div
          className={`absolute -bottom-0.5 -right-0.5 h-3.5 w-3.5 rounded-full border-status border-surface-sidebar ${
            member.online ? 'bg-status-success' : 'bg-status-offline'
          }`}
        />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1">
          <span className="truncate text-sm font-medium text-secondary">{member.displayName}</span>
          {member.role !== 'member' && (
            <span
              className={`flex-shrink-0 rounded px-1.5 py-0.5 text-micro font-semibold ${
                member.role === 'owner' ? 'bg-accent/10 text-accent' : 'bg-surface-active text-muted'
              }`}
            >
              {member.role === 'owner' ? 'Owner' : 'Admin'}
            </span>
          )}
        </div>
      </div>
      {(canAct || canDm) && actions && (
        <div className="flex items-center gap-0.5">
          {canDm && (
            <button
              type="button"
              onClick={() => void actions.onDm(member).catch((error) => console.error('DM start failed:', error))}
              className="flex h-8 w-8 items-center justify-center rounded-control text-muted transition-colors hover:bg-surface-active hover:text-primary"
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
                  className="flex h-8 w-8 items-center justify-center rounded-control text-muted transition-colors hover:bg-surface-active hover:text-primary"
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
}
