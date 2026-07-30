import { create } from 'zustand'
import type { PendingInvitationMetadata } from '../types/ipc'

export type ServerModalTab = 'create' | 'join' | 'discover'

interface ShellStore {
  serverModalOpen: boolean
  serverModalTab: ServerModalTab
  pendingInvitation: PendingInvitationMetadata | null
  profileOpen: boolean
  securityOpen: boolean
  openServerModal: (tab: ServerModalTab) => void
  closeServerModal: () => void
  setPendingInvitation: (pendingInvitation: PendingInvitationMetadata | null) => void
  setProfileOpen: (open: boolean) => void
  setSecurityOpen: (open: boolean) => void
}

export const useShellStore = create<ShellStore>()(
  (set) => ({
    serverModalOpen: false,
    serverModalTab: 'create',
    pendingInvitation: null,
    profileOpen: false,
    securityOpen: false,
    openServerModal: (serverModalTab) => set({ serverModalOpen: true, serverModalTab }),
    closeServerModal: () => set({ serverModalOpen: false }),
    setPendingInvitation: (pendingInvitation) => set({ pendingInvitation }),
    setProfileOpen: (profileOpen) => set({ profileOpen }),
    setSecurityOpen: (securityOpen) => set({ securityOpen }),
  }),
)
