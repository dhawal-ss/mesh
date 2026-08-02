import { create } from 'zustand'
import type { Channel } from '../types/ipc'
import { patchChanges } from '../lib/state'

interface ChannelsStore {
  /** Normalized source of truth. */
  channelEntities: Record<string, Channel>
  channelOrder: string[]
  /** Ordered compatibility snapshot for list consumers. */
  channels: Channel[]
  activeChannelId: string | null
  refreshByCommunity: Record<string, CommunityRefreshState>
  refreshRequests: Record<string, number>
  setChannels: (channels: Channel[]) => void
  replaceCommunityChannels: (communityId: string, channels: Channel[]) => void
  setCommunityRefresh: (communityId: string, state: CommunityRefreshState) => void
  requestCommunityRefresh: (communityId: string) => void
  addChannel: (channel: Channel) => void
  upsertChannel: (channel: Channel) => void
  removeChannel: (id: string) => void
  patchChannel: (id: string, patch: Partial<Omit<Channel, 'id' | 'communityId'>>) => void
  setActiveChannel: (id: string | null) => void
}

export interface CommunityRefreshState {
  status: 'idle' | 'loading' | 'loaded' | 'stale' | 'failed'
  error: unknown | null
  generation: number
}

function mergeChannel(existing: Channel | undefined, incoming: Channel): Channel {
  if (!existing || patchChanges(existing, incoming)) return incoming
  return existing
}

function sameOrder(left: string[], right: string[]) {
  return left.length === right.length && left.every((id, index) => id === right[index])
}

function normalizeChannels(channels: Channel[], existing: Record<string, Channel>) {
  const channelEntities: Record<string, Channel> = {}
  const channelOrder: string[] = []

  for (const incoming of channels) {
    if (channelEntities[incoming.id]) continue
    channelEntities[incoming.id] = mergeChannel(existing[incoming.id], incoming)
    channelOrder.push(incoming.id)
  }

  return {
    channelEntities,
    channelOrder,
    channels: channelOrder.map((id) => channelEntities[id]),
  }
}

export const useChannelStore = create<ChannelsStore>((set) => ({
  channelEntities: {},
  channelOrder: [],
  channels: [],
  activeChannelId: null,
  refreshByCommunity: {},
  refreshRequests: {},

  setChannels: (incoming) =>
    set((state) => {
      const normalized = normalizeChannels(incoming, state.channelEntities)
      const activeChannelId =
        state.activeChannelId && normalized.channelEntities[state.activeChannelId]
          ? state.activeChannelId
          : normalized.channelOrder[0] ?? null
      const entitiesUnchanged =
        sameOrder(state.channelOrder, normalized.channelOrder) &&
        normalized.channelOrder.every(
          (id) => state.channelEntities[id] === normalized.channelEntities[id],
        )

      if (entitiesUnchanged && activeChannelId === state.activeChannelId) return state
      return { ...normalized, activeChannelId }
    }),

  replaceCommunityChannels: (communityId, incoming) =>
    set((state) => {
      const retained = state.channels.filter((channel) => channel.communityId !== communityId)
      const sanitized = incoming.filter((channel) => channel.communityId === communityId)
      const normalized = normalizeChannels([...retained, ...sanitized], state.channelEntities)
      const activeChannelId = state.activeChannelId
        && normalized.channelEntities[state.activeChannelId]
          ? state.activeChannelId
          : normalized.channelOrder.find(
              (id) => normalized.channelEntities[id].communityId === communityId,
            ) ?? normalized.channelOrder[0] ?? null
      return { ...normalized, activeChannelId }
    }),

  setCommunityRefresh: (communityId, refresh) =>
    set((state) => ({
      refreshByCommunity: { ...state.refreshByCommunity, [communityId]: refresh },
    })),

  requestCommunityRefresh: (communityId) =>
    set((state) => ({
      refreshRequests: {
        ...state.refreshRequests,
        [communityId]: (state.refreshRequests[communityId] ?? 0) + 1,
      },
    })),

  addChannel: (channel) =>
    set((state) => upsertChannelState(state, channel)),

  upsertChannel: (channel) =>
    set((state) => upsertChannelState(state, channel)),

  removeChannel: (id) =>
    set((state) => {
      if (!state.channelEntities[id]) return state
      const channelEntities = { ...state.channelEntities }
      delete channelEntities[id]
      const channelOrder = state.channelOrder.filter((channelId) => channelId !== id)
      return {
        channelEntities,
        channelOrder,
        channels: channelOrder.map((channelId) => channelEntities[channelId]),
        activeChannelId: state.activeChannelId === id ? null : state.activeChannelId,
      }
    }),

  patchChannel: (id, patch) =>
    set((state) => {
      const current = state.channelEntities[id]
      if (!current || !patchChanges(current, patch)) return state
      const next = { ...current, ...patch }
      const index = state.channelOrder.indexOf(id)
      const channels = [...state.channels]
      if (index >= 0) channels[index] = next
      return {
        channelEntities: { ...state.channelEntities, [id]: next },
        channels,
      }
    }),

  setActiveChannel: (id) => set({ activeChannelId: id }),
}))

function upsertChannelState(
  state: ChannelsStore,
  incoming: Channel,
): Partial<ChannelsStore> | ChannelsStore {
  const current = state.channelEntities[incoming.id]
  const next = mergeChannel(current, incoming)
  if (current === next) return state

  const channelOrder = current
    ? state.channelOrder
    : [...state.channelOrder, incoming.id]
  const channels = current
    ? [...state.channels]
    : [...state.channels, next]
  if (current) {
    const index = state.channelOrder.indexOf(incoming.id)
    if (index >= 0) channels[index] = next
  }

  return {
    channelEntities: { ...state.channelEntities, [incoming.id]: next },
    channelOrder,
    channels,
  }
}

export function useChannel(id: string | null | undefined) {
  return useChannelStore((state) => (id ? state.channelEntities[id] : undefined))
}

export function useActiveChannel() {
  return useChannelStore((state) =>
    state.activeChannelId
      ? state.channelEntities[state.activeChannelId]
      : undefined,
  )
}
