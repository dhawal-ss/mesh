export type UiSize = 'sm' | 'md' | 'lg'

/**
 * Shared controls resolve through the density-aware geometry tokens so
 * adjacent actions stay aligned in every display density.
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
