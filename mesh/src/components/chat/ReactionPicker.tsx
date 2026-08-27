import { motion } from '../../lib/lazy-motion'
import {
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react'
import { variants } from '../../lib/motion'
import { Icon } from '../ui/Icon'
import {
  DEFAULT_FREQUENT,
  EMOJI_BY_CHAR,
  EMOJI_CATEGORIES,
  type EmojiEntry,
} from '../../lib/emoji-data'
import type { LoadedServerEmoji } from '../../store/custom-emoji'
import { rememberEmoji, useRecentEmoji } from '../../store/recent-emoji'

const RECENTS_VISIBLE = 8
const COLUMNS = 8

interface ReactionPickerProps {
  onSelect: (emoji: string) => void
  onClose: () => void
  label?: string
  actionLabel?: string
  /** Community custom emoji, surfaced as a "This community" section. */
  customEmoji?: readonly LoadedServerEmoji[]
}

/** A pickable emoji: a unicode glyph, or a custom emoji with an image. */
interface PickerEntry extends EmojiEntry {
  /** Present for custom emoji; renders an image instead of the glyph. */
  imageUrl?: string
}

interface Cell {
  entry: PickerEntry
  /** Position in the flat, focusable order across every section. */
  index: number
}

interface Section {
  id: string
  label: string
  cells: Cell[]
}

function customToEntry(emoji: LoadedServerEmoji): PickerEntry {
  return {
    // The value reacted with / inserted, matched back for rendering.
    char: `:${emoji.shortcode}:`,
    // Accessible label and primary search term.
    name: emoji.shortcode,
    keywords: emoji.body ?? '',
    imageUrl: emoji.imageUrl,
  }
}

function resolveChar(char: string, customByChar: Map<string, PickerEntry>): PickerEntry {
  return EMOJI_BY_CHAR.get(char) ?? customByChar.get(char) ?? { char, name: char, keywords: '' }
}

function buildView(
  query: string,
  recents: string[],
  customEntries: PickerEntry[],
): { sections: Section[]; flat: PickerEntry[] } {
  const trimmed = query.trim().toLowerCase()
  const customByChar = new Map(customEntries.map((entry) => [entry.char, entry]))

  const matches = (entry: PickerEntry) =>
    entry.char === query ||
    entry.name.toLowerCase().includes(trimmed) ||
    entry.keywords.toLowerCase().includes(trimmed)

  if (trimmed) {
    const seen = new Set<string>()
    const flat: PickerEntry[] = []
    const consider = (entry: PickerEntry) => {
      if (seen.has(entry.char)) return
      if (matches(entry)) {
        seen.add(entry.char)
        flat.push(entry)
      }
    }
    for (const category of EMOJI_CATEGORIES) {
      for (const entry of category.emoji) consider(entry)
    }
    for (const entry of customEntries) consider(entry)
    const cells = flat.map((entry, index) => ({ entry, index }))
    return {
      flat,
      sections: cells.length ? [{ id: 'results', label: '', cells }] : [],
    }
  }

  const flat: PickerEntry[] = []
  const sections: Section[] = []
  const pushSection = (id: string, sectionLabel: string, entries: PickerEntry[]) => {
    if (entries.length === 0) return
    const cells = entries.map((entry) => {
      const cell = { entry, index: flat.length }
      flat.push(entry)
      return cell
    })
    sections.push({ id, label: sectionLabel, cells })
  }

  const hasRecents = recents.length > 0
  const leadEntries = (hasRecents ? recents : DEFAULT_FREQUENT)
    .slice(0, RECENTS_VISIBLE)
    .map((char) => resolveChar(char, customByChar))
  pushSection('recent', hasRecents ? 'Recently used' : 'Frequently used', leadEntries)

  pushSection('community', 'This community', customEntries)

  for (const category of EMOJI_CATEGORIES) {
    pushSection(category.id, category.label, category.emoji)
  }

  return { flat, sections }
}

export function ReactionPicker({
  onSelect,
  onClose,
  label = 'Add reaction',
  actionLabel = 'React with',
  customEmoji = [],
}: ReactionPickerProps) {
  const [query, setQuery] = useState('')
  const recents = useRecentEmoji()
  const [requestedIndex, setActiveIndex] = useState(0)
  const [requestedTab, setActiveTab] = useState(0)

  const searchRef = useRef<HTMLInputElement>(null)
  const buttonRefs = useRef<Array<HTMLButtonElement | null>>([])
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([])

  const customEntries = useMemo(() => customEmoji.map(customToEntry), [customEmoji])

  const { sections, flat } = useMemo(
    () => buildView(query, recents, customEntries),
    [query, recents, customEntries],
  )

  /*
    The roving index is clamped where it is read rather than corrected in an
    effect afterwards. Correcting it afterwards meant a render existed in which
    the index pointed past the end of the list -- brief, but the tabIndex and
    the focus target were both wrong in it -- and then a second render to fix
    it. Typing narrows this list on every keystroke, so that was two renders per
    character.
  */
  const activeIndex = flat.length === 0 ? 0 : Math.min(requestedIndex, flat.length - 1)
  const activeTab = Math.min(requestedTab, Math.max(0, sections.length - 1))

  const moveFocus = (nextIndex: number) => {
    if (flat.length === 0) return
    const clamped = Math.max(0, Math.min(nextIndex, flat.length - 1))
    setActiveIndex(clamped)
    buttonRefs.current[clamped]?.focus()
  }

  const commit = (entry: PickerEntry) => {
    rememberEmoji(entry.char)
    onSelect(entry.char)
    onClose()
  }

  const handleSearchKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      moveFocus(0)
    } else if (event.key === 'Enter') {
      if (flat.length > 0) {
        event.preventDefault()
        commit(flat[0])
      }
    } else if (event.key === 'Escape') {
      event.preventDefault()
      if (query) {
        setQuery('')
      } else {
        onClose()
      }
    }
  }

  const handleGridKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    switch (event.key) {
      case 'ArrowRight':
        event.preventDefault()
        moveFocus(activeIndex + 1)
        break
      case 'ArrowLeft':
        event.preventDefault()
        moveFocus(activeIndex - 1)
        break
      case 'ArrowDown':
        event.preventDefault()
        moveFocus(activeIndex + COLUMNS)
        break
      case 'ArrowUp':
        event.preventDefault()
        if (activeIndex - COLUMNS < 0) {
          searchRef.current?.focus()
        } else {
          moveFocus(activeIndex - COLUMNS)
        }
        break
      case 'Home':
        event.preventDefault()
        moveFocus(0)
        break
      case 'End':
        event.preventDefault()
        moveFocus(flat.length - 1)
        break
      case 'Escape':
        event.preventDefault()
        if (query) {
          setQuery('')
          searchRef.current?.focus()
        } else {
          onClose()
        }
        break
      default:
        break
    }
  }

  const moveTabFocus = (nextTab: number) => {
    const count = sections.length
    if (count === 0) return
    const clamped = (nextTab + count) % count
    setActiveTab(clamped)
    tabRefs.current[clamped]?.focus()
  }

  const jumpToSection = (sectionIndex: number) => {
    const first = sections[sectionIndex]?.cells[0]?.index
    if (first === undefined) return
    moveFocus(first)
    try {
      buttonRefs.current[first]?.scrollIntoView({ block: 'start' })
    } catch {
      // Some webviews (and jsdom) do not implement scrollIntoView; focus has
      // already moved, which is the essential behavior.
    }
  }

  const handleTabKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    switch (event.key) {
      case 'ArrowRight':
        event.preventDefault()
        moveTabFocus(activeTab + 1)
        break
      case 'ArrowLeft':
        event.preventDefault()
        moveTabFocus(activeTab - 1)
        break
      case 'Home':
        event.preventDefault()
        moveTabFocus(0)
        break
      case 'End':
        event.preventDefault()
        moveTabFocus(sections.length - 1)
        break
      case 'Escape':
        event.preventDefault()
        onClose()
        break
      default:
        break
    }
  }

  const isSearching = query.trim().length > 0

  const renderGlyph = (entry: PickerEntry, size: string) =>
    entry.imageUrl ? (
      <img src={entry.imageUrl} alt="" className={`${size} object-contain`} />
    ) : (
      <span aria-hidden="true">{entry.char}</span>
    )

  return (
    <motion.div
      variants={variants.popover}
      initial="initial"
      animate="animate"
      exit="exit"
      className="mesh-emoji-picker flex w-72 flex-col overflow-hidden rounded-xl border border-outline-variant bg-surface-container-high shadow-elev-3"
      aria-label={label}
    >
      <div className="flex items-center gap-2 border-b border-outline-variant px-2.5">
        <Icon name="search" size="sm" aria-hidden="true" />
        <input
          ref={searchRef}
          type="text"
          value={query}
          autoFocus
          spellCheck={false}
          autoComplete="off"
          aria-label={label}
          placeholder="Search emoji"
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={handleSearchKeyDown}
          className="h-9 flex-1 bg-transparent text-body-md text-on-surface placeholder:text-on-surface-variant focus:outline-none"
        />
      </div>

      <span aria-live="polite" className="sr-only">
        {isSearching ? `${flat.length} emoji found` : ''}
      </span>

      <div
        role="group"
        aria-label="Emoji"
        onKeyDown={handleGridKeyDown}
        className="max-h-64 overflow-y-auto p-1.5"
      >
        {flat.length === 0 ? (
          <p className="px-2 py-6 text-center text-body-sm text-on-surface-variant">
            No emoji found.
          </p>
        ) : (
          sections.map((section) => (
            <section key={section.id} aria-label={section.label || undefined} className="mb-1.5 last:mb-0">
              {section.label && (
                <h4 className="px-1 pb-1 pt-0.5 text-label-sm font-semibold lowercase tracking-label-md text-on-surface-variant">
                  {section.label}
                </h4>
              )}
              <div className="grid grid-cols-8 gap-0.5">
                {section.cells.map(({ entry, index }) => (
                  <button
                    key={`${section.id}:${entry.char}`}
                    ref={(button) => {
                      buttonRefs.current[index] = button
                    }}
                    type="button"
                    tabIndex={activeIndex === index ? 0 : -1}
                    aria-label={`${actionLabel} ${entry.name}`}
                    title={entry.name}
                    onFocus={() => setActiveIndex(index)}
                    onClick={() => commit(entry)}
                    className="flex h-8 w-8 items-center justify-center rounded-full text-title-sm leading-none transition-colors hover:bg-surface-container-highest focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus motion-safe:active:scale-95"
                  >
                    {renderGlyph(entry, 'h-6 w-6')}
                  </button>
                ))}
              </div>
            </section>
          ))
        )}
      </div>

      {!isSearching && sections.length > 1 && (
        <div
          role="toolbar"
          aria-label="Emoji categories"
          aria-orientation="horizontal"
          onKeyDown={handleTabKeyDown}
          className="flex items-center gap-0.5 border-t border-outline-variant px-1.5 py-1"
        >
          {sections.map((section, index) => (
            <button
              key={section.id}
              ref={(button) => {
                tabRefs.current[index] = button
              }}
              type="button"
              tabIndex={activeTab === index ? 0 : -1}
              aria-label={`Jump to ${section.label}`}
              title={section.label}
              onFocus={() => setActiveTab(index)}
              onClick={() => jumpToSection(index)}
              className="flex h-8 w-6 flex-shrink-0 items-center justify-center rounded-full text-body-md leading-none transition-colors hover:bg-surface-container-highest focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus"
            >
              {section.cells[0] ? renderGlyph(section.cells[0].entry, 'h-5 w-5') : null}
            </button>
          ))}
        </div>
      )}
    </motion.div>
  )
}
