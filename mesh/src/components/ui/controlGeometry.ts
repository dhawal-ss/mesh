export type UiSize = 'sm' | 'md' | 'lg'

/**
 * Shared controls resolve through the density-aware geometry tokens so
 * adjacent actions stay aligned in every display density.
 *
 * The Material 3 defaults are 40, 48 and 56. `md` is the primary touch target
 * the density contract asks for, and no density takes any of the three below
 * the 32px floor.
 */
export const controlHeightClasses: Record<UiSize, string> = {
  sm: 'h-control-sm',
  md: 'h-control-md',
  lg: 'h-control-lg',
}

export const controlWidthClasses: Record<UiSize, string> = {
  sm: 'w-control-sm',
  md: 'w-control-md',
  lg: 'w-control-lg',
}
