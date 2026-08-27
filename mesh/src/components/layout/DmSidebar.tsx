import { memo, useEffect, useCallback, useMemo, useRef, useState } from 'react'
import { useDmStore } from '../../store/dms'
import * as bridge from '../../lib/bridge'
import { formatShortDate } from '../../lib/message-time'
import { Avatar } from '../ui/Avatar'
import { AmbientCard } from '../ui/Primitives'
import { serverName, serverRelation } from '../../lib/trust'
import { UserPanel } from './UserPanel'
import { registerPoll } from '../../lib/scheduler'
import { ScopedErrorBoundary } from '../ui/ScopedErrorBoundary'
import { Icon } from '../ui/Icon'
import { EmptyState } from '../ui/Primitives'
import { useVirtualScroll, type VirtualItem } from '../../hooks/useVirtualScroll'
import { useMeshNavigationStore } from '../../store/navigation'
import { AsyncStatus } from '../ui/AsyncStatus'
import { Button } from '../ui/Button'
import { openPeopleCommandPalette } from '../../lib/command-palette'
import { describeError, errorLine } from '../../lib/errors'
import { Modal } from '../ui/Modal'
import { disposeSubscription } from '../../lib/subscription-cleanup'
import type { DmConversation } from '../../types/ipc'
import { dmPrimaryPeer } from '../../types/ipc'

export const DM_CONVERSATION_ROW_HEIGHT = 64
export const dmSidebarRenderMetrics = {
  rows: 0,
  reset() { this.rows = 0 },
  record() { this.rows += 1 },
}

export function DmSidebar() {
  const conversations = useDmStore((state) => state.conversations)
  const activeConversationId = useDmStore((state) => state.activeConversationId)
  const setActiveConversation = useDmStore((state) => state.setActiveConversation)
  const setDmMode = useDmStore((state) => state.setDmMode)
  const navigate = useMeshNavigationStore((state) => state.navigate)
  const messagesByConversation = useDmStore((state) => state.messages)
  const loadConversations = useDmStore((state) => state.loadConversations)
  const conversationLoad = useDmStore((state) => state.conversationLoad)
  const requests = useDmStore((state) => state.requests)
  const requestLoad = useDmStore((state) => state.requestLoad)
  const loadRequests = useDmStore((state) => state.loadRequests)
  const removeRequest = useDmStore((state) => state.removeRequest)
  const blockedAccounts = useDmStore((state) => state.blockedAccounts)
  const blockedAccountsNextCursor = useDmStore((state) => state.blockedAccountsNextCursor)
  const blockedAccountLoad = useDmStore((state) => state.blockedAccountLoad)
  const loadBlockedAccounts = useDmStore((state) => state.loadBlockedAccounts)
  const upsertBlockedAccount = useDmStore((state) => state.upsertBlockedAccount)
  const removeBlockedAccount = useDmStore((state) => state.removeBlockedAccount)
  const upsertConversation = useDmStore((state) => state.upsertConversation)
  const matrixMode = bridge.isMatrixBackend()
  const [query, setQuery] = useState('')
  const [requestsExpanded, setRequestsExpanded] = useState(false)
  const [blockedExpanded, setBlockedExpanded] = useState(false)
  const [activeRequestId, setActiveRequestId] = useState<string | null>(null)
  const [pendingBlockRequest, setPendingBlockRequest] = useState<{
    roomId: string
    inviterDisplayName: string
    inviterUserId: string
  } | null>(null)
  const [activeBlockedUserId, setActiveBlockedUserId] = useState<string | null>(null)
  const [requestError, setRequestError] = useState<{ roomId: string; message: string } | null>(null)
  const [blockedAccountError, setBlockedAccountError] = useState<{
    userId: string
    message: string
  } | null>(null)
  const [requestAnnouncement, setRequestAnnouncement] = useState('')
  const requestsHeadingRef = useRef<HTMLButtonElement>(null)
  const blockedHeadingRef = useRef<HTMLButtonElement>(null)
  const filteredConversations = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase()
    if (!normalizedQuery) return conversations
    return conversations.filter((conversation) => {
      const name = dmPrimaryPeer(conversation).displayName || dmPrimaryPeer(conversation).userId
      return name.toLocaleLowerCase().includes(normalizedQuery)
    })
  }, [conversations, query])
  const virtualItems = useMemo<VirtualItem[]>(() => filteredConversations.map((conversation) => ({
    key: conversation.id,
    type: 'message',
    height: DM_CONVERSATION_ROW_HEIGHT,
  })), [filteredConversations])
  const {
    scrollContainerRef,
    topSpacerHeight,
    bottomSpacerHeight,
    visibleRange,
    handleScroll,
    resetLayout,
  } = useVirtualScroll(virtualItems, {
    estimatedMessageHeight: DM_CONVERSATION_ROW_HEIGHT,
    overscanPx: 500,
    // A conversation list reads top down, so it must not pin to the newest
    // row the way a message timeline does. Without this the list opens on the
    // last conversation, and every poll refresh or search keystroke that calls
    // resetLayout re-pins it to the bottom.
    autoScrollToBottom: false,
  })
  const visibleConversations = useMemo(
    () => filteredConversations.length === 0
      ? []
      : filteredConversations.slice(visibleRange.start, visibleRange.end + 1),
    [filteredConversations, visibleRange.end, visibleRange.start],
  )
  const ownUserId = bridge.isMatrixBackend() ? bridge.getMatrixUserId() : null
  /*
    Whether the legend has anything to explain. Read from the same derivation
    the rings use, so the sentence cannot appear on a list with no rings and
    cannot be missing from one that has them.
  */
  const hasRemotePeers = useMemo(
    () => matrixMode && filteredConversations.some(
      (conversation) => serverRelation(dmPrimaryPeer(conversation).userId, ownUserId) === 'remote',
    ),
    [filteredConversations, matrixMode, ownUserId],
  )

  useEffect(() => {
    resetLayout()
  }, [query, resetLayout])

  useEffect(() => {
    if (bridge.isMatrixBackend()) {
      void loadBlockedAccounts().catch(() => {})
      let active = true
      const unregisterPoll = registerPoll({
        key: 'matrix-dm-conversations',
        intervalMs: 5_000,
        run: async () => {
          if (active) await Promise.all([loadConversations(), loadRequests()])
        },
        pauseWhenHidden: true,
        backoffOnError: true,
      })
      return () => {
        active = false
        unregisterPoll()
      }
    }
    void loadConversations().catch(() => {})
  }, [loadBlockedAccounts, loadConversations, loadRequests])

  useEffect(() => {
    const unsub = bridge.onDmReceived((_msg) => {
      void Promise.all([loadConversations(), loadRequests()]).catch(() => {})
    })
    return () => disposeSubscription(unsub, 'direct-message sidebar listener')
  }, [loadConversations, loadRequests])

  const handleSelect = useCallback(async (conversationId: string) => {
    setDmMode(true)
    setActiveConversation(conversationId)
    navigate({ kind: 'direct', conversationId })
  }, [navigate, setActiveConversation, setDmMode])

  const startConversation = useCallback(() => {
    openPeopleCommandPalette()
  }, [])

  const acceptRequest = useCallback(async (roomId: string) => {
    setActiveRequestId(roomId)
    setRequestError(null)
    try {
      const conversation = await bridge.acceptDmRequest(roomId)
      removeRequest(roomId)
      upsertConversation(conversation)
      setRequestAnnouncement(`You can now message ${dmPrimaryPeer(conversation).displayName}.`)
      await handleSelect(conversation.id)
    } catch (error) {
      const description = describeError(error, { operation: 'accept this message request' })
      setRequestError({ roomId, message: errorLine(description) })
    } finally {
      setActiveRequestId(null)
    }
  }, [handleSelect, removeRequest, upsertConversation])

  const declineRequest = useCallback(async (roomId: string) => {
    setActiveRequestId(roomId)
    setRequestError(null)
    try {
      await bridge.declineDmRequest(roomId)
      removeRequest(roomId)
      setRequestAnnouncement('Message request deleted. This account can request again.')
      window.requestAnimationFrame(() => requestsHeadingRef.current?.focus())
    } catch (error) {
      const description = describeError(error, { operation: 'delete this message request' })
      setRequestError({ roomId, message: errorLine(description) })
    } finally {
      setActiveRequestId(null)
    }
  }, [removeRequest])

  const blockRequest = useCallback(async (request: NonNullable<typeof pendingBlockRequest>) => {
    setActiveRequestId(request.roomId)
    setRequestError(null)
    try {
      const account = await bridge.blockDmRequest(request.roomId)
      removeRequest(request.roomId)
      upsertBlockedAccount(account)
      setBlockedExpanded(true)
      setRequestAnnouncement(
        'Account blocked. Its messages and new requests are ignored until you unblock it.',
      )
      window.requestAnimationFrame(() => blockedHeadingRef.current?.focus())
    } catch (error) {
      const description = describeError(error, { operation: 'block this account' })
      setRequestError({
        roomId: request.roomId,
        message: errorLine(description),
      })
    } finally {
      setActiveRequestId(null)
      setPendingBlockRequest(null)
    }
  }, [removeRequest, upsertBlockedAccount])

  const unblockAccount = useCallback(async (userId: string) => {
    setActiveBlockedUserId(userId)
    setBlockedAccountError(null)
    try {
      await bridge.matrixSetDmBlocked(userId, false)
      removeBlockedAccount(userId)
      setRequestAnnouncement(
        'Account unblocked. A message request that was already waiting may appear again.',
      )
      try {
        await loadRequests()
      } catch {
        setRequestAnnouncement(
          'Account unblocked. Message requests could not be refreshed yet.',
        )
      }
    } catch (error) {
      const description = describeError(error, { operation: 'unblock this account' })
      setBlockedAccountError({ userId, message: errorLine(description) })
    } finally {
      setActiveBlockedUserId(null)
    }
  }, [loadRequests, removeBlockedAccount])

  return (
    <div className="mesh-dm-sidebar flex h-full flex-col">
      {/* Header */}
      <div className="mesh-dm-header flex min-h-conversation-header flex-shrink-0 items-center gap-3 border-b border-outline-variant bg-surface-container-low px-3 py-2">
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-body-lg font-semibold text-on-surface">Messages</h2>
        </div>
        <button
          type="button"
          aria-label="Find someone to message"
          className="flex min-h-9 flex-shrink-0 items-center gap-1.5 rounded-full border border-primary-container-line bg-primary-container px-2.5 text-label-sm font-semibold text-on-primary-container transition-colors hover:border-outline hover:bg-state-hover"
          onClick={startConversation}
        >
          <Icon name="squarePen" size="sm" />
          New
        </button>
      </div>

      <div className="sr-only" aria-live="polite">{requestAnnouncement}</div>
      {(requests.length > 0
        || requestLoad.status === 'failed'
        || (requestsExpanded && requestAnnouncement.length > 0)) && (
        <section className="border-b border-outline-variant px-2 py-2" aria-labelledby="dm-requests-heading">
          <button
            ref={requestsHeadingRef}
            id="dm-requests-heading"
            type="button"
            className="flex min-h-10 w-full items-center gap-2 rounded-full px-2 text-left text-body-md font-semibold text-on-surface hover:bg-state-hover"
            aria-expanded={requestsExpanded}
            aria-controls="dm-request-list"
            onClick={() => setRequestsExpanded((expanded) => !expanded)}
          >
            <Icon name="messageCircle" size="sm" />
            <span>Message requests</span>
            {requests.length > 0 && (
              <span className="badge-count ml-auto flex h-5 min-w-5 items-center justify-center rounded-round bg-primary px-1 text-body-sm font-semibold text-on-primary">
                {requests.length > 99 ? '99+' : requests.length}
              </span>
            )}
          </button>
          {requestsExpanded && (
            <div id="dm-request-list" className="mt-2 space-y-2">
              <p className="px-2 text-label-sm text-on-surface-variant">
                People you haven&apos;t chatted with yet. Messages stay out of your inbox until you accept.
              </p>
              {requestLoad.status === 'failed' && (
                <div role="alert" className="rounded-full border border-marker-container-line bg-marker-container px-3 py-2 text-body-sm text-on-marker-container">
                  <span>Message requests could not be refreshed.</span>{' '}
                  <button
                    type="button"
                    className="min-h-8 rounded-full px-2 font-semibold text-primary hover:bg-state-hover"
                    onClick={() => void loadRequests().catch(() => {})}
                  >
                    Retry
                  </button>
                </div>
              )}
              {requests.length > 0 && (
                <div role="list" aria-label="Message requests" className="space-y-2">
                  {requests.map((request) => {
                    const saving = activeRequestId === request.roomId
                    const actionError = requestError?.roomId === request.roomId
                      ? requestError.message
                      : null
                    return (
                      <div
                        key={request.roomId}
                        role="listitem"
                        aria-busy={saving || undefined}
                        className="rounded-md border border-outline bg-surface-container-lowest p-3"
                      >
                        <div className="flex items-center gap-2.5">
                          <Avatar
                            color={request.inviterAvatarColor}
                            size={36}
                            name={request.inviterDisplayName}
                          />
                          <div className="min-w-0 flex-1">
                            <p className="truncate text-body-md font-semibold text-on-surface">
                              {request.inviterDisplayName} wants to message you
                            </p>
                            <p className="text-label-sm text-on-surface-variant">
                              You haven&apos;t chatted with this person before.
                            </p>
                          </div>
                        </div>
                        <p className="mt-2 text-label-sm text-on-surface-variant">
                          {request.canAccept
                            ? 'Only accept if you recognize them. Mesh never asks for your backup code or sign-in code.'
                            : 'Mesh couldn\'t verify this private conversation yet.'}
                        </p>
                        <details className="mt-1 text-label-sm text-on-surface-variant">
                          <summary className="cursor-pointer min-h-7 py-1">Show account address</summary>
                          <code className="block break-all rounded-full bg-surface px-2 py-1 text-on-surface-variant">
                            {request.inviterUserId}
                          </code>
                        </details>
                        <div className="mt-2 flex flex-wrap gap-2">
                          {request.canAccept && (
                            <Button
                              size="sm"
                              onClick={() => void acceptRequest(request.roomId)}
                              disabled={saving}
                            >
                              {saving ? 'Saving…' : 'Accept'}
                            </Button>
                          )}
                          <Button
                            size="sm"
                            variant="secondary"
                            onClick={() => void declineRequest(request.roomId)}
                            disabled={saving}
                          >
                            Delete request
                          </Button>
                          <Button
                            size="sm"
                            variant="soft"
                            tone="danger"
                            onClick={() => setPendingBlockRequest({
                              roomId: request.roomId,
                              inviterDisplayName: request.inviterDisplayName,
                              inviterUserId: request.inviterUserId,
                            })}
                            disabled={saving}
                          >
                            Block account
                          </Button>
                        </div>
                        {actionError && (
                          <p role="alert" className="mt-2 text-label-sm text-error">
                            {actionError}
                          </p>
                        )}
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          )}
        </section>
      )}

      {matrixMode && (
        <section className="border-b border-outline-variant px-2 py-2" aria-labelledby="blocked-accounts-heading">
          <button
            ref={blockedHeadingRef}
            id="blocked-accounts-heading"
            type="button"
            className="flex min-h-10 w-full items-center gap-2 rounded-full px-2 text-left text-body-md font-semibold text-on-surface hover:bg-state-hover"
            aria-expanded={blockedExpanded}
            aria-controls="blocked-account-list"
            onClick={() => {
              const nextExpanded = !blockedExpanded
              setBlockedExpanded(nextExpanded)
              if (nextExpanded) void loadBlockedAccounts().catch(() => {})
            }}
          >
            <Icon name="shieldCheck" size="sm" />
            <span>Blocked accounts</span>
            {blockedAccounts.length > 0 && (
              <span className="badge-count ml-auto flex h-5 min-w-5 items-center justify-center rounded-round bg-surface-container-highest px-1 text-body-sm font-semibold text-on-surface-variant">
                {blockedAccounts.length}{blockedAccountsNextCursor ? '+' : ''}
              </span>
            )}
          </button>
          {blockedExpanded && (
            <div id="blocked-account-list" className="mt-2 space-y-2">
              <p className="px-2 text-label-sm text-on-surface-variant">
                Their messages and new requests are ignored.
              </p>
              {blockedAccountLoad.status === 'failed' && (
                <div role="alert" className="rounded-full border border-marker-container-line bg-marker-container px-3 py-2 text-body-sm text-on-marker-container">
                  <span>Blocked accounts could not be refreshed.</span>{' '}
                  <button
                    type="button"
                    className="min-h-8 rounded-full px-2 font-semibold text-primary hover:bg-state-hover"
                    onClick={() => void loadBlockedAccounts().catch(() => {})}
                  >
                    Retry
                  </button>
                </div>
              )}
              {blockedAccounts.length > 0 && (
                <div role="list" aria-label="Blocked accounts" className="space-y-2">
                  {blockedAccounts.map((account) => {
                    const saving = activeBlockedUserId === account.userId
                    const actionError = blockedAccountError?.userId === account.userId
                      ? blockedAccountError.message
                      : null
                    return (
                      <div
                        key={account.userId}
                        role="listitem"
                        aria-busy={saving || undefined}
                        className="rounded-md border border-outline bg-surface-container-lowest p-3"
                      >
                        <code className="block break-all text-label-sm text-on-surface-variant">
                          {account.userId}
                        </code>
                        <Button
                          className="mt-2"
                          size="sm"
                          variant="secondary"
                          onClick={() => void unblockAccount(account.userId)}
                          disabled={saving}
                        >
                          {saving ? 'Unblocking…' : 'Unblock'}
                        </Button>
                        {actionError && (
                          <p role="alert" className="mt-2 text-label-sm text-error">
                            {actionError}
                          </p>
                        )}
                      </div>
                    )
                  })}
                </div>
              )}
              {blockedAccounts.length === 0
              && blockedAccountLoad.status === 'loaded' && (
                <p className="px-2 text-label-sm text-on-surface-variant">Block an account from a direct message to manage it here.</p>
              )}
              {blockedAccountsNextCursor && (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => void loadBlockedAccounts(false).catch(() => {})}
                  disabled={blockedAccountLoad.status === 'refreshing'}
                >
                  {blockedAccountLoad.status === 'refreshing' ? 'Loading…' : 'Load more'}
                </Button>
              )}
            </div>
          )}
        </section>
      )}

      <Modal
        open={pendingBlockRequest !== null}
        onClose={() => {
          if (!activeRequestId) setPendingBlockRequest(null)
        }}
        title={pendingBlockRequest
          ? `Block ${pendingBlockRequest.inviterDisplayName}?`
          : 'Block account?'}
        description="Mesh will ignore this account's messages and new message requests until you unblock it."
        size="sm"
        closeLabel="Keep message request"
      >
        {pendingBlockRequest && (
          <>
            <p className="text-body-md text-on-surface-variant">
              Confirm the account address before blocking:
            </p>
            <code className="mt-2 block break-all rounded-full bg-surface-container-lowest px-3 py-2 text-label-sm text-on-surface-variant">
              {pendingBlockRequest.inviterUserId}
            </code>
            <div className="mt-4 flex flex-wrap justify-end gap-2">
              <Button
                variant="ghost"
                onClick={() => setPendingBlockRequest(null)}
                disabled={activeRequestId !== null}
              >
                Keep request
              </Button>
              <Button
                tone="danger"
                onClick={() => void blockRequest(pendingBlockRequest)}
                disabled={activeRequestId !== null}
              >
                {activeRequestId ? 'Blocking…' : `Block ${pendingBlockRequest.inviterDisplayName}`}
              </Button>
            </div>
          </>
        )}
      </Modal>

      {/* Conversation search */}
      <div className="mesh-dm-search-region px-4 py-2">
        <label className="sr-only" htmlFor="dm-search">Find a conversation</label>
        <div className="mesh-dm-search-shell flex min-h-control-lg items-center gap-3 rounded-xl bg-surface-container-high px-4 focus-within:outline focus-within:outline-2 focus-within:outline-focus">
          <Icon
            name="search"
            size="sm"
            className="flex-shrink-0 text-on-surface-variant"
          />
          <input
            id="dm-search"
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Find a conversation"
            className="mesh-dm-search min-w-0 flex-1 bg-transparent text-body-lg text-on-surface outline-none placeholder:text-on-surface-variant"
          />
        </div>
      </div>

      {/* Conversation list */}
      <div
        ref={scrollContainerRef}
        onScroll={() => void handleScroll()}
        className="mesh-dm-list flex-1 overflow-y-auto"
        role="list"
        aria-label="Direct message conversations"
      >
        {(conversationLoad.status === 'idle' || conversationLoad.status === 'loading')
        && conversations.length === 0 ? (
          <AsyncStatus
            compact
            title="Bringing in your conversations"
            detail="You can keep using your current room while private conversations arrive."
          />
        ) : conversationLoad.status === 'failed' && conversations.length === 0 ? (
          <div
            role="alert"
            className="rounded-lg-inc border border-marker-container-line bg-marker-container px-3 py-3 text-body-sm text-on-marker-container"
          >
            <p>Conversations could not be loaded.</p>
            <button
              type="button"
              className="mt-2 min-h-8 rounded-full px-2 font-semibold text-primary hover:bg-state-hover"
              onClick={() => void loadConversations().catch(() => {})}
            >
              Retry conversations
            </button>
          </div>
        ) : filteredConversations.length === 0 ? (
          <EmptyState
            variant="compact"
            icon={<Icon name={conversations.length === 0 ? 'messageCircle' : 'search'} size="lg" />}
            title={conversations.length === 0 ? 'Start a direct message' : 'Try another conversation search'}
            description={
              conversations.length === 0
                ? 'Start a private conversation when you need one.'
                : 'Try another name or account address.'
            }
            action={conversations.length === 0 ? (
              <Button size="sm" variant="secondary" onClick={startConversation}>
                New conversation
              </Button>
            ) : undefined}
          />
        ) : (
          <div
            data-design-token-exception="data-driven-virtual-spacer-geometry"
            style={{
              paddingTop: `${topSpacerHeight}px`,
              paddingBottom: `${bottomSpacerHeight}px`,
            }}
          >
            {visibleConversations.map((conversation) => {
              const conversationMessages = messagesByConversation[conversation.id] ?? []
              const latestMessage = conversationMessages[conversationMessages.length - 1]

              return (
                <DmConversationRow
                  key={conversation.id}
                  conversation={conversation}
                  active={conversation.id === activeConversationId}
                  latestContent={latestMessage?.content ?? null}
                  matrixMode={matrixMode}
                  /*
                    The list virtualises, so the row's position is its offset
                    into the whole conversation list, not into the visible
                    slice. A number that renumbered on scroll would be worse
                    than no number.
                  */
                  ownUserId={ownUserId}
                  onSelect={handleSelect}
                />
              )
            })}
          </div>
        )}
      </div>
      {conversationLoad.status === 'failed' && conversations.length > 0 && (
        <div
          role="alert"
          className="mx-2 mb-2 rounded-full border border-marker-container-line bg-marker-container px-2 py-2 text-body-sm text-on-marker-container"
        >
          <span>Could not refresh conversations. Showing the last update.</span>{' '}
          <button
            type="button"
            className="min-h-8 rounded-full px-2 font-semibold text-primary hover:bg-state-hover"
            onClick={() => void loadConversations().catch(() => {})}
          >
            Retry
          </button>
        </div>
      )}
      {/*
        Every surface that draws rings owes this line. It is the DM hub's one
        ambient caption, and it doubles as the encryption statement so the
        screen still says only one thing.
      */}
      {hasRemotePeers && (
        <AmbientCard>
          Ringed marks are on another server · every conversation here is encrypted
        </AmbientCard>
      )}
      <ScopedErrorBoundary
        name="User controls"
        description="Account controls could not be displayed."
        className="m-2"
      >
        <UserPanel />
      </ScopedErrorBoundary>
    </div>
  )
}

const DmConversationRow = memo(function DmConversationRow({
  conversation,
  active,
  latestContent,
  matrixMode,
  ownUserId,
  onSelect,
}: {
  conversation: DmConversation
  active: boolean
  latestContent: string | null
  matrixMode: boolean
  ownUserId: string | null
  onSelect: (conversationId: string) => Promise<void>
}) {
  if (import.meta.env.DEV) dmSidebarRenderMetrics.record()
  const peer = dmPrimaryPeer(conversation)
  const shortName = peer.displayName || peer.userId.slice(0, 8)
  /*
    This list has no gutter to carry a rail, so the ring is the whole of what
    says "another homeserver" here. It reads the same derivation the timeline
    rail reads, and the footer legend on the list explains it in words.

    Gated on Matrix mode. serverRelation fails closed, which is right when the
    question is meaningful and wrong when it is not: the legacy backend has no
    homeservers to be on either side of, so every mark would be ringed and the
    ring would stop saying anything.
  */
  const isRemotePeer = matrixMode && serverRelation(peer.userId, ownUserId) === 'remote'

  return (
    <div role="listitem">
      <button
        onClick={() => void onSelect(conversation.id)}
        /*
          A Material 3 two-line list item: 72px, a 40px mark, a title-medium
          headline and the last message as supporting text under it. Selected is
          the secondary container plus aria-current, the same pill the room list
          uses, so a person moving between the two lists reads one selection.
        */
        className={`mesh-dm-item group flex min-h-shell-occupant w-full items-center gap-4 rounded-xl px-4 py-2 text-left transition-colors ${
          active
            ? 'bg-secondary-container text-on-secondary-container'
            : 'text-on-surface-variant hover:bg-state-hover hover:text-on-surface'
        }`}
        aria-label={`Direct message with ${shortName}${isRemotePeer ? `, on ${serverName(peer.userId)}` : ''}${conversation.unreadCount > 0
          ? `, ${conversation.unreadCount} unread ${conversation.unreadCount === 1 ? 'message' : 'messages'}`
          : ''}`}
        aria-current={active ? 'page' : undefined}
      >
        <Avatar
          color={peer.avatarColor}
          size={40}
          name={shortName}
          imageUrl={peer.avatarUrl}
          className={isRemotePeer ? 'mesh-remote-mark' : undefined}
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-title-md font-medium">{shortName}</span>
            {conversation.lastMessageAt && (
              <span className={`tnum ml-auto flex-shrink-0 text-label-sm ${
                active ? 'text-on-secondary-container' : 'text-on-surface-variant'
              }`}>
                {formatShortDate(conversation.lastMessageAt)}
              </span>
            )}
            {conversation.unreadCount > 0 && !active && (
              <span className="badge-count flex h-4 min-w-4 flex-shrink-0 items-center justify-center rounded-full bg-surface-container-highest px-1 text-label-sm text-on-surface">
                {conversation.unreadCount > 99 ? '99+' : conversation.unreadCount}
              </span>
            )}
          </div>
          {/*
            A preview only when there is one. The fallback under every name read
            "Private conversation", which is what the whole surface is, so it
            named no conversation in particular. The row is avatar-bound at
            72px either way, so a conversation with nothing loaded yet
            keeps the same height as one with a preview.
          */}
          {latestContent && (
            <span className={`block truncate text-body-sm ${
              active ? 'text-on-secondary-container' : 'text-on-surface-variant'
            }`}>
              {latestContent}
            </span>
          )}
        </div>
      </button>
    </div>
  )
})
