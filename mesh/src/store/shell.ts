import { create } from 'zustand'
import type { PendingInvitationMetadata } from '../types/ipc'

export type ServerModalTab = 'create' | 'join' | 'discover'

interface ShellStore {
  serverModalOpen: boolean
  serverModalTab: ServerModalTab
  pendingInvitation: PendingInvitationMetadata | null
  foregroundInvitationHandle: string | null
  profileOpen: boolean
  securityOpen: boolean
  diagnosticsOpen: boolean
  openServerModal: (tab: ServerModalTab) => void
  closeServerModal: () => void
  setPendingInvitation: (pendingInvitation: PendingInvitationMetadata | null) => void
  foregroundPendingInvitation: () => void
  savePendingInvitationForLater: () => void
  setProfileOpen: (open: boolean) => void
  setSecurityOpen: (open: boolean) => void
  setDiagnosticsOpen: (open: boolean) => void
}

export const useShellStore = create<ShellStore>()(
  (set) => ({
    serverModalOpen: false,
    serverModalTab: 'create',
    pendingInvitation: null,
    foregroundInvitationHandle: null,
    profileOpen: false,
    securityOpen: false,
    diagnosticsOpen: false,
    openServerModal: (serverModalTab) => set({ serverModalOpen: true, serverModalTab }),
    closeServerModal: () => set({ serverModalOpen: false }),
    setPendingInvitation: (pendingInvitation) => set((state) => ({
      pendingInvitation,
      foregroundInvitationHandle: pendingInvitation
        ? state.pendingInvitation?.handle === pendingInvitation.handle
          ? state.foregroundInvitationHandle
          : pendingInvitation.handle
        : null,
    })),
    foregroundPendingInvitation: () => set((state) => ({
      foregroundInvitationHandle: state.pendingInvitation?.handle ?? null,
    })),
    savePendingInvitationForLater: () => set({ foregroundInvitationHandle: null }),
    setProfileOpen: (profileOpen) => set({ profileOpen }),
    setSecurityOpen: (securityOpen) => set({ securityOpen }),
    setDiagnosticsOpen: (diagnosticsOpen) => set({ diagnosticsOpen }),
  }),
)
