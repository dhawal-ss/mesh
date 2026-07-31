export const MESH_REGION_SELECTOR = '[data-mesh-region]'

export function nextMeshRegion(
  regions: readonly HTMLElement[],
  activeElement: Element | null,
  backwards = false,
): HTMLElement | null {
  if (regions.length === 0) return null

  const currentIndex = regions.findIndex(
    (region) => region === activeElement || region.contains(activeElement),
  )
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
