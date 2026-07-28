const SHRUG = '¯\\_(ツ)_/¯'

export interface SlashCommand {
  command: '/shrug' | '/me'
  description: string
}

export const SLASH_COMMANDS: readonly SlashCommand[] = [
  { command: '/shrug', description: 'Add a shrug to your message' },
  { command: '/me', description: 'Send an action in italics' },
]

export interface SlashCommandContext {
  start: number
  end: number
  query: string
}

export function getSlashCommandContext(value: string, cursor: number): SlashCommandContext | null {
  const beforeCursor = value.slice(0, cursor)
  const match = beforeCursor.match(/^\/([^\s/]*)$/)
  if (!match) return null

  return {
    start: 0,
    end: cursor,
    query: match[1],
  }
}

export function getSlashCommandSuggestions(query: string): readonly SlashCommand[] {
  const normalizedQuery = query.toLocaleLowerCase()
  return SLASH_COMMANDS.filter(({ command }) => command.slice(1).startsWith(normalizedQuery))
}

export type MarkdownFormat = 'bold' | 'italic' | 'strike' | 'code'

const FORMAT_MARKERS: Record<MarkdownFormat, readonly [string, string]> = {
  bold: ['**', '**'],
  italic: ['*', '*'],
  strike: ['~~', '~~'],
  code: ['`', '`'],
}

export interface MarkdownFormatResult {
  value: string
  selectionStart: number
  selectionEnd: number
}

export function toggleMarkdownFormat(
  value: string,
  selectionStart: number,
  selectionEnd: number,
  format: MarkdownFormat,
): MarkdownFormatResult {
  const [open, close] = FORMAT_MARKERS[format]
  const selected = value.slice(selectionStart, selectionEnd)
  const alreadyWrapped = selected.length >= open.length + close.length
    && selected.startsWith(open)
    && selected.endsWith(close)

  if (alreadyWrapped) {
    const unwrapped = selected.slice(open.length, -close.length)
    const nextValue = `${value.slice(0, selectionStart)}${unwrapped}${value.slice(selectionEnd)}`
    return {
      value: nextValue,
      selectionStart,
      selectionEnd: selectionStart + unwrapped.length,
    }
  }

  const nextValue = `${value.slice(0, selectionStart)}${open}${selected}${close}${value.slice(selectionEnd)}`
  const nextSelectionStart = selectionStart + open.length
  return {
    value: nextValue,
    selectionStart: nextSelectionStart,
    selectionEnd: nextSelectionStart + selected.length,
  }
}

/**
 * Expand commands that are purely local formatting conveniences.
 * Server-backed commands must stay explicit until their permission model exists.
 */
export function expandSlashCommand(content: string): string {
  const trimmed = content.trim()
  if (!trimmed.startsWith('/')) return content

  const [command, ...args] = trimmed.split(/\s+/)
  const argumentText = args.join(' ')
  switch (command.toLowerCase()) {
    case '/shrug':
      return argumentText ? `${argumentText} ${SHRUG}` : SHRUG
    case '/me':
      return argumentText ? `*${argumentText}*` : trimmed
    default:
      return content
  }
}
