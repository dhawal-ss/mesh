import { useEffect, useLayoutEffect } from 'react'

const FOCUSABLE_SELECTOR = [
  'button:not([disabled])',
  'a[href]',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',')

export function useCompactPaneFocus({
  active,
  compact,
  panelId,
  onClose,
}: {
  active: boolean
  compact: boolean
  panelId: string | null
  onClose: () => void
}): void {
  useEffect(() => {
    if (!active) return
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      event.preventDefault()
      onClose()
    }
    window.addEventListener('keydown', handleEscape)
    return () => window.removeEventListener('keydown', handleEscape)
  }, [active, onClose])

  useLayoutEffect(() => {
    if (!active || !compact || !panelId) return
    const getPanel = () => document.getElementById(panelId)
    const visibleFocusables = () => [
      ...(getPanel()?.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR) ?? []),
    ].filter((element) => !element.hidden && element.getClientRects().length > 0)
    const focusFirst = () => {
      const panel = getPanel()
      if (!panel) return false
      ;(visibleFocusables()[0] ?? panel).focus()
      return true
    }

    focusFirst()
    const focusFrame = window.requestAnimationFrame(focusFirst)
    const mountObserver = new MutationObserver(() => {
      if (focusFirst()) mountObserver.disconnect()
    })
    mountObserver.observe(document.body, { childList: true, subtree: true })

    const handleTab = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return
      const focusables = visibleFocusables()
      if (focusables.length === 0) return
      const first = focusables[0]
      const last = focusables[focusables.length - 1]
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', handleTab)
    return () => {
      window.cancelAnimationFrame(focusFrame)
      mountObserver.disconnect()
      document.removeEventListener('keydown', handleTab)
    }
  }, [active, compact, panelId])
}
