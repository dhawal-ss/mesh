import { beforeEach, describe, expect, it } from 'vitest'
import { MAX_DRAFT_LENGTH, useDraftStore } from './drafts'

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
    const oversized = 'x'.repeat(MAX_DRAFT_LENGTH + 100)
    useDraftStore.getState().setDraft('!first:mesh.test', oversized)
    expect(useDraftStore.getState().drafts['!first:mesh.test']).toHaveLength(MAX_DRAFT_LENGTH)

    for (let index = 0; index < 128; index += 1) {
      useDraftStore.getState().setDraft(`!room-${index}:mesh.test`, 'draft')
    }
    useDraftStore.getState().setDraft('!last:mesh.test', 'draft')

    const drafts = useDraftStore.getState().drafts
    expect(Object.keys(drafts)).toHaveLength(128)
    expect(drafts['!first:mesh.test']).toBeUndefined()
    expect(drafts['!last:mesh.test']).toBe('draft')
  })
})
