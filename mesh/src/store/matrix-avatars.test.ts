import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import * as bridge from '../lib/bridge'
import { MAX_CACHED_AVATARS } from '../lib/matrix-avatar-source'
import { releaseAvatar, retainAvatar, useMatrixAvatarStore } from './matrix-avatars'

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47])

function settle() {
  // The store starts its load without awaiting it, so a test has to yield past
  // the bridge promise and the set() that follows it.
  return new Promise((resolve) => setTimeout(resolve, 0))
}

describe('useMatrixAvatarStore', () => {
  let created: string[]
  let revoked: string[]

  beforeEach(() => {
    created = []
    revoked = []
    let counter = 0
    vi.stubGlobal('URL', Object.assign(URL, {
      createObjectURL: vi.fn(() => {
        counter += 1
        const url = `blob:avatar-${counter}`
        created.push(url)
        return url
      }),
      revokeObjectURL: vi.fn((url: string) => {
        revoked.push(url)
      }),
    }))
    vi.spyOn(bridge, 'isMatrixBackend').mockReturnValue(true)
  })

  afterEach(() => {
    // clearAll rather than resetting the fields: a test that leaves a load
    // unresolved on purpose otherwise leaves it in flight, and the next test
    // asking for the same picture gets skipped instead of resolved.
    useMatrixAvatarStore.getState().clearAll()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('resolves an MXC URI to an object URL through the native reader', async () => {
    const load = vi.spyOn(bridge, 'matrixLoadProfileAvatar').mockResolvedValue(PNG)

    useMatrixAvatarStore.getState().resolve('mxc://example.org/one')
    expect(useMatrixAvatarStore.getState().entries['mxc://example.org/one']?.status).toBe('loading')

    await settle()
    expect(load).toHaveBeenCalledWith('mxc://example.org/one')
    expect(useMatrixAvatarStore.getState().entries['mxc://example.org/one']).toEqual({
      status: 'ready',
      objectUrl: 'blob:avatar-1',
    })
  })

  it('loads one picture once however many elements ask for it', async () => {
    const load = vi.spyOn(bridge, 'matrixLoadProfileAvatar').mockResolvedValue(PNG)

    const { resolve } = useMatrixAvatarStore.getState()
    resolve('mxc://example.org/shared')
    resolve('mxc://example.org/shared')
    resolve('mxc://example.org/shared')
    await settle()

    expect(load).toHaveBeenCalledTimes(1)
  })

  it('does not ask again after a picture fails', async () => {
    const load = vi
      .spyOn(bridge, 'matrixLoadProfileAvatar')
      .mockRejectedValue(new Error('gone'))

    useMatrixAvatarStore.getState().resolve('mxc://example.org/missing')
    await settle()
    expect(useMatrixAvatarStore.getState().entries['mxc://example.org/missing']).toEqual({
      status: 'failed',
      objectUrl: null,
    })

    useMatrixAvatarStore.getState().resolve('mxc://example.org/missing')
    await settle()
    expect(load).toHaveBeenCalledTimes(1)
  })

  it('ignores a value that is not an MXC URI', () => {
    const load = vi.spyOn(bridge, 'matrixLoadProfileAvatar')
    useMatrixAvatarStore.getState().resolve('blob:already-resolved')
    expect(load).not.toHaveBeenCalled()
    expect(useMatrixAvatarStore.getState().entries).toEqual({})
  })

  it('records a failure instead of retrying forever without a Matrix session', () => {
    vi.spyOn(bridge, 'isMatrixBackend').mockReturnValue(false)
    const load = vi.spyOn(bridge, 'matrixLoadProfileAvatar')

    useMatrixAvatarStore.getState().resolve('mxc://example.org/offline')

    expect(load).not.toHaveBeenCalled()
    expect(useMatrixAvatarStore.getState().entries['mxc://example.org/offline']?.status)
      .toBe('failed')
  })

  it('revokes the object URL of an entry it evicts', async () => {
    vi.spyOn(bridge, 'matrixLoadProfileAvatar').mockResolvedValue(PNG)

    // One past the cap, so exactly the oldest entry falls out.
    for (let index = 0; index <= MAX_CACHED_AVATARS; index += 1) {
      useMatrixAvatarStore.getState().resolve(`mxc://example.org/${index}`)
      await settle()
    }

    const { entries } = useMatrixAvatarStore.getState()
    expect(Object.keys(entries)).toHaveLength(MAX_CACHED_AVATARS)
    expect(entries['mxc://example.org/0']).toBeUndefined()
    expect(revoked).toEqual([created[0]])
  })

  it('does not evict the picture an element on screen is showing', async () => {
    vi.spyOn(bridge, 'matrixLoadProfileAvatar').mockResolvedValue(PNG)

    // The oldest entry, and the one the cap would take next, except that
    // something is showing it.
    useMatrixAvatarStore.getState().resolve('mxc://example.org/on-screen')
    await settle()
    retainAvatar('mxc://example.org/on-screen')
    const onScreenUrl = created[0]

    for (let index = 0; index < MAX_CACHED_AVATARS; index += 1) {
      useMatrixAvatarStore.getState().resolve(`mxc://example.org/${index}`)
      await settle()
    }

    expect(useMatrixAvatarStore.getState().entries['mxc://example.org/on-screen']).toEqual({
      status: 'ready',
      objectUrl: onScreenUrl,
    })
    expect(revoked).not.toContain(onScreenUrl)

    // Once it leaves the screen it is an ordinary entry again.
    releaseAvatar('mxc://example.org/on-screen')
    useMatrixAvatarStore.getState().resolve('mxc://example.org/after-release')
    await settle()

    expect(useMatrixAvatarStore.getState().entries['mxc://example.org/on-screen'])
      .toBeUndefined()
    expect(revoked).toContain(onScreenUrl)
  })

  it('does not resurrect an evicted entry when its bytes arrive late', async () => {
    let release: ((bytes: Uint8Array) => void) | undefined
    vi.spyOn(bridge, 'matrixLoadProfileAvatar').mockImplementation(
      () => new Promise((resolveBytes) => {
        release = resolveBytes as (bytes: Uint8Array) => void
      }),
    )

    useMatrixAvatarStore.getState().resolve('mxc://example.org/slow')
    // Whatever drops the entry first: an account switch is the real case.
    useMatrixAvatarStore.getState().clearAll()

    release?.(PNG)
    await settle()

    expect(useMatrixAvatarStore.getState().entries['mxc://example.org/slow']).toBeUndefined()
    // The object URL it made anyway is revoked rather than left resident with
    // nothing holding a reference that could ever revoke it.
    expect(revoked).toContain(created[0])
  })

  it('revokes every held picture when an account leaves', async () => {
    vi.spyOn(bridge, 'matrixLoadProfileAvatar').mockResolvedValue(PNG)

    useMatrixAvatarStore.getState().resolve('mxc://example.org/a')
    await settle()
    useMatrixAvatarStore.getState().resolve('mxc://example.org/b')
    await settle()
    expect(created).toHaveLength(2)

    useMatrixAvatarStore.getState().clearAll()

    expect(revoked).toEqual(created)
    expect(useMatrixAvatarStore.getState().entries).toEqual({})
    expect(useMatrixAvatarStore.getState().recency).toEqual([])
  })

  it('lets a picture load again after the cache is cleared', async () => {
    const load = vi.spyOn(bridge, 'matrixLoadProfileAvatar').mockResolvedValue(PNG)

    useMatrixAvatarStore.getState().resolve('mxc://example.org/again')
    await settle()
    useMatrixAvatarStore.getState().clearAll()
    useMatrixAvatarStore.getState().resolve('mxc://example.org/again')
    await settle()

    expect(load).toHaveBeenCalledTimes(2)
    expect(useMatrixAvatarStore.getState().entries['mxc://example.org/again']?.status)
      .toBe('ready')
  })
})
