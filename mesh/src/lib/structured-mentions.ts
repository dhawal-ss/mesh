export interface StructuredMention {
  start: number
  end: number
  userId: string
}

const MAX_STRUCTURED_MENTIONS = 64
const MATRIX_TO_USER_PREFIX = 'https://matrix.to/#/'

export function mentionDisplayToken(displayName: string): string {
  const normalized = displayName.trim().replace(/\s+/gu, ' ')
  return `@${normalized || 'Member'}`
}

export function normalizeStructuredMentions(
  body: string,
  mentions: readonly StructuredMention[],
): StructuredMention[] {
  const normalized: StructuredMention[] = []
  let previousEnd = -1
  for (const mention of [...mentions].sort((left, right) => left.start - right.start || left.end - right.end)) {
    if (normalized.length >= MAX_STRUCTURED_MENTIONS) break
    if (
      !Number.isInteger(mention.start)
      || !Number.isInteger(mention.end)
      || mention.start < 0
      || mention.end <= mention.start
      || mention.end > body.length
      || mention.start < previousEnd
      || !isMatrixUserId(mention.userId)
      || !body.slice(mention.start, mention.end).startsWith('@')
    ) {
      continue
    }
    normalized.push({ ...mention })
    previousEnd = mention.end
  }
  return normalized
}

export function reconcileStructuredMentions(
  previousBody: string,
  nextBody: string,
  mentions: readonly StructuredMention[],
): StructuredMention[] {
  const current = normalizeStructuredMentions(previousBody, mentions)
  if (previousBody === nextBody) return current

  let prefixLength = 0
  while (
    prefixLength < previousBody.length
    && prefixLength < nextBody.length
    && previousBody[prefixLength] === nextBody[prefixLength]
  ) {
    prefixLength += 1
  }

  let suffixLength = 0
  while (
    suffixLength < previousBody.length - prefixLength
    && suffixLength < nextBody.length - prefixLength
    && previousBody[previousBody.length - suffixLength - 1]
      === nextBody[nextBody.length - suffixLength - 1]
  ) {
    suffixLength += 1
  }

  const previousEditEnd = previousBody.length - suffixLength
  const nextEditEnd = nextBody.length - suffixLength
  const delta = nextEditEnd - previousEditEnd
  const adjusted = current.flatMap((mention) => {
    if (mention.end <= prefixLength) return [mention]
    if (mention.start >= previousEditEnd) {
      return [{ ...mention, start: mention.start + delta, end: mention.end + delta }]
    }
    return []
  })

  return normalizeStructuredMentions(nextBody, adjusted)
}

export function structuredMentionUserIds(
  body: string,
  mentions: readonly StructuredMention[],
): string[] {
  const seen = new Set<string>()
  return normalizeStructuredMentions(body, mentions)
    .map((mention) => mention.userId)
    .filter((userId) => {
      if (seen.has(userId)) return false
      seen.add(userId)
      return true
    })
}

export function retainStructuredMentionUserIds(
  body: string,
  userIds: readonly string[],
  members: readonly { publicKey: string; displayName: string }[],
): string[] {
  const seen = new Set<string>()
  return userIds.filter((userId) => {
    if (seen.has(userId)) return false
    seen.add(userId)
    const member = members.find((candidate) => candidate.publicKey === userId)
    return member ? containsMentionToken(body, mentionDisplayToken(member.displayName)) : false
  })
}

export function serializeStructuredMentionDraft(
  body: string,
  mentions: readonly StructuredMention[],
): string | null {
  const normalized = normalizeStructuredMentions(body, mentions)
  if (normalized.length === 0) return null

  const parts = ['<p>']
  let cursor = 0
  for (const mention of normalized) {
    parts.push(escapeDraftText(body.slice(cursor, mention.start)))
    parts.push(
      `<a href="${MATRIX_TO_USER_PREFIX}${encodeURIComponent(mention.userId)}">${escapeDraftText(body.slice(mention.start, mention.end))}</a>`,
    )
    cursor = mention.end
  }
  parts.push(escapeDraftText(body.slice(cursor)), '</p>')
  return parts.join('')
}

export function parseStructuredMentionDraft(
  body: string,
  formattedBody: string | null | undefined,
): StructuredMention[] {
  if (!formattedBody || typeof DOMParser === 'undefined') return []
  const document = new DOMParser().parseFromString(formattedBody, 'text/html')
  const textParts: string[] = []
  const mentions: StructuredMention[] = []
  let textLength = 0

  const walk = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      const text = node.nodeValue ?? ''
      textParts.push(text)
      textLength += text.length
      return
    }
    if (!(node instanceof HTMLElement)) return
    if (node.tagName === 'BR') {
      textParts.push('\n')
      textLength += 1
      return
    }

    const start = textLength
    for (const child of node.childNodes) walk(child)
    if (node.tagName !== 'A') return
    const userId = matrixUserIdFromHref(node.getAttribute('href'))
    if (userId && textLength > start) {
      mentions.push({ start, end: textLength, userId })
    }
  }

  for (const child of document.body.childNodes) walk(child)
  if (textParts.join('') !== body) return []
  return normalizeStructuredMentions(body, mentions)
}

function matrixUserIdFromHref(href: string | null): string | null {
  if (!href?.startsWith(MATRIX_TO_USER_PREFIX)) return null
  try {
    const userId = decodeURIComponent(href.slice(MATRIX_TO_USER_PREFIX.length))
    return isMatrixUserId(userId) ? userId : null
  } catch {
    return null
  }
}

/**
 * Whether a string is a full Matrix account address, `@localpart:server`.
 *
 * Shape only. An address can be perfectly well formed and belong to nobody,
 * which is why the backend looks the account up before opening a room with it.
 */
export function isMatrixUserId(value: string): boolean {
  return /^@[^\s:@]+:[^\s]+$/u.test(value)
}

function containsMentionToken(body: string, token: string): boolean {
  let index = body.indexOf(token)
  while (index >= 0) {
    const before = index === 0 ? '' : body[index - 1]
    const afterIndex = index + token.length
    const after = afterIndex >= body.length ? '' : body[afterIndex]
    if (
      (!before || /\s/u.test(before))
      && (!after || /[\s.,!?;:)\]]/u.test(after))
    ) {
      return true
    }
    index = body.indexOf(token, index + 1)
  }
  return false
}

function escapeDraftText(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/\n/g, '<br>')
}
