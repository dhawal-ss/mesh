import { create } from 'zustand'
import type { Channel } from '../types/ipc'

interface ChannelsStore {
  channels: Channel[]
  activeChannelId: string | null
  setChannels: (channels: Channel[]) => void
  addChannel: (channel: Channel) => void
  upsertChannel: (channel: Channel) => void
  removeChannel: (id: string) => void
  patchChannel: (id: string, patch: Partial<Omit<Channel, 'id' | 'communityId'>>) => void
  setActiveChannel: (id: string | null) => void
}

function mergeChannel(existing: Channel | undefined, channel: Channel): Channel {
  if (!existing) {
    return channel
  }

  return {
    ...existing,
    ...channel,
    id: channel.id,
    communityId: channel.communityId,
  }
}

export const useChannelStore = create<ChannelsStore>((set) => ({
  channels: [],
  activeChannelId: null,
  setChannels: (channels) =>
    set((state) => ({
      channels: channels.map((channel) =>
        mergeChannel(state.channels.find((entry) => entry.id === channel.id), channel),
      ),
      activeChannelId:
        state.activeChannelId && channels.some((channel) => channel.id === state.activeChannelId)
          ? state.activeChannelId
          : channels[0]?.id ?? null,
    })),
  addChannel: (channel) =>
    set((state) => ({
      channels: [
        ...state.channels.filter((entry) => entry.id !== channel.id),
        mergeChannel(state.channels.find((entry) => entry.id === channel.id), channel),
      ],
    })),
  upsertChannel: (channel) =>
    set((state) => ({
      channels: [
        ...state.channels.filter((entry) => entry.id !== channel.id),
        mergeChannel(state.channels.find((entry) => entry.id === channel.id), channel),
      ],
    })),
  removeChannel: (id) =>
    set((state) => ({
      channels: state.channels.filter((channel) => channel.id !== id),
      activeChannelId: state.activeChannelId === id ? null : state.activeChannelId,
    })),
  patchChannel: (id, patch) =>
    set((state) => ({
      channels: state.channels.map((channel) =>
        channel.id === id ? { ...channel, ...patch } : channel,
      ),
    })),
  setActiveChannel: (id) => set({ activeChannelId: id }),
}))
