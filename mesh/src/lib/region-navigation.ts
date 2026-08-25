export const MESH_REGION_SELECTOR = '[data-mesh-region]'

export function nextMeshRegion(
  regions: readonly HTMLElement[],
  activeElement: Element | null,
  backwards = false,
): HTMLElement | null {
  if (regions.length === 0) return null

  /*
   * Innermost containing region wins. Regions nest: `main#mesh-conversation`
   * contains both the room context panel and the composer, so a forward scan
   * resolved a focused composer to `main` and F6 handed focus straight back to
   * the region it started in. Scanning in reverse picks the deepest match,
   * because a nested region is always rendered after its container in document
   * order. `findLastIndex` is ES2023 and this target is ES2020.
   */
  let currentIndex = -1
  for (let index = regions.length - 1; index >= 0; index -= 1) {
    const region = regions[index]
    if (region === activeElement || region.contains(activeElement)) {
      currentIndex = index
      break
    }
  }
  const step = backwards ? -1 : 1
  const startIndex = currentIndex < 0 ? (backwards ? 0 : -1) : currentIndex
  const nextIndex = (startIndex + step + regions.length) % regions.length
  return regions[nextIndex] ?? null
}

export function isVisibleMeshRegion(region: HTMLElement): boolean {
  if (region.hidden || region.getAttribute('aria-hidden') === 'true') return false
  if (region.closest('[inert]')) return false
  return region.getClientRects().length > 0
}
