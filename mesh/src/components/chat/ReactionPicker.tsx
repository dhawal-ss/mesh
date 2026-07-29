import { motion } from 'framer-motion'
import { variants } from '../../lib/motion'
import type { LoadedServerEmoji } from '../../store/custom-emoji'

const REACTIONS = ['👍', '❤️', '😂', '🔥', '👀', '🎉', '💯', '✅', '🤔', '👋']

interface ReactionPickerProps {
  onSelect: (emoji: string) => void
  onClose: () => void
  customEmoji?: readonly LoadedServerEmoji[]
}

export function ReactionPicker({
  onSelect,
  onClose,
  customEmoji = [],
}: ReactionPickerProps) {
  return (
    <motion.div
      role="toolbar"
      aria-label="Add reaction"
      variants={variants.popover}
      initial="initial"
      animate="animate"
      exit="exit"
      className="mesh-reaction-picker z-popover flex flex-wrap items-center gap-0.5 rounded-panel border border-border-subtle bg-surface-overlay px-1.5 py-1 shadow-overlay"
      onMouseLeave={onClose}
    >
      {REACTIONS.map((emoji) => (
        <button
          key={emoji}
          type="button"
          onClick={() => {
            onSelect(emoji)
            onClose()
          }}
          className="flex h-7 w-7 items-center justify-center rounded-sm text-sm transition-colors hover:bg-surface-active active:scale-95"
        >
          {emoji}
        </button>
      ))}
      {customEmoji.map((emoji) => (
        <button
          key={emoji.shortcode}
          type="button"
          title={`:${emoji.shortcode}:`}
          aria-label={`React with ${emoji.shortcode}`}
          onClick={() => {
            onSelect(`:${emoji.shortcode}:`)
            onClose()
          }}
          className="flex h-7 w-7 items-center justify-center rounded-sm transition-colors hover:bg-surface-active active:scale-95"
        >
          <img
            src={emoji.imageUrl}
            alt=""
            className="h-5 w-5 object-contain"
          />
        </button>
      ))}
    </motion.div>
  )
}
