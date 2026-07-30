import { motion } from 'framer-motion'
import { useRef, useState, type KeyboardEvent } from 'react'
import { variants } from '../../lib/motion'
import type { LoadedServerEmoji } from '../../store/custom-emoji'

const REACTIONS = [
  ['👍', 'thumbs up'],
  ['❤️', 'heart'],
  ['😂', 'face with tears of joy'],
  ['🔥', 'fire'],
  ['👀', 'eyes'],
  ['🎉', 'party popper'],
  ['💯', 'hundred points'],
  ['✅', 'check mark'],
  ['🤔', 'thinking face'],
  ['👋', 'waving hand'],
] as const

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
  const [activeIndex, setActiveIndex] = useState(0)
  const buttonRefs = useRef<Array<HTMLButtonElement | null>>([])
  const totalReactions = REACTIONS.length + customEmoji.length

  const moveFocus = (index: number) => {
    if (totalReactions === 0) return
    const nextIndex = (index + totalReactions) % totalReactions
    setActiveIndex(nextIndex)
    buttonRefs.current[nextIndex]?.focus()
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
      event.preventDefault()
      moveFocus(activeIndex + 1)
    } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
      event.preventDefault()
      moveFocus(activeIndex - 1)
    } else if (event.key === 'Home') {
      event.preventDefault()
      moveFocus(0)
    } else if (event.key === 'End') {
      event.preventDefault()
      moveFocus(totalReactions - 1)
    } else if (event.key === 'Escape') {
      event.preventDefault()
      onClose()
    }
  }

  return (
    <motion.div
      role="toolbar"
      aria-label="Add reaction"
      variants={variants.popover}
      initial="initial"
      animate="animate"
      exit="exit"
      className="mesh-reaction-picker z-popover flex flex-wrap items-center gap-0.5 rounded-panel border border-border-subtle bg-surface-overlay px-1.5 py-1 shadow-overlay"
      onKeyDown={handleKeyDown}
    >
      {REACTIONS.map(([emoji, name], index) => (
        <button
          key={emoji}
          ref={(button) => { buttonRefs.current[index] = button }}
          type="button"
          tabIndex={activeIndex === index ? 0 : -1}
          aria-label={`React with ${name}`}
          onFocus={() => setActiveIndex(index)}
          onClick={() => {
            onSelect(emoji)
            onClose()
          }}
          className="flex h-7 w-7 items-center justify-center rounded-sm text-sm transition-colors hover:bg-surface-active active:scale-95"
        >
          {emoji}
        </button>
      ))}
      {customEmoji.map((emoji, customIndex) => {
        const index = REACTIONS.length + customIndex
        return (
        <button
          key={emoji.shortcode}
          ref={(button) => { buttonRefs.current[index] = button }}
          type="button"
          title={`:${emoji.shortcode}:`}
          aria-label={`React with ${emoji.shortcode}`}
          tabIndex={activeIndex === index ? 0 : -1}
          onFocus={() => setActiveIndex(index)}
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
        )
      })}
    </motion.div>
  )
}
