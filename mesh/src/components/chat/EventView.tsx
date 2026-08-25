import { Avatar } from '../ui/Avatar'
import { EmptyState } from '../ui/Primitives'
import { MessageTime } from './MessageTime'
import { RSVP_REPLIES, type Rsvp, type RsvpReplyId } from '../../lib/room-shape'
import { pixelColorForSeed } from '../ui/PixelMark'

export interface EventPlan {
  id: string
  authorDisplayName: string
  content: string
  timestamp: string
}

/**
 * A room read as a plan rather than a transcript.
 *
 * Some rooms exist to answer one question the transcript buries: who is
 * coming. This surface pulls that answer to the top and leaves everything else
 * exactly as it was. The plan is the room's pinned message, and the replies are
 * reactions on it, so nothing here is a new kind of object: somebody reading
 * the same room as a conversation sees a pinned plan with ticks on it, which is
 * what a group does by hand anyway.
 */
export function EventView({
  roomId,
  channelName,
  plan,
  rsvp,
  memberNames,
  myUserId,
  onReply,
  onOpenPlan,
}: {
  roomId: string
  channelName: string
  /** The room's pinned message. Without one there is no plan to answer. */
  plan: EventPlan | null
  rsvp: Rsvp
  /** User id to display name, for naming who replied rather than counting them. */
  memberNames: Record<string, string>
  myUserId: string | null
  onReply: (reply: RsvpReplyId) => void
  onOpenPlan: (messageId: string) => void
}) {
  if (!plan) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center p-6">
        <EmptyState
          className="w-full max-w-2xl"
          eyebrow={`#${channelName}`}
          markSeed={roomId}
          title="No plan pinned"
          description="Pin a message to make it the plan."
        />
      </div>
    )
  }

  const mine = RSVP_REPLIES.find((reply) => (
    myUserId !== null && rsvp[reply.id].includes(myUserId)
  ))

  return (
    <div
      className="min-h-0 flex-1 overflow-y-auto px-4 py-5 sm:px-6"
      aria-label={`Plan for #${channelName}`}
    >
      <div className="mx-auto w-full max-w-measure">
        <p className="font-mono text-caption font-semibold lowercase tracking-eyebrow text-content-secondary">
          the plan
        </p>
        {/*
          The room name is the poster, not the plan. A name is short and never
          wraps; the plan is somebody's sentence, of no known length, and
          setting that at poster scale would make the loudest thing on the
          surface a fragment.
        */}
        <h2
          data-event-name
          className="mt-1 border-b-bar border-border-strong pb-2 text-display font-display text-primary"
        >
          #{channelName}
        </h2>

        <p data-event-plan className="mt-4 whitespace-pre-wrap text-lg text-primary">
          {plan.content}
        </p>

        <p className="mt-2 flex flex-wrap items-center gap-2 font-mono text-meta text-muted">
          <span>{plan.authorDisplayName}</span>
          <span aria-hidden="true">·</span>
          <MessageTime value={plan.timestamp} variant="full" />
          <span aria-hidden="true">·</span>
          <button
            type="button"
            data-event-open-plan
            onClick={() => onOpenPlan(plan.id)}
            className="rounded-panel text-content-link underline underline-offset-2 hover:text-content focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus"
          >
            Open in the conversation
          </button>
        </p>

        <div
          role="group"
          aria-label="Your reply"
          className="mt-6 flex flex-wrap items-center gap-2"
        >
          {RSVP_REPLIES.map((reply) => {
            const chosen = mine?.id === reply.id
            return (
              <button
                key={reply.id}
                type="button"
                aria-pressed={chosen}
                onClick={() => onReply(reply.id)}
                /*
                  The chosen reply is marked by a bar and a fill, never by
                  colour alone: `aria-pressed` names it, the leading bar shows
                  it without hue, and the fill is the third cue.
                */
                className={`flex min-h-9 items-center gap-2 rounded-panel border border-border-control px-3 text-sm font-medium transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus ${
                  chosen
                    ? 'border-l-bar border-l-accent bg-surface-selected text-primary'
                    : 'border-l-bar border-l-transparent text-secondary hover:bg-surface-hover hover:text-primary'
                }`}
              >
                <span aria-hidden="true">{reply.emoji}</span>
                <span>{reply.label}</span>
                <span className="font-mono text-meta text-muted">{rsvp[reply.id].length}</span>
              </button>
            )
          })}
        </div>

        {rsvp.total > 0 && (
          <div data-event-roster className="mt-6 border-t border-border-subtle pt-4">
            {RSVP_REPLIES.filter((reply) => rsvp[reply.id].length > 0).map((reply) => (
              <section key={reply.id} className="mb-4 last:mb-0">
                <h3 className="font-mono text-caption font-semibold lowercase tracking-eyebrow text-content-secondary">
                  {reply.label} · {rsvp[reply.id].length}
                </h3>
                <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-2">
                  {rsvp[reply.id].map((userId) => (
                    <li key={userId} className="flex min-w-0 items-center gap-2">
                      <Avatar
                        color={pixelColorForSeed(userId)}
                        seed={userId}
                        size={24}
                        name={memberNames[userId] ?? userId}
                      />
                      <span className="truncate text-sm text-secondary">
                        {memberNames[userId] ?? userId}
                      </span>
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
