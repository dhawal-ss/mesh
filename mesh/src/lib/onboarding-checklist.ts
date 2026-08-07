import {
  getSafeLocalStorage,
  safeStorageRead,
  safeStorageRemove,
  safeStorageSet,
  type StorageLike,
} from './safe-storage'

export const NEWCOMER_CHECKLIST_STORAGE_KEY = 'mesh-newcomer-checklists-v1'
export const NEWCOMER_CHECKLIST_EVENT = 'mesh:newcomer-checklist-change'

const MAX_DOCUMENT_BYTES = 64 * 1024
const MAX_ENTRIES = 32
const MAX_IDENTIFIER_LENGTH = 512
const UNSAFE_IDENTIFIER_PATTERN = /[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u

export type NewcomerChecklistStepId =
  | 'account-ready'
  | 'invitation-ready'
  | 'community-ready'
  | 'room-opened'
  | 'draft-opened'

export interface NewcomerChecklistEntry {
  schemaVersion: 1
  accountId: string
  communityId: string
  invitationResolvedAt: number
  draftOpenedAt: number | null
  dismissed: boolean
  updatedAt: number
}

export interface NewcomerChecklistFacts {
  accountSignedIn: boolean
  invitationResolved: boolean
  communityJoined: boolean
  channelOpened: boolean
  draftOpened: boolean
}

export interface NewcomerChecklistStep {
  id: NewcomerChecklistStepId
  label: string
  complete: boolean
}

interface NewcomerChecklistDocument {
  schemaVersion: 1
  entries: NewcomerChecklistEntry[]
}

function defaultStorage(): StorageLike | null {
  return getSafeLocalStorage()
}

function validIdentifier(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= MAX_IDENTIFIER_LENGTH
    && !UNSAFE_IDENTIFIER_PATTERN.test(value)
}

function validTimestamp(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function validEntry(value: unknown): value is NewcomerChecklistEntry {
  if (!isRecord(value)) return false
  const keys = Object.keys(value)
  if (
    keys.length !== 7
    || ![
      'schemaVersion',
      'accountId',
      'communityId',
      'invitationResolvedAt',
      'draftOpenedAt',
      'dismissed',
      'updatedAt',
    ].every((key) => keys.includes(key))
  ) {
    return false
  }
  return value.schemaVersion === 1
    && validIdentifier(value.accountId)
    && validIdentifier(value.communityId)
    && validTimestamp(value.invitationResolvedAt)
    && (value.draftOpenedAt === null || validTimestamp(value.draftOpenedAt))
    && typeof value.dismissed === 'boolean'
    && validTimestamp(value.updatedAt)
}

function documentBytes(serialized: string): number {
  return new TextEncoder().encode(serialized).byteLength
}

function readDocument(
  storage: StorageLike | null | undefined = defaultStorage(),
): NewcomerChecklistDocument | null {
  const read = safeStorageRead(storage, NEWCOMER_CHECKLIST_STORAGE_KEY)
  if (!read.ok || read.value === null) return null
  if (documentBytes(read.value) > MAX_DOCUMENT_BYTES) {
    safeStorageRemove(storage, NEWCOMER_CHECKLIST_STORAGE_KEY)
    return null
  }
  try {
    const parsed: unknown = JSON.parse(read.value)
    if (
      !isRecord(parsed)
      || parsed.schemaVersion !== 1
      || !Array.isArray(parsed.entries)
      || parsed.entries.length > MAX_ENTRIES
      || !parsed.entries.every(validEntry)
    ) {
      safeStorageRemove(storage, NEWCOMER_CHECKLIST_STORAGE_KEY)
      return null
    }
    const scopes = new Set<string>()
    for (const entry of parsed.entries) {
      const scope = newcomerChecklistScopeKey(entry.accountId, entry.communityId)
      if (scopes.has(scope)) {
        safeStorageRemove(storage, NEWCOMER_CHECKLIST_STORAGE_KEY)
        return null
      }
      scopes.add(scope)
    }
    return { schemaVersion: 1, entries: parsed.entries }
  } catch {
    safeStorageRemove(storage, NEWCOMER_CHECKLIST_STORAGE_KEY)
    return null
  }
}

function writeDocument(
  document: NewcomerChecklistDocument,
  storage: StorageLike | null | undefined,
): boolean {
  const serialized = JSON.stringify(document)
  if (documentBytes(serialized) > MAX_DOCUMENT_BYTES) return false
  return safeStorageSet(storage, NEWCOMER_CHECKLIST_STORAGE_KEY, serialized)
}

function announceChecklistChange(): void {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(NEWCOMER_CHECKLIST_EVENT))
}

function upsertEntry({
  accountId,
  communityId,
  storage = defaultStorage(),
  update,
}: {
  accountId: string
  communityId: string
  storage?: StorageLike | null
  update: (current: NewcomerChecklistEntry | null) => NewcomerChecklistEntry | null
}): NewcomerChecklistEntry | null {
  if (!validIdentifier(accountId) || !validIdentifier(communityId)) return null
  const currentDocument = readDocument(storage) ?? { schemaVersion: 1, entries: [] }
  const scope = newcomerChecklistScopeKey(accountId, communityId)
  const current = currentDocument.entries.find(
    (entry) => newcomerChecklistScopeKey(entry.accountId, entry.communityId) === scope,
  ) ?? null
  const next = update(current)
  if (!next || !validEntry(next)) return current
  if (next === current) return current ? { ...current } : null

  const entries = [
    next,
    ...currentDocument.entries.filter(
      (entry) => newcomerChecklistScopeKey(entry.accountId, entry.communityId) !== scope,
    ),
  ]
    .sort((left, right) => right.updatedAt - left.updatedAt)
    .slice(0, MAX_ENTRIES)
  if (!writeDocument({ schemaVersion: 1, entries }, storage)) return current
  announceChecklistChange()
  return { ...next }
}

export function newcomerChecklistScopeKey(accountId: string, communityId: string): string {
  return `${encodeURIComponent(accountId)}::${encodeURIComponent(communityId)}`
}

export function beginNewcomerChecklist({
  accountId,
  communityId,
  occurredAt = Date.now(),
  storage = defaultStorage(),
}: {
  accountId: string
  communityId: string
  occurredAt?: number
  storage?: StorageLike | null
}): NewcomerChecklistEntry | null {
  if (!validTimestamp(occurredAt)) return null
  return upsertEntry({
    accountId,
    communityId,
    storage,
    update: (current) => ({
      schemaVersion: 1,
      accountId,
      communityId,
      invitationResolvedAt: current?.invitationResolvedAt ?? occurredAt,
      draftOpenedAt: current?.draftOpenedAt ?? null,
      dismissed: false,
      updatedAt: occurredAt,
    }),
  })
}

export function markNewcomerDraftOpened({
  accountId,
  communityId,
  occurredAt = Date.now(),
  storage = defaultStorage(),
}: {
  accountId: string
  communityId: string
  occurredAt?: number
  storage?: StorageLike | null
}): NewcomerChecklistEntry | null {
  if (!validTimestamp(occurredAt)) return null
  return upsertEntry({
    accountId,
    communityId,
    storage,
    update: (current) => {
      if (!current || current.draftOpenedAt !== null) return current
      return { ...current, draftOpenedAt: occurredAt, updatedAt: occurredAt }
    },
  })
}

export function setNewcomerChecklistDismissed({
  accountId,
  communityId,
  dismissed,
  occurredAt = Date.now(),
  storage = defaultStorage(),
}: {
  accountId: string
  communityId: string
  dismissed: boolean
  occurredAt?: number
  storage?: StorageLike | null
}): NewcomerChecklistEntry | null {
  if (!validTimestamp(occurredAt)) return null
  return upsertEntry({
    accountId,
    communityId,
    storage,
    update: (current) => current
      ? { ...current, dismissed, updatedAt: occurredAt }
      : null,
  })
}

export function readNewcomerChecklist(
  accountId: string,
  communityId: string,
  storage: StorageLike | null = defaultStorage(),
): NewcomerChecklistEntry | null {
  if (!validIdentifier(accountId) || !validIdentifier(communityId)) return null
  const scope = newcomerChecklistScopeKey(accountId, communityId)
  const entry = readDocument(storage)?.entries.find(
    (candidate) => newcomerChecklistScopeKey(candidate.accountId, candidate.communityId) === scope,
  )
  return entry ? { ...entry } : null
}

export function clearNewcomerChecklistsForAccount(
  accountId: string,
  storage: StorageLike | null = defaultStorage(),
): boolean {
  if (!validIdentifier(accountId)) return false
  const document = readDocument(storage)
  if (!document) return true
  const entries = document.entries.filter((entry) => entry.accountId !== accountId)
  if (entries.length === document.entries.length) return true
  const updated = entries.length === 0
    ? safeStorageRemove(storage, NEWCOMER_CHECKLIST_STORAGE_KEY)
    : writeDocument({ schemaVersion: 1, entries }, storage)
  if (updated) announceChecklistChange()
  return updated
}

export function deriveNewcomerChecklistSteps(
  facts: NewcomerChecklistFacts,
): NewcomerChecklistStep[] {
  return [
    { id: 'account-ready', label: 'Account ready', complete: facts.accountSignedIn },
    { id: 'invitation-ready', label: 'Invitation confirmed', complete: facts.invitationResolved },
    { id: 'community-ready', label: 'Community joined', complete: facts.communityJoined },
    { id: 'room-opened', label: 'Room opened', complete: facts.channelOpened },
    { id: 'draft-opened', label: 'Start a message', complete: facts.draftOpened },
  ]
}
