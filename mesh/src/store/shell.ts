import { create } from 'zustand'
import type { PendingInvitationMetadata } from '../types/ipc'

export type ServerModalTab = 'create' | 'join' | 'discover'

interface ShellStore {
  serverModalOpen: boolean
  serverModalTab: ServerModalTab
  pendingInvitation: PendingInvitationMetadata | null
  profileOpen: boolean
  securityOpen: boolean
  diagnosticsOpen: boolean
  openServerModal: (tab: ServerModalTab) => void
  closeServerModal: () => void
  setPendingInvitation: (pendingInvitation: PendingInvitationMetadata | null) => void
  setProfileOpen: (open: boolean) => void
  setSecurityOpen: (open: boolean) => void
  setDiagnosticsOpen: (open: boolean) => void
}

export const useShellStore = create<ShellStore>()(
  (set) => ({
    serverModalOpen: false,
    serverModalTab: 'create',
    pendingInvitation: null,
    profileOpen: false,
    securityOpen: false,
    diagnosticsOpen: false,
    openServerModal: (serverModalTab) => set({ serverModalOpen: true, serverModalTab }),
    closeServerModal: () => set({ serverModalOpen: false }),
    setPendingInvitation: (pendingInvitation) => set({ pendingInvitation }),
    setProfileOpen: (profileOpen) => set({ profileOpen }),
    setSecurityOpen: (securityOpen) => set({ securityOpen }),
    setDiagnosticsOpen: (diagnosticsOpen) => set({ diagnosticsOpen }),
  }),
)
