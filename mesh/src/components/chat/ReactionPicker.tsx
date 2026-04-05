import { motion } from 'framer-motion'
import { transitions } from '../../lib/motion'

const REACTIONS = ['👍', '❤️', '😂', '🔥', '👀', '🎉', '💯', '✅', '🤔', '👋']

interface ReactionPickerProps {
  onSelect: (emoji: string) => void
  onClose: () => void
}

export function ReactionPicker({ onSelect, onClose }: ReactionPickerProps) {
  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.92, y: 4 }}
      animate={{ opacity: 1, scale: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.92, y: 4 }}
      transition={transitions.softSpring}
      className="flex items-center gap-0.5 rounded-full border border-white/10 bg-surface-float/95 px-2 py-1.5 shadow-floating backdrop-blur-2xl"
      onMouseLeave={onClose}
    >
      {REACTIONS.map((emoji) => (
        <button
          key={emoji}
          onClick={() => {
            onSelect(emoji)
            onClose()
          }}
          className="flex h-8 w-8 items-center justify-center rounded-full text-base transition-colors hover:bg-white/[0.08] active:scale-95"
        >
          {emoji}
        </button>
      ))}
    </motion.div>
  )
}
