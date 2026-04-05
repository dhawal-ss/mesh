import { create } from 'zustand'
import type { Community } from '../types/ipc'

interface CommunitiesStore {
  communities: Community[]
  activeCommunityId: string | null
  setCommunities: (communities: Community[]) => void
  addCommunity: (community: Community) => void
  upsertCommunity: (community: Community) => void
  patchCommunity: (id: string, patch: Partial<Omit<Community, 'id'>>) => void
  removeCommunity: (id: string) => void
  setActiveCommunity: (id: string | null) => void
}

function mergeCommunity(existing: Community | undefined, community: Community): Community {
  if (!existing) {
    return community
  }

  return {
    ...existing,
    ...community,
    id: community.id,
  }
}

export const useCommunityStore = create<CommunitiesStore>((set) => ({
  communities: [],
  activeCommunityId: null,
  setCommunities: (communities) =>
    set((state) => {
      const merged = communities.map((community) =>
        mergeCommunity(state.communities.find((entry) => entry.id === community.id), community),
      )

      return {
        communities: merged,
        activeCommunityId:
          state.activeCommunityId && merged.some((community) => community.id === state.activeCommunityId)
            ? state.activeCommunityId
            : merged[0]?.id ?? null,
      }
    }),
  addCommunity: (community) =>
    set((state) => ({
      communities: [
        ...state.communities.filter((entry) => entry.id !== community.id),
        mergeCommunity(state.communities.find((entry) => entry.id === community.id), community),
      ],
      activeCommunityId: state.activeCommunityId ?? community.id,
    })),
  upsertCommunity: (community) =>
    set((state) => ({
      communities: [
        ...state.communities.filter((entry) => entry.id !== community.id),
        mergeCommunity(state.communities.find((entry) => entry.id === community.id), community),
      ],
      activeCommunityId: state.activeCommunityId ?? community.id,
    })),
  patchCommunity: (id, patch) =>
    set((state) => ({
      communities: state.communities.map((community) =>
        community.id === id ? { ...community, ...patch } : community,
      ),
    })),
  removeCommunity: (id) =>
    set((state) => {
      const communities = state.communities.filter((c) => c.id !== id)
      return {
        communities,
        activeCommunityId:
          state.activeCommunityId === id
            ? communities[0]?.id ?? null
            : state.activeCommunityId,
      }
    }),
  setActiveCommunity: (id) => set({ activeCommunityId: id }),
}))
