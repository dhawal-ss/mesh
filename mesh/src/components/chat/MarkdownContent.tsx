import React, { memo, useMemo } from 'react'

interface MarkdownContentProps {
  content: string
  className?: string
}

export const MarkdownContent = memo(function MarkdownContent({
  content,
  className = '',
}: MarkdownContentProps) {
  const rendered = useMemo(() => parseMarkdown(content), [content])

  return (
    <div
      className={`markdown-content break-words whitespace-pre-wrap text-sm leading-[1.375rem] text-secondary ${className}`}
    >
      {rendered}
    </div>
  )
})

type InlineNode = string | React.ReactElement

function parseMarkdown(text: string): React.ReactElement[] {
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
          className="my-1 overflow-x-auto rounded bg-bg-secondary border border-border p-3 font-mono text-[13px] text-secondary"
        >
          <code data-lang={lang || undefined}>{codeLines.join('\n')}</code>
        </pre>,
      )
      continue
    }

    elements.push(
      <span key={`line-${i}`}>
        {i > 0 && '\n'}
        {parseInline(lines[i], i)}
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

function parseInline(text: string, lineKey: number): InlineNode[] {
  const nodes: InlineNode[] = []
  const regex =
    /(`[^`]+`)|(\*\*[^*]+\*\*)|(~~[^~]+~~)|(\*[^*]+\*|_[^_]+_)|(\[([^\]]+)\]\(([^)]+)\))|(@\w[\w\s]*\w|@\w)/g

  let lastIndex = 0
  let match

  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      nodes.push(text.slice(lastIndex, match.index))
    }

    const key = `${lineKey}-${match.index}`

    if (match[1]) {
      const code = match[1].slice(1, -1)
      nodes.push(
        <code key={key} className="rounded-sm bg-bg-secondary px-1 py-0.5 font-mono text-[13px]">
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
    } else if (match[0].startsWith('@')) {
      nodes.push(
        <span
          key={key}
          className="rounded-sm bg-blue/15 px-1 py-0.5 font-medium text-blue hover:bg-blue/25 cursor-pointer"
        >
          {match[0]}
        </span>,
      )
    }

    lastIndex = regex.lastIndex
  }

  if (lastIndex < text.length) {
    nodes.push(text.slice(lastIndex))
  }

  return nodes
}
