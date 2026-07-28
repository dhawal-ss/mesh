import { useMemo } from 'react'
import type { Channel, Message } from '../../types/ipc'
import type { RoomTrustSnapshot } from '../../hooks/useRoomTrust'
import { useMessageStore } from '../../store/messages'
import { useRoomPinStore } from '../../store/room-pins'
import { useMessageNavigationStore } from '../../store/message-navigation'
import { useShellStore } from '../../store/shell'
import { copyText, matrixRoomPermalink } from '../../lib/notifications'
import { formatFederatedTimestamp } from '../../lib/federated-time'
import { showToast } from '../ui/Toast'
import { Icon } from '../ui/Icon'
import { MemberList } from './MemberList'

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
}

const EMPTY_MESSAGES: Message[] = []

export function RoomContextPanel({
  channel,
  members,
  trust,
  activeTab,
  onTabChange,
  onClose,
}: RoomContextPanelProps) {
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

  return (
    <aside
      id="mesh-room-context-panel"
      className="mesh-room-context-panel flex w-member-list flex-shrink-0 flex-col overflow-hidden border-l border-border-subtle bg-bg-secondary"
      aria-label={`Room context for ${channel.name}`}
    >
      <div className="flex h-12 flex-shrink-0 items-center gap-1 border-b border-border-subtle px-2">
        <div className="flex min-w-0 flex-1" role="tablist" aria-label="Room context">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={activeTab === tab.id}
              className={`min-h-control-sm flex-1 rounded px-1 text-xs font-medium transition-colors ${
                activeTab === tab.id
                  ? 'bg-bg-modifier-active text-primary'
                  : 'text-muted hover:bg-bg-modifier-hover hover:text-secondary'
              }`}
              onClick={() => onTabChange(tab.id)}
            >
              {tab.label}
            </button>
          ))}
        </div>
        <button
          type="button"
          className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded text-muted transition-colors hover:bg-bg-modifier-hover hover:text-secondary"
          aria-label="Close room context"
          onClick={onClose}
        >
          <Icon name="x" size="sm" />
        </button>
      </div>

      {activeTab === 'people' && (
        <div role="tabpanel" className="flex min-h-0 flex-1 flex-col">
          <div className="border-b border-border-subtle px-4 py-3">
            <p className="text-xs font-medium text-primary">
              {members.length} {members.length === 1 ? 'person' : 'people'}
            </p>
            <p className="mt-1 text-caption text-muted">
              {members.filter((member) => member.online).length} here now
            </p>
          </div>
          <MemberList embedded isOpen onClose={onClose} members={members} />
        </div>
      )}

      {activeTab === 'ledger' && trust.matrixMode && (
        <div role="tabpanel" className="flex-1 space-y-5 overflow-y-auto px-4 py-4">
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
                : trust.protection === 'blocked'
                  ? 'border-status-warning/30 bg-status-warning/10'
                  : 'border-border-subtle bg-bg-modifier-hover'
            }`}
          >
            <div className="flex items-start gap-2">
              <Icon
                name={trust.protection === 'protected' ? 'lock' : 'triangleAlert'}
                size="sm"
                className={
                  trust.protection === 'protected'
                    ? 'text-status-success'
                    : trust.protection === 'blocked'
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
                      <div className="mt-1 h-1 overflow-hidden rounded-full bg-bg-modifier-active">
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
                    <span
                      key={device.deviceId}
                      className={`h-3 w-3 rounded-sm ${
                        needsReview ? 'bg-status-warning' : 'bg-status-success'
                      }`}
                      title={`${device.displayName || 'Unnamed device'}: ${needsReview ? 'needs review' : 'approved'}`}
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
              className="min-h-control-md w-full rounded-md border border-border-subtle px-3 text-xs font-medium text-secondary transition-colors hover:border-border-strong hover:bg-bg-modifier-hover hover:text-primary"
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
                className="min-h-control-md rounded-md border border-border-subtle px-3 text-xs font-medium text-secondary transition-colors hover:border-border-strong hover:bg-bg-modifier-hover hover:text-primary"
                onClick={() => void copyRoomLink()}
              >
                Copy room link
              </button>
            </div>
          </section>
        </div>
      )}

      {activeTab === 'files' && (
        <div role="tabpanel" className="flex-1 overflow-y-auto p-3">
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
                  className="flex min-h-control-lg w-full items-start gap-2 rounded-md border border-transparent p-2 text-left transition-colors hover:border-border-subtle hover:bg-bg-modifier-hover"
                  onClick={() => requestNavigation(message)}
                >
                  <span className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-md bg-bg-modifier-active text-accent">
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
            <div className="rounded-lg border border-dashed border-border-subtle px-4 py-8 text-center">
              <Icon name="file" className="mx-auto text-muted" />
              <p className="mt-3 text-xs font-medium text-secondary">No files shared yet</p>
              <p className="mt-1 text-caption leading-5 text-muted">
                Encrypted attachments from loaded messages will collect here.
              </p>
            </div>
          )}
        </div>
      )}

      {activeTab === 'pins' && trust.matrixMode && (
        <div role="tabpanel" className="flex-1 overflow-y-auto p-3">
          <div className="mb-3">
            <p className="text-xs font-medium text-primary">Pinned in #{channel.name}</p>
            <p className="mt-1 text-caption text-muted">
              Shared reference points for everyone in this room
            </p>
          </div>
          {pinsLoadFailed ? (
            <div className="rounded-lg border border-status-warning/30 bg-status-warning/10 px-4 py-5 text-center">
              <Icon name="triangleAlert" className="mx-auto text-status-warning" />
              <p className="mt-3 text-xs font-medium text-primary">Pins are unavailable right now</p>
              <p className="mt-1 text-caption leading-5 text-muted">
                Messaging still works. Check your connection and try again.
              </p>
              <button
                type="button"
                className="mt-3 min-h-control-sm rounded-md border border-border-subtle px-3 text-xs font-medium text-secondary transition-colors hover:border-border-strong hover:bg-bg-modifier-hover hover:text-primary"
                onClick={() => void loadRoomPins(channel.id)}
              >
                Try again
              </button>
            </div>
          ) : pinsLoading && pinnedMessages.length === 0 ? (
            <div className="rounded-lg border border-dashed border-border-subtle px-4 py-8 text-center">
              <Icon name="loader" className="mx-auto animate-spin text-muted" />
              <p className="mt-3 text-xs font-medium text-secondary">Loading pinned messages…</p>
            </div>
          ) : pinnedEventCount > 0 ? (
            <div className="space-y-1.5">
              {newestPinnedMessages.map((message) => (
                <button
                  key={message.id}
                  type="button"
                  className="min-h-control-lg w-full rounded-md border border-transparent p-2 text-left transition-colors hover:border-border-subtle hover:bg-bg-modifier-hover"
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
                  className="rounded-md border border-border-subtle bg-bg-modifier-hover px-3 py-2 text-caption leading-5 text-muted"
                >
                  {unavailablePinCount} pinned {unavailablePinCount === 1 ? 'message is' : 'messages are'} no longer available on this device.
                </div>
              )}
            </div>
          ) : (
            <div className="rounded-lg border border-dashed border-border-subtle px-4 py-8 text-center">
              <Icon name="pin" className="mx-auto text-muted" />
              <p className="mt-3 text-xs font-medium text-secondary">Nothing pinned yet</p>
              <p className="mt-1 text-caption leading-5 text-muted">
                Use a message’s actions to pin an important decision or reference for the room.
              </p>
            </div>
          )}
        </div>
      )}
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
  if (state === 'blocked') return 'Sending is blocked until protection is restored'
  if (state === 'checking') return 'Checking room protection'
  return 'Protection details are temporarily unavailable'
}

function formatFileSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
