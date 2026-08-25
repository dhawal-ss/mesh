/*
  The two derivations every trust surface reads from.

  Quiet Structure states federation and encryption in three places -- a 2px rail
  in the timeline gutter, a ring on an avatar, and one caption per screen -- and
  those three must never disagree. A rail that says "local" beside a ring that
  says "remote" is worse than either mark alone, because it teaches people that
  the marks do not mean anything. So the semantics live here, once, and every
  surface reads them rather than re-deriving a domain comparison of its own.

  Nothing in this module touches the store or the bridge. It is pure, so the
  rules can be tested directly rather than through a rendered timeline.
*/

/** What a mark says about where somebody's account lives. */
export type ServerRelation = 'local' | 'remote'

/**
 * What the trust rail says about one message group.
 *
 * `ok` is the norm and carries no words anywhere in the interface. `remote`
 * is not a warning: it is the ordinary condition of a federated room, and it
 * exists so a person can see the shape of a conversation without reading
 * anything. `suspect` is the only state that earns a text line.
 */
export type TrustTone = 'ok' | 'remote' | 'suspect'

/**
 * The part of an event this module needs.
 *
 * Deliberately structural rather than the full `Message`, so a member row, a
 * palette result and a voice peer can all be judged by the same function
 * without inventing a message around themselves.
 */
export interface TrustableEvent {
  /** The sender's Matrix user id, `@local:server`. */
  sender: string | null | undefined
  /** True when Matrix received the event but could not decrypt its content. */
  undecryptable?: boolean
  /**
   * Whether the sending device is verified.
   *
   * `undefined` means unknown, which is not the same as unverified. Most rooms
   * cannot answer this per event, and treating "we did not check" as "it failed"
   * would paint the whole timeline vermilion and make the state meaningless.
   */
  deviceVerified?: boolean
}

/**
 * The homeserver a Matrix user id lives on, lowercased, or null.
 *
 * A port is kept: `lantern.dev:8448` and `lantern.dev` are different
 * homeservers and comparing them equal would silently drop a ring.
 */
export function serverName(userId: string | null | undefined): string | null {
  if (!userId) return null
  const separator = userId.indexOf(':')
  if (separator < 0) return null
  return userId.slice(separator + 1).trim().toLowerCase() || null
}

/**
 * Whether `userId` lives on the same homeserver as `ownUserId`.
 *
 * Fails closed. An id neither side can parse resolves to `remote`, because a
 * missing ring is a claim ("this person is on your server") while an extra ring
 * is only a prompt to look closer.
 */
export function serverRelation(
  userId: string | null | undefined,
  ownUserId: string | null | undefined,
): ServerRelation {
  const theirs = serverName(userId)
  const ours = serverName(ownUserId)
  if (!theirs || !ours) return 'remote'
  return theirs === ours ? 'local' : 'remote'
}

/**
 * The tone the trust rail takes for one event.
 *
 * Suspicion outranks origin: an undecryptable event from your own homeserver is
 * still the more urgent of the two facts, and losing it to a domain comparison
 * that happened to match is exactly the failure this ordering prevents.
 */
export function eventTrust(
  event: TrustableEvent,
  ownUserId: string | null | undefined,
): TrustTone {
  if (event.undecryptable) return 'suspect'
  if (event.deviceVerified === false) return 'suspect'
  return serverRelation(event.sender, ownUserId) === 'local' ? 'ok' : 'remote'
}

/**
 * The rail's accessible name.
 *
 * The rail is a colour, and colour is never the only channel, so every rail
 * carries this sentence and pairs it with the hover tooltip that holds the
 * event id, the origin server and the key state.
 */
export function trustRailLabel(tone: TrustTone, server: string | null): string {
  if (tone === 'suspect') return 'Could not verify this message'
  if (tone === 'remote') {
    return server ? `Encrypted, from another server, ${server}` : 'Encrypted, from another server'
  }
  return server ? `Encrypted, from ${server}, verified device` : 'Encrypted, verified device'
}

/**
 * How many distinct homeservers carry a set of participants.
 *
 * This is the number in the conversation's ambient line ("Encrypted, 3 servers
 * carry this room"), and it counts servers rather than people so the caption
 * does not change every time somebody joins from a server already present.
 */
export function serverReach(userIds: readonly (string | null | undefined)[]): number {
  const servers = new Set<string>()
  for (const userId of userIds) {
    const server = serverName(userId)
    if (server) servers.add(server)
  }
  return servers.size
}
