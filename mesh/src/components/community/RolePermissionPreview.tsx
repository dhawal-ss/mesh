import { useId } from 'react'
import {
  COMMUNITY_ROLE_TEMPLATES,
  aggregateCommunityPermissionProjection,
  compareCommunityRolePermissions,
  getCommunityPermissionMetadata,
  getEffectiveCommunityPermissions,
  type CommunityPermissionAggregateStatus,
  type CommunityPermissionProjection,
  type CommunityRole,
  type MatrixCommunityPermissionPolicy,
} from '../../lib/community-permissions'
import { Button } from '../ui/Button'

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
}

export function RolePermissionPreview({
  role,
  previousRole,
  memberName,
  evidence,
}: RolePermissionPreviewProps) {
  const headingId = useId()

  if (evidence.kind === 'loading') {
    return (
      <section
        aria-labelledby={headingId}
        aria-busy="true"
        className="space-y-2 rounded-panel border border-border-subtle bg-surface-sunken p-4"
      >
        <h3 id={headingId} className="text-sm font-semibold text-primary">
          Checking current permissions
        </h3>
        <p className="text-xs text-muted" role="status" aria-live="polite">
          Reading the community and each connected room…
        </p>
      </section>
    )
  }

  if (evidence.kind === 'unavailable') {
    return (
      <section
        aria-labelledby={headingId}
        className="space-y-3 rounded-panel border border-status-warning/30 bg-status-warning/10 p-4"
      >
        <div>
          <h3 id={headingId} className="text-sm font-semibold text-primary">
            Unable to verify permissions
          </h3>
          <p className="mt-1 text-xs text-muted" role="alert">
            {evidence.message
              ?? 'Mesh could not read authoritative permission state for every room.'}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {evidence.onRetry ? (
            <Button size="sm" onClick={evidence.onRetry}>Retry</Button>
          ) : null}
          <Button size="sm" variant="outline" onClick={evidence.onDiagnostics}>
            View diagnostics
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
  const permissions = aggregateCommunityPermissionProjection(evidence.projection, target)
  const hasUnknown = permissions.some((permission) => permission.status === 'unknown')
  const hasPartial = permissions.some(
    (permission) => permission.status === 'granted-some-rooms',
  )
  const title = evidence.kind === 'current'
    ? 'Current effective permissions'
    : `Proposed ${COMMUNITY_ROLE_TEMPLATES[role].label} permissions`

  return (
    <section
      aria-labelledby={headingId}
      className="space-y-3 rounded-panel border border-border-subtle bg-surface-sunken p-4"
    >
      <div>
        <h3 id={headingId} className="text-sm font-semibold text-primary">{title}</h3>
        <p className="mt-1 text-xs text-muted">
          Based on current permissions in this community and its rooms.
        </p>
      </div>

      {hasUnknown ? (
        <p className="text-xs text-status-warning" role="alert">
          Mesh couldn&apos;t confirm permissions in every room.
        </p>
      ) : hasPartial ? (
        <p className="text-xs text-status-warning" role="status" aria-live="polite">
          Some permissions differ between rooms. Review what each room allows before applying.
        </p>
      ) : (
        <p className="text-xs text-secondary" role="status" aria-live="polite">
          Verified across {evidence.projection.rooms.length}{' '}
          {evidence.projection.rooms.length === 1 ? 'room' : 'rooms'}.
        </p>
      )}

      <ul className="space-y-2" aria-label="Effective permission results">
        {permissions.map((permission) => {
          const metadata = getCommunityPermissionMetadata(permission.permissionId)
          return (
            <li
              key={permission.permissionId}
              className="flex items-start justify-between gap-3 text-xs"
            >
              <span>
                <span className="block font-medium text-secondary">{metadata.label}</span>
                <span className="block text-muted">{metadata.description}</span>
              </span>
              <span className={aggregateTone(permission.status)}>
                {aggregateLabel(permission.status)}
              </span>
            </li>
          )
        })}
      </ul>

      {hasUnknown ? (
        <ul className="space-y-1 border-t border-border-subtle pt-3 text-xs text-muted">
          {evidence.projection.rooms
            .filter((room) => room.status !== 'loaded' && room.status !== 'matrix-default')
            .map((room) => (
              <li key={room.roomId}>
                <span className="font-medium text-secondary">{room.roomName}:</span>{' '}
                {room.failureReason ?? 'Permission state unavailable.'}
              </li>
            ))}
          {!evidence.projection.discoveryComplete ? (
            <li>
              {evidence.projection.discoveryFailureReason
                ?? 'One or more connected rooms could not be discovered.'}
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
      className="space-y-3 rounded-panel border border-border-subtle bg-surface-sunken p-4"
    >
      <div>
        <h3 id={headingId} className="text-sm font-semibold text-primary">
          {template.label} role preview
        </h3>
        <p className="mt-1 text-xs text-muted">
          {subject} would receive the {template.label} role. {template.summary}
        </p>
      </div>
      <p className="text-xs text-status-warning" role="status">
        This is a preview and has not been applied.
      </p>
      {comparison && (comparison.gained.length > 0 || comparison.lost.length > 0) ? (
        <p className="text-xs text-secondary" role="status" aria-live="polite">
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
          <li key={permission.id} className="flex justify-between gap-3 text-xs">
            <span className="font-medium text-secondary">{permission.label}</span>
            <span className={permission.granted ? 'text-status-success' : 'text-muted'}>
              {permission.granted ? 'Template grants' : 'Template does not grant'}
            </span>
          </li>
        ))}
      </ul>
    </section>
  )
}

function aggregateLabel(status: CommunityPermissionAggregateStatus) {
  switch (status) {
    case 'granted-everywhere':
      return 'All rooms'
    case 'granted-some-rooms':
      return 'Some rooms'
    case 'not-granted':
      return 'Not granted'
    case 'unknown':
      return 'Unknown'
  }
}

function aggregateTone(status: CommunityPermissionAggregateStatus) {
  switch (status) {
    case 'granted-everywhere':
      return 'flex-shrink-0 text-status-success'
    case 'granted-some-rooms':
    case 'unknown':
      return 'flex-shrink-0 text-status-warning'
    case 'not-granted':
      return 'flex-shrink-0 text-muted'
  }
}
