import { describe, expect, it } from 'vitest'
import {
  RSVP_REPLIES,
  clipsFromMessages,
  rsvpFromReactions,
  emptyRoomShapes,
  restoreRoomShapes,
  roomShapeStorageKey,
  serializeRoomShapes,
  type RoomShapesSnapshot,
} from './room-shape'

const ACCOUNT = '@taylor:mesh.test'

function message(patch: Partial<Parameters<typeof clipsFromMessages>[0][number]> = {}) {
  return {
    id: '$one',
    authorDisplayName: 'Maya Chen',
    content: '',
    attachments: [],
    reactions: {},
    timestamp: '2026-08-01T10:00:00.000Z',
    ...patch,
  } as Parameters<typeof clipsFromMessages>[0][number]
}

function attachment(filename: string, contentType: string) {
  return { fileHash: filename, filename, size: 1024, chunks: 1, sourcePeerId: 'peer', contentType }
}

const image = attachment('lantern.png', 'image/png')

describe('room shape storage', () => {
  it('scopes the key to one account so a second account starts clean', () => {
    expect(roomShapeStorageKey(ACCOUNT)).not.toBe(roomShapeStorageKey('@other:mesh.test'))
    expect(roomShapeStorageKey(ACCOUNT)).toContain(encodeURIComponent(ACCOUNT))
  })

  it('round-trips a declared shape', () => {
    const snapshot: RoomShapesSnapshot = {
      ...emptyRoomShapes(ACCOUNT),
      shapes: { '!art:mesh.test': 'clips' },
    }

    expect(restoreRoomShapes(serializeRoomShapes(snapshot), ACCOUNT)).toEqual(snapshot)
  })

  it('falls back to an empty set rather than throwing on unreadable storage', () => {
    expect(restoreRoomShapes('not json at all', ACCOUNT)).toEqual(emptyRoomShapes(ACCOUNT))
    expect(restoreRoomShapes(null, ACCOUNT)).toEqual(emptyRoomShapes(ACCOUNT))
  })

  it('drops a shape it does not recognise instead of rendering an unknown surface', () => {
    const stored = JSON.stringify({
      schemaVersion: 1,
      accountId: ACCOUNT,
      shapes: { '!art:mesh.test': 'clips', '!weird:mesh.test': 'hologram' },
    })

    expect(restoreRoomShapes(stored, ACCOUNT).shapes).toEqual({ '!art:mesh.test': 'clips' })
  })

  it('ignores a snapshot saved by a different account', () => {
    const stored = serializeRoomShapes({
      ...emptyRoomShapes('@someone:mesh.test'),
      shapes: { '!art:mesh.test': 'clips' },
    })

    expect(restoreRoomShapes(stored, ACCOUNT)).toEqual(emptyRoomShapes(ACCOUNT))
  })
})

describe('clipsFromMessages', () => {
  it('keeps only messages that actually carry an image', () => {
    const clips = clipsFromMessages([
      message({ id: '$text', content: 'just talking' }),
      message({ id: '$pic', attachments: [image] }),
      message({ id: '$file', attachments: [attachment('notes.pdf', 'application/pdf')] }),
    ])

    expect(clips.map((clip) => clip.id)).toEqual(['$pic'])
  })

  it('shows the newest clip first, because a gallery is not a transcript', () => {
    const clips = clipsFromMessages([
      message({ id: '$older', attachments: [image], timestamp: '2026-08-01T09:00:00.000Z' }),
      message({ id: '$newer', attachments: [image], timestamp: '2026-08-01T11:00:00.000Z' }),
    ])

    expect(clips.map((clip) => clip.id)).toEqual(['$newer', '$older'])
  })

  it('leaves a deleted message out of the gallery', () => {
    const clips = clipsFromMessages([
      message({ id: '$gone', attachments: [image], deletedAt: '2026-08-01T12:00:00.000Z' }),
    ])

    expect(clips).toEqual([])
  })

  it('carries the poster and their reactions, which are the point of a clip', () => {
    const clips = clipsFromMessages([
      message({ id: '$pic', attachments: [image], reactions: { '✨': ['@a:m.test', '@b:m.test'] } }),
    ])

    expect(clips[0].authorDisplayName).toBe('Maya Chen')
    expect(clips[0].reactionCount).toBe(2)
  })

  it('counts every image in a message that carries several', () => {
    const clips = clipsFromMessages([
      message({ id: '$pair', attachments: [image, attachment('b.jpg', 'image/jpeg')] }),
    ])

    expect(clips[0].attachments).toHaveLength(2)
  })
})

describe('rsvpFromReactions', () => {
  it('reads the three replies off the reactions already on the message', () => {
    const rsvp = rsvpFromReactions({
      '✅': ['@maya:mesh.test', '@rohan:mesh.test'],
      '🤔': ['@ari:mesh.test'],
      '❌': ['@kira:mesh.test'],
    })

    expect(rsvp.going).toEqual(['@maya:mesh.test', '@rohan:mesh.test'])
    expect(rsvp.maybe).toEqual(['@ari:mesh.test'])
    expect(rsvp.cant).toEqual(['@kira:mesh.test'])
  })

  it('ignores every other reaction, because a room is still a room', () => {
    const rsvp = rsvpFromReactions({ '✨': ['@maya:mesh.test'], '🍕': ['@rohan:mesh.test'] })

    expect(rsvp.going).toEqual([])
    expect(rsvp.maybe).toEqual([])
    expect(rsvp.cant).toEqual([])
    expect(rsvp.total).toBe(0)
  })

  it('counts a person once, on their strongest reply', () => {
    // Somebody who reacted twice is not two people, and "going" is the answer
    // that changes what a host does.
    const rsvp = rsvpFromReactions({
      '✅': ['@maya:mesh.test'],
      '🤔': ['@maya:mesh.test'],
      '❌': ['@maya:mesh.test'],
    })

    expect(rsvp.going).toEqual(['@maya:mesh.test'])
    expect(rsvp.maybe).toEqual([])
    expect(rsvp.cant).toEqual([])
    expect(rsvp.total).toBe(1)
  })

  it('has no reply at all when nobody has answered', () => {
    const rsvp = rsvpFromReactions({})
    expect(rsvp.total).toBe(0)
    expect(rsvp.going).toEqual([])
  })

  it('names the three replies so the surface and the reaction agree', () => {
    expect(RSVP_REPLIES.map((reply) => reply.id)).toEqual(['going', 'maybe', 'cant'])
    expect(RSVP_REPLIES.every((reply) => reply.emoji.length > 0)).toBe(true)
    expect(RSVP_REPLIES.every((reply) => reply.label.length > 0)).toBe(true)
  })
})
