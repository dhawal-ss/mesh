export type SubscriptionCleanup = () => void | Promise<void>

/**
 * Settle asynchronous listener registration during unmount without leaking a
 * rejected registration or cleanup promise into the global error boundary.
 */
export function disposeSubscription(
  subscription: Promise<SubscriptionCleanup> | undefined,
  label: string,
): void {
  if (!subscription) return
  void subscription
    .then((stopListening) => stopListening())
    .catch((error) => {
      console.warn(`Failed to stop ${label}:`, error)
    })
}
