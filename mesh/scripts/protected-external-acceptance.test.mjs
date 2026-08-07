import { createHash } from 'node:crypto'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { requiredExternalAcceptanceIdsForMilestone } from './check-external-acceptance.mjs'
import {
  PROTECTED_EXTERNAL_ACCEPTANCE_ENTRY,
  PROTECTED_EXTERNAL_ACCEPTANCE_WORKFLOW,
  verifyProtectedExternalAcceptanceEvidence,
} from './protected-external-acceptance.mjs'
import {
  downloadGitHubActionsArtifact,
  extractSingleJsonArchive,
  MAX_PROTECTED_ARCHIVE_BYTES,
  MAX_PROTECTED_JSON_BYTES,
} from './protected-readiness-evidence.mjs'

const sourceSha = 'a'.repeat(40)
const treeHash = 'c'.repeat(40)
const artifactUrl = 'https://github.com/dhawal-ss/mesh/actions/runs/456/artifacts/789'
const testedAt = '2026-08-04T00:00:00Z'
const expiresAt = '2026-09-04T00:00:00Z'
const now = new Date('2026-08-05T00:00:00Z')
const scriptDirectory = dirname(fileURLToPath(import.meta.url))
const template = JSON.parse(readFileSync(resolve(scriptDirectory, '..', 'release', 'external-acceptance.example.json'), 'utf8'))

function archive(label = 'external-acceptance') {
  return Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from(label)])
}

function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function liveAcceptance() {
  const document = structuredClone(template)
  const resultIds = requiredExternalAcceptanceIdsForMilestone('R2')
  document.acceptanceMilestone = 'R2'
  document.sourceSha = sourceSha
  document.releaseTag = 'v0.2.0'
  document.status = 'passed'
  document.testedAt = testedAt
  document.expiresAt = expiresAt
  document.operator = 'release acceptance operator'
  document.artifacts = [{
    id: 'r2-campaign-log',
    path: 'r2-campaign.log',
    sha256: 'd'.repeat(64),
    bytes: 64,
    mediaType: 'text/plain',
    collectedAt: testedAt,
    sanitized: true,
    privacyReviewer: null,
    resultIds,
  }]
  const required = new Set(resultIds)
  for (const result of document.results) {
    if (!required.has(result.id)) continue
    result.status = 'passed'
    result.environment = 'signed Windows beta and independently operated public services'
    result.notes = 'Acceptance result reviewed for the exact candidate.'
    result.evidenceIds = ['r2-campaign-log']
  }
  return document
}

function makeFixture() {
  const bytes = archive()
  const evidence = {
    testedCommit: sourceSha,
    testedTreeHash: treeHash,
    command: 'protected external acceptance campaign',
    artifactPath: null,
    artifactUri: artifactUrl,
    artifactSha256: digest(bytes),
    artifactRunAttempt: 1,
    environment: 'protected GitHub Actions main push',
    collectedAt: testedAt,
    expiresAt,
  }
  const gate = (id, milestone) => ({
    id,
    milestone,
    required: true,
    releaseStatus: 'live-pass',
    status: 'live-pass',
    evidence: structuredClone(evidence),
  })
  return {
    bytes,
    document: liveAcceptance(),
    ledger: {
      sourceCommit: sourceSha,
      sourceTreeHash: treeHash,
      gates: [
        gate('r1.clean-device-onboarding', 'R1'),
        gate('r2.signed-windows-beta', 'R2'),
      ],
    },
  }
}

function dependencies(fixture) {
  const calls = []
  return {
    calls,
    downloadArtifact: async (url, options) => {
      calls.push({ url, options })
      return fixture.bytes
    },
    extractSingleJson: async () => ({
      entryName: PROTECTED_EXTERNAL_ACCEPTANCE_ENTRY,
      value: structuredClone(fixture.document),
    }),
  }
}

describe('protected R2 external acceptance verifier', () => {
  it('binds one comprehensive live campaign to every required R1/R2 gate', async () => {
    const fixture = makeFixture()
    const injected = dependencies(fixture)
    assert.deepEqual(await verifyProtectedExternalAcceptanceEvidence(fixture.ledger, {
      milestone: 'R2',
      now,
      ...injected,
    }), [])
    assert.equal(injected.calls.length, 1)
    assert.equal(injected.calls[0].url, artifactUrl)
    assert.equal(injected.calls[0].options.expectedSourceCommit, sourceSha)
    assert.equal(injected.calls[0].options.expectedWorkflowName, PROTECTED_EXTERNAL_ACCEPTANCE_WORKFLOW)
    assert.equal(injected.calls[0].options.expectedRunAttempt, 1)
  })

  it('rejects foreign repositories and split campaign artifacts before download', async () => {
    const fixture = makeFixture()
    const injected = dependencies(fixture)
    fixture.ledger.gates[0].evidence.artifactUri = 'https://github.com/attacker/mesh/actions/runs/456/artifacts/789'
    let errors = await verifyProtectedExternalAcceptanceEvidence(fixture.ledger, { now, ...injected })
    assert.ok(errors.some((error) => error.includes('dhawal-ss/mesh')))
    assert.equal(injected.calls.length, 0)

    const split = makeFixture()
    split.ledger.gates[1].evidence.artifactUri = 'https://github.com/dhawal-ss/mesh/actions/runs/456/artifacts/790'
    errors = await verifyProtectedExternalAcceptanceEvidence(split.ledger, { now, ...dependencies(split) })
    assert.ok(errors.some((error) => error.includes('one comprehensive protected campaign')))
  })

  it('rejects wrong digests, oversized downloads, and wrong archive shapes', async () => {
    const digestFixture = makeFixture()
    digestFixture.ledger.gates.forEach((gate) => { gate.evidence.artifactSha256 = '0'.repeat(64) })
    let errors = await verifyProtectedExternalAcceptanceEvidence(digestFixture.ledger, {
      now,
      ...dependencies(digestFixture),
    })
    assert.ok(errors.some((error) => error.includes('SHA-256 does not match')))

    const oversized = makeFixture()
    const oversizedDependencies = dependencies(oversized)
    oversizedDependencies.downloadArtifact = async () => Buffer.alloc(MAX_PROTECTED_ARCHIVE_BYTES + 1)
    errors = await verifyProtectedExternalAcceptanceEvidence(oversized.ledger, { now, ...oversizedDependencies })
    assert.ok(errors.some((error) => error.includes('must be between')))

    const shape = makeFixture()
    const shapeDependencies = dependencies(shape)
    shapeDependencies.extractSingleJson = async () => ({ entryName: 'other.json', value: shape.document })
    errors = await verifyProtectedExternalAcceptanceEvidence(shape.ledger, { now, ...shapeDependencies })
    assert.ok(errors.some((error) => error.includes(`exactly ${PROTECTED_EXTERNAL_ACCEPTANCE_ENTRY}`)))
  })

  it('rejects stale evidence and the fail-closed template', async () => {
    const stale = makeFixture()
    stale.document.expiresAt = '2026-08-04T12:00:00Z'
    stale.ledger.gates.forEach((gate) => { gate.evidence.expiresAt = stale.document.expiresAt })
    let errors = await verifyProtectedExternalAcceptanceEvidence(stale.ledger, { now, ...dependencies(stale) })
    assert.ok(errors.some((error) => error.includes('expired')))

    const templateFixture = makeFixture()
    templateFixture.document = structuredClone(template)
    errors = await verifyProtectedExternalAcceptanceEvidence(templateFixture.ledger, {
      now,
      ...dependencies(templateFixture),
    })
    assert.ok(errors.some((error) => error.includes('document status passed')))
  })

  it('rejects multi-entry and nested ZIP archive shapes before parsing JSON', async () => {
    await assert.rejects(
      extractSingleJsonArchive(archive('shape'), {
        runCommand: async (_command, args) => args[0] === '-Z1'
          ? { stdout: 'external-acceptance.json\nextra.json\n' }
          : { stdout: Buffer.from('{}') },
      }),
      /exactly one root-level JSON/u,
    )
    await assert.rejects(
      extractSingleJsonArchive(archive('nested'), {
        runCommand: async (_command, args) => args[0] === '-Z1'
          ? { stdout: 'nested/external-acceptance.json\n' }
          : { stdout: Buffer.from('{}') },
      }),
      /exactly one root-level JSON/u,
    )
    await assert.rejects(
      extractSingleJsonArchive(archive('oversized-json'), {
        runCommand: async (_command, args) => args[0] === '-Z1'
          ? { stdout: 'external-acceptance.json\n' }
          : { stdout: Buffer.alloc(MAX_PROTECTED_JSON_BYTES + 1) },
      }),
      /protected JSON must be between/u,
    )
  })
})

describe('external acceptance GitHub provenance boundary', () => {
  const metadata = (bytes, overrides = {}) => ({
    id: 789,
    expired: false,
    size_in_bytes: bytes.length,
    archive_download_url: 'https://api.github.com/repos/dhawal-ss/mesh/actions/artifacts/789/zip',
    created_at: '2026-08-04T00:05:00Z',
    workflow_run: { id: 456, head_sha: sourceSha, head_branch: 'main' },
    ...overrides,
  })
  const run = (overrides = {}) => ({
    id: 456,
    name: 'CI',
    path: '.github/workflows/ci.yml@refs/heads/main',
    event: 'push',
    status: 'completed',
    conclusion: 'success',
    head_sha: sourceSha,
    head_branch: 'main',
    run_attempt: 1,
    run_started_at: '2026-08-04T00:00:00Z',
    updated_at: '2026-08-04T00:10:00Z',
    repository: { full_name: 'dhawal-ss/mesh' },
    head_repository: { full_name: 'dhawal-ss/mesh' },
    ...overrides,
  })

  it('rejects wrong SHA, workflow, event, branch, and repository metadata', async () => {
    const bytes = archive('provenance')
    const invoke = (metadataOverrides = {}, runOverrides = {}) => downloadGitHubActionsArtifact(artifactUrl, {
      expectedSourceCommit: sourceSha,
      expectedWorkflowName: PROTECTED_EXTERNAL_ACCEPTANCE_WORKFLOW,
      expectedRunAttempt: 1,
      fetchImpl: async (url) => {
        if (url.endsWith('/actions/runs/456/attempts/1')) return new Response(JSON.stringify(run(runOverrides)), { status: 200 })
        if (url.endsWith('/zip')) return new Response(bytes, { status: 200 })
        return new Response(JSON.stringify(metadata(bytes, metadataOverrides)), { status: 200 })
      },
    })

    assert.deepEqual(await invoke(), bytes)
    await assert.rejects(invoke({ workflow_run: { id: 456, head_sha: 'b'.repeat(40), head_branch: 'main' } }), /main-branch run and source commit/u)
    await assert.rejects(invoke({}, { path: '.github/workflows/security.yml@refs/heads/main' }), /successful protected CI push/u)
    await assert.rejects(invoke({}, { event: 'workflow_dispatch' }), /successful protected CI push/u)
    await assert.rejects(invoke({}, { head_branch: 'release' }), /successful protected CI push/u)
    await assert.rejects(invoke({}, { repository: { full_name: 'attacker/mesh' } }), /successful protected CI push/u)
    await assert.rejects(invoke({}, { run_attempt: 2 }), /successful protected CI push/u)
    await assert.rejects(invoke({ created_at: '2026-08-04T00:11:00Z' }), /expected workflow run attempt/u)
  })
})
