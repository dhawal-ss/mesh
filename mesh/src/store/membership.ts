import { create } from 'zustand'
import { patchChanges } from '../lib/state'

export interface MemberRecord {
  publicKey: string
  displayName: string
  avatarColor: string
  avatarUrl?: string | null
  role: 'owner' | 'admin' | 'member'
  joinStatus: 'invited' | 'joined' | 'left'
  banStatus: 'none' | 'banned'
  lastSeen: string | null
  online?: boolean
}

interface MembershipStore {
  /** Normalized member source of truth, scoped by community ID. */
  memberEntities: Record<string, Record<string, MemberRecord>>
  memberOrder: Record<string, string[]>
  /** Ordered compatibility snapshots for roster consumers. */
  members: Record<string, MemberRecord[]>
  setRoster: (communityId: string, roster: MemberRecord[]) => void
  clearCommunity: (communityId: string) => void
  upsertMember: (communityId: string, member: MemberRecord) => void
  removeMember: (communityId: string, publicKey: string) => void
  banMember: (communityId: string, publicKey: string) => void
  updateRole: (communityId: string, publicKey: string, role: MemberRecord['role']) => void
  touchMember: (communityId: string, publicKey: string) => void
  getMembersForCommunity: (communityId: string) => MemberRecord[]
  getActiveMembersForCommunity: (communityId: string) => MemberRecord[]
  getMemberCount: (communityId: string) => number
}

function sameOrder(left: string[], right: string[]) {
  return left.length === right.length && left.every((id, index) => id === right[index])
}

function normalizeRoster(
  roster: MemberRecord[],
  existing: Record<string, MemberRecord>,
) {
  const entities: Record<string, MemberRecord> = {}
  const order: string[] = []

  for (const incoming of roster) {
    if (entities[incoming.publicKey]) continue
    const current = existing[incoming.publicKey]
    entities[incoming.publicKey] =
      !current || patchChanges(current, incoming) ? incoming : current
    order.push(incoming.publicKey)
  }

  return {
    entities,
    order,
    members: order.map((publicKey) => entities[publicKey]),
  }
}

export const useMembershipStore = create<MembershipStore>((set, get) => ({
  memberEntities: {},
  memberOrder: {},
  members: {},

  setRoster: (communityId, roster) =>
    set((state) => {
      const normalized = normalizeRoster(
        roster,
        state.memberEntities[communityId] ?? {},
      )
      const currentOrder = state.memberOrder[communityId] ?? []
      const unchanged =
        sameOrder(currentOrder, normalized.order) &&
        normalized.order.every(
          (publicKey) =>
            state.memberEntities[communityId]?.[publicKey] === normalized.entities[publicKey],
        )
      if (unchanged) return state

      return {
        memberEntities: {
          ...state.memberEntities,
          [communityId]: normalized.entities,
        },
        memberOrder: {
          ...state.memberOrder,
          [communityId]: normalized.order,
        },
        members: {
          ...state.members,
          [communityId]: normalized.members,
        },
      }
    }),

  clearCommunity: (communityId) =>
    set((state) => {
      if (
        !state.memberEntities[communityId] &&
        !state.memberOrder[communityId] &&
        !state.members[communityId]
      ) {
        return state
      }
      const memberEntities = { ...state.memberEntities }
      const memberOrder = { ...state.memberOrder }
      const members = { ...state.members }
      delete memberEntities[communityId]
      delete memberOrder[communityId]
      delete members[communityId]
      return { memberEntities, memberOrder, members }
    }),

  upsertMember: (communityId, incoming) =>
    set((state) => {
      const communityEntities = state.memberEntities[communityId] ?? {}
      const current = communityEntities[incoming.publicKey]
      const next = !current || patchChanges(current, incoming) ? incoming : current
      if (current === next) return state

      const order = state.memberOrder[communityId] ?? []
      if (!current) {
        return {
          memberEntities: {
            ...state.memberEntities,
            [communityId]: { ...communityEntities, [incoming.publicKey]: next },
          },
          memberOrder: {
            ...state.memberOrder,
            [communityId]: [...order, incoming.publicKey],
          },
          members: {
            ...state.members,
            [communityId]: [...(state.members[communityId] ?? []), next],
          },
        }
      }

      return patchMemberState(state, communityId, incoming.publicKey, next)
    }),

  removeMember: (communityId, publicKey) =>
    set((state) => {
      const current = state.memberEntities[communityId]?.[publicKey]
      if (!current || current.joinStatus === 'left') return state
      return patchMemberState(
        state,
        communityId,
        publicKey,
        { ...current, joinStatus: 'left' },
      )
    }),

  banMember: (communityId, publicKey) =>
    set((state) => {
      const current = state.memberEntities[communityId]?.[publicKey]
      if (!current || (current.joinStatus === 'left' && current.banStatus === 'banned')) {
        return state
      }
      return patchMemberState(
        state,
        communityId,
        publicKey,
        { ...current, joinStatus: 'left', banStatus: 'banned' },
      )
    }),

  updateRole: (communityId, publicKey, role) =>
    set((state) => {
      const current = state.memberEntities[communityId]?.[publicKey]
      if (!current || current.role === role) return state
      return patchMemberState(
        state,
        communityId,
        publicKey,
        { ...current, role },
      )
    }),

  touchMember: (communityId, publicKey) =>
    set((state) => {
      const current = state.memberEntities[communityId]?.[publicKey]
      if (!current) return state
      return patchMemberState(
        state,
        communityId,
        publicKey,
        { ...current, lastSeen: new Date().toISOString() },
      )
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

function patchMemberState(
  state: MembershipStore,
  communityId: string,
  publicKey: string,
  next: MemberRecord,
): Partial<MembershipStore> {
  const index = (state.memberOrder[communityId] ?? []).indexOf(publicKey)
  const members = [...(state.members[communityId] ?? [])]
  if (index >= 0) members[index] = next

  return {
    memberEntities: {
      ...state.memberEntities,
      [communityId]: {
        ...state.memberEntities[communityId],
        [publicKey]: next,
      },
    },
    members: { ...state.members, [communityId]: members },
  }
}

export function useMember(
  communityId: string | null | undefined,
  publicKey: string | null | undefined,
) {
  return useMembershipStore((state) =>
    communityId && publicKey
      ? state.memberEntities[communityId]?.[publicKey]
      : undefined,
  )
}

const EMPTY_MEMBERS: MemberRecord[] = []

export function useCommunityMembers(communityId: string | null | undefined) {
  return useMembershipStore((state) =>
    communityId
      ? state.members[communityId] ?? EMPTY_MEMBERS
      : EMPTY_MEMBERS,
  )
}
