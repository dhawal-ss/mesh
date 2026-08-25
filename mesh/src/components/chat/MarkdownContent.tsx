import React, { memo, useEffect, useMemo, useState, type ReactNode } from 'react'
import { copyText } from '../../lib/notifications'
import type { MemberRecord } from '../../store/membership'
import type { LoadedServerEmoji } from '../../store/custom-emoji'

interface MarkdownContentProps {
  content: string
  className?: string
  /** Member data is resolved at render time so profile renames propagate. */
  members?: readonly Pick<MemberRecord, 'publicKey' | 'displayName'>[]
  ownUserId?: string | null
  mentionUserIds?: readonly string[]
  /**
   * Whether this particular message carried `m.mentions.room`, which is the
   * only thing that makes `@room` a notification rather than two words.
   */
  roomWideMentionsAllowed?: boolean
  /** Community custom emoji, used to render :shortcode: tokens as images. */
  customEmoji?: readonly LoadedServerEmoji[]
}

export const MarkdownContent = memo(function MarkdownContent({
  content,
  className = '',
  members = [],
  ownUserId = null,
  mentionUserIds = [],
  roomWideMentionsAllowed = false,
  customEmoji = [],
}: MarkdownContentProps) {
  const rendered = useMemo(
    () => parseMarkdown(content, {
      members,
      ownUserId,
      mentionUserIds,
      roomWideMentionsAllowed,
      customEmoji,
    }),
    [content, members, mentionUserIds, ownUserId, roomWideMentionsAllowed, customEmoji],
  )

  return (
    <div
      className={`markdown-content break-words whitespace-pre-wrap text-base leading-prose text-content-primary ${className}`}
    >
      {rendered}
    </div>
  )
})

type InlineNode = string | React.ReactElement

/**
 * A fenced code block.
 *
 * Two things were wrong with the plain `<pre>` this replaces. The content was
 * rendered in `text-secondary`, a muted foreground, for the one kind of content
 * a reader most needs to read precisely. And there was no way to copy it: no
 * clipboard path existed anywhere in the chat surface for code, while manual
 * selection is fragile inside the virtualizer, because scrolling mid-drag
 * re-renders the row and drops the selection.
 *
 * The language tag is still parsed and still drives no highlighting, but it is
 * now shown, so the fence's own metadata reaches the reader instead of being
 * written to an attribute nothing consumes.
 */
function CodeBlock({ language, code }: { language: string; code: string }) {
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    if (!copied) return
    const timer = window.setTimeout(() => setCopied(false), 2_000)
    return () => window.clearTimeout(timer)
  }, [copied])

  return (
    <div className="group/code relative my-1">
      <pre className="overflow-x-auto rounded-panel border border-border bg-surface-sunken p-3 font-mono text-code text-content-primary">
        <code data-lang={language || undefined}>{code}</code>
      </pre>
      <div className="absolute right-1.5 top-1.5 flex items-center gap-1.5">
        {language ? (
          <span aria-hidden="true" className="font-mono text-meta text-muted">{language}</span>
        ) : null}
        <button
          type="button"
          onClick={() => {
            void copyText(code).then(() => setCopied(true)).catch(() => setCopied(false))
          }}
          className="rounded-control border border-border-subtle bg-surface-raised px-1.5 py-0.5 text-meta text-secondary opacity-0 focus-visible:opacity-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus group-hover/code:opacity-100"
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      {/* Announced separately: a screen reader has already moved past the
          button by the time its label changes. */}
      <span className="sr-only" role="status" aria-live="polite">
        {copied ? 'Code copied to the clipboard' : ''}
      </span>
    </div>
  )
}

function Spoiler({ children }: { children: ReactNode }) {
  const [revealed, setRevealed] = useState(false)
  return (
    <button
      type="button"
      aria-expanded={revealed}
      onClick={() => setRevealed((current) => !current)}
      className={`inline rounded-control px-1 text-left transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus ${
        revealed
          ? 'bg-surface-sunken text-secondary'
          : 'bg-content text-transparent hover:bg-content/80'
      }`}
    >
      {/* The prompt must be part of the button's own content, not an aria-label:
          a label would replace the accessible name entirely and make the
          revealed text unreadable to a screen reader, which is the one thing
          revealing it is for. Hidden content stays hidden until revealed. */}
      <span className="sr-only">{revealed ? 'Hide spoiler: ' : 'Reveal spoiler'}</span>
      <span aria-hidden={!revealed}>{children}</span>
    </button>
  )
}

interface MentionRenderOptions {
  members: readonly Pick<MemberRecord, 'publicKey' | 'displayName'>[]
  ownUserId: string | null
  mentionUserIds: readonly string[]
  roomWideMentionsAllowed: boolean
  customEmoji: readonly LoadedServerEmoji[]
}

function parseMarkdown(text: string, mentionOptions: MentionRenderOptions): React.ReactElement[] {
  const lines = text.split('\n')
  const elements: React.ReactElement[] = []
  let i = 0

  while (i < lines.length) {
    if (lines[i].startsWith('```')) {
      const lang = lines[i].slice(3).trim()
      const codeLines: string[] = []
      i++
      while (i < lines.length && !lines[i].startsWith('```')) {
        codeLines.push(lines[i])
        i++
      }
      if (i < lines.length) i++

      elements.push(
        <CodeBlock key={`code-${i}`} language={lang} code={codeLines.join('\n')} />,
      )
      continue
    }

    const heading = /^(#{1,6})\s+(.+)$/.exec(lines[i])
    if (heading) {
      const level = Math.min(6, heading[1].length + 1)
      const tag = `h${level}` as keyof React.JSX.IntrinsicElements
      // A heading inside a message must stay quieter than the room title: the
      // ladder runs 18/15/14 from the closed scale, not 22px. `text-body` was
      // never a defined utility, so the middle step silently rendered at the
      // inherited size.
      // Each step already carries its contracted line height, so no `leading-*`
      // is layered on top of it here.
      const headingClass = level === 2
        ? 'my-1 text-md font-semibold text-content-primary'
        : level === 3
          ? 'my-1 text-base font-semibold text-content-primary'
          : 'my-1 text-sm font-semibold text-content-primary'
      elements.push(React.createElement(
        tag,
        { key: `heading-${i}`, className: headingClass },
        parseInline(heading[2], i, mentionOptions),
      ))
      i++
      continue
    }

    if (/^>/.test(lines[i])) {
      const quoteLines: string[] = []
      const quoteStart = i
      while (i < lines.length && /^>/.test(lines[i])) {
        quoteLines.push(lines[i].replace(/^>\s?/, ''))
        i++
      }
      elements.push(
        <blockquote
          key={`quote-${quoteStart}`}
          className="my-1 border-l-2 border-border-strong pl-3 text-muted"
        >
          {parseMarkdown(quoteLines.join('\n'), mentionOptions)}
        </blockquote>,
      )
      continue
    }

    const list = parseListItem(lines[i])
    if (list) {
      const parsed = parseList(lines, i, list.indent, list.ordered, mentionOptions)
      elements.push(parsed.element)
      i = parsed.nextIndex
      continue
    }

    elements.push(
      <span key={`line-${i}`}>
        {i > 0 && '\n'}
        {parseInline(lines[i], i, mentionOptions)}
      </span>,
    )
    i++
  }

  return elements
}

interface ParsedListLine {
  indent: number
  ordered: boolean
  content: string
}

function parseListItem(line: string): ParsedListLine | null {
  const normalized = line.replace(/\t/g, '  ')
  const match = /^(\s*)(?:(\d+)[.)]|[-+*])\s+(.+)$/.exec(normalized)
  if (!match) return null
  return {
    indent: match[1].length,
    ordered: Boolean(match[2]),
    content: match[3],
  }
}

function parseList(
  lines: string[],
  startIndex: number,
  indent: number,
  ordered: boolean,
  mentionOptions: MentionRenderOptions,
): { element: React.ReactElement; nextIndex: number } {
  const items: Array<{
    content: string
    lineIndex: number
    children: React.ReactElement[]
  }> = []
  let index = startIndex

  while (index < lines.length) {
    const item = parseListItem(lines[index])
    if (!item || item.indent < indent) break
    if (item.indent > indent) {
      const parent = items[items.length - 1]
      if (!parent) break
      const nested = parseList(
        lines,
        index,
        item.indent,
        item.ordered,
        mentionOptions,
      )
      parent.children.push(nested.element)
      index = nested.nextIndex
      continue
    }
    if (item.ordered !== ordered) break
    items.push({ content: item.content, lineIndex: index, children: [] })
    index++
  }

  const ListTag = ordered ? 'ol' : 'ul'
  return {
    element: (
      <ListTag
        key={`list-${startIndex}`}
        className={`my-1 space-y-0.5 pl-5 ${ordered ? 'list-decimal' : 'list-disc'}`}
      >
        {items.map((item) => (
          <li key={`item-${item.lineIndex}`}>
            {parseInline(item.content, item.lineIndex, mentionOptions)}
            {item.children}
          </li>
        ))}
      </ListTag>
    ),
    nextIndex: index,
  }
}

/** Only allow safe URI schemes in rendered links. */
function isSafeUrl(url: string): boolean {
  try {
    // Handle protocol-relative URLs
    const normalized = url.startsWith('//') ? `https:${url}` : url
    const parsed = new URL(normalized, 'https://placeholder.invalid')
    return ['https:', 'mailto:'].includes(parsed.protocol)
  } catch {
    return false
  }
}

function parseInline(
  text: string,
  lineKey: number,
  mentionOptions: MentionRenderOptions,
): InlineNode[] {
  const nodes: InlineNode[] = []
  const structuredMentionTokens = mentionOptions.members
    .filter((member) => mentionOptions.mentionUserIds.includes(member.publicKey))
    .map((member) => `@${member.displayName.trim().replace(/\s+/gu, ' ')}`)
    .filter((mention) => mention.length > 1)
    .sort((left, right) => right.length - left.length)
    .map((mention) => `${escapeRegExp(mention)}(?=$|\\s|[.,!?;)\\]])`)
  const structuredMentionPattern = structuredMentionTokens.length > 0
    ? `${structuredMentionTokens.join('|')}|`
    : ''
  /*
    Underscore emphasis requires both delimiters to sit outside a word, the way
    CommonMark, Discord, Slack and Element all require it. Without that
    condition an identifier is not merely mis-styled, it is corrupted: the
    delimiters are dropped by the slice below, so MAX_DRAFT_BYTES renders as
    "MAXDRAFTBYTES" and anyone copying the rendered text copies the corruption.
    snake_case names, __init__ and file_name_utils.ts all hit this, which for a
    developer audience is constant.

    Asterisk emphasis keeps intraword matching, which is also what CommonMark
    specifies, so *no* change is made to that alternative.
  */
  const regex = new RegExp(
    '(`[^`]+`)|(\\*\\*[^*]+\\*\\*)|(~~[^~]+~~)|(\\*[^*]+\\*|(?<!\\w)_[^_\\n]+_(?!\\w))'
      + '|(\\[([^\\]]+)\\]\\(((?:[^()]|\\([^()]*\\))+)\\))|(https?:\\/\\/[^\\s<]+)'
      + `|(${structuredMentionPattern}@[A-Za-z0-9._=+/-]+:(?:[A-Za-z0-9.-]+|\\[[0-9A-Fa-f:]+\\])(?::\\d{1,5})?|@(everyone|here|room)\\b|@[A-Za-z0-9_][\\w-]*)`
      + '|(\\|\\|[^|]+\\|\\|)|(:([a-z0-9_]{2,32}):)',
    'gi',
  )

  let lastIndex = 0
  let match: RegExpExecArray | null

  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      nodes.push(text.slice(lastIndex, match.index))
    }

    const key = `${lineKey}-${match.index}`

    if (match[1]) {
      const code = match[1].slice(1, -1)
      nodes.push(
        <code key={key} className="rounded-control bg-surface-sunken px-1 py-0.5 font-mono text-code">
          {code}
        </code>,
      )
    } else if (match[2]) {
      nodes.push(
        <strong key={key} className="font-semibold text-primary">
          {match[2].slice(2, -2)}
        </strong>,
      )
    } else if (match[3]) {
      nodes.push(
        <del key={key} className="text-muted line-through">
          {match[3].slice(2, -2)}
        </del>,
      )
    } else if (match[4]) {
      nodes.push(
        <em key={key} className="italic">
          {match[4].slice(1, -1)}
        </em>,
      )
    } else if (match[5]) {
      const linkText = match[6]
      const url = match[7]
      if (isSafeUrl(url)) {
        nodes.push(
          <a
            key={key}
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            className="text-text-link underline underline-offset-2"
          >
            {linkText}
          </a>,
        )
      } else {
        // Unsafe destinations must not retain link styling that promises an action.
        nodes.push(linkText)
      }
    } else if (match[8]) {
      const rawUrl = match[8]
      const url = trimTrailingUrlPunctuation(rawUrl)
      const trailingPunctuation = rawUrl.slice(url.length)
      if (isSafeUrl(url)) {
        nodes.push(
          <a
            key={key}
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            className="text-text-link underline underline-offset-2"
          >
            {url}
          </a>,
        )
      } else {
        nodes.push(url)
      }
      if (trailingPunctuation) nodes.push(trailingPunctuation)
    } else if (match[9]) {
      const rawMention = match[9]
      const mention = trimMentionPunctuation(rawMention)
      const trailingPunctuation = rawMention.slice(mention.length)
      // `@here` is deliberately absent. Matrix carries exactly one room-wide
      // flag and no online-only variant, so highlighting `@here` would promise
      // a narrower audience than anything that was actually sent. It stays
      // plain text until there is a representation for it to mean.
      const isRoomWide = mention === '@everyone' || mention === '@room'
      if (isRoomWide && !mentionOptions.roomWideMentionsAllowed) {
        nodes.push(mention)
      } else {
        const member = resolveMemberMention(
          mention,
          mentionOptions.members,
          mentionOptions.mentionUserIds,
        )
        const isFullMatrixId = isMatrixUserId(mention)
        if (!isRoomWide && !member && !isFullMatrixId) {
          nodes.push(mention)
          if (trailingPunctuation) nodes.push(trailingPunctuation)
          lastIndex = regex.lastIndex
          continue
        }
        const displayName = member?.displayName.trim()
        const label = displayName ? `@${displayName}` : mention
        const mentionId = member?.publicKey ?? mention
        const isSelf = !isRoomWide && mentionOptions.ownUserId === mentionId
        nodes.push(
          <span
            key={key}
            data-mention-id={!isRoomWide ? mentionId : undefined}
            data-mention-kind={isRoomWide ? 'room-wide' : 'user'}
            className={isSelf
              ? 'inline-flex rounded-panel border border-container-accent-line bg-container-accent-active px-1.5 py-0.5 font-medium text-accent'
              : 'inline-flex rounded-panel bg-container-accent px-1.5 py-0.5 font-medium text-accent hover:bg-container-accent-hover'}
          >
            {label}
          </span>,
        )
      }
      if (trailingPunctuation) nodes.push(trailingPunctuation)
    } else if (match[11]) {
      nodes.push(
        <Spoiler key={key}>
          {parseInline(match[11].slice(2, -2), lineKey, mentionOptions)}
        </Spoiler>,
      )
    } else if (match[12]) {
      const shortcode = match[13]
      const emoji = mentionOptions.customEmoji.find(
        (candidate) => candidate.shortcode.toLowerCase() === shortcode.toLowerCase(),
      )
      if (emoji) {
        nodes.push(
          <img
            key={key}
            src={emoji.imageUrl}
            alt={`:${emoji.shortcode}:`}
            title={emoji.body}
            className="mx-0.5 inline-block h-5 w-5 object-contain align-text-bottom"
          />,
        )
      } else {
        // Unknown or unloaded shortcode: leave the literal text in place.
        nodes.push(match[12])
      }
    }

    lastIndex = regex.lastIndex
  }

  if (lastIndex < text.length) {
    nodes.push(text.slice(lastIndex))
  }

  return nodes
}

function trimMentionPunctuation(token: string): string {
  let mention = token.replace(/[.,!?;]+$/, '')
  if (mention.endsWith(')') && !mention.includes('(')) mention = mention.slice(0, -1)
  if (mention.endsWith(']') && !mention.includes('[')) mention = mention.slice(0, -1)
  return mention
}

function isMatrixUserId(value: string): boolean {
  return /^@[A-Za-z0-9._=+/-]+:(?:[A-Za-z0-9.-]+|\[[0-9A-Fa-f:]+\])(?::\d{1,5})?$/.test(value)
}

function resolveMemberMention(
  mention: string,
  members: readonly Pick<MemberRecord, 'publicKey' | 'displayName'>[],
  mentionUserIds: readonly string[],
) {
  const exact = members.find((candidate) => candidate.publicKey === mention)
  if (exact || isMatrixUserId(mention)) return exact

  const name = mention.slice(1).toLocaleLowerCase()
  const matches = members.filter((candidate) => mentionUserIds.includes(candidate.publicKey)).filter((candidate) => {
    const displayName = candidate.displayName.trim().toLocaleLowerCase()
    return displayName === name
  })
  return matches.length === 1 ? matches[0] : undefined
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function trimTrailingUrlPunctuation(token: string): string {
  let url = token.replace(/[.,!?;:]+$/, '')
  if (url.endsWith(')') && countCharacter(url, '(') < countCharacter(url, ')')) {
    url = url.slice(0, -1)
  }
  if (url.endsWith(']') && countCharacter(url, '[') < countCharacter(url, ']')) {
    url = url.slice(0, -1)
  }
  return url
}

function countCharacter(value: string, character: string): number {
  return [...value].filter((candidate) => candidate === character).length
}
