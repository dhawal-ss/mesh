import { describe, expect, it } from 'vitest'
import { classifySearchResultKind } from './search-result-kind'

function message(content: string, attachments: Array<{ filename: string; contentType?: string | null }> = []) {
  return {
    content,
    attachments: attachments.map((attachment) => ({
      fileHash: 'hash',
      filename: attachment.filename,
      size: 1,
      chunks: 1,
      sourcePeerId: 'peer',
      contentType: attachment.contentType ?? null,
    })),
  }
}

describe('classifySearchResultKind', () => {
  it('classifies a plain-text message', () => {
    expect(classifySearchResultKind(message('hello there'))).toBe('message')
  })

  it('classifies an image attachment by content type as media', () => {
    expect(classifySearchResultKind(
      message('a screenshot', [{ filename: 'blob', contentType: 'image/png' }]),
    )).toBe('media')
  })

  it('classifies an image attachment by filename extension when content type is missing', () => {
    expect(classifySearchResultKind(
      message('a screenshot', [{ filename: 'shot.PNG' }]),
    )).toBe('media')
  })

  it('classifies a non-image attachment as a file', () => {
    expect(classifySearchResultKind(
      message('the report', [{ filename: 'report.pdf', contentType: 'application/pdf' }]),
    )).toBe('file')
  })

  it('classifies a link in the body as a link, when there is no attachment', () => {
    expect(classifySearchResultKind(message('see https://example.org/doc'))).toBe('link')
  })

  it('prefers media over a link when a message has both', () => {
    expect(classifySearchResultKind(
      message('see https://example.org/doc', [{ filename: 'shot.png', contentType: 'image/png' }]),
    )).toBe('media')
  })
})
