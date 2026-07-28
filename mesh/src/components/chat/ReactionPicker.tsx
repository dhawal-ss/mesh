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
      className="flex items-center gap-0.5 rounded-full border border-border-strong bg-surface-overlay/95 px-2 py-1.5 shadow-overlay backdrop-blur-2xl"
      onMouseLeave={onClose}
    >
      {REACTIONS.map((emoji) => (
        <button
          key={emoji}
          onClick={() => {
            onSelect(emoji)
            onClose()
          }}
          className="flex h-8 w-8 items-center justify-center rounded-full text-base transition-colors hover:bg-surface-active active:scale-95"
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
          className="flex h-8 w-8 items-center justify-center rounded-full transition-colors hover:bg-surface-active active:scale-95"
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
