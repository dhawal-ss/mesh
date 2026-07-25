import { create } from 'zustand'
import type { Community } from '../types/ipc'
import { patchChanges } from '../lib/state'

interface CommunitiesStore {
  /** Normalized source of truth. */
  communityEntities: Record<string, Community>
  communityOrder: string[]
  /** Ordered compatibility snapshot for list consumers. */
  communities: Community[]
  activeCommunityId: string | null
  setCommunities: (communities: Community[]) => void
  addCommunity: (community: Community) => void
  upsertCommunity: (community: Community) => void
  patchCommunity: (id: string, patch: Partial<Omit<Community, 'id'>>) => void
  removeCommunity: (id: string) => void
  setActiveCommunity: (id: string | null) => void
}

function mergeCommunity(existing: Community | undefined, incoming: Community): Community {
  if (!existing || patchChanges(existing, incoming)) return incoming
  return existing
}

function sameOrder(left: string[], right: string[]) {
  return left.length === right.length && left.every((id, index) => id === right[index])
}

function normalizeCommunities(
  communities: Community[],
  existing: Record<string, Community>,
) {
  const communityEntities: Record<string, Community> = {}
  const communityOrder: string[] = []

  for (const incoming of communities) {
    if (communityEntities[incoming.id]) continue
    communityEntities[incoming.id] = mergeCommunity(existing[incoming.id], incoming)
    communityOrder.push(incoming.id)
  }

  return {
    communityEntities,
    communityOrder,
    communities: communityOrder.map((id) => communityEntities[id]),
  }
}

export const useCommunityStore = create<CommunitiesStore>((set) => ({
  communityEntities: {},
  communityOrder: [],
  communities: [],
  activeCommunityId: null,

  setCommunities: (incoming) =>
    set((state) => {
      const normalized = normalizeCommunities(incoming, state.communityEntities)
      const activeCommunityId =
        state.activeCommunityId && normalized.communityEntities[state.activeCommunityId]
          ? state.activeCommunityId
          : normalized.communityOrder[0] ?? null
      const entitiesUnchanged =
        sameOrder(state.communityOrder, normalized.communityOrder) &&
        normalized.communityOrder.every(
          (id) => state.communityEntities[id] === normalized.communityEntities[id],
        )

      if (entitiesUnchanged && activeCommunityId === state.activeCommunityId) return state
      return { ...normalized, activeCommunityId }
    }),

  addCommunity: (community) =>
    set((state) => upsertCommunityState(state, community)),

  upsertCommunity: (community) =>
    set((state) => upsertCommunityState(state, community)),

  patchCommunity: (id, patch) =>
    set((state) => {
      const current = state.communityEntities[id]
      if (!current || !patchChanges(current, patch)) return state

      const next = { ...current, ...patch }
      const index = state.communityOrder.indexOf(id)
      const communities = [...state.communities]
      if (index >= 0) communities[index] = next

      return {
        communityEntities: { ...state.communityEntities, [id]: next },
        communities,
      }
    }),

  removeCommunity: (id) =>
    set((state) => {
      if (!state.communityEntities[id]) return state
      const communityEntities = { ...state.communityEntities }
      delete communityEntities[id]
      const communityOrder = state.communityOrder.filter((communityId) => communityId !== id)
      return {
        communityEntities,
        communityOrder,
        communities: communityOrder.map((communityId) => communityEntities[communityId]),
        activeCommunityId:
          state.activeCommunityId === id
            ? communityOrder[0] ?? null
            : state.activeCommunityId,
      }
    }),

  setActiveCommunity: (id) => set({ activeCommunityId: id }),
}))

function upsertCommunityState(
  state: CommunitiesStore,
  incoming: Community,
): Partial<CommunitiesStore> | CommunitiesStore {
  const current = state.communityEntities[incoming.id]
  const next = mergeCommunity(current, incoming)
  const communityOrder = current
    ? state.communityOrder
    : [...state.communityOrder, incoming.id]

  if (current === next) {
    if (state.activeCommunityId) return state
    return { activeCommunityId: incoming.id }
  }

  const communities = current
    ? [...state.communities]
    : [...state.communities, next]
  if (current) {
    const index = state.communityOrder.indexOf(incoming.id)
    if (index >= 0) communities[index] = next
  }

  return {
    communityEntities: { ...state.communityEntities, [incoming.id]: next },
    communityOrder,
    communities,
    activeCommunityId: state.activeCommunityId ?? incoming.id,
  }
}

export function useCommunity(id: string | null | undefined) {
  return useCommunityStore((state) => (id ? state.communityEntities[id] : undefined))
}

export function useActiveCommunity() {
  return useCommunityStore((state) =>
    state.activeCommunityId
      ? state.communityEntities[state.activeCommunityId]
      : undefined,
  )
}
