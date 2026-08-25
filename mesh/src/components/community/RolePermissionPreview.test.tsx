import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  MATRIX_COMMUNITY_PERMISSION_POLICY_V1,
  type CommunityPermissionProjection,
} from '../../lib/community-permissions'
import { RolePermissionPreview } from './RolePermissionPreview'

describe('RolePermissionPreview', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
  })

  it('labels a role template as proposed rather than current state', async () => {
    await render(
      <RolePermissionPreview
        role="admin"
        previousRole="member"
        memberName="Bob"
        evidence={{ kind: 'template', policy: MATRIX_COMMUNITY_PERMISSION_POLICY_V1 }}
      />,
    )

    expect(container.textContent).toContain('Administrator role preview')
    expect(container.textContent).toContain('Bob would receive the Administrator role')
    expect(container.textContent).toContain('This is a preview and has not been applied')
    expect(container.textContent).toContain('Would gain moderate messages')
    expect(container.textContent).not.toContain('Current effective permissions')
  })

  it('renders loading and retryable unavailable states without a default fallback', async () => {
    await render(
      <RolePermissionPreview role="admin" evidence={{ kind: 'loading' }} />,
    )
    expect(container.querySelector('[aria-busy="true"]')).not.toBeNull()
    expect(container.querySelector('[role="status"]')?.textContent)
      .toContain('Reading the community and each connected room')
    expect(container.textContent).not.toContain('Template grants')

    const retry = vi.fn()
    const diagnostics = vi.fn()
    await render(
      <RolePermissionPreview
        role="admin"
        evidence={{
          kind: 'unavailable',
          message: 'Federated support could not be read.',
          onRetry: retry,
          onDiagnostics: diagnostics,
        }}
      />,
    )
    expect(container.querySelector('[role="alert"]')?.textContent)
      .toContain('Federated support could not be read')
    await act(async () => {
      findButton('Retry').click()
      findButton('View permission details').click()
    })
    expect(retry).toHaveBeenCalledOnce()
    expect(diagnostics).toHaveBeenCalledOnce()
  })

  it('distinguishes current partial permissions from unknown room state', async () => {
    const partial = projection()
    partial.rooms[1].policy!.ban = 75
    await render(
      <RolePermissionPreview
        role="admin"
        evidence={{ kind: 'current', projection: partial, userId: '@admin:example.org' }}
      />,
    )
    expect(container.textContent).toContain('Current effective permissions')
    expect(container.querySelector('[role="status"]')?.textContent)
      .toContain('Some permissions differ between rooms')
    expect(container.textContent).toContain('Some rooms')

    const unknown = projection()
    unknown.rooms[1] = {
      ...unknown.rooms[1],
      status: 'inaccessible',
      policy: null,
      failureReason: 'This federated room is not joined on this account.',
    }
    await render(
      <RolePermissionPreview
        role="admin"
        evidence={{ kind: 'proposed', projection: unknown, userId: '@member:example.org' }}
      />,
    )
    expect(container.querySelector('[role="alert"]')?.textContent)
      .toContain("Mesh couldn't confirm permissions in every room")
    expect(container.textContent).toContain('Federated support:')
    expect(container.textContent).toContain('Unknown')
  })

  it('names the rooms behind a partial verdict when asked to', async () => {
    const partial = projection()
    partial.rooms[1].policy!.ban = 75
    await render(
      <RolePermissionPreview
        role="admin"
        nameRooms
        evidence={{ kind: 'current', projection: partial, userId: '@admin:example.org' }}
      />,
    )

    expect(container.textContent).toContain('Some rooms')
    expect(container.textContent).toContain('Allowed in:')
    expect(container.textContent).toContain('Community')
    expect(container.textContent).toContain('Not allowed in:')
    expect(container.textContent).toContain('Federated support')
  })

  it('names an unreadable room as unread rather than as a refusal', async () => {
    const unknown = projection()
    unknown.rooms[1] = {
      ...unknown.rooms[1],
      status: 'inaccessible',
      policy: null,
      failureReason: 'This federated room is not joined on this account.',
    }
    await render(
      <RolePermissionPreview
        role="admin"
        nameRooms
        evidence={{ kind: 'current', projection: unknown, userId: '@admin:example.org' }}
      />,
    )

    expect(container.textContent).toContain('Mesh could not read:')
    expect(container.textContent).not.toContain('Not allowed in:')
  })

  it('answers for a single room without community-wide wording', async () => {
    const single = projection()
    single.rooms = [single.rooms[0]]
    await render(
      <RolePermissionPreview
        role="member"
        scope="room"
        evidence={{ kind: 'current', projection: single, userId: '@member:example.org' }}
      />,
    )

    expect(container.textContent).toContain('Allowed')
    expect(container.textContent).not.toContain('All rooms')
    expect(container.textContent).toContain('Read from this room’s current permissions.')
  })

  it('says it could not read a room instead of reporting a denial', async () => {
    const unreadable = projection()
    unreadable.rooms = [{
      ...unreadable.rooms[0],
      status: 'failed',
      policy: null,
      failureReason: 'The room state could not be read.',
    }]
    await render(
      <RolePermissionPreview
        role="member"
        scope="room"
        evidence={{ kind: 'current', projection: unreadable, userId: '@member:example.org' }}
      />,
    )

    expect(container.querySelector('[role="alert"]')?.textContent)
      .toContain('Mesh could not read this room’s permissions.')
    expect(container.textContent).not.toContain('Not allowed')
  })

  async function render(element: React.ReactNode) {
    await act(async () => {
      root.render(element)
    })
  }

  function findButton(label: string) {
    const button = [...container.querySelectorAll<HTMLButtonElement>('button')]
      .find((candidate) => candidate.textContent === label)
    if (!button) throw new Error(`Button not found: ${label}`)
    return button
  }
})

function projection(): CommunityPermissionProjection {
  const policy = {
    users: {
      '@owner:example.org': 100,
      '@admin:example.org': 50,
      '@member:example.org': 0,
    },
    usersDefault: 0,
    events: { 'm.room.power_levels': 100 },
    eventsDefault: 0,
    stateDefault: 50,
    ban: 50,
    kick: 50,
    invite: 0,
    redact: 50,
    notifications: { room: 50 },
    creatorUserIds: ['@owner:example.org'],
    privilegedCreatorUserIds: [],
  }
  return {
    communityId: '!space:example.org',
    subjectUserId: '@admin:example.org',
    discoveryComplete: true,
    discoveryFailureReason: null,
    aggregate: [],
    rooms: [
      {
        roomId: '!space:example.org',
        roomName: 'Community',
        roomKind: 'space',
        status: 'loaded',
        policy: structuredClone(policy),
        failureReason: null,
      },
      {
        roomId: '!federated:remote.org',
        roomName: 'Federated support',
        roomKind: 'room',
        status: 'loaded',
        policy: structuredClone(policy),
        failureReason: null,
      },
    ],
  }
}
