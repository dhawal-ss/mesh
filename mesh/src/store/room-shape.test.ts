import { beforeEach, describe, expect, it } from 'vitest'
import { useRoomShapeStore } from './room-shape'
import { emptyRoomShapes, roomShapeStorageKey } from '../lib/room-shape'

const ACCOUNT = '@taylor:mesh.test'
const ROOM = '!art:mesh.test'

describe('room shape store', () => {
  beforeEach(() => {
    window.localStorage.clear()
    useRoomShapeStore.setState({ ...emptyRoomShapes('local-device'), hydrated: false })
  })

  it('treats an undeclared room as a conversation', () => {
    useRoomShapeStore.getState().initialize(ACCOUNT)

    expect(useRoomShapeStore.getState().shapeFor(ROOM)).toBe('conversation')
  })

  it('remembers a declared shape across a reload', () => {
    useRoomShapeStore.getState().initialize(ACCOUNT)
    useRoomShapeStore.getState().setShape(ROOM, 'clips')

    useRoomShapeStore.setState({ ...emptyRoomShapes('local-device'), hydrated: false })
    useRoomShapeStore.getState().initialize(ACCOUNT)

    expect(useRoomShapeStore.getState().shapeFor(ROOM)).toBe('clips')
  })

  it('stores nothing for a room put back to conversation', () => {
    useRoomShapeStore.getState().initialize(ACCOUNT)
    useRoomShapeStore.getState().setShape(ROOM, 'clips')

    useRoomShapeStore.getState().setShape(ROOM, 'conversation')

    expect(useRoomShapeStore.getState().shapes).toEqual({})
    expect(window.localStorage.getItem(roomShapeStorageKey(ACCOUNT)))
      .not.toContain(ROOM)
  })

  it('keeps one account’s shapes out of another’s', () => {
    useRoomShapeStore.getState().initialize(ACCOUNT)
    useRoomShapeStore.getState().setShape(ROOM, 'clips')

    useRoomShapeStore.setState({ ...emptyRoomShapes('local-device'), hydrated: false })
    useRoomShapeStore.getState().initialize('@someone:mesh.test')

    expect(useRoomShapeStore.getState().shapeFor(ROOM)).toBe('conversation')
  })

  it('does not re-read storage when it is already hydrated for that account', () => {
    useRoomShapeStore.getState().initialize(ACCOUNT)
    useRoomShapeStore.getState().setShape(ROOM, 'clips')

    useRoomShapeStore.getState().initialize(ACCOUNT)

    expect(useRoomShapeStore.getState().shapeFor(ROOM)).toBe('clips')
  })
})
