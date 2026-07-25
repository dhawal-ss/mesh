import { Icon, type IconSize } from './Icon'

const SPINNER_SIZES: Record<14 | 16 | 20 | 24, IconSize> = {
  14: 'xs',
  16: 'sm',
  20: 'md',
  24: 'lg',
}

export function Spinner({ size = 16 }: { size?: 14 | 16 | 20 | 24 }) {
  return <Icon name="loader" size={SPINNER_SIZES[size]} className="animate-spin" />
}
