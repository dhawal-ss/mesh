import { describe, expect, it } from 'vitest'
import {
  attentionFirst,
  calloutsFirst,
  isCallout,
  isUnread,
  type MutedLookup,
} from './attention-ranking'

interface Row {
  id: string
  unreadCount: number
  unreadMentions?: number
  unreadMarked?: boolean
  muted?: boolean
}

const nothingMuted: MutedLookup<Row> = () => false
const respectMute: MutedLookup<Row> = (row) => Boolean(row.muted)

const row = (
  id: string,
  unreadCount = 0,
  unreadMentions?: number,
  muted?: boolean,
  unreadMarked?: boolean,
): Row => ({
  id,
  unreadCount,
  ...(unreadMentions === undefined ? {} : { unreadMentions }),
  ...(muted === undefined ? {} : { muted }),
  ...(unreadMarked === undefined ? {} : { unreadMarked }),
})

const ids = (rows: Row[]) => rows.map((entry) => entry.id)

describe('attention signals', () => {
  it('treats a mention as a callout and plain unread as not', () => {
    expect(isCallout(row('a', 40), nothingMuted)).toBe(false)
    expect(isCallout(row('b', 0, 1), nothingMuted)).toBe(true)
    expect(isUnread(row('a', 40), nothingMuted)).toBe(true)
    expect(isUnread(row('c'), nothingMuted)).toBe(false)
  })

  it('counts a mention as unread even when the unread total is stale at zero', () => {
    expect(isUnread(row('b', 0, 2), nothingMuted)).toBe(true)
  })

  it('never lets a silenced destination register either signal', () => {
    expect(isCallout(row('b', 5, 3, true), respectMute)).toBe(false)
    expect(isUnread(row('b', 5, 3, true), respectMute)).toBe(false)
  })

  it('tolerates records that predate mention counting', () => {
    expect(isCallout(row('a', 9), nothingMuted)).toBe(false)
    expect(isUnread(row('a', 9), nothingMuted)).toBe(true)
  })

  it('treats an explicit mark-unread as unread even with zero count and mentions', () => {
    const marked = row('a', 0, undefined, undefined, true)
    expect(isUnread(marked, nothingMuted)).toBe(true)
    // Marking a room unread is not the same as being named in it.
    expect(isCallout(marked, nothingMuted)).toBe(false)
  })

  it('suppresses an explicit mark-unread on a muted destination, matching how a muted mention is suppressed', () => {
    const markedAndMuted = row('a', 0, undefined, true, true)
    expect(isUnread(markedAndMuted, respectMute)).toBe(false)
  })
})

describe('calloutsFirst', () => {
  it('lifts callouts without disturbing anything else', () => {
    const rows = [row('read'), row('busy', 200), row('named', 1, 1), row('quiet')]
    expect(ids(calloutsFirst(rows, nothingMuted))).toEqual(['named', 'read', 'busy', 'quiet'])
  })

  it('refuses to reorder on unread volume alone', () => {
    // The room someone actually works in must not be displaced by a firehose.
    const rows = [row('mine', 2), row('firehose', 900)]
    expect(ids(calloutsFirst(rows, nothingMuted))).toEqual(['mine', 'firehose'])
  })

  it('keeps a silenced callout in place', () => {
    const rows = [row('read'), row('muted-mention', 5, 5, true)]
    expect(ids(calloutsFirst(rows, respectMute))).toEqual(['read', 'muted-mention'])
  })

  it('preserves the incoming order among several callouts', () => {
    const rows = [row('second', 0, 9), row('first', 0, 1), row('read')]
    expect(ids(calloutsFirst(rows, nothingMuted))).toEqual(['second', 'first', 'read'])
  })
})

describe('attentionFirst', () => {
  it('bands callouts, then unread, then everything read', () => {
    const rows = [row('read-a'), row('unread-a', 3), row('named', 0, 2), row('read-b'), row('unread-b', 1)]
    expect(ids(attentionFirst(rows, nothingMuted)))
      .toEqual(['named', 'unread-a', 'unread-b', 'read-a', 'read-b'])
  })

  it('sinks silenced destinations to the read band however loud they are', () => {
    const rows = [row('read'), row('muted-firehose', 500, 12, true), row('unread', 1)]
    expect(ids(attentionFirst(rows, respectMute)))
      .toEqual(['unread', 'read', 'muted-firehose'])
  })

  it('leaves a list with no signals exactly as it arrived', () => {
    const rows = [row('c'), row('a'), row('b')]
    expect(ids(attentionFirst(rows, nothingMuted))).toEqual(['c', 'a', 'b'])
  })

  it('returns an empty list unchanged', () => {
    expect(attentionFirst([], nothingMuted)).toEqual([])
  })
})
