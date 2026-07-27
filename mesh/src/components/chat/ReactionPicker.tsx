import { motion } from 'framer-motion'
import { variants } from '../../lib/motion'

const REACTIONS = ['👍', '❤️', '😂', '🔥', '👀', '🎉', '💯', '✅', '🤔', '👋']

interface ReactionPickerProps {
  onSelect: (emoji: string) => void
  onClose: () => void
}

export function ReactionPicker({ onSelect, onClose }: ReactionPickerProps) {
  return (
    <motion.div
      role="toolbar"
      aria-label="Add reaction"
      variants={variants.popover}
      initial="initial"
      animate="animate"
      exit="exit"
      className="flex items-center gap-0.5 rounded-full border border-border-strong bg-surface-overlay/95 px-2 py-1.5 shadow-floating backdrop-blur-2xl"
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
    </motion.div>
  )
}
