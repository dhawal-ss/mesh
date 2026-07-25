import { create } from 'zustand'

export type ServerModalTab = 'create' | 'join' | 'discover'

interface ShellStore {
  serverModalOpen: boolean
  serverModalTab: ServerModalTab
  inviteDraft: string
  profileOpen: boolean
  openServerModal: (tab: ServerModalTab, inviteDraft?: string) => void
  closeServerModal: () => void
  setProfileOpen: (open: boolean) => void
}

export const useShellStore = create<ShellStore>((set) => ({
  serverModalOpen: false,
  serverModalTab: 'create',
  inviteDraft: '',
  profileOpen: false,
  openServerModal: (serverModalTab, inviteDraft = '') =>
    set({ serverModalOpen: true, serverModalTab, inviteDraft }),
  closeServerModal: () =>
    set({ serverModalOpen: false, inviteDraft: '' }),
  setProfileOpen: (profileOpen) => set({ profileOpen }),
}))
