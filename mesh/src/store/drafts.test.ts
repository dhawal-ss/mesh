import { beforeEach, describe, expect, it } from 'vitest'
import { MAX_DRAFT_BYTES, truncateDraft, useDraftStore } from './drafts'

const utf8Encoder = new TextEncoder()

describe('draft store', () => {
  beforeEach(() => {
    useDraftStore.setState({ drafts: {} })
  })

  it('keeps drafts isolated by channel and removes empty values', () => {
    useDraftStore.getState().setDraft('!general:mesh.test', 'hello')
    useDraftStore.getState().setDraft('!random:mesh.test', 'later')

    expect(useDraftStore.getState().drafts).toEqual({
      '!general:mesh.test': 'hello',
      '!random:mesh.test': 'later',
    })

    useDraftStore.getState().setDraft('!general:mesh.test', '')
    expect(useDraftStore.getState().drafts).toEqual({ '!random:mesh.test': 'later' })
  })

  it('bounds draft size and the number of retained channels', () => {
    const oversized = 'x'.repeat(MAX_DRAFT_BYTES + 100)
    useDraftStore.getState().setDraft('!first:mesh.test', oversized)
    expect(useDraftStore.getState().drafts['!first:mesh.test']).toHaveLength(MAX_DRAFT_BYTES)

    for (let index = 0; index < 128; index += 1) {
      useDraftStore.getState().setDraft(`!room-${index}:mesh.test`, 'draft')
    }
    useDraftStore.getState().setDraft('!last:mesh.test', 'draft')

    const drafts = useDraftStore.getState().drafts
    expect(Object.keys(drafts)).toHaveLength(128)
    expect(drafts['!first:mesh.test']).toBeUndefined()
    expect(drafts['!last:mesh.test']).toBe('draft')
  })

  it('bounds multibyte drafts by UTF-8 bytes without splitting code points', () => {
    const emojiDraft = truncateDraft('😀'.repeat((MAX_DRAFT_BYTES / 4) + 1))
    expect(utf8Encoder.encode(emojiDraft)).toHaveLength(MAX_DRAFT_BYTES)
    expect(emojiDraft).toHaveLength(MAX_DRAFT_BYTES / 2)
    expect(emojiDraft.endsWith('😀')).toBe(true)

    const cjkDraft = truncateDraft('界'.repeat(MAX_DRAFT_BYTES))
    expect(utf8Encoder.encode(cjkDraft).byteLength).toBeLessThanOrEqual(MAX_DRAFT_BYTES)
    expect(utf8Encoder.encode(`${cjkDraft}界`).byteLength).toBeGreaterThan(MAX_DRAFT_BYTES)
    expect(cjkDraft.endsWith('界')).toBe(true)
  })
})
