import { useEffect, useCallback, useMemo, useRef, useState } from 'react'
import { useDmStore } from '../../store/dms'
import * as bridge from '../../lib/bridge'
import { format } from 'date-fns'
import { Avatar } from '../ui/Avatar'
import { UserPanel } from './UserPanel'
import { registerPoll } from '../../lib/scheduler'
import { ScopedErrorBoundary } from '../ui/ScopedErrorBoundary'
import { Icon } from '../ui/Icon'
import { useIdentityStore } from '../../store/identity'
import { EmptyState } from '../ui/Primitives'
import { useVirtualScroll, type VirtualItem } from '../../hooks/useVirtualScroll'
import { identityLabel } from '../../lib/notifications'
import { useMeshNavigationStore } from '../../store/navigation'
import { AsyncStatus } from '../ui/AsyncStatus'
import { Button } from '../ui/Button'
import { openPeopleCommandPalette } from '../../lib/command-palette'
import { describeError } from '../../lib/errors'
import { Modal } from '../ui/Modal'

export const DM_CONVERSATION_ROW_HEIGHT = 64

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
  const storedIdentity = useIdentityStore((state) => state.identity)
  const matrixMode = bridge.isMatrixBackend()
  const currentIdentityLabel = identityLabel(storedIdentity, matrixMode)
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
      const name = conversation.peerDisplayName || conversation.peerPublicKey
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
  })
  const visibleConversations = useMemo(
    () => filteredConversations.length === 0
      ? []
      : filteredConversations.slice(visibleRange.start, visibleRange.end + 1),
    [filteredConversations, visibleRange.end, visibleRange.start],
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
    return () => { unsub.then((fn) => fn()) }
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
      setRequestAnnouncement(`You can now message ${conversation.peerDisplayName}.`)
      await handleSelect(conversation.id)
    } catch (error) {
      const description = describeError(error, { operation: 'accept this message request' })
      setRequestError({ roomId, message: `${description.title}. ${description.body}` })
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
      setRequestError({ roomId, message: `${description.title}. ${description.body}` })
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
        message: `${description.title}. ${description.body}`,
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
      setBlockedAccountError({ userId, message: `${description.title}. ${description.body}` })
    } finally {
      setActiveBlockedUserId(null)
    }
  }, [loadRequests, removeBlockedAccount])

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex min-h-conversation-header flex-shrink-0 items-center gap-3 border-b border-border-subtle bg-surface-sidebar px-3 py-2">
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-base font-semibold tracking-tight text-primary">Messages</h2>
          <p className="mt-0.5 truncate text-caption text-muted">
            Private conversations for {currentIdentityLabel}
          </p>
        </div>
        <button
          type="button"
          aria-label="Find someone to message"
          className="flex min-h-9 flex-shrink-0 items-center gap-1.5 rounded-control border border-accent/30 bg-accent/10 px-2.5 text-caption font-semibold text-primary transition-colors hover:border-border-emphasis hover:bg-surface-hover"
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
        <section className="border-b border-border-subtle px-2 py-2" aria-labelledby="dm-requests-heading">
          <button
            ref={requestsHeadingRef}
            id="dm-requests-heading"
            type="button"
            className="flex min-h-10 w-full items-center gap-2 rounded-control px-2 text-left text-sm font-semibold text-primary hover:bg-surface-hover"
            aria-expanded={requestsExpanded}
            aria-controls="dm-request-list"
            onClick={() => setRequestsExpanded((expanded) => !expanded)}
          >
            <Icon name="messageCircle" size="sm" />
            <span>Message requests</span>
            {requests.length > 0 && (
              <span className="badge-count ml-auto flex h-5 min-w-5 items-center justify-center rounded-full bg-accent px-1 text-meta font-semibold text-content-on-accent">
                {requests.length > 99 ? '99+' : requests.length}
              </span>
            )}
          </button>
          {requestsExpanded && (
            <div id="dm-request-list" className="mt-2 space-y-2">
              <p className="px-2 text-caption text-muted">
                People you haven&apos;t chatted with yet. Messages stay out of your inbox until you accept.
              </p>
              {requestLoad.status === 'failed' && (
                <div role="alert" className="rounded-control border border-status-warning/30 bg-status-warning/10 px-3 py-2 text-xs text-secondary">
                  <span>Message requests could not be refreshed.</span>{' '}
                  <button
                    type="button"
                    className="min-h-8 rounded-control px-2 font-semibold text-text-link hover:bg-surface-hover"
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
                        className="rounded-control border border-border bg-surface-sunken p-3"
                      >
                        <div className="flex items-center gap-2.5">
                          <Avatar
                            color={request.inviterAvatarColor}
                            size={36}
                            name={request.inviterDisplayName}
                          />
                          <div className="min-w-0 flex-1">
                            <p className="truncate text-sm font-semibold text-primary">
                              {request.inviterDisplayName} wants to message you
                            </p>
                            <p className="text-caption text-muted">
                              You haven&apos;t chatted with this person before.
                            </p>
                          </div>
                        </div>
                        <p className="mt-2 text-caption text-secondary">
                          {request.canAccept
                            ? 'Only accept if you recognize them. Mesh will never ask for your backup code or sign-in code.'
                            : 'Mesh couldn\'t verify this private conversation yet. Nothing has been accepted.'}
                        </p>
                        <details className="mt-1 text-caption text-muted">
                          <summary className="cursor-pointer min-h-7 py-1">Show account address</summary>
                          <code className="block break-all rounded-control bg-surface-base px-2 py-1 text-secondary">
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
                          <p role="alert" className="mt-2 text-caption text-status-danger">
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
        <section className="border-b border-border-subtle px-2 py-2" aria-labelledby="blocked-accounts-heading">
          <button
            ref={blockedHeadingRef}
            id="blocked-accounts-heading"
            type="button"
            className="flex min-h-10 w-full items-center gap-2 rounded-control px-2 text-left text-sm font-semibold text-primary hover:bg-surface-hover"
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
              <span className="badge-count ml-auto flex h-5 min-w-5 items-center justify-center rounded-full bg-surface-active px-1 text-meta font-semibold text-secondary">
                {blockedAccounts.length}{blockedAccountsNextCursor ? '+' : ''}
              </span>
            )}
          </button>
          {blockedExpanded && (
            <div id="blocked-account-list" className="mt-2 space-y-2">
              <p className="px-2 text-caption text-muted">
                Their messages and new requests are ignored. Unblocking may show a request that was already waiting.
              </p>
              {blockedAccountLoad.status === 'failed' && (
                <div role="alert" className="rounded-control border border-status-warning/30 bg-status-warning/10 px-3 py-2 text-xs text-secondary">
                  <span>Blocked accounts could not be refreshed.</span>{' '}
                  <button
                    type="button"
                    className="min-h-8 rounded-control px-2 font-semibold text-text-link hover:bg-surface-hover"
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
                        className="rounded-control border border-border bg-surface-sunken p-3"
                      >
                        <code className="block break-all text-caption text-secondary">
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
                          <p role="alert" className="mt-2 text-caption text-status-danger">
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
                <p className="px-2 text-caption text-muted">No blocked accounts.</p>
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
            <p className="text-sm text-secondary">
              Confirm the account address before blocking:
            </p>
            <code className="mt-2 block break-all rounded-control bg-surface-sunken px-3 py-2 text-caption text-secondary">
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
      <div className="px-2 py-2.5">
        <label className="sr-only" htmlFor="dm-search">Find a conversation</label>
        <div className="flex min-h-9 items-center gap-2 rounded-control border border-border bg-surface-sunken px-3">
          <Icon
            name="search"
            size="xs"
            className="flex-shrink-0 text-muted"
          />
          <input
            id="dm-search"
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Find a conversation"
            className="mesh-dm-search min-w-0 flex-1 bg-transparent text-xs text-primary placeholder:text-muted"
          />
        </div>
      </div>

      {/* Conversation list */}
      <div
        ref={scrollContainerRef}
        onScroll={() => void handleScroll()}
        className="flex-1 overflow-y-auto px-2"
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
            className="rounded-control border border-status-warning/30 bg-status-warning/10 px-3 py-3 text-xs text-secondary"
          >
            <p>Conversations could not be loaded.</p>
            <button
              type="button"
              className="mt-2 min-h-8 rounded-control px-2 font-semibold text-text-link hover:bg-surface-hover"
              onClick={() => void loadConversations().catch(() => {})}
            >
              Retry conversations
            </button>
          </div>
        ) : filteredConversations.length === 0 ? (
          <EmptyState
            variant="compact"
            icon={<Icon name={conversations.length === 0 ? 'messageCircle' : 'search'} size="lg" />}
            title={conversations.length === 0 ? 'No direct messages yet' : 'No conversations found'}
            description={
              conversations.length === 0
                ? 'Start a private conversation when you need one.'
                : 'Try another name, or a full address like @ashvin:example.org.'
            }
            action={conversations.length === 0 ? (
              <Button size="sm" variant="secondary" onClick={startConversation}>
                New conversation
              </Button>
            ) : undefined}
          />
        ) : (
          <div
            className="space-y-0.5"
            data-design-token-exception="data-driven-virtual-spacer-geometry"
            style={{
              paddingTop: `${topSpacerHeight}px`,
              paddingBottom: `${bottomSpacerHeight}px`,
            }}
          >
            {visibleConversations.map((conv) => {
              const isActive = conv.id === activeConversationId
              const shortName = conv.peerDisplayName || conv.peerPublicKey.slice(0, 8)
              const conversationMessages = messagesByConversation[conv.id] ?? []
              const latestMessage = conversationMessages[conversationMessages.length - 1]

              return (
                <div key={conv.id} role="listitem">
                  <button
                    onClick={() => void handleSelect(conv.id)}
                    className={`mesh-dm-item group flex min-h-14 w-full items-center gap-3 rounded-control border px-2.5 py-2 text-left transition-colors ${
                      isActive
                        ? 'mesh-channel-active text-primary'
                        : 'border-transparent text-muted hover:border-border-subtle hover:bg-surface-hover hover:text-secondary'
                    }`}
                    aria-label={`Direct message with ${shortName}${conv.unreadCount > 0
                      ? `, ${conv.unreadCount} unread ${conv.unreadCount === 1 ? 'message' : 'messages'}`
                      : ''}`}
                    aria-current={isActive ? 'page' : undefined}
                  >
                    <Avatar
                      color={conv.peerAvatarColor}
                      size={40}
                      name={shortName}
                    />

                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="truncate text-sm font-medium">{shortName}</span>
                        {conv.lastMessageAt && (
                          <span className="tnum ml-auto flex-shrink-0 text-meta text-muted">
                            {format(new Date(conv.lastMessageAt), 'MMM d')}
                          </span>
                        )}
                        {conv.unreadCount > 0 && (
                          <span className="badge-count flex h-4 min-w-4 flex-shrink-0 items-center justify-center rounded-full bg-accent px-1 text-meta font-semibold text-content-on-accent">
                            {conv.unreadCount > 99 ? '99+' : conv.unreadCount}
                          </span>
                        )}
                      </div>
                      <span className="block truncate text-caption text-muted">
                        {latestMessage?.content || (matrixMode ? 'Private conversation' : 'Local conversation')}
                      </span>
                    </div>
                  </button>
                </div>
              )
            })}
          </div>
        )}
      </div>
      {conversationLoad.status === 'failed' && conversations.length > 0 && (
        <div
          role="alert"
          className="mx-2 mb-2 rounded-control border border-status-warning/30 bg-status-warning/10 px-2 py-2 text-xs text-secondary"
        >
          <span>Could not refresh conversations. Showing the last update.</span>{' '}
          <button
            type="button"
            className="min-h-8 rounded-control px-2 font-semibold text-text-link hover:bg-surface-hover"
            onClick={() => void loadConversations().catch(() => {})}
          >
            Retry
          </button>
        </div>
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
