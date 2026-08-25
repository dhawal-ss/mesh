/*
    Turning a Matrix avatar address into something an `img` element can show.

    Every avatar Matrix knows about is an MXC URI (`mxc://server/mediaid`). The
    renderer cannot load one: Mesh's content security policy allows images from
    `'self'`, `data:`, and `blob:` only, and the media endpoint needs the
    account access token, which never leaves the Rust side. So an MXC URI in an
    `img src` does not render a broken image with a console error a developer
    would notice; it is refused by the CSP and lands in the element's error
    handler, which `Avatar` treats as "this person has no picture" and replaces
    with a generated mark. The failure is silent and looks exactly like the
    intended fallback, which is why it survived.

    The fix is to resolve the URI to bytes through the native side once, hold
    the resulting object URL, and hand that to the element instead. This module
    is the decision logic for that cache; `src/store/matrix-avatars.ts` performs
    the loads and owns the object URLs.
*/

/*
    How many resolved avatars are held at once.

    The number has to cover everything that can be on screen together, because
    an eviction revokes an object URL and any element still using it falls back
    to the generated mark without saying why. The screens that ask for the most
    at once: a member list page (100 rows), a timeline window and its distinct
    authors (tens), and the community rail, direct message list and voice rows
    beside them (tens more). 256 leaves headroom over that sum.

    It also bounds memory, which is why the number is not simply enormous: the
    native side re-encodes every picture to a 256px PNG, so an entry is on the
    order of tens of kilobytes and a full cache is a few megabytes.

    A cap alone is not enough, so `admitAvatar` also refuses to evict a picture
    something is currently showing. See `pinned`.
*/
export const MAX_CACHED_AVATARS = 256

const NO_PINNED_AVATARS: ReadonlySet<string> = new Set()

/**
 * Whether this image source has to be resolved before an element can show it.
 *
 * Only MXC is rewritten. Anything else, a bundled asset path or an object URL
 * a caller already made, is passed through untouched, so this cannot change
 * what an existing caller renders.
 */
export function isMxcUri(value: string | null | undefined): boolean {
  return typeof value === 'string' && value.startsWith('mxc://')
}

/**
 * Records `key` as the most recently used entry and reports which keys fall out
 * of the cache once `cap` is exceeded.
 *
 * Least-recently-used rather than insertion order because the working set is
 * whatever is on screen. The caller revokes every returned key's object URL.
 *
 * `pinned` holds the pictures something is showing right now, and no key in it
 * is ever reported: revoking one turns a live `img` into a broken image, which
 * reads as "this person has no picture" rather than as a cache eviction. So a
 * screen showing more pictures at once than `cap` holds keeps all of them and
 * the cache goes over its cap until they leave, which is the lesser cost of the
 * two. Nothing else is protected, so an off-screen entry still ages out.
 */
export function admitAvatar(
  recency: readonly string[],
  key: string,
  cap: number = MAX_CACHED_AVATARS,
  pinned: ReadonlySet<string> = NO_PINNED_AVATARS,
): { recency: string[]; evicted: string[] } {
  const promoted = [key, ...recency.filter((entry) => entry !== key)]
  const kept: string[] = []
  const evicted: string[] = []
  // Newest first, so what is offered for eviction is always the oldest.
  for (const entry of promoted) {
    if (kept.length < cap || pinned.has(entry)) kept.push(entry)
    else evicted.push(entry)
  }
  return { recency: kept, evicted }
}

/**
 * Marks `key` used without admitting it, for a cache hit.
 *
 * A read has to promote too, or the entry a screen keeps displaying ages out
 * from under it while entries nobody looks at stay resident.
 */
export function touchAvatar(recency: readonly string[], key: string): string[] {
  if (recency[0] === key) return recency as string[]
  if (!recency.includes(key)) return recency as string[]
  return [key, ...recency.filter((entry) => entry !== key)]
}
