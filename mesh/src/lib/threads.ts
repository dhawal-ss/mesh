export interface ThreadableMessage {
  id: string
  threadRootId?: string | null
}

export interface ThreadMessageGroups<T extends ThreadableMessage> {
  visibleMessages: T[]
  repliesByRoot: Map<string, T[]>
}

/**
 * Keep thread replies out of the main room stream when their root is present.
 * If a bounded history window does not contain the root, retain the reply in
 * the main stream so the user never loses a message just because its root is
 * outside the loaded window.
 */
export function groupThreadReplies<T extends ThreadableMessage>(
  messages: readonly T[],
): ThreadMessageGroups<T> {
  const rootIds = new Set(messages.map((message) => message.id))
  const repliesByRoot = new Map<string, T[]>()

  for (const message of messages) {
    const rootId = message.threadRootId
    if (!rootId) continue
    const replies = repliesByRoot.get(rootId) ?? []
    replies.push(message)
    repliesByRoot.set(rootId, replies)
  }

  return {
    visibleMessages: messages.filter((message) => (
      !message.threadRootId || !rootIds.has(message.threadRootId)
    )),
    repliesByRoot,
  }
}
