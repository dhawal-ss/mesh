import {
  Activity,
  Check,
  ChevronDown,
  CirclePlus,
  CircleX,
  CodeXml,
  File,
  FileText,
  HeadphoneOff,
  Headphones,
  Hash,
  Image,
  LoaderCircle,
  LockKeyhole,
  Menu,
  MessageCircle,
  Mic,
  MicOff,
  PhoneOff,
  Play,
  Plus,
  RefreshCw,
  Reply,
  Search,
  Send,
  Smile,
  SquarePen,
  Settings,
  TriangleAlert,
  Upload,
  UserPlus,
  Users,
  Volume2,
  X,
  type LucideIcon,
  type LucideProps,
} from 'lucide-react'

const ICONS = {
  activity: Activity,
  check: Check,
  chevronDown: ChevronDown,
  circlePlus: CirclePlus,
  circleX: CircleX,
  code: CodeXml,
  file: File,
  fileText: FileText,
  headphoneOff: HeadphoneOff,
  headphones: Headphones,
  hash: Hash,
  image: Image,
  loader: LoaderCircle,
  lock: LockKeyhole,
  menu: Menu,
  messageCircle: MessageCircle,
  mic: Mic,
  micOff: MicOff,
  phoneOff: PhoneOff,
  play: Play,
  plus: Plus,
  refresh: RefreshCw,
  reply: Reply,
  search: Search,
  send: Send,
  smile: Smile,
  squarePen: SquarePen,
  settings: Settings,
  triangleAlert: TriangleAlert,
  upload: Upload,
  userPlus: UserPlus,
  users: Users,
  volume: Volume2,
  x: X,
} satisfies Record<string, LucideIcon>

const ICON_SIZES = {
  xs: 14,
  sm: 16,
  md: 20,
  lg: 24,
} as const

export type IconName = keyof typeof ICONS
export type IconSize = keyof typeof ICON_SIZES

export interface IconProps
  extends Omit<LucideProps, 'absoluteStrokeWidth' | 'size' | 'strokeWidth'> {
  name: IconName
  size?: IconSize
}

export function Icon({
  name,
  size = 'md',
  'aria-hidden': ariaHidden,
  'aria-label': ariaLabel,
  role,
  ...props
}: IconProps) {
  const Glyph = ICONS[name]
  const isDecorative = ariaHidden ?? !ariaLabel

  return (
    <Glyph
      {...props}
      size={ICON_SIZES[size]}
      strokeWidth={size === 'lg' ? 1.75 : 1.5}
      absoluteStrokeWidth
      focusable="false"
      aria-hidden={isDecorative || undefined}
      aria-label={ariaLabel}
      role={ariaLabel ? (role ?? 'img') : role}
    />
  )
}
