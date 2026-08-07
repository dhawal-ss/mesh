import Activity from 'lucide-react/dist/esm/icons/activity.mjs'
import BellOff from 'lucide-react/dist/esm/icons/bell-off.mjs'
import Check from 'lucide-react/dist/esm/icons/check.mjs'
import ChevronDown from 'lucide-react/dist/esm/icons/chevron-down.mjs'
import CirclePlus from 'lucide-react/dist/esm/icons/circle-plus.mjs'
import CircleX from 'lucide-react/dist/esm/icons/circle-x.mjs'
import CodeXml from 'lucide-react/dist/esm/icons/code-xml.mjs'
import Ellipsis from 'lucide-react/dist/esm/icons/ellipsis.mjs'
import File from 'lucide-react/dist/esm/icons/file.mjs'
import FileText from 'lucide-react/dist/esm/icons/file-text.mjs'
import Compass from 'lucide-react/dist/esm/icons/compass.mjs'
import HeadphoneOff from 'lucide-react/dist/esm/icons/headphone-off.mjs'
import Headphones from 'lucide-react/dist/esm/icons/headphones.mjs'
import House from 'lucide-react/dist/esm/icons/house.mjs'
import Hash from 'lucide-react/dist/esm/icons/hash.mjs'
import Image from 'lucide-react/dist/esm/icons/image.mjs'
import LoaderCircle from 'lucide-react/dist/esm/icons/loader-circle.mjs'
import LockKeyhole from 'lucide-react/dist/esm/icons/lock-keyhole.mjs'
import Menu from 'lucide-react/dist/esm/icons/menu.mjs'
import MessageCircle from 'lucide-react/dist/esm/icons/message-circle.mjs'
import Mic from 'lucide-react/dist/esm/icons/mic.mjs'
import MicOff from 'lucide-react/dist/esm/icons/mic-off.mjs'
import PanelRight from 'lucide-react/dist/esm/icons/panel-right.mjs'
import Pin from 'lucide-react/dist/esm/icons/pin.mjs'
import PhoneOff from 'lucide-react/dist/esm/icons/phone-off.mjs'
import Play from 'lucide-react/dist/esm/icons/play.mjs'
import Plus from 'lucide-react/dist/esm/icons/plus.mjs'
import RefreshCw from 'lucide-react/dist/esm/icons/refresh-cw.mjs'
import Reply from 'lucide-react/dist/esm/icons/reply.mjs'
import Search from 'lucide-react/dist/esm/icons/search.mjs'
import Send from 'lucide-react/dist/esm/icons/send.mjs'
import Settings from 'lucide-react/dist/esm/icons/settings.mjs'
import ShieldCheck from 'lucide-react/dist/esm/icons/shield-check.mjs'
import Smile from 'lucide-react/dist/esm/icons/smile.mjs'
import SquarePen from 'lucide-react/dist/esm/icons/square-pen.mjs'
import TriangleAlert from 'lucide-react/dist/esm/icons/triangle-alert.mjs'
import Upload from 'lucide-react/dist/esm/icons/upload.mjs'
import UserPlus from 'lucide-react/dist/esm/icons/user-plus.mjs'
import Users from 'lucide-react/dist/esm/icons/users.mjs'
import Volume2 from 'lucide-react/dist/esm/icons/volume-2.mjs'
import X from 'lucide-react/dist/esm/icons/x.mjs'
import type { LucideIcon, LucideProps } from 'lucide-react'

const ICONS = {
  activity: Activity,
  bellOff: BellOff,
  check: Check,
  chevronDown: ChevronDown,
  circlePlus: CirclePlus,
  circleX: CircleX,
  code: CodeXml,
  ellipsis: Ellipsis,
  file: File,
  fileText: FileText,
  compass: Compass,
  headphoneOff: HeadphoneOff,
  headphones: Headphones,
  home: House,
  hash: Hash,
  image: Image,
  loader: LoaderCircle,
  lock: LockKeyhole,
  menu: Menu,
  messageCircle: MessageCircle,
  mic: Mic,
  micOff: MicOff,
  panelRight: PanelRight,
  pin: Pin,
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
  shieldCheck: ShieldCheck,
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
  md: 18,
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
