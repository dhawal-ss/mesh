import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { REQUIRED_RELEASE_GATES, ledgerPathFromGitRoot, validateReadinessLedger } from './check-readiness-ledger.mjs'

const sha = 'a'.repeat(40)
const baseEvidence = {
  commitSha: sha,
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
    schemaVersion: 1,
    ledgerId: 'mesh-production-readiness',
    releaseSha: sha,
    updatedAt: '2026-07-31T00:00:00Z',
    gates: [gate()],
    ...overrides,
  }
}

describe('readiness ledger validator', () => {
  it('normalizes the ledger path relative to the actual Git root', () => {
    assert.equal(
      ledgerPathFromGitRoot('D:\\Creations\\Applications\\mesh'),
      'mesh/release/readiness.json',
    )
  })

  it('requires live evidence to be tied to the release SHA', () => {
    const errors = validateReadinessLedger(ledger(), { now: new Date('2026-08-01T00:00:00Z') })
    assert.ok(errors.some((error) => error.includes('artifact is missing')))
  })

  it('requires the explicit external release gate contract', () => {
    const errors = validateReadinessLedger(ledger(), { enforceGateContract: true })
    assert.equal(REQUIRED_RELEASE_GATES.length, 11)
    assert.ok(errors.some((error) => error.includes('r1.provider-identity-lifecycle')))
    assert.ok(errors.some((error) => error.includes('r4.native-invitation-delivery')))
    assert.ok(errors.some((error) => error.includes('r4.manual-accessibility-cross-platform')))
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

  it('rejects a required non-live gate in release mode', () => {
    const errors = validateReadinessLedger(
      ledger({ gates: [gate({ status: 'blocked', blockReason: 'not ready', nextAction: 'run it' })] }),
      { milestone: 'R2', requireLive: true },
    )
    assert.ok(errors.some((error) => error.includes('minimum is live-pass')))
  })

  it('rejects evidence from another snapshot', () => {
    const errors = validateReadinessLedger(
      ledger({ gates: [gate({ evidence: { ...baseEvidence, commitSha: 'b'.repeat(40) } })] }),
    )
    assert.ok(errors.some((error) => error.includes('must equal releaseSha')))
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
            collectedAt: null,
            expiresAt: null,
          },
          nextAction: 'rerun before the next release',
        })],
      }),
      {
        commitSha: 'b'.repeat(40),
        allowReleaseShaMismatch: true,
      },
    )
    assert.deepEqual(errors, [])
  })
})
