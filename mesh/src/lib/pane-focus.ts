/**
 * A thread root can trigger the same panel from two places at once: the
 * message row that started it, and its row in the "My threads" list. Both
 * would otherwise share one `data-message-id`, so `restorePaneTriggerFocus`
 * could hand focus back to the wrong trigger. Callers that open a thread
 * from the list use this scoped key on both the trigger and the close call.
 */
export function threadListFocusScopeId(rootEventId: string): string {
  return `threads-list:${rootEventId}`
}

export function restorePaneTriggerFocus(
  controlsId: string,
  messageId?: string | null,
): void {
  let framesRemaining = 6
  let observedClosedState = false
  const tryFocus = () => {
    const scope = messageId
      ? [...document.querySelectorAll<HTMLElement>('[data-message-id]')]
          .find((candidate) => candidate.dataset.messageId === messageId)
      : document
    const trigger = scope?.querySelector<HTMLButtonElement>(
      `button[aria-controls="${controlsId}"]`,
    )
    const paneIsOpen = document.getElementById(controlsId) !== null
      || trigger?.getAttribute('aria-expanded') === 'true'
    if (paneIsOpen) {
      if (observedClosedState) return
    } else {
      observedClosedState = true
      trigger?.focus({ preventScroll: true })
    }
    framesRemaining -= 1
    if (framesRemaining > 0) window.requestAnimationFrame(tryFocus)
  }
  window.requestAnimationFrame(tryFocus)
}
