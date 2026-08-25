import { create } from 'zustand'
import type { PendingInvitationMetadata } from '../types/ipc'
import { registerAccountReset } from '../lib/account-reset-registry'

export type ServerModalTab = 'create' | 'join' | 'discover'

interface ShellStore {
  serverModalOpen: boolean
  serverModalTab: ServerModalTab
  pendingInvitation: PendingInvitationMetadata | null
  foregroundInvitationHandle: string | null
  profileOpen: boolean
  securityOpen: boolean
  diagnosticsOpen: boolean
  feedbackOpen: boolean
  openServerModal: (tab: ServerModalTab) => void
  closeServerModal: () => void
  setPendingInvitation: (pendingInvitation: PendingInvitationMetadata | null) => void
  foregroundPendingInvitation: () => void
  savePendingInvitationForLater: () => void
  setProfileOpen: (open: boolean) => void
  setSecurityOpen: (open: boolean) => void
  setDiagnosticsOpen: (open: boolean) => void
  setFeedbackOpen: (open: boolean) => void
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
    feedbackOpen: false,
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
    setFeedbackOpen: (feedbackOpen) => set({ feedbackOpen }),
  }),
)

registerAccountReset('shell', () => {
  useShellStore.setState({
    serverModalOpen: false,
    profileOpen: false,
    securityOpen: false,
  })
})
