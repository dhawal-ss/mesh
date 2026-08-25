import { Icon, type IconSize } from './Icon'

const SPINNER_SIZES: Record<14 | 16 | 20 | 24, IconSize> = {
  14: 'xs',
  16: 'sm',
  20: 'md',
  24: 'lg',
}

/**
 * Indeterminate activity.
 *
 * The glyph spins only where movement is welcome. Reduced motion stops every
 * `animate-` class, which used to leave a static loader icon that meant
 * nothing, so the reduced route swaps in the three-cell tick from globals.css:
 * bounded progress the contract protects, without rotation. The status is
 * always named, so the state survives even when neither indicator is seen.
 */
export function Spinner({
  size = 16,
  label = 'Loading',
}: {
  size?: 14 | 16 | 20 | 24
  /** Accessible name for the process. Keep it specific where the caller knows it. */
  label?: string
}) {
  return (
    <span role="status" className="inline-flex items-center justify-center">
      <Icon name="loader" size={SPINNER_SIZES[size]} className="mesh-spinner-glyph animate-spin" />
      <span className="mesh-spinner-steps" aria-hidden="true">
        <span />
        <span />
        <span />
      </span>
      <span className="sr-only">{label}</span>
    </span>
  )
}
