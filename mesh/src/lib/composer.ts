const SHRUG = '¯\\_(ツ)_/¯'

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
