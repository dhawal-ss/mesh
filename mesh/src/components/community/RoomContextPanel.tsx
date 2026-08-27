import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import type {
  Channel,
  MatrixPermissionRoomStatus,
  Message,
  ThreadListItemDto,
} from '../../types/ipc'
import type { RoomTrustSnapshot } from '../../hooks/useRoomTrust'
import { useMessageStore } from '../../store/messages'
import { useRoomPinStore } from '../../store/room-pins'
import { useThreadListStore } from '../../store/threads'
import { threadListFocusScopeId } from '../../lib/pane-focus'
import { useMessageNavigationStore } from '../../store/message-navigation'
import { useShellStore } from '../../store/shell'
import { useCommunityStore } from '../../store/communities'
import { useIdentityStore } from '../../store/identity'
import { useCommunityPermissionProjection } from '../../hooks/useCommunityPermissionProjection'
import { copyText, matrixRoomPermalink } from '../../lib/notifications'
import { formatFederatedTimestamp } from '../../lib/federated-time'
import { showToast } from '../ui/Toast'
import { Icon } from '../ui/Icon'
import { SectionLabel } from '../ui/Primitives'
import { MemberList } from './MemberList'
import { RolePermissionPreview, type RolePermissionEvidence } from './RolePermissionPreview'
import { scopeCommunityPermissionProjectionToRoom } from '../../lib/community-permissions'
import { EmptyState } from '../ui/Primitives'
import { Button } from '../ui/Button'
import { Spinner } from '../ui/Spinner'
import { StatusDot } from '../ui/StatusDot'
import { Modal } from '../ui/Modal'
import { PanelResizeHandle } from '../layout/PanelResizeHandle'
import { FileAttachmentCard } from '../chat/Message'

export type RoomContextTab = 'people' | 'ledger' | 'files' | 'pins' | 'threads'

interface MemberEntry {
  publicKey: string
  displayName: string
  avatarColor: string
  role: 'owner' | 'admin' | 'member'
  online: boolean
}

interface RoomContextPanelProps {
  channel: Channel
  members: MemberEntry[]
  trust: RoomTrustSnapshot
  activeTab: RoomContextTab
  onTabChange: (tab: RoomContextTab) => void
  onOpenThread: (rootEventId: string) => void
  openThreadId: string | null
  onClose: () => void
  panelWidth: number
  panelWidthMinimum: number
  panelWidthMaximum: number
  onResizeStart: (event: ReactPointerEvent<HTMLElement>, direction: 1 | -1) => void
  onResizeBy: (delta: number) => void
}

const EMPTY_MESSAGES: Message[] = []
const EMPTY_THREADS: ThreadListItemDto[] = []

export function RoomContextPanel({
  channel,
  members,
  trust,
  activeTab,
  onTabChange,
  onOpenThread,
  openThreadId,
  onClose,
  panelWidth,
  panelWidthMinimum,
  panelWidthMaximum,
  onResizeStart,
  onResizeBy,
}: RoomContextPanelProps) {
  const activeCommunityId = useCommunityStore((state) => state.activeCommunityId)
  const matrixSessionKey = useIdentityStore((state) => state.identity?.publicKey ?? null)
  const [permissionDiagnosticsOpen, setPermissionDiagnosticsOpen] = useState(false)
  const [selfPermissionsOpen, setSelfPermissionsOpen] = useState(false)
  const tabListRef = useRef<HTMLDivElement>(null)
  const keyboardFocusTabRef = useRef<RoomContextTab | null>(null)
  const messages = useMessageStore((state) => state.messages[channel.id] ?? EMPTY_MESSAGES)
  const pinnedMessages = useRoomPinStore((state) => (
    state.roomId === channel.id ? state.messages : EMPTY_MESSAGES
  ))
  const pinnedEventCount = useRoomPinStore((state) => (
    state.roomId === channel.id ? state.eventIds.length : 0
  ))
  const unavailablePinCount = useRoomPinStore((state) => (
    state.roomId === channel.id ? state.unavailableEventIds.length : 0
  ))
  const pinsLoading = useRoomPinStore((state) => (
    state.roomId === channel.id && state.loading
  ))
  const pinsLoadFailed = useRoomPinStore((state) => (
    state.roomId === channel.id && state.loadFailed
  ))
  const loadRoomPins = useRoomPinStore((state) => state.load)
  const threadListItems = useThreadListStore((state) => (
    state.roomId === channel.id ? state.items : EMPTY_THREADS
  ))
  const threadListHasMore = useThreadListStore((state) => (
    state.roomId === channel.id && state.hasMore
  ))
  const threadListLoading = useThreadListStore((state) => (
    state.roomId === channel.id && state.loading && state.items.length === 0
  ))
  const threadListLoadFailed = useThreadListStore((state) => (
    state.roomId === channel.id && state.loadFailed
  ))
  const loadThreadList = useThreadListStore((state) => state.load)
  const setSecurityOpen = useShellStore((state) => state.setSecurityOpen)
  const requestNavigation = useMessageNavigationStore((state) => state.requestNavigation)
  const permissions = useCommunityPermissionProjection({
    communityId: activeCommunityId,
    enabled: trust.matrixMode && activeTab === 'people',
    sessionKey: matrixSessionKey,
  })
  // "What can I do here?" narrows the community-wide projection to this room.
  // A room Mesh could not read has to say so: resolving it to `unavailable`
  // keeps an unreadable room from reading as a refusal.
  const scopedRoomPermissions = permissions.projection
    ? scopeCommunityPermissionProjectionToRoom(permissions.projection, channel.id)
    : null
  const selfPermissionEvidence: RolePermissionEvidence = permissions.loading
    ? { kind: 'loading' }
    : permissions.projection && scopedRoomPermissions
      ? {
          kind: 'current',
          projection: { ...permissions.projection, ...scopedRoomPermissions },
          userId: permissions.projection.subjectUserId,
        }
      : {
          kind: 'unavailable',
          message: 'Mesh could not read this room’s permissions.',
          onRetry: () => void permissions.refresh(),
          onDiagnostics: () => setPermissionDiagnosticsOpen(true),
        }

  const files = useMemo(
    () => messages.flatMap((message) => (
      (message.attachments ?? []).map((attachment, attachmentIndex) => ({
        attachment,
        attachmentIndex,
        message,
      }))
    )).reverse(),
    [messages],
  )
  const tabs: Array<{ id: RoomContextTab; label: string }> = trust.matrixMode
    ? [
        { id: 'people', label: 'People' },
        { id: 'pins', label: 'Pins' },
        { id: 'threads', label: 'Threads' },
        { id: 'files', label: 'Files' },
      ]
    : [
        { id: 'people', label: 'People' },
        { id: 'files', label: 'Files' },
      ]
  const signalCheckOpen = activeTab === 'ledger'

  useEffect(() => {
    if (activeTab !== 'threads' || !trust.matrixMode) return
    void loadThreadList(channel.id)
  }, [activeTab, channel.id, loadThreadList, trust.matrixMode])

  useLayoutEffect(() => {
    if (keyboardFocusTabRef.current !== activeTab) return

    tabListRef.current
      ?.querySelector<HTMLElement>(`#room-context-tab-${activeTab}`)
      ?.focus()
    keyboardFocusTabRef.current = null
  }, [activeTab])

  const copyRoomLink = async () => {
    try {
      await copyText(matrixRoomPermalink(channel.id))
      showToast('Room link copied.', 'success')
    } catch {
      showToast('Could not copy this room link.', 'error')
    }
  }

  const handleTabKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
    const currentTab = (event.target as HTMLElement).closest<HTMLElement>('[role="tab"]')
    if (!currentTab) return
    const currentIndex = tabs.findIndex((tab) => `room-context-tab-${tab.id}` === currentTab.id)
    if (currentIndex < 0) return

    event.preventDefault()
    const nextIndex =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? tabs.length - 1
          : event.key === 'ArrowRight'
            ? (currentIndex + 1) % tabs.length
            : (currentIndex - 1 + tabs.length) % tabs.length
    const nextTab = tabs[nextIndex]
    keyboardFocusTabRef.current = nextTab.id
    onTabChange(nextTab.id)
  }

  return (
    <aside
      id="mesh-room-context-panel"
      className="mesh-room-context-panel relative flex min-w-0 flex-shrink-0 flex-col overflow-hidden border-l border-outline-variant bg-surface"
      data-design-token-exception="user-resizable-persisted-room-context-width"
      style={{
        '--mesh-room-context-width': `${panelWidth}px`,
      } as CSSProperties}
      aria-label={signalCheckOpen ? `Connection check for ${channel.name}` : `Details for ${channel.name}`}
      data-mesh-region
      tabIndex={-1}
    >
      <PanelResizeHandle
        label="Resize room context"
        side="left"
        value={panelWidth}
        minimum={panelWidthMinimum}
        maximum={panelWidthMaximum}
        onPointerDown={onResizeStart}
        onResizeBy={onResizeBy}
      />
      <div className="mesh-room-context-header flex-shrink-0 border-b border border-outline-variant">
        <div className="flex h-conversation-header items-center gap-2 px-4">
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-title-lg font-semibold text-on-surface">
              {signalCheckOpen ? 'Connection check' : 'Room details'}
            </h2>
            <p className="mt-0.5 truncate text-label-sm text-on-surface-variant">
              {channel.name}
            </p>
          </div>
          <button
            type="button"
            className="flex min-h-11 min-w-11 flex-shrink-0 items-center justify-center rounded-full text-on-surface-variant transition-colors hover:bg-state-hover hover:text-on-surface-variant"
            aria-label="Close room context"
            onClick={onClose}
          >
            <Icon name="x" size="sm" />
          </button>
        </div>
        {!signalCheckOpen && (
          <div
            ref={tabListRef}
            className="mesh-room-context-tabs mx-3 mb-3 flex min-w-0 overflow-x-auto rounded-full border border-outline"
            role="tablist"
            aria-label="Details"
            onKeyDown={handleTabKeyDown}
          >
            {tabs.map((tab) => (
              <button
                key={tab.id}
                id={`room-context-tab-${tab.id}`}
                type="button"
                role="tab"
                tabIndex={activeTab === tab.id ? 0 : -1}
                aria-selected={activeTab === tab.id}
                aria-controls={`room-context-${tab.id}`}
                className={`mesh-room-context-tab min-h-8 flex-1 rounded-full px-2 text-label-sm font-medium transition-colors ${
                  activeTab === tab.id
                    ? 'text-on-surface'
                    : 'text-on-surface-variant hover:bg-state-hover hover:text-on-surface'
                } ${tab.id === tabs[0]?.id ? '' : 'border-l border border-outline-variant'}`}
                onClick={() => onTabChange(tab.id)}
              >
                {tab.label}
              </button>
            ))}
          </div>
        )}
      </div>

      {activeTab === 'people' && (
        <div
          id="room-context-people"
          role="tabpanel"
          aria-labelledby="room-context-tab-people"
          className="flex min-h-0 flex-1 flex-col"
        >
          {/*
            The room's description in full.

            The conversation header truncates it to one line, and the
            typography rule allows truncation only when the full value is
            reachable as an accessible name or adjacent detail. This is that
            detail, so the header does not need a hover-only tooltip. Absent
            entirely when the room has none, rather than rendering an empty
            block or repeating the header's generated fallback here.
          */}
          {(channel.topic ?? '').trim() ? (
            <section className="mx-3 mt-3 rounded-xl bg-surface-container-lowest px-3 py-3">
              <SectionLabel className="block">About this room</SectionLabel>
              <p className="mt-1 whitespace-pre-line text-body-sm text-on-surface-variant">
                {(channel.topic ?? '').trim()}
              </p>
            </section>
          ) : null}
          {/*
            The panel leads with the number.

            It was a bordered card with an icon tile, a heading, a subheading
            and a tally, which is four elements to say one thing. The tally is
            the thing, so it is the size of a screen title and the two clauses
            under it are an eyebrow.
          */}
          <div className="mesh-room-context-summary flex flex-col gap-1 border-b border border-outline-variant px-3 pb-4 pt-3">
            <span className="text-display-sm font-semibold text-on-surface">
              {members.length}
            </span>
            <SectionLabel>
              {members.length === 1 ? 'Person here' : 'People here'}
              {' \u00b7 '}
              {members.filter((member) => member.online).length} online
            </SectionLabel>
          </div>
          {trust.matrixMode ? (
            <div className="px-1">
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="w-full"
                onClick={() => setSelfPermissionsOpen(true)}
              >
                <Icon name="shieldCheck" size="sm" />
                What can I do here?
              </Button>
            </div>
          ) : null}
          <MemberList
            embedded
            isOpen
            onClose={onClose}
            members={members}
            rolePermissionProjection={permissions.projection ?? undefined}
            rolePermissionsLoading={permissions.loading}
            onRetryRolePermissions={() => void permissions.refresh()}
            onOpenPermissionDiagnostics={() => setPermissionDiagnosticsOpen(true)}
          />
        </div>
      )}

      {activeTab === 'ledger' && trust.matrixMode && (
        <div
          id="room-context-ledger"
          role="region"
          aria-label="Connection check"
          className="flex-1 space-y-5 overflow-y-auto px-4 py-4"
        >
          <section>
            <p className="text-label-sm font-semibold lowercase tracking-label-md text-on-surface-variant">
              Connection check
            </p>
            <h2 className="mt-1 truncate text-body-md font-semibold text-on-surface">#{channel.name}</h2>
            <p className="mt-1 truncate text-label-sm text-on-surface-variant">
              {trust.homeService ? `${trust.homeService} · private room` : 'Private room'}
            </p>
          </section>

          <section
            className={`rounded-xl border p-3 ${
              trust.protection === 'protected'
                ? 'border-primary-container-line bg-primary-container'
                : trust.protection === 'unencrypted'
                  ? 'border-marker-container-line bg-marker-container'
                  : 'border-outline-variant bg-surface-container-lowest'
            }`}
          >
            <div className="flex items-start gap-2">
              <Icon
                name={trust.protection === 'protected' ? 'lock' : 'triangleAlert'}
                size="sm"
                className={
                  trust.protection === 'protected'
                    ? 'text-primary'
                    : trust.protection === 'unencrypted'
                      ? 'text-marker'
                      : 'text-on-surface-variant'
                }
              />
              <div>
                <p className="text-body-sm font-medium text-on-surface">
                  {protectionLabel(trust.protection)}
                </p>
                <p className="mt-1 text-label-sm text-on-surface-variant">
                  Readable only on approved participant devices, not by connected services.
                </p>
              </div>
            </div>
          </section>

          <section className="space-y-3">
            <LedgerHeading label="Access" />
            <dl className="space-y-2">
              <LedgerRow
                label="Community members"
                value={String(trust.communityMemberCount)}
              />
              <LedgerRow
                label="Connected services"
                value={String(trust.services.length)}
              />
              <LedgerRow
                label="Approved devices"
                value={trust.loadingAccountTrust ? 'Checking…' : String(trust.verifiedDevices)}
                tone="success"
              />
              <LedgerRow
                label="Need review"
                value={trust.loadingAccountTrust ? 'Checking…' : String(trust.devicesNeedReview)}
                tone={trust.devicesNeedReview > 0 ? 'warning' : 'muted'}
              />
            </dl>
          </section>

          <section className="space-y-3">
            <LedgerHeading label="Connected services" />
            {trust.services.length > 0 ? (
              <div className="space-y-3">
                {trust.services.map((service) => {
                  const largest = Math.max(1, ...trust.services.map((item) => item.memberCount))
                  const width = Math.max(8, Math.round((service.memberCount / largest) * 100))
                  return (
                    <div key={service.name}>
                      <div className="flex items-center justify-between gap-3 text-label-sm">
                        <span className="identifier truncate text-on-surface-variant">
                          {service.name}
                        </span>
                        <span className="member-count text-on-surface-variant">{service.memberCount}</span>
                      </div>
                      <div className="mt-1 h-1 overflow-hidden rounded-full bg-surface-container-highest">
                        <div
                          className="h-full rounded-full bg-primary"
                          data-design-token-exception="data-driven-service-distribution-width"
                          style={{ width: `${width}%` }}
                        />
                      </div>
                    </div>
                  )
                })}
              </div>
            ) : (
              <p className="text-label-sm text-on-surface-variant">
                Service distribution will appear after the member list syncs.
              </p>
            )}
          </section>

          <section className="space-y-3">
            <div className="flex items-center justify-between gap-3">
              <LedgerHeading label="Your devices" />
              {trust.devicesNeedReview > 0 && (
                <span className="text-label-sm font-medium text-marker">
                  {trust.devicesNeedReview} need review
                </span>
              )}
            </div>
            {trust.devices.length > 0 ? (
              <div className="flex flex-wrap gap-1" aria-label="Device trust overview">
                {trust.devices.map((device) => {
                  const needsReview = !device.verified || device.newDevice || device.identityChanged
                  return (
                    <StatusDot
                      key={device.deviceId}
                      state={needsReview ? 'degraded' : 'connected'}
                      label={`${device.displayName || 'Unnamed device'}: ${needsReview ? 'needs review' : 'approved'}`}
                    />
                  )
                })}
              </div>
            ) : (
              <p className="text-label-sm text-on-surface-variant">
                {trust.loadingAccountTrust
                  ? 'Checking the devices signed into your account…'
                  : 'Device details are unavailable right now.'}
              </p>
            )}
            <button
              type="button"
              className="min-h-control-md w-full rounded-full border border-outline-variant px-3 text-body-sm font-medium text-on-surface-variant transition-colors hover:border-outline hover:bg-state-hover hover:text-on-surface"
              onClick={() => setSecurityOpen(true)}
            >
              Review devices
            </button>
          </section>

          <section className="space-y-3">
            <LedgerHeading label="Your control" />
            <dl className="space-y-2">
              <LedgerRow
                label="Message access"
                value="Your devices"
                tone="success"
              />
              <LedgerRow
                label="Message backup"
                value={trust.backup?.healthy ? 'Ready' : 'Needs attention'}
                tone={trust.backup?.healthy ? 'success' : 'warning'}
              />
              <LedgerRow
                label="Account recovery"
                value={trust.accountId ? 'Available' : 'Unavailable'}
              />
            </dl>
            <div className="grid gap-2">
              <button
                type="button"
                className="min-h-control-md rounded-full bg-primary px-3 text-body-sm font-semibold text-on-primary transition-colors hover:bg-primary"
                onClick={() => setSecurityOpen(true)}
              >
                Manage devices and recovery
              </button>
              <button
                type="button"
                className="min-h-control-md rounded-full border border-outline-variant px-3 text-body-sm font-medium text-on-surface-variant transition-colors hover:border-outline hover:bg-state-hover hover:text-on-surface"
                onClick={() => void copyRoomLink()}
              >
                Copy room link
              </button>
            </div>
          </section>
        </div>
      )}

      {activeTab === 'files' && (
        <div
          id="room-context-files"
          role="tabpanel"
          aria-labelledby="room-context-tab-files"
          className="flex-1 overflow-y-auto p-3"
        >
          <div className="mb-3">
            <p className="text-body-sm font-medium text-on-surface">Shared in #{channel.name}</p>
            <p className="mt-1 text-label-sm text-on-surface-variant">
              {files.length} {files.length === 1 ? 'file' : 'files'} in loaded messages
            </p>
          </div>
          {files.length > 0 ? (
            <div className="space-y-3">
              {files.map(({ attachment, attachmentIndex, message }) => (
                <article
                  key={`${message.id}:${attachment.fileHash}:${attachmentIndex}`}
                  className="space-y-2 border-b border-outline-variant pb-3 last:border-b-0"
                >
                  <div className="flex items-center justify-between gap-2 px-1 text-label-sm text-on-surface-variant">
                    <span className="truncate">{message.authorDisplayName}</span>
                    <span className="tnum flex-shrink-0">
                      {formatFederatedTimestamp(message.timestamp, 'MMM d, HH:mm')}
                    </span>
                  </div>
                  <FileAttachmentCard
                    attachment={attachment}
                    roomId={channel.id}
                    eventId={message.id}
                    attachmentIndex={attachmentIndex}
                    compact
                  />
                  <div className="flex items-center justify-between gap-2 px-1">
                    <span className="text-label-sm font-medium text-on-surface-variant">
                      {trust.matrixMode ? 'Protected' : 'Shared file'} · {formatFileSize(attachment.size)}
                    </span>
                    <button
                      type="button"
                      className="min-h-8 rounded-full px-2 text-label-sm font-semibold text-primary hover:bg-state-hover"
                      onClick={() => requestNavigation(message)}
                    >
                      Go to message
                    </button>
                  </div>
                </article>
              ))}
            </div>
          ) : (
            <EmptyState
              variant="compact"
              icon={<Icon name="file" />}
              title="Share a file"
              description="Attach a file to a message."
            />
          )}
        </div>
      )}

      {activeTab === 'pins' && trust.matrixMode && (
        <div
          id="room-context-pins"
          role="tabpanel"
          aria-labelledby="room-context-tab-pins"
          className="flex-1 overflow-y-auto p-3"
        >
          <div className="mb-3">
            <p className="text-body-sm font-medium text-on-surface">Pinned in #{channel.name}</p>
          </div>
          {pinsLoadFailed ? (
            <div role="alert">
              <EmptyState
                variant="compact"
                icon={<Icon name="triangleAlert" className="text-marker" />}
                title="Pins are unavailable right now"
                description="Check your connection."
                action={
                  <Button variant="secondary" size="sm" onClick={() => void loadRoomPins(channel.id)}>
                    Try again
                  </Button>
                }
              />
            </div>
          ) : pinsLoading && pinnedMessages.length === 0 ? (
            <div role="status">
              <EmptyState
                variant="compact"
                icon={<Spinner size={16} />}
                title="Loading pinned messages"
                description="Checking the room’s pinned references."
              />
            </div>
          ) : pinnedEventCount > 0 ? (
            <div className="space-y-1.5">
              {pinnedMessages.map((message) => (
                <button
                  key={message.id}
                  type="button"
                  className="min-h-control-lg w-full rounded-xl border border-transparent p-2 text-left transition-colors hover:border-outline-variant hover:bg-state-hover"
                  onClick={() => requestNavigation(message)}
                >
                  <span className="flex items-center gap-1.5 text-label-sm text-primary">
                    <Icon name="pin" size="xs" />
                    Pinned message
                  </span>
                  <span className="mt-1 block line-clamp-3 text-body-sm text-on-surface-variant">
                    {message.content || 'Attachment'}
                  </span>
                  <span className="tnum mt-1 block text-label-sm text-on-surface-variant">
                    {message.authorDisplayName} · {formatFederatedTimestamp(message.timestamp, 'MMM d, HH:mm')}
                  </span>
                  <span className="mt-1 block text-label-sm font-semibold text-primary">
                    Go to message
                  </span>
                </button>
              ))}
              {unavailablePinCount > 0 && (
                <div
                  role="status"
                  className="rounded-xl bg-surface-container-lowest px-3 py-2 text-label-sm text-on-surface-variant"
                >
                  {unavailablePinCount} pinned {unavailablePinCount === 1 ? 'message is' : 'messages are'} no longer available on this device.
                </div>
              )}
            </div>
          ) : (
            <EmptyState
              variant="compact"
              icon={<Icon name="pin" />}
              title="Pin an important message"
              description="Pin one from a message’s actions."
            />
          )}
        </div>
      )}

      {activeTab === 'threads' && trust.matrixMode && (
        <div
          id="room-context-threads"
          role="tabpanel"
          aria-labelledby="room-context-tab-threads"
          className="flex-1 overflow-y-auto p-3"
        >
          <div className="mb-3">
            <p className="text-body-sm font-medium text-on-surface">Your threads in #{channel.name}</p>
            <p className="mt-1 text-label-sm text-on-surface-variant">
              Threads you started, replied to, or joined
            </p>
          </div>
          {threadListLoadFailed ? (
            <div role="alert">
              <EmptyState
                variant="compact"
                icon={<Icon name="triangleAlert" className="text-marker" />}
                title="Threads are unavailable right now"
                description="Check your connection."
                action={
                  <Button variant="secondary" size="sm" onClick={() => void loadThreadList(channel.id)}>
                    Try again
                  </Button>
                }
              />
            </div>
          ) : threadListLoading ? (
            <div role="status">
              <EmptyState
                variant="compact"
                icon={<Spinner size={16} />}
                title="Loading your threads"
                description="Checking this room’s threads."
              />
            </div>
          ) : threadListItems.length > 0 ? (
            <div className="space-y-1.5">
              {threadListItems.map((item) => {
                const unread = item.unreadCount > 0 || item.unreadMentions > 0
                return (
                  <div key={item.root.id} data-message-id={threadListFocusScopeId(item.root.id)}>
                    <button
                      type="button"
                      onClick={() => onOpenThread(item.root.id)}
                      aria-expanded={openThreadId === item.root.id}
                      aria-controls="mesh-thread-panel"
                      className="min-h-control-lg w-full rounded-xl border border-transparent p-2 text-left transition-colors hover:border-outline-variant hover:bg-state-hover"
                    >
                      <span className="flex items-center gap-1.5 text-label-sm text-primary">
                        <Icon name="reply" size="xs" />
                        {item.root.authorDisplayName}
                        {item.unreadMentions > 0 && (
                          <span className="rounded-full bg-error px-1.5 py-0.5 text-label-sm font-semibold text-on-error">
                            {item.unreadMentions} {item.unreadMentions === 1 ? 'mention' : 'mentions'}
                          </span>
                        )}
                      </span>
                      <span className={`mt-1 block line-clamp-2 text-body-sm ${unread ? 'font-semibold text-on-surface' : 'text-on-surface-variant'}`}>
                        {item.root.content || 'Attachment'}
                      </span>
                      <span className="tnum mt-1 block text-label-sm text-on-surface-variant">
                        {item.replyCount} {item.replyCount === 1 ? 'reply' : 'replies'} · {item.participantCount} {item.participantCount === 1 ? 'person' : 'people'} · {formatFederatedTimestamp(item.lastActivity, 'MMM d, HH:mm')}
                      </span>
                    </button>
                  </div>
                )
              })}
              {threadListHasMore && (
                <div
                  role="status"
                  className="rounded-xl bg-surface-container-lowest px-3 py-2 text-label-sm text-on-surface-variant"
                >
                  More threads exist in this room than are shown here.
                </div>
              )}
            </div>
          ) : (
            <EmptyState
              variant="compact"
              icon={<Icon name="reply" />}
              title="No threads yet"
              description="Reply in a thread to start one."
            />
          )}
        </div>
      )}
      <Modal
        open={selfPermissionsOpen}
        onClose={() => setSelfPermissionsOpen(false)}
        title="What can I do here?"
        description={`Your effective permissions in ${channel.name}.`}
        size="sm"
      >
        <div className="space-y-3">
          <RolePermissionPreview
            role="member"
            evidence={selfPermissionEvidence}
            scope="room"
            title="Your permissions in this room"
          />
          <div className="flex justify-end">
            <Button
              type="button"
              variant="secondary"
              onClick={() => setSelfPermissionsOpen(false)}
            >
              Close
            </Button>
          </div>
        </div>
      </Modal>
      <Modal
        open={permissionDiagnosticsOpen}
        onClose={() => setPermissionDiagnosticsOpen(false)}
        title="Permission details"
        description="Current room permissions used for role changes."
        size="sm"
      >
        <div className="space-y-3">
          {permissions.error ? (
            <p className="rounded-xl border border-error-container-line bg-error-container px-3 py-2 text-body-sm text-on-error-container">
              {permissions.error}
            </p>
          ) : null}
          {permissions.projection?.discoveryFailureReason ? (
            <p className="rounded-xl border border-marker-container-line bg-marker-container px-3 py-2 text-body-sm text-on-marker-container">
              {permissions.projection.discoveryFailureReason}
            </p>
          ) : null}
          {permissions.projection?.rooms.length ? (
            <ul className="space-y-2" aria-label="Room permission state">
              {permissions.projection.rooms.map((room) => (
                <li
                  key={room.roomId}
                  className="rounded-xl bg-surface-container-lowest px-3 py-2"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="truncate text-body-sm font-medium text-on-surface">{room.roomName}</p>
                      <p className="mt-0.5 text-label-sm capitalize text-on-surface-variant">{room.roomKind}</p>
                    </div>
                    <span className="text-label-sm font-medium text-on-surface-variant">
                      {permissionRoomStatusLabel(room.status)}
                    </span>
                  </div>
                  {room.failureReason ? (
                    <p className="mt-2 text-label-sm text-on-surface-variant">{room.failureReason}</p>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-body-sm text-on-surface-variant">
              {permissions.loading
                ? 'Checking the community rooms now.'
                : 'No room permission results are available yet.'}
            </p>
          )}
          <div className="flex justify-end">
            <Button
              type="button"
              variant="secondary"
              disabled={permissions.loading}
              onClick={() => void permissions.refresh()}
            >
              {permissions.loading ? 'Checking…' : 'Check again'}
            </Button>
          </div>
        </div>
      </Modal>
    </aside>
  )
}

function LedgerHeading({ label }: { label: string }) {
  return (
    <h3 className="text-label-sm font-semibold lowercase tracking-label-md text-on-surface-variant">{label}</h3>
  )
}

function LedgerRow({
  label,
  value,
  tone = 'muted',
}: {
  label: string
  value: string
  tone?: 'muted' | 'success' | 'warning'
}) {
  return (
    <div className="flex items-center justify-between gap-3 text-body-sm">
      <dt className="text-on-surface-variant">{label}</dt>
      <dd className={
        tone === 'success'
          ? 'font-medium text-primary'
          : tone === 'warning'
            ? 'font-medium text-marker'
            : 'font-medium text-on-surface-variant'
      }>
        {value}
      </dd>
    </div>
  )
}

function protectionLabel(state: RoomTrustSnapshot['protection']) {
  if (state === 'protected') return 'Protected end to end'
  if (state === 'unencrypted') return 'Message protection is required'
  if (state === 'checking') return 'Checking room protection'
  return 'Protection details are temporarily unavailable'
}

function permissionRoomStatusLabel(status: MatrixPermissionRoomStatus) {
  if (status === 'loaded') return 'Loaded'
  if (status === 'matrix-default') return 'Service default'
  if (status === 'inaccessible') return 'Not accessible'
  if (status === 'unsupported') return 'Unsupported'
  return 'Failed'
}

function formatFileSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
