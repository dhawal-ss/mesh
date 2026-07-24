import { create } from 'zustand'

export interface MemberRecord {
  publicKey: string
  displayName: string
  avatarColor: string
  role: 'owner' | 'admin' | 'member'
  joinStatus: 'invited' | 'joined' | 'left'
  banStatus: 'none' | 'banned'
  lastSeen: string | null
  online?: boolean
}

interface MembershipStore {
  /** Members indexed by community ID */
  members: Record<string, MemberRecord[]>

  /** Set the full roster for a community (from initial load) */
  setRoster: (communityId: string, roster: MemberRecord[]) => void

  /** Clear all cached membership state for a community */
  clearCommunity: (communityId: string) => void

  /** Insert or update a single member */
  upsertMember: (communityId: string, member: MemberRecord) => void

  /** Remove a member from the roster */
  removeMember: (communityId: string, publicKey: string) => void

  /** Mark a member as banned (removes from active roster) */
  banMember: (communityId: string, publicKey: string) => void

  /** Update a member's role */
  updateRole: (communityId: string, publicKey: string, role: MemberRecord['role']) => void

  /** Update last seen timestamp */
  touchMember: (communityId: string, publicKey: string) => void

  /** Get members for a community */
  getMembersForCommunity: (communityId: string) => MemberRecord[]

  /** Get active members for a community */
  getActiveMembersForCommunity: (communityId: string) => MemberRecord[]

  /** Get member count for a community */
  getMemberCount: (communityId: string) => number
}

export const useMembershipStore = create<MembershipStore>((set, get) => ({
  members: {},

  setRoster: (communityId, roster) =>
    set((state) => ({
      members: { ...state.members, [communityId]: roster },
    })),

  clearCommunity: (communityId) =>
    set((state) => {
      const members = { ...state.members }
      delete members[communityId]
      return { members }
    }),

  upsertMember: (communityId, member) =>
    set((state) => {
      const current = state.members[communityId] ?? []
      const existing = current.findIndex((m) => m.publicKey === member.publicKey)
      const updated =
        existing >= 0
          ? current.map((m, i) => (i === existing ? { ...m, ...member } : m))
          : [...current, member]
      return { members: { ...state.members, [communityId]: updated } }
    }),

  removeMember: (communityId, publicKey) =>
    set((state) => {
      const current = state.members[communityId] ?? []
      return {
        members: {
          ...state.members,
          [communityId]: current.map((member) =>
            member.publicKey === publicKey
              ? { ...member, joinStatus: 'left' }
              : member,
          ),
        },
      }
    }),

  banMember: (communityId, publicKey) =>
    set((state) => {
      const current = state.members[communityId] ?? []
      return {
        members: {
          ...state.members,
          [communityId]: current.map((member) =>
            member.publicKey === publicKey
              ? { ...member, joinStatus: 'left', banStatus: 'banned' }
              : member,
          ),
        },
      }
    }),

  updateRole: (communityId, publicKey, role) =>
    set((state) => {
      const current = state.members[communityId] ?? []
      return {
        members: {
          ...state.members,
          [communityId]: current.map((m) =>
            m.publicKey === publicKey ? { ...m, role } : m,
          ),
        },
      }
    }),

  touchMember: (communityId, publicKey) =>
    set((state) => {
      const current = state.members[communityId] ?? []
      return {
        members: {
          ...state.members,
          [communityId]: current.map((m) =>
            m.publicKey === publicKey
              ? { ...m, lastSeen: new Date().toISOString() }
              : m,
          ),
        },
      }
    }),

  getMembersForCommunity: (communityId) => get().members[communityId] ?? [],

  getActiveMembersForCommunity: (communityId) =>
    (get().members[communityId] ?? []).filter(
      (member) => member.joinStatus === 'joined' && member.banStatus === 'none',
    ),

  getMemberCount: (communityId) =>
    (get().members[communityId] ?? []).filter(
      (member) => member.joinStatus === 'joined' && member.banStatus === 'none',
    ).length,
}))
