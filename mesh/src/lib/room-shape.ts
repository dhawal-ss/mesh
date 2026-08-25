import type { AttachmentDto } from '../types/ipc'
import { classifySearchResultKind } from './search-result-kind'

/**
 * What a room is for.
 *
 * `conversation` is the default and is never stored: a room with no declared
 * shape is a conversation, so an account that never touches this feature keeps
 * an empty snapshot and the surface it has always had.
 *
 * A shape changes what the room promises and how it is read. It does not change
 * membership, permissions, encryption, or the composer, and it is not a room
 * type on the wire: this is a local reading preference, so declaring one cannot
 * fail, cannot need a power level, and cannot desynchronise from the server.
 */
export const ROOM_SHAPES = ['conversation', 'clips', 'event'] as const

export type RoomShape = (typeof ROOM_SHAPES)[number]

export const ROOM_SHAPE_SCHEMA_VERSION = 1

export interface RoomShapesSnapshot {
  schemaVersion: typeof ROOM_SHAPE_SCHEMA_VERSION
  accountId: string
  /** Room id to declared shape. `conversation` is absent rather than stored. */
  shapes: Record<string, RoomShape>
}

export function roomShapeStorageKey(accountId: string): string {
  return `mesh-room-shape-v1:${encodeURIComponent(accountId)}`
}

export function emptyRoomShapes(accountId: string): RoomShapesSnapshot {
  return { schemaVersion: ROOM_SHAPE_SCHEMA_VERSION, accountId, shapes: {} }
}

export function serializeRoomShapes(snapshot: RoomShapesSnapshot): string {
  return JSON.stringify(snapshot)
}

function isRoomShape(value: unknown): value is RoomShape {
  return typeof value === 'string' && (ROOM_SHAPES as readonly string[]).includes(value)
}

/**
 * Restores a snapshot, dropping anything this build cannot render.
 *
 * An unknown shape is discarded rather than kept: a newer build may have
 * written a shape this one has no surface for, and falling back to the
 * conversation everybody already understands beats rendering nothing.
 */
export function restoreRoomShapes(
  stored: string | null,
  accountId: string,
): RoomShapesSnapshot {
  if (!stored) return emptyRoomShapes(accountId)
  try {
    const parsed = JSON.parse(stored) as Partial<RoomShapesSnapshot>
    if (parsed?.accountId !== accountId) return emptyRoomShapes(accountId)
    const shapes: Record<string, RoomShape> = {}
    for (const [roomId, shape] of Object.entries(parsed.shapes ?? {})) {
      if (isRoomShape(shape) && shape !== 'conversation') shapes[roomId] = shape
    }
    return { schemaVersion: ROOM_SHAPE_SCHEMA_VERSION, accountId, shapes }
  } catch {
    return emptyRoomShapes(accountId)
  }
}

interface ClipSource {
  id: string
  authorDisplayName: string
  authorAvatarColor?: string
  content: string
  attachments: AttachmentDto[]
  reactions: Record<string, string[]>
  timestamp: string
  deletedAt?: string | null
}

export interface Clip {
  id: string
  authorDisplayName: string
  /** The message body, which in a clips room reads as a caption. */
  caption: string
  attachments: AttachmentDto[]
  reactionCount: number
  timestamp: string
}

/**
 * The clips in a room, newest first.
 *
 * A gallery is not a transcript: what matters is what was posted and who
 * reacted, so a message with no image is not a clip at all. Reuses the same
 * classifier the search tabs use, which mirrors the native `has:image` filter,
 * so "media" means one thing across the product.
 */
export function clipsFromMessages(messages: readonly ClipSource[]): Clip[] {
  return messages
    .filter((message) => !message.deletedAt)
    .filter((message) => classifySearchResultKind(message) === 'media')
    .map((message) => ({
      id: message.id,
      authorDisplayName: message.authorDisplayName,
      caption: message.content,
      attachments: message.attachments,
      reactionCount: Object.values(message.reactions ?? {})
        .reduce((total, senders) => total + senders.length, 0),
      timestamp: message.timestamp,
    }))
    .sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp))
}

/**
 * The three replies an event asks for.
 *
 * They are reactions, deliberately. A room already syncs reactions, already
 * permissions them, already renders them, and already survives an account
 * switch; an RSVP built on anything else would need a wire format, a power
 * level, and a failure mode, to answer a question the room can already answer.
 * Somebody reading this room as a conversation sees a plan with ticks on it,
 * which is what they would have done by hand anyway.
 */
export const RSVP_REPLIES = [
  { id: 'going', emoji: '\u2705', label: 'Going' },
  { id: 'maybe', emoji: '\ud83e\udd14', label: 'Maybe' },
  { id: 'cant', emoji: '\u274c', label: "Can't" },
] as const

export type RsvpReplyId = (typeof RSVP_REPLIES)[number]['id']

export interface Rsvp {
  going: string[]
  maybe: string[]
  cant: string[]
  /** People who answered, counted once each. */
  total: number
}

/**
 * The replies on a plan, from the reactions already sitting on it.
 *
 * Every other reaction is ignored rather than counted as an answer: a plan is
 * still a message, and somebody adding a party popper to it has not said they
 * are coming. A person who reacted more than once is counted once, on the
 * strongest thing they said, because a host reading this needs a headcount and
 * two of those answers cannot both be true.
 */
export function rsvpFromReactions(reactions: Record<string, readonly string[]>): Rsvp {
  const claimed = new Set<string>()
  const buckets: Record<RsvpReplyId, string[]> = { going: [], maybe: [], cant: [] }

  for (const reply of RSVP_REPLIES) {
    for (const sender of reactions[reply.emoji] ?? []) {
      if (claimed.has(sender)) continue
      claimed.add(sender)
      buckets[reply.id].push(sender)
    }
  }

  return { ...buckets, total: claimed.size }
}
