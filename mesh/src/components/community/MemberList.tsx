import { Avatar } from '../ui/Avatar'
import { useCommunityStore } from '../../store/communities'
import { useIdentityStore } from '../../store/identity'
import { useMembershipStore } from '../../store/membership'
import { useDmStore } from '../../store/dms'
import * as bridge from '../../lib/bridge'

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
}

const ROLE_ORDER = { owner: 0, admin: 1, member: 2 } as const

export function MemberList({ isOpen, members }: MemberListProps) {
  const activeCommunityId = useCommunityStore((state) => state.activeCommunityId)
  const activeCommunity = useCommunityStore((state) =>
    state.communities.find((community) => community.id === state.activeCommunityId),
  )
  const legacyUserId = useIdentityStore((state) => state.identity?.publicKey)
  const currentUserId = bridge.isMatrixBackend() ? bridge.getMatrixUserId() : legacyUserId
  const updateRole = useMembershipStore((state) => state.updateRole)
  const removeMember = useMembershipStore((state) => state.removeMember)
  const banMember = useMembershipStore((state) => state.banMember)
  const upsertConversation = useDmStore((state) => state.upsertConversation)
  const setActiveConversation = useDmStore((state) => state.setActiveConversation)
  const setDmMode = useDmStore((state) => state.setDmMode)
  if (!isOpen) return null

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
          await bridge.updateMemberRole(activeCommunityId, member.publicKey, role)
          updateRole(activeCommunityId, member.publicKey, role)
        },
        onKick: async (member: MemberEntry) => {
          await bridge.kickUser(activeCommunityId, member.publicKey)
          removeMember(activeCommunityId, member.publicKey)
        },
        onBan: async (member: MemberEntry) => {
          await bridge.banUser(activeCommunityId, member.publicKey)
          banMember(activeCommunityId, member.publicKey)
        },
        onDm: async (member: MemberEntry) => {
          const conversation = await bridge.ensureDm(member.publicKey)
          upsertConversation(conversation)
          setActiveConversation(conversation.id)
          setDmMode(true)
        },
      }
    : undefined

  const sorted = [...members].sort((a, b) => {
    const roleSort = ROLE_ORDER[a.role] - ROLE_ORDER[b.role]
    if (roleSort !== 0) return roleSort
    if (a.online !== b.online) return a.online ? -1 : 1
    return a.displayName.localeCompare(b.displayName)
  })

  // Group: online vs offline, then by role within each
  const online = sorted.filter((m) => m.online)
  const offline = sorted.filter((m) => !m.online)

  return (
    <div className="mesh-member-list flex w-[240px] flex-shrink-0 flex-col overflow-hidden bg-bg-secondary">
      <div className="flex-1 overflow-y-auto px-2 py-4">
        {/* Online section */}
        {online.length > 0 && (
          <div className="mb-2">
            <p className="px-2 pb-1 text-[11px] font-semibold uppercase tracking-[0.02em] text-muted">
              Online — {online.length}
            </p>
            <div>
              {online.map((member) => (
                <MemberRow key={member.publicKey} member={member} actions={actions} />
              ))}
            </div>
          </div>
        )}

        {/* Offline section */}
        {offline.length > 0 && (
          <div className="mb-2">
            <p className="px-2 pb-1 text-[11px] font-semibold uppercase tracking-[0.02em] text-muted">
              Offline — {offline.length}
            </p>
            <div>
              {offline.map((member) => (
                <MemberRow key={member.publicKey} member={member} actions={actions} />
              ))}
            </div>
          </div>
        )}

        {members.length === 0 && (
          <div className="flex h-32 items-center justify-center">
            <p className="text-xs text-muted">No members yet</p>
          </div>
        )}
      </div>
    </div>
  )
}

function MemberRow({
  member,
  actions,
}: {
  member: MemberEntry
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
  return (
    <div
      className={`group flex items-center gap-3 rounded px-2 py-[6px] cursor-pointer transition-colors hover:bg-bg-modifier-hover ${
        !member.online ? 'opacity-40' : ''
      }`}
    >
      <div className="relative flex-shrink-0">
        <Avatar color={member.avatarColor} size={32} name={member.displayName} />
        {/* Status dot */}
        <div
          className={`absolute -bottom-0.5 -right-0.5 h-[14px] w-[14px] rounded-full border-[3px] border-bg-secondary ${
            member.online ? 'bg-green' : 'bg-[#80848e]'
          }`}
        />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1">
          <span className="truncate text-sm font-medium text-secondary">
            {member.displayName}
          </span>
          {member.role !== 'member' && (
            <span className={`flex-shrink-0 text-[10px] font-semibold ${
              member.role === 'owner' ? 'text-accent' : 'text-blue'
            }`}>
              {member.role === 'owner' ? '👑' : '🛡️'}
            </span>
          )}
        </div>
      </div>
      {(canAct || canDm) && actions && (
        <div className="hidden items-center gap-0.5 group-hover:flex">
          {canDm && (
            <button
              onClick={() => void actions.onDm(member).catch((error) => console.error('DM start failed:', error))}
              className="rounded px-1 text-[10px] text-muted hover:bg-bg-modifier-active hover:text-primary"
              title="Message member"
              aria-label={`Message ${member.displayName}`}
            >
              DM
            </button>
          )}
          {canAct && actions.canManageRoles && (
            <button
              onClick={() => void actions.onRole(member).catch((error) => console.error('Role update failed:', error))}
              className="rounded px-1 text-[10px] text-muted hover:bg-bg-modifier-active hover:text-primary"
              title={member.role === 'admin' ? 'Make member' : 'Make admin'}
            >
              {member.role === 'admin' ? 'M' : 'A'}
            </button>
          )}
          {canAct && <button
            onClick={() => void actions.onKick(member).catch((error) => console.error('Kick failed:', error))}
            className="rounded px-1 text-[10px] text-muted hover:bg-bg-modifier-active hover:text-primary"
            title="Kick member"
          >
            K
          </button>}
          {canAct && <button
            onClick={() => void actions.onBan(member).catch((error) => console.error('Ban failed:', error))}
            className="rounded px-1 text-[10px] text-red hover:bg-red/10"
            title="Ban member"
          >
            B
          </button>}
        </div>
      )}
    </div>
  )
}
