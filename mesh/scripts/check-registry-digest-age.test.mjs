import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  parseRegistryMaintenanceControl,
  registryCandidateEntries,
  validateRegistryDigestAges,
} from './check-registry-digest-age.mjs'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const now = new Date('2026-09-01T00:00:00.000Z')

async function fixture() {
  const [markdown, policyText] = await Promise.all([
    readFile(path.join(projectRoot, 'infra/REGISTRY_MAINTENANCE.md'), 'utf8'),
    readFile(path.join(projectRoot, 'infra/container-candidates/candidate-policy.json'), 'utf8'),
  ])
  const control = parseRegistryMaintenanceControl(markdown)
  const entries = registryCandidateEntries(JSON.parse(policyText), control)
  return { markdown, control, entries }
}

function evidence(entries, createdAt = '2026-08-03T00:00:00.000Z') {
  return new Map(entries.map((entry) => [entry.image, {
    digest: entry.digest,
    platformCreatedAt: {
      'linux/amd64': createdAt,
      'linux/arm64': '2026-08-04T00:00:00.000Z',
    },
  }]))
}

test('derives the owner, cadence, maximum age, registry, and images from tracked truth', async () => {
  const { control, entries } = await fixture()
  assert.equal(control.primaryOwner, 'Dhawal Shah')
  assert.equal(control.backupOwner, null)
  assert.equal(control.backupOwnerStatus, 'UNRESOLVED_OWNER_ASSIGNMENT_REQUIRED')
  assert.equal(control.rebuildCadenceDays, 28)
  assert.equal(control.maximumDigestAgeDays, 35)
  assert.deepEqual(entries.map((entry) => entry.name), ['caddy', 'lk-jwt-service'])
  assert.ok(entries.every((entry) => entry.image.startsWith('ghcr.io/dhawal-ss/')))
})

test('accepts both immutable platform configs inside the maximum age', async () => {
  const { control, entries } = await fixture()
  const result = validateRegistryDigestAges({
    entries,
    evidenceByImage: evidence(entries),
    maximumDigestAgeDays: control.maximumDigestAgeDays,
    now,
  })
  assert.deepEqual(result.errors, [])
  assert.equal(result.results.length, 2)
  assert.equal(result.results[0].oldestCreatedAt, '2026-08-03T00:00:00.000Z')
  assert.equal(result.results[0].ageDays, 29)
})

test('fails closed when the oldest immutable config exceeds maximum age', async () => {
  const { control, entries } = await fixture()
  const result = validateRegistryDigestAges({
    entries,
    evidenceByImage: evidence(entries, '2026-07-27T23:59:59.000Z'),
    maximumDigestAgeDays: control.maximumDigestAgeDays,
    now,
  })
  assert.equal(result.errors.length, 2)
  assert.ok(result.errors.every((error) => /published digest is expired/u.test(error)))
})

test('rejects missing platforms, wrong digests, unexpected platforms, and future timestamps', async () => {
  const { control, entries } = await fixture()
  const observations = evidence(entries)
  observations.get(entries[0].image).digest = `sha256:${'f'.repeat(64)}`
  delete observations.get(entries[0].image).platformCreatedAt['linux/arm64']
  observations.get(entries[1].image).platformCreatedAt['linux/amd64'] = '2026-09-01T00:00:01.000Z'
  observations.get(entries[1].image).platformCreatedAt['linux/s390x'] = '2026-08-04T00:00:00.000Z'
  const errors = validateRegistryDigestAges({
    entries,
    evidenceByImage: observations,
    maximumDigestAgeDays: control.maximumDigestAgeDays,
    now,
  }).errors.join('; ')
  assert.match(errors, /does not bind the policy digest/u)
  assert.match(errors, /linux\/arm64 immutable config creation time is missing or invalid/u)
  assert.match(errors, /creation time is in the future/u)
  assert.match(errors, /unexpected platforms/u)
})

test('rejects an ambiguous or weakened machine-enforced maintenance contract', async () => {
  const { markdown } = await fixture()
  assert.throws(
    () => parseRegistryMaintenanceControl(`${markdown}\n${markdown}`),
    /exactly one machine-enforced control block/u,
  )
  const noBackupStatus = markdown.replace('"UNRESOLVED_OWNER_ASSIGNMENT_REQUIRED"', '"not assigned"')
  assert.throws(() => parseRegistryMaintenanceControl(noBackupStatus), /backup owner/u)
  const shorterMaximum = markdown.replace('"maximumDigestAgeDays": 35', '"maximumDigestAgeDays": 14')
  assert.throws(() => parseRegistryMaintenanceControl(shorterMaximum), /shorter than the rebuild cadence/u)
})
