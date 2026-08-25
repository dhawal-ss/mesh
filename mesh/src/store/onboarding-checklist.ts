import { create } from 'zustand'
import {
  emptyOnboardingChecklist,
  onboardingChecklistStorageKey,
  restoreOnboardingChecklist,
  serializeOnboardingChecklist,
  type OnboardingChecklistSnapshot,
  type OnboardingStepId,
} from '../lib/onboarding-checklist'
import {
  safeLocalStorageGet,
  safeLocalStorageRemove,
  safeLocalStorageSet,
} from '../lib/safe-storage'
import { registerAccountReset } from '../lib/account-reset-registry'

interface OnboardingChecklistStore extends OnboardingChecklistSnapshot {
  hydrated: boolean
  initialize: (accountId: string) => void
  /**
   * Record every step currently complete. Called with what the facts say, as
   * often as they change; it writes only when something is new, so a render
   * that changes nothing does not touch storage.
   */
  observe: (completeStepIds: readonly OnboardingStepId[]) => void
  setCollapsed: (collapsed: boolean) => void
  dismiss: () => void
  show: () => void
  resetForAccountTransition: (removedAccountId?: string | null) => void
}

const initial = emptyOnboardingChecklist('local-device')

function write(state: OnboardingChecklistSnapshot): void {
  safeLocalStorageSet(
    onboardingChecklistStorageKey(state.accountId),
    serializeOnboardingChecklist(state),
  )
}

export const useOnboardingChecklistStore = create<OnboardingChecklistStore>()((set, get) => ({
  ...initial,
  hydrated: false,

  initialize: (accountId) => {
    if (get().hydrated && get().accountId === accountId) return
    const restored = restoreOnboardingChecklist(
      safeLocalStorageGet(onboardingChecklistStorageKey(accountId)),
      accountId,
    )
    set({ ...restored, hydrated: true })
  },

  observe: (completeStepIds) => {
    const state = get()
    if (!state.hydrated) return
    const known = new Set(state.reached)
    const added = completeStepIds.filter((id) => !known.has(id))
    if (added.length === 0) return
    const reached = [...state.reached, ...added]
    write({ ...state, reached })
    set({ reached })
  },

  setCollapsed: (collapsed) => {
    const state = get()
    if (state.collapsed === collapsed) return
    write({ ...state, collapsed })
    set({ collapsed })
  },

  dismiss: () => {
    const state = get()
    if (state.dismissed) return
    write({ ...state, dismissed: true })
    set({ dismissed: true })
  },

  /** Bring a hidden checklist back, expanded, so it cannot return invisible. */
  show: () => {
    const state = get()
    if (!state.dismissed && !state.collapsed) return
    write({ ...state, dismissed: false, collapsed: false })
    set({ dismissed: false, collapsed: false })
  },

  resetForAccountTransition: (removedAccountId) => {
    if (removedAccountId) {
      safeLocalStorageRemove(onboardingChecklistStorageKey(removedAccountId))
    }
    set({ ...emptyOnboardingChecklist('local-device'), hydrated: false })
  },
}))

registerAccountReset('onboarding-checklist', (removedAccountId) => {
  useOnboardingChecklistStore.getState().resetForAccountTransition(removedAccountId)
})
