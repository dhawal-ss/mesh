import { create } from 'zustand'
import type { Message } from '../types/ipc'
import { registerAccountReset } from '../lib/account-reset-registry'

export interface MessageNavigationRequest {
  requestId: number
  message: Message
}

interface MessageNavigationStore {
  pending: MessageNavigationRequest | null
  requestNavigation: (message: Message) => void
  completeNavigation: (requestId: number) => void
}

let nextRequestId = 1

export const useMessageNavigationStore = create<MessageNavigationStore>((set) => ({
  pending: null,
  requestNavigation: (message) => {
    set({
      pending: {
        requestId: nextRequestId,
        message,
      },
    })
    nextRequestId += 1
  },
  completeNavigation: (requestId) => {
    set((state) => (
      state.pending?.requestId === requestId
        ? { pending: null }
        : state
    ))
  },
}))

registerAccountReset('message-navigation', () => {
  useMessageNavigationStore.setState({ pending: null })
})
