export function restorePaneTriggerFocus(
  controlsId: string,
  messageId?: string | null,
): void {
  let framesRemaining = 6
  const tryFocus = () => {
    const scope = messageId
      ? [...document.querySelectorAll<HTMLElement>('[data-message-id]')]
          .find((candidate) => candidate.dataset.messageId === messageId)
      : document
    const trigger = scope?.querySelector<HTMLButtonElement>(
      `button[aria-controls="${controlsId}"]`,
    )
    trigger?.focus({ preventScroll: true })
    framesRemaining -= 1
    if (framesRemaining > 0) window.requestAnimationFrame(tryFocus)
  }
  window.requestAnimationFrame(tryFocus)
}
