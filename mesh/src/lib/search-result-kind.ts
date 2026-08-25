import type { AttachmentDto } from '../types/ipc'

export type SearchResultKind = 'message' | 'media' | 'file' | 'link'

const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg', '.avif', '.heic']

function attachmentIsImage(attachment: AttachmentDto): boolean {
  if (attachment.contentType?.toLowerCase().startsWith('image/')) return true
  const filename = attachment.filename.toLowerCase()
  return IMAGE_EXTENSIONS.some((extension) => filename.endsWith(extension))
}

function contentHasLink(content: string): boolean {
  const lowered = content.toLowerCase()
  return lowered.includes('http://') || lowered.includes('https://')
}

/**
 * Classifies a search result the same way the native engine's `has:` filter
 * does (mirrors `attachment_is_image`/`content_has_link` in
 * `src-tauri/src/backend/matrix.rs`), so the result tabs partition results
 * into exactly the categories a person could already reach one at a time
 * with `has:image`, `has:link`, etc.
 */
export function classifySearchResultKind(
  message: { content: string; attachments: AttachmentDto[] },
): SearchResultKind {
  if (message.attachments.some(attachmentIsImage)) return 'media'
  if (message.attachments.length > 0) return 'file'
  if (contentHasLink(message.content)) return 'link'
  return 'message'
}
