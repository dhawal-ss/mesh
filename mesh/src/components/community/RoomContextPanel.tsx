import {
  useMemo,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import type { Channel, MatrixPermissionRoomStatus, Message } from '../../types/ipc'
import type { RoomTrustSnapshot } from '../../hooks/useRoomTrust'
import { useMessageStore } from '../../store/messages'
import { useRoomPinStore } from '../../store/room-pins'
import { useMessageNavigationStore } from '../../store/message-navigation'
import { useShellStore } from '../../store/shell'
import { useCommunityStore } from '../../store/communities'
import { useIdentityStore } from '../../store/identity'
import { useCommunityPermissionProjection } from '../../hooks/useCommunityPermissionProjection'
import { copyText, matrixRoomPermalink } from '../../lib/notifications'
import { formatFederatedTimestamp } from '../../lib/federated-time'
import { showToast } from '../ui/Toast'
import { Icon } from '../ui/Icon'
import { MemberList } from './MemberList'
import { EmptyState } from '../ui/Primitives'
import { Button } from '../ui/Button'
import { Spinner } from '../ui/Spinner'
import { StatusDot } from '../ui/StatusDot'
import { Modal } from '../ui/Modal'
import { PanelResizeHandle } from '../layout/PanelResizeHandle'

export type RoomContextTab = 'people' | 'ledger' | 'files' | 'pins'

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
  onClose: () => void
  panelWidth: number
  panelWidthMinimum: number
  panelWidthMaximum: number
  onResizeStart: (event: ReactPointerEvent<HTMLElement>, direction: 1 | -1) => void
  onResizeBy: (delta: number) => void
}

const EMPTY_MESSAGES: Message[] = []

export function RoomContextPanel({
  channel,
  members,
  trust,
  activeTab,
  onTabChange,
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
  const setSecurityOpen = useShellStore((state) => state.setSecurityOpen)
  const requestNavigation = useMessageNavigationStore((state) => state.requestNavigation)
  const permissions = useCommunityPermissionProjection({
    communityId: activeCommunityId,
    enabled: trust.matrixMode && activeTab === 'people',
    sessionKey: matrixSessionKey,
  })
  const files = useMemo(
    () => messages.flatMap((message) => (
      (message.attachments ?? []).map((attachment) => ({ attachment, message }))
    )).reverse(),
    [messages],
  )
  const newestPinnedMessages = useMemo(() => [...pinnedMessages].reverse(), [pinnedMessages])
  const tabs: Array<{ id: RoomContextTab; label: string }> = trust.matrixMode
    ? [
        { id: 'people', label: 'People' },
        { id: 'ledger', label: 'Ledger' },
        { id: 'files', label: 'Files' },
        { id: 'pins', label: 'Pins' },
      ]
    : [
        { id: 'people', label: 'People' },
        { id: 'files', label: 'Files' },
      ]

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
    onTabChange(nextTab.id)
    event.currentTarget
      .querySelector<HTMLElement>(`#room-context-tab-${nextTab.id}`)
      ?.focus()
  }

  return (
    <aside
      id="mesh-room-context-panel"
      className="mesh-room-context-panel relative flex flex-shrink-0 flex-col overflow-hidden border-l border-border-subtle bg-surface-sidebar"
      data-design-token-exception="user-resizable-persisted-room-context-width"
      style={{
        '--mesh-room-context-width': `${panelWidth}px`,
      } as CSSProperties}
      aria-label={`Room context for ${channel.name}`}
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
      <div className="flex h-conversation-header flex-shrink-0 items-center gap-1 border-b border-border-subtle px-2">
        <button
          type="button"
          className="order-2 flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-control text-muted transition-colors hover:bg-surface-hover hover:text-secondary"
          aria-label="Close room context"
          onClick={onClose}
        >
          <Icon name="x" size="sm" />
        </button>
        <div
          className="order-1 flex min-w-0 flex-1"
          role="tablist"
          aria-label="Room context"
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
              className={`min-h-control-sm flex-1 border-b-2 border-transparent px-1 text-xs font-medium transition-colors ${
                activeTab === tab.id
                  ? 'border-accent text-primary'
                  : 'text-muted hover:bg-surface-hover hover:text-secondary'
              }`}
              onClick={() => onTabChange(tab.id)}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      {activeTab === 'people' && (
        <div
          id="room-context-people"
          role="tabpanel"
          aria-labelledby="room-context-tab-people"
          className="flex min-h-0 flex-1 flex-col"
        >
          <div className="border-b border-border-subtle px-4 py-3">
            <p className="text-xs font-medium text-primary">
              {members.length} {members.length === 1 ? 'person' : 'people'}
            </p>
            <p className="mt-1 text-caption text-muted">
              {members.filter((member) => member.online).length} here now
            </p>
          </div>
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
          role="tabpanel"
          aria-labelledby="room-context-tab-ledger"
          className="flex-1 space-y-5 overflow-y-auto px-4 py-4"
        >
          <section>
            <p className="text-caption font-semibold uppercase tracking-caption text-muted">
              Room ledger
            </p>
            <h2 className="mt-1 truncate text-sm font-semibold text-primary">#{channel.name}</h2>
            <p className="mt-1 truncate text-caption text-muted">
              {trust.homeService ? `${trust.homeService} · private room` : 'Private room'}
            </p>
          </section>

          <section
            className={`rounded-lg border p-3 ${
              trust.protection === 'protected'
                ? 'border-status-success/30 bg-status-success/10'
                : trust.protection === 'unencrypted'
                  ? 'border-status-warning/30 bg-status-warning/10'
                  : 'border-border-subtle bg-surface-sunken'
            }`}
          >
            <div className="flex items-start gap-2">
              <Icon
                name={trust.protection === 'protected' ? 'lock' : 'triangleAlert'}
                size="sm"
                className={
                  trust.protection === 'protected'
                    ? 'text-status-success'
                    : trust.protection === 'unencrypted'
                      ? 'text-status-warning'
                      : 'text-muted'
                }
              />
              <div>
                <p className="text-xs font-medium text-primary">
                  {protectionLabel(trust.protection)}
                </p>
                <p className="mt-1 text-caption leading-5 text-muted">
                  Messages are readable only on approved participant devices. Connected services
                  route encrypted data, not message contents.
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
                      <div className="flex items-center justify-between gap-3 text-caption">
                        <span className="identifier truncate font-mono text-secondary">
                          {service.name}
                        </span>
                        <span className="member-count text-muted">{service.memberCount}</span>
                      </div>
                      <div className="mt-1 h-1 overflow-hidden rounded-full bg-surface-active">
                        <div
                          className="h-full rounded-full bg-accent"
                          data-design-token-exception="data-driven-service-distribution-width"
                          style={{ width: `${width}%` }}
                        />
                      </div>
                    </div>
                  )
                })}
              </div>
            ) : (
              <p className="text-caption leading-5 text-muted">
                Service distribution will appear after the member list syncs.
              </p>
            )}
          </section>

          <section className="space-y-3">
            <div className="flex items-center justify-between gap-3">
              <LedgerHeading label="Your devices" />
              {trust.devicesNeedReview > 0 && (
                <span className="text-caption font-medium text-status-warning">
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
              <p className="text-caption leading-5 text-muted">
                {trust.loadingAccountTrust
                  ? 'Checking the devices signed into your account…'
                  : 'Device details are unavailable right now.'}
              </p>
            )}
            <button
              type="button"
              className="min-h-control-md w-full rounded-control border border-border-subtle px-3 text-xs font-medium text-secondary transition-colors hover:border-border-strong hover:bg-surface-hover hover:text-primary"
              onClick={() => setSecurityOpen(true)}
            >
              Review devices
            </button>
          </section>

          <section className="space-y-3">
            <LedgerHeading label="Your control" />
            <dl className="space-y-2">
              <LedgerRow
                label="Message keys"
                value="Your devices"
                tone="success"
              />
              <LedgerRow
                label="Message backup"
                value={trust.backup?.healthy ? 'Ready' : 'Needs attention'}
                tone={trust.backup?.healthy ? 'success' : 'warning'}
              />
              <LedgerRow
                label="Portable identity"
                value={trust.accountId ? 'Available' : 'Unavailable'}
              />
            </dl>
            <div className="grid gap-2">
              <button
                type="button"
                className="min-h-control-md rounded-md bg-accent px-3 text-xs font-semibold text-content-on-accent transition-colors hover:bg-accent-hover"
                onClick={() => setSecurityOpen(true)}
              >
                Manage backup and keys
              </button>
              <button
                type="button"
                className="min-h-control-md rounded-control border border-border-subtle px-3 text-xs font-medium text-secondary transition-colors hover:border-border-strong hover:bg-surface-hover hover:text-primary"
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
            <p className="text-xs font-medium text-primary">Shared in #{channel.name}</p>
            <p className="mt-1 text-caption text-muted">
              {files.length} {files.length === 1 ? 'file' : 'files'} in loaded messages
            </p>
          </div>
          {files.length > 0 ? (
            <div className="space-y-1.5">
              {files.map(({ attachment, message }, index) => (
                <button
                  key={`${message.id}:${attachment.fileHash}:${index}`}
                  type="button"
                  className="flex min-h-control-lg w-full items-start gap-2 rounded-panel border border-transparent p-2 text-left transition-colors hover:border-border-subtle hover:bg-surface-hover"
                  onClick={() => requestNavigation(message)}
                >
                  <span className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-control bg-surface-active text-accent">
                    <Icon name="file" size="sm" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-xs font-medium text-secondary">
                      {attachment.filename}
                    </span>
                    <span className="file-size mt-0.5 block text-caption text-muted">
                      {formatFileSize(attachment.size)} · {message.authorDisplayName}
                    </span>
                    <span className="tnum block text-caption text-muted">
                      {formatFederatedTimestamp(message.timestamp, 'MMM d, HH:mm')}
                    </span>
                  </span>
                </button>
              ))}
            </div>
          ) : (
            <EmptyState
              variant="compact"
              icon={<Icon name="file" />}
              title="No files shared yet"
              description="Encrypted attachments from loaded messages will collect here."
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
            <p className="text-xs font-medium text-primary">Pinned in #{channel.name}</p>
            <p className="mt-1 text-caption text-muted">
              Shared reference points for everyone in this room
            </p>
          </div>
          {pinsLoadFailed ? (
            <div role="alert">
              <EmptyState
                variant="compact"
                icon={<Icon name="triangleAlert" className="text-status-warning" />}
                title="Pins are unavailable right now"
                description="Messaging still works. Check your connection and try again."
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
              {newestPinnedMessages.map((message) => (
                <button
                  key={message.id}
                  type="button"
                  className="min-h-control-lg w-full rounded-panel border border-transparent p-2 text-left transition-colors hover:border-border-subtle hover:bg-surface-hover"
                  onClick={() => requestNavigation(message)}
                >
                  <span className="flex items-center gap-1.5 text-caption text-accent">
                    <Icon name="pin" size="xs" />
                    Pinned message
                  </span>
                  <span className="mt-1 block line-clamp-3 text-xs leading-5 text-secondary">
                    {message.content || 'Attachment'}
                  </span>
                  <span className="tnum mt-1 block text-caption text-muted">
                    {message.authorDisplayName} · {formatFederatedTimestamp(message.timestamp, 'MMM d, HH:mm')}
                  </span>
                </button>
              ))}
              {unavailablePinCount > 0 && (
                <div
                  role="status"
                  className="rounded-panel border border-border-subtle bg-surface-sunken px-3 py-2 text-caption leading-5 text-muted"
                >
                  {unavailablePinCount} pinned {unavailablePinCount === 1 ? 'message is' : 'messages are'} no longer available on this device.
                </div>
              )}
            </div>
          ) : (
            <EmptyState
              variant="compact"
              icon={<Icon name="pin" />}
              title="Nothing pinned yet"
              description="Use a message’s actions to pin an important decision or reference for the room."
            />
          )}
        </div>
      )}
      <Modal
        open={permissionDiagnosticsOpen}
        onClose={() => setPermissionDiagnosticsOpen(false)}
        title="Permission diagnostics"
        description="Authoritative room state used for role changes."
        size="sm"
      >
        <div className="space-y-3">
          {permissions.error ? (
            <p className="rounded-panel border border-status-danger/30 bg-status-danger/10 px-3 py-2 text-xs leading-5 text-status-danger">
              {permissions.error}
            </p>
          ) : null}
          {permissions.projection?.discoveryFailureReason ? (
            <p className="rounded-panel border border-status-warning/30 bg-status-warning/10 px-3 py-2 text-xs leading-5 text-status-warning">
              {permissions.projection.discoveryFailureReason}
            </p>
          ) : null}
          {permissions.projection?.rooms.length ? (
            <ul className="space-y-2" aria-label="Room permission state">
              {permissions.projection.rooms.map((room) => (
                <li
                  key={room.roomId}
                  className="rounded-panel border border-border-subtle bg-surface-sunken px-3 py-2"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="truncate text-xs font-medium text-primary">{room.roomName}</p>
                      <p className="mt-0.5 text-caption capitalize text-muted">{room.roomKind}</p>
                    </div>
                    <span className="text-caption font-medium text-secondary">
                      {permissionRoomStatusLabel(room.status)}
                    </span>
                  </div>
                  {room.failureReason ? (
                    <p className="mt-2 text-caption leading-5 text-muted">{room.failureReason}</p>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-xs leading-5 text-muted">
              {permissions.loading
                ? 'Checking the community rooms now.'
                : 'No authoritative room results are available yet.'}
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
    <h3 className="text-caption font-semibold uppercase tracking-caption text-muted">{label}</h3>
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
    <div className="flex items-center justify-between gap-3 text-xs">
      <dt className="text-muted">{label}</dt>
      <dd className={
        tone === 'success'
          ? 'font-medium text-status-success'
          : tone === 'warning'
            ? 'font-medium text-status-warning'
            : 'font-medium text-secondary'
      }>
        {value}
      </dd>
    </div>
  )
}

function protectionLabel(state: RoomTrustSnapshot['protection']) {
  if (state === 'protected') return 'Protected end to end'
  if (state === 'unencrypted') return 'Messages in this room are not end-to-end encrypted'
  if (state === 'checking') return 'Checking room protection'
  return 'Protection details are temporarily unavailable'
}

function permissionRoomStatusLabel(status: MatrixPermissionRoomStatus) {
  if (status === 'loaded') return 'Loaded'
  if (status === 'matrix-default') return 'Matrix default'
  if (status === 'inaccessible') return 'Not accessible'
  if (status === 'unsupported') return 'Unsupported'
  return 'Failed'
}

function formatFileSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
