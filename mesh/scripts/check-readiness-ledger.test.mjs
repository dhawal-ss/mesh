import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import {
  DEFERRED_RELEASE_GATES,
  REQUIRED_RELEASE_GATES,
  ledgerPathFromGitRoot,
  validateReadinessLedger,
  validateSourceTreeBinding,
} from './check-readiness-ledger.mjs'

const sha = 'a'.repeat(40)
const treeHash = 'c'.repeat(40)
const testDirectory = dirname(fileURLToPath(import.meta.url))
const gitRoot = resolve(testDirectory, '..', '..')
const baseEvidence = {
  testedCommit: sha,
  testedTreeHash: treeHash,
  command: 'test command',
  artifactPath: 'release/evidence.txt',
  artifactUri: null,
  artifactSha256: '0'.repeat(64),
  environment: 'test',
  collectedAt: '2026-07-31T00:00:00Z',
  expiresAt: '2099-01-01T00:00:00Z',
}

function gate(overrides = {}) {
  return {
    id: 'r0.test',
    milestone: 'R0',
    required: true,
    releaseStatus: 'live-pass',
    status: 'live-pass',
    evidence: { ...baseEvidence },
    owner: 'test owner',
    capability: 'test capability',
    blockReason: null,
    nextAction: null,
    waiver: null,
    ...overrides,
  }
}

function ledger(overrides = {}) {
  return {
    schemaVersion: 2,
    ledgerId: 'mesh-production-readiness',
    sourceCommit: sha,
    sourceTreeHash: treeHash,
    updatedAt: '2026-07-31T00:00:00Z',
    gates: [gate()],
    ...overrides,
  }
}

describe('readiness ledger validator', () => {
  it('normalizes the ledger path relative to the actual Git root', () => {
    assert.equal(
      ledgerPathFromGitRoot(gitRoot),
      'mesh/release/readiness.json',
    )
  })

  it('requires live evidence to be tied to the source snapshot', () => {
    const errors = validateReadinessLedger(ledger(), { now: new Date('2026-08-01T00:00:00Z') })
    assert.ok(errors.some((error) => error.includes('artifact is missing')))
  })

  it('requires the explicit external release gate contract', () => {
    const errors = validateReadinessLedger(ledger(), { enforceGateContract: true })
    assert.equal(REQUIRED_RELEASE_GATES.length, 11)
    assert.equal(DEFERRED_RELEASE_GATES.length, 3)
    assert.ok(errors.some((error) => error.includes('r1.provider-identity-lifecycle')))
    assert.ok(errors.some((error) => error.includes('r1.admission-openid-verifier')))
    assert.ok(errors.some((error) => error.includes('r4.native-invitation-delivery')))
    assert.ok(errors.some((error) => error.includes('r4.manual-accessibility-cross-platform')))
  })

  it('rejects making owner-deferred capabilities beta requirements', () => {
    const deferredGates = DEFERRED_RELEASE_GATES.map(({ id }) => gate({
      id,
      milestone: 'R1',
      required: true,
      status: 'blocked',
      evidence: {
        testedCommit: null,
        testedTreeHash: null,
        command: null,
        artifactPath: null,
        artifactUri: null,
        artifactSha256: null,
        environment: null,
        collectedAt: null,
        expiresAt: null,
      },
      blockReason: 'disabled for beta',
      nextAction: 'review after beta',
    }))
    const errors = validateReadinessLedger(
      ledger({ gates: [...deferredGates, ...REQUIRED_RELEASE_GATES.map((expected) => gate(expected))] }),
      { enforceGateContract: true },
    )
    for (const expected of DEFERRED_RELEASE_GATES) {
      assert.ok(errors.some((error) => error.includes(`${expected.id}.required must be false`)))
    }
  })

  it('accepts immutable external evidence metadata for a live pass', () => {
    const document = ledger({
      gates: [gate({
        evidence: {
          ...baseEvidence,
          artifactPath: null,
          artifactUri: 'https://github.com/example/mesh/releases/download/v1.0.0/acceptance.json',
        },
      })],
    })
    assert.deepEqual(validateReadinessLedger(document, { now: new Date('2026-08-01T00:00:00Z') }), [])
  })

  it('rejects credential-bearing external evidence URLs', () => {
    const document = ledger({
      gates: [gate({
        evidence: {
          ...baseEvidence,
          artifactPath: null,
          artifactUri: 'https://github.com/example/acceptance.json?token=secret',
        },
      })],
    })
    const errors = validateReadinessLedger(document, { now: new Date('2026-08-01T00:00:00Z') })
    assert.ok(errors.some((error) => error.includes('must not contain credentials')))
  })

  it('rejects mutable and cross-SHA evidence URLs', () => {
    for (const artifactUri of [
      'https://github.com/example/mesh/releases/latest',
      `https://github.com/example/mesh/actions/runs/123/artifacts/${'b'.repeat(40)}`,
    ]) {
      const document = ledger({ gates: [gate({ evidence: { ...baseEvidence, artifactPath: null, artifactUri } })] })
      const errors = validateReadinessLedger(document, { now: new Date('2026-08-01T00:00:00Z') })
      assert.ok(errors.some((error) => error.includes('mutable or latest') || error.includes('another source SHA')))
    }
  })

  it('requires an immutable protected manifest for release-relevant R0 evidence', () => {
    const document = ledger({
      gates: [gate({
        releaseStatus: 'local-pass',
        status: 'local-pass',
        evidence: { ...baseEvidence, artifactPath: null, artifactUri: null, artifactSha256: null },
        nextAction: 'retain protected evidence',
      })],
    })
    const errors = validateReadinessLedger(document, { milestone: 'R0', requireLive: true, now: new Date('2026-08-01T00:00:00Z') })
    assert.ok(errors.some((error) => error.includes('protected artifact URI')))
    assert.ok(errors.some((error) => error.includes('artifact digest')))
  })

  it('rejects a required non-live gate in release mode', () => {
    const errors = validateReadinessLedger(
      ledger({ gates: [gate({ status: 'blocked', blockReason: 'not ready', nextAction: 'run it' })] }),
      { milestone: 'R2', requireLive: true },
    )
    assert.ok(errors.some((error) => error.includes('minimum is live-pass')))
  })

  it('rejects evidence from another snapshot', () => {
    const errors = validateReadinessLedger(
      ledger({ gates: [gate({ evidence: { ...baseEvidence, testedCommit: 'b'.repeat(40) } })] }),
    )
    assert.ok(errors.some((error) => error.includes('must equal sourceCommit')))
  })

  it('rejects a required R0 local-pass gate with null evidence fields', () => {
    const document = ledger({
      gates: [gate({
        releaseStatus: 'local-pass',
        status: 'local-pass',
        evidence: {
          testedCommit: null,
          testedTreeHash: null,
          command: null,
          artifactPath: null,
          artifactUri: null,
          artifactSha256: null,
          environment: null,
          collectedAt: null,
          expiresAt: null,
        },
        nextAction: 'collect evidence',
      })],
    })
    const errors = validateReadinessLedger(document)
    assert.ok(errors.some((error) => error.includes('local-pass evidence must use sourceCommit')))
    assert.ok(errors.some((error) => error.includes('local-pass evidence must use sourceTreeHash')))
    assert.ok(errors.some((error) => error.includes('local-pass evidence requires command')))
    assert.ok(errors.some((error) => error.includes('local-pass evidence requires environment')))
    assert.ok(errors.some((error) => error.includes('local-pass evidence requires collectedAt')))
  })

  it('rejects a local-pass gate whose tested tree differs from its source tree', () => {
    const errors = validateReadinessLedger(ledger({
      gates: [gate({
        releaseStatus: 'local-pass',
        status: 'local-pass',
        evidence: { ...baseEvidence, testedTreeHash: 'd'.repeat(40), artifactPath: null },
        nextAction: 'rerun before release',
      })],
    }))
    assert.ok(errors.some((error) => error.includes('must use sourceTreeHash')))
  })

  it('binds sourceTreeHash to the actual Git tree for sourceCommit', async () => {
    const matching = await validateSourceTreeBinding(
      ledger(),
      async () => ({ stdout: `${treeHash}\n` }),
    )
    assert.deepEqual(matching, [])

    const mismatched = await validateSourceTreeBinding(
      ledger(),
      async () => ({ stdout: `${'d'.repeat(40)}\n` }),
    )
    assert.ok(mismatched.some((error) => error.includes('does not match Git tree')))
  })

  it('fails closed when the source commit tree cannot be resolved', async () => {
    const errors = await validateSourceTreeBinding(ledger(), async () => {
      throw new Error('missing object')
    })
    assert.ok(errors.some((error) => error.includes('could not resolve the Git tree')))
  })

  it('rejects fields outside the readiness schema', () => {
    const document = ledger()
    document.gates[0].evidence.unreviewedClaim = true
    const errors = validateReadinessLedger(document)
    assert.ok(errors.some((error) => error.includes('unreviewedClaim is not allowed')))
  })

  it('can validate a ledger-only commit after the evidence snapshot', () => {
    const errors = validateReadinessLedger(
      ledger({
        gates: [gate({
          releaseStatus: 'local-pass',
          status: 'local-pass',
          evidence: {
            ...baseEvidence,
            artifactPath: null,
            expiresAt: null,
          },
          nextAction: 'rerun before the next release',
        })],
      }),
      {
        commitSha: 'b'.repeat(40),
        allowSourceCommitMismatch: true,
      },
    )
    assert.deepEqual(errors, [])
  })
})
