import React, { memo, useMemo } from 'react'
import type { LoadedServerEmoji } from '../../store/custom-emoji'
import type { MemberRecord } from '../../store/membership'

interface MarkdownContentProps {
  content: string
  className?: string
  /** Member data is resolved at render time so profile renames propagate. */
  members?: readonly Pick<MemberRecord, 'publicKey' | 'displayName'>[]
  customEmoji?: readonly LoadedServerEmoji[]
  ownUserId?: string | null
  /** Room-wide mentions remain opt-in until power-level policy is available. */
  roomWideMentionsAllowed?: boolean
}

export const MarkdownContent = memo(function MarkdownContent({
  content,
  className = '',
  members = [],
  customEmoji = [],
  ownUserId = null,
  roomWideMentionsAllowed = false,
}: MarkdownContentProps) {
  const rendered = useMemo(
    () => parseMarkdown(content, {
      members,
      customEmoji,
      ownUserId,
      roomWideMentionsAllowed,
    }),
    [content, customEmoji, members, ownUserId, roomWideMentionsAllowed],
  )

  return (
    <div
      className={`markdown-content break-words whitespace-pre-wrap text-sm leading-prose text-secondary ${className}`}
    >
      {rendered}
    </div>
  )
})

type InlineNode = string | React.ReactElement

interface MentionRenderOptions {
  members: readonly Pick<MemberRecord, 'publicKey' | 'displayName'>[]
  customEmoji: readonly LoadedServerEmoji[]
  ownUserId: string | null
  roomWideMentionsAllowed: boolean
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
        <pre
          key={`code-${i}`}
          className="my-1 overflow-x-auto rounded border border-border bg-bg-secondary p-3 font-mono text-code text-secondary"
        >
          <code data-lang={lang || undefined}>{codeLines.join('\n')}</code>
        </pre>,
      )
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

/** Only allow safe URI schemes in rendered links. */
function isSafeUrl(url: string): boolean {
  try {
    // Handle protocol-relative URLs
    const normalized = url.startsWith('//') ? `https:${url}` : url
    const parsed = new URL(normalized, 'https://placeholder.invalid')
    return ['http:', 'https:', 'mailto:'].includes(parsed.protocol)
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
  const regex =
    /(`[^`]+`)|(\*\*[^*]+\*\*)|(~~[^~]+~~)|(\*[^*]+\*|_[^_]+_)|(\[([^\]]+)\]\(([^)]+)\))|(@[A-Za-z0-9._=-]+:[^\s]+|@(everyone|here|room)\b|@\w[\w-]*)|(:([a-z0-9_]{2,32}):)/gi

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
        <code key={key} className="rounded-sm bg-bg-secondary px-1 py-0.5 font-mono text-code">
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
            className="text-text-link hover:underline"
          >
            {linkText}
          </a>,
        )
      } else {
        // Render unsafe URLs as plain text
        nodes.push(
          <span key={key} className="text-text-link">
            {linkText}
          </span>,
        )
      }
    } else if (match[8]) {
      const rawMention = match[8]
      const mention = trimMentionPunctuation(rawMention)
      const trailingPunctuation = rawMention.slice(mention.length)
      const isRoomWide = mention === '@everyone' || mention === '@here' || mention === '@room'
      if (isRoomWide && !mentionOptions.roomWideMentionsAllowed) {
        nodes.push(mention)
      } else {
        const member = mentionOptions.members.find((candidate) => candidate.publicKey === mention)
        const displayName = member?.displayName.trim()
        const label = displayName ? `@${displayName}` : mention
        const isSelf = !isRoomWide && mentionOptions.ownUserId === mention
        nodes.push(
          <span
            key={key}
            data-mention-id={!isRoomWide ? mention : undefined}
            data-mention-kind={isRoomWide ? 'room-wide' : 'user'}
            title={displayName ? mention : undefined}
            aria-label={`Mention ${mention}`}
            className={isSelf
              ? 'inline-flex rounded-full bg-accent/25 px-1.5 py-0.5 font-medium text-accent ring-1 ring-accent/40'
              : 'inline-flex rounded-full bg-accent/15 px-1.5 py-0.5 font-medium text-accent hover:bg-accent/25'}
          >
            {label}
          </span>,
        )
      }
      if (trailingPunctuation) nodes.push(trailingPunctuation)
    } else if (match[10]) {
      const shortcode = match[11]
      const emoji = mentionOptions.customEmoji.find(
        (candidate) => (
          candidate.shortcode.toLocaleLowerCase() === shortcode.toLocaleLowerCase()
        ),
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
        nodes.push(match[10])
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
