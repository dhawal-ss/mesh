import { useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react'
import { Icon } from '../ui/Icon'
import { Popover } from '../ui/InteractivePrimitives'
import { ReactionPicker } from './ReactionPicker'
import type { LoadedServerEmoji } from '../../store/custom-emoji'

interface EditComposerProps {
  /** The edited text, owned by the message so save can read it. */
  value: string
  onChange: (next: string) => void
  /** Enter (without Shift), or the inline "save" affordance. */
  onSave: () => void
  /** Escape, or the inline "cancel" affordance. */
  onCancel: () => void
  /** True while the edit mutation is in flight; freezes every control. */
  disabled?: boolean
  /** Accessible name for the edit textarea (kept stable for tests/AT). */
  label: string
  /** Community custom emoji; empty in DMs, matching the message renderer. */
  customEmoji?: readonly LoadedServerEmoji[]
}

/**
 * The inline editor for a sent message. It gives editing the same reach as the
 * main composer (an emoji picker, including this community's custom emoji) without the composer's channel-draft, typing, and
 * attachment machinery, none of which belong to an edit. Mentions still resolve
 * from the saved text, so no autocomplete is needed here.
 */
export function EditComposer({
  value,
  onChange,
  onSave,
  onCancel,
  disabled = false,
  label,
  customEmoji = [],
}: EditComposerProps) {
  const [emojiOpen, setEmojiOpen] = useState(false)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  // A value change from emoji insertion carries the caret it
  // should land on; applied after the controlled re-render paints.
  const pendingSelectionRef = useRef<{ start: number; end: number } | null>(null)

  // Grow the textarea with its content, like the main composer.
  useLayoutEffect(() => {
    const input = inputRef.current
    if (!input) return
    input.style.height = 'auto'
    // design-token-exception: height follows measured content; CSS owns the max-height token.
    input.style.height = `${input.scrollHeight}px`
  }, [value])

  useLayoutEffect(() => {
    const pending = pendingSelectionRef.current
    if (!pending || !inputRef.current) return
    pendingSelectionRef.current = null
    inputRef.current.focus()
    inputRef.current.setSelectionRange(pending.start, pending.end)
  }, [value])

  const insertEmoji = (emoji: string) => {
    const input = inputRef.current
    const start = input?.selectionStart ?? value.length
    const end = input?.selectionEnd ?? start
    const next = `${value.slice(0, start)}${emoji}${value.slice(end)}`
    const cursor = start + emoji.length
    pendingSelectionRef.current = { start: cursor, end: cursor }
    onChange(next)
    setEmojiOpen(false)
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      onSave()
    } else if (event.key === 'Escape') {
      event.preventDefault()
      onCancel()
    }
  }

  return (
    <div className="mt-1 space-y-2">
      <div className="overflow-hidden rounded-full border border-outline bg-surface-container-lowest focus-within:border-primary">
        <div className="flex items-center gap-1 border-b border-outline-variant px-1.5 py-1">
          <div>
            <Popover
              open={emojiOpen}
              onOpenChange={setEmojiOpen}
              restoreFocusRef={inputRef}
              side="top"
              align="end"
              label="Emoji picker"
              description="Add emoji to this edit."
              className="w-auto border-0 bg-transparent p-0 shadow-none"
              trigger={(
                <button
                  type="button"
                  disabled={disabled}
                  aria-label="Open emoji picker"
                  aria-expanded={emojiOpen}
                  className="flex h-control-sm w-control-sm items-center justify-center rounded-full text-on-surface-variant transition-colors hover:bg-state-hover hover:text-on-surface-variant focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus disabled:cursor-not-allowed disabled:opacity-40"
                >
                  <Icon name="smile" size="sm" />
                </button>
              )}
            >
              <ReactionPicker
                label="Choose emoji"
                actionLabel="Insert"
                onSelect={insertEmoji}
                onClose={() => setEmojiOpen(false)}
                customEmoji={customEmoji}
              />
            </Popover>
          </div>
        </div>
        <textarea
          ref={inputRef}
          aria-label={label}
          value={value}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={handleKeyDown}
          rows={1}
          autoFocus
          className="max-h-composer block w-full resize-none bg-transparent px-3 py-2 text-body-lg text-on-surface placeholder:text-on-surface-variant focus:outline-none disabled:opacity-60"
        />
      </div>
      <div className="flex items-center gap-2 text-body-sm text-on-surface-variant">
        <span>
          escape to{' '}
          <button
            type="button"
            disabled={disabled}
            onClick={onCancel}
            className="text-primary hover:underline disabled:opacity-60"
          >
            cancel
          </button>
        </span>
        <span>•</span>
        <span>
          enter to{' '}
          <button
            type="button"
            disabled={disabled}
            onClick={onSave}
            className="text-primary hover:underline disabled:opacity-60"
          >
            save
          </button>
        </span>
      </div>
    </div>
  )
}
