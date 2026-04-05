import { Avatar } from '../ui/Avatar'

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
  if (!isOpen) return null

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
    <div className="flex w-[240px] flex-shrink-0 flex-col bg-bg-secondary overflow-hidden">
      <div className="flex-1 overflow-y-auto px-2 py-4">
        {/* Online section */}
        {online.length > 0 && (
          <div className="mb-2">
            <p className="px-2 pb-1 text-[11px] font-semibold uppercase tracking-[0.02em] text-muted">
              Online — {online.length}
            </p>
            <div>
              {online.map((member) => (
                <MemberRow key={member.publicKey} member={member} />
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
                <MemberRow key={member.publicKey} member={member} />
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

function MemberRow({ member }: { member: MemberEntry }) {
  return (
    <div
      className={`flex items-center gap-3 rounded px-2 py-[6px] cursor-pointer transition-colors hover:bg-bg-modifier-hover ${
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
    </div>
  )
}
