import { useId } from 'react'
import {
  COMMUNITY_ROLE_TEMPLATES,
  compareCommunityRolePermissions,
  explainCommunityPermissionProjection,
  getCommunityPermissionMetadata,
  getEffectiveCommunityPermissions,
  type CommunityPermissionAggregateStatus,
  type CommunityPermissionExplanation,
  type CommunityPermissionProjection,
  type CommunityRole,
  type MatrixCommunityPermissionPolicy,
} from '../../lib/community-permissions'
import { Button } from '../ui/Button'

/**
 * `community` summarises a capability across every room Mesh could read.
 * `room` answers the same question for one room, where "some rooms" cannot
 * arise and the wording has to say allowed or not allowed instead.
 */
export type RolePermissionScope = 'community' | 'room'

export type RolePermissionEvidence =
  | {
      kind: 'template'
      policy: Readonly<MatrixCommunityPermissionPolicy>
    }
  | {
      kind: 'current'
      projection: CommunityPermissionProjection
      userId: string
    }
  | {
      kind: 'proposed'
      projection: CommunityPermissionProjection
      userId: string
    }
  | {
      kind: 'loading'
    }
  | {
      kind: 'unavailable'
      message?: string
      onRetry?: () => void
      onDiagnostics: () => void
    }

interface RolePermissionPreviewProps {
  role: CommunityRole
  previousRole?: CommunityRole
  memberName?: string
  evidence: RolePermissionEvidence
  /** Defaults to the community-wide summary the role-change dialog needs. */
  scope?: RolePermissionScope
  /** Names the rooms behind a partial or unreadable verdict. */
  nameRooms?: boolean
  /** Replaces the default heading when a consumer asks a different question. */
  title?: string
  /** Replaces the default sub-heading. */
  caption?: string
}

export function RolePermissionPreview({
  role,
  previousRole,
  memberName,
  evidence,
  scope = 'community',
  nameRooms = false,
  title: titleOverride,
  caption,
}: RolePermissionPreviewProps) {
  const headingId = useId()

  if (evidence.kind === 'loading') {
    return (
      <section
        aria-labelledby={headingId}
        aria-busy="true"
        className="space-y-2 rounded-xl border border-outline-variant bg-surface-container-lowest p-4"
      >
        <h3 id={headingId} className="text-body-md font-semibold text-on-surface">
          Checking current permissions
        </h3>
        <p className="text-body-sm text-on-surface-variant" role="status" aria-live="polite">
          Reading the community and each connected room…
        </p>
      </section>
    )
  }

  if (evidence.kind === 'unavailable') {
    return (
      <section
        aria-labelledby={headingId}
        className="space-y-3 rounded-xl border border-marker-container-line bg-marker-container p-4"
      >
        <div>
          <h3 id={headingId} className="text-body-md font-semibold text-on-surface">
            Unable to verify permissions
          </h3>
          <p className="mt-1 text-body-sm text-on-surface-variant" role="alert">
            {evidence.message
              ?? 'Mesh could not read current permissions for every room.'}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {evidence.onRetry ? (
            <Button size="sm" onClick={evidence.onRetry}>Retry</Button>
          ) : null}
          <Button size="sm" variant="outline" onClick={evidence.onDiagnostics}>
            View permission details
          </Button>
        </div>
      </section>
    )
  }

  if (evidence.kind === 'template') {
    return (
      <TemplatePermissionPreview
        headingId={headingId}
        role={role}
        previousRole={previousRole}
        memberName={memberName}
        policy={evidence.policy}
      />
    )
  }

  const target = evidence.kind === 'current'
    ? { kind: 'current-user' as const, userId: evidence.userId }
    : { kind: 'proposed-role' as const, userId: evidence.userId, role }
  const permissions = explainCommunityPermissionProjection(evidence.projection, target)
  const hasUnknown = permissions.some((permission) => permission.status === 'unknown')
  const hasPartial = permissions.some(
    (permission) => permission.status === 'granted-some-rooms',
  )
  const title = titleOverride ?? (evidence.kind === 'current'
    ? 'Current effective permissions'
    : `Proposed ${COMMUNITY_ROLE_TEMPLATES[role].label} permissions`)
  const roomCount = evidence.projection.rooms.length

  return (
    <section
      aria-labelledby={headingId}
      className="space-y-3 rounded-xl border border-outline-variant bg-surface-container-lowest p-4"
    >
      <div>
        <h3 id={headingId} className="text-body-md font-semibold text-on-surface">{title}</h3>
        <p className="mt-1 text-body-sm text-on-surface-variant">
          {caption ?? (scope === 'room'
            ? 'Based on current permissions in this room.'
            : 'Based on current permissions in this community and its rooms.')}
        </p>
      </div>

      {hasUnknown ? (
        <p className="text-body-sm text-marker" role="alert">
          {scope === 'room'
            ? 'Mesh could not read this room’s permissions.'
            : "Mesh couldn't confirm permissions in every room."}
        </p>
      ) : hasPartial ? (
        <p className="text-body-sm text-marker" role="status" aria-live="polite">
          Some permissions differ between rooms.
        </p>
      ) : scope === 'room' ? (
        <p className="text-body-sm text-on-surface-variant" role="status" aria-live="polite">
          Read from this room’s current permissions.
        </p>
      ) : (
        <p className="text-body-sm text-on-surface-variant" role="status" aria-live="polite">
          Verified across {roomCount} {roomCount === 1 ? 'room' : 'rooms'}.
        </p>
      )}

      <ul className="space-y-2" aria-label="Effective permission results">
        {permissions.map((permission) => {
          const metadata = getCommunityPermissionMetadata(permission.permissionId)
          return (
            <li key={permission.permissionId} className="text-body-sm">
              <div className="flex items-start justify-between gap-3">
                <span>
                  <span className="block font-medium text-on-surface-variant">{metadata.label}</span>
                  <span className="block text-on-surface-variant">{metadata.description}</span>
                </span>
                <span className={aggregateTone(permission.status)}>
                  {aggregateLabel(permission.status, scope)}
                </span>
              </div>
              {nameRooms ? <PermissionRoomBreakdown permission={permission} /> : null}
            </li>
          )
        })}
      </ul>

      {hasUnknown ? (
        <ul className="space-y-1 border-t border-outline-variant pt-3 text-body-sm text-on-surface-variant">
          {evidence.projection.rooms
            .filter((room) => room.status !== 'loaded' && room.status !== 'matrix-default')
            .map((room) => (
              <li key={room.roomId}>
                <span className="font-medium text-on-surface-variant">{room.roomName}:</span>{' '}
                {room.failureReason ?? 'Permission state unavailable.'}
              </li>
            ))}
          {!evidence.projection.discoveryComplete ? (
            <li>
              {evidence.projection.discoveryFailureReason
                ?? 'One or more connected rooms could not be found.'}
            </li>
          ) : null}
        </ul>
      ) : null}
    </section>
  )
}

function TemplatePermissionPreview({
  headingId,
  role,
  previousRole,
  memberName,
  policy,
}: {
  headingId: string
  role: CommunityRole
  previousRole?: CommunityRole
  memberName?: string
  policy: Readonly<MatrixCommunityPermissionPolicy>
}) {
  const template = COMMUNITY_ROLE_TEMPLATES[role]
  const comparison = previousRole
    ? compareCommunityRolePermissions(previousRole, role, policy)
    : null
  const permissions = comparison?.effective ?? getEffectiveCommunityPermissions(role, policy)
  const subject = memberName ?? 'This member'

  return (
    <section
      aria-labelledby={headingId}
      className="space-y-3 rounded-xl border border-outline-variant bg-surface-container-lowest p-4"
    >
      <div>
        <h3 id={headingId} className="text-body-md font-semibold text-on-surface">
          {template.label} role preview
        </h3>
        <p className="mt-1 text-body-sm text-on-surface-variant">
          {subject} would receive the {template.label} role. {template.summary}
        </p>
      </div>
      <p className="text-body-sm text-marker" role="status">
        This is a preview and has not been applied.
      </p>
      {comparison && (comparison.gained.length > 0 || comparison.lost.length > 0) ? (
        <p className="text-body-sm text-on-surface-variant" role="status" aria-live="polite">
          {comparison.gained.length > 0
            ? `Would gain ${comparison.gained.map((item) => item.label.toLowerCase()).join(', ')}.`
            : ''}
          {comparison.gained.length > 0 && comparison.lost.length > 0 ? ' ' : ''}
          {comparison.lost.length > 0
            ? `Would lose ${comparison.lost.map((item) => item.label.toLowerCase()).join(', ')}.`
            : ''}
        </p>
      ) : null}
      <ul className="space-y-1.5">
        {permissions.map((permission) => (
          <li key={permission.id} className="flex justify-between gap-3 text-body-sm">
            <span className="font-medium text-on-surface-variant">{permission.label}</span>
            <span className={permission.granted ? 'text-primary' : 'text-on-surface-variant'}>
              {permission.granted ? 'Template grants' : 'Template does not grant'}
            </span>
          </li>
        ))}
      </ul>
    </section>
  )
}

/**
 * Names the rooms behind a verdict.
 *
 * Only a partial verdict needs the room list spelled out: "all rooms" and
 * "not granted" already say which rooms they mean. Unreadable rooms are always
 * listed, and always as rooms Mesh could not read rather than as a refusal.
 */
function PermissionRoomBreakdown({ permission }: { permission: CommunityPermissionExplanation }) {
  const showSplit = permission.status === 'granted-some-rooms'
  if (!showSplit && permission.unreadableRooms.length === 0) return null

  return (
    <dl className="mt-1.5 space-y-1 border-l border-outline-variant pl-2.5 text-label-sm">
      {showSplit ? (
        <>
          <PermissionRoomLine
            term="Allowed in"
            rooms={permission.grantedRooms}
            className="text-primary"
          />
          <PermissionRoomLine
            term="Not allowed in"
            rooms={permission.deniedRooms}
            className="text-on-surface-variant"
          />
        </>
      ) : null}
      <PermissionRoomLine
        term="Mesh could not read"
        rooms={permission.unreadableRooms}
        className="text-marker"
      />
    </dl>
  )
}

function PermissionRoomLine({
  term,
  rooms,
  className,
}: {
  term: string
  rooms: readonly { roomId: string; roomName: string }[]
  className: string
}) {
  if (rooms.length === 0) return null
  return (
    <div className="flex flex-wrap gap-x-1.5">
      <dt className={`font-medium ${className}`}>{term}:</dt>
      <dd className="text-on-surface-variant">{rooms.map((room) => room.roomName).join(', ')}</dd>
    </div>
  )
}

function aggregateLabel(
  status: CommunityPermissionAggregateStatus,
  scope: RolePermissionScope = 'community',
) {
  switch (status) {
    case 'granted-everywhere':
      return scope === 'room' ? 'Allowed' : 'All rooms'
    case 'granted-some-rooms':
      return 'Some rooms'
    case 'not-granted':
      return scope === 'room' ? 'Not allowed' : 'Not granted'
    case 'unknown':
      return 'Unknown'
  }
}

function aggregateTone(status: CommunityPermissionAggregateStatus) {
  switch (status) {
    case 'granted-everywhere':
      return 'flex-shrink-0 text-primary'
    case 'granted-some-rooms':
    case 'unknown':
      return 'flex-shrink-0 text-marker'
    case 'not-granted':
      return 'flex-shrink-0 text-on-surface-variant'
  }
}
