import assert from 'node:assert/strict'
import test from 'node:test'
import { normalizeContainerSignatureDiscovery } from './check-container-signature-evidence.mjs'

const digest = 'a'.repeat(64)
const image = `example/service:1.2.3@sha256:${digest}`
const policy = {
  schemaVersion: 6,
  signatureDiscoveryPolicy: {
    cosignVersion: 'v3.0.6',
    mode: 'discovery-only',
    identityRegexp: '^.+$',
    issuerRegexp: '^https://.+$',
    maxPayloadBytes: 1_048_576,
    maxSignatures: 64,
    requiresReviewer: true,
    trustedForRelease: false,
  },
}

function payload(overrides = {}) {
  return Buffer.from(JSON.stringify([{
    critical: {
      identity: { 'docker-reference': 'example/service' },
      image: { 'docker-manifest-digest': `sha256:${digest}` },
      type: 'cosign container image signature',
    },
    optional: { untrustedAnnotation: 'discard me' },
    ...overrides,
  }]))
}

test('normalizes a digest-bound signature without retaining arbitrary annotations', () => {
  const result = normalizeContainerSignatureDiscovery({
    policy,
    verificationBuffer: payload(),
    cosignExitCode: 0,
    expectedImage: image,
  })
  assert.equal(result.status, 'signature-exists-identity-unreviewed')
  assert.equal(result.verifiedSignatureCount, 1)
  assert.equal(result.signatureClaims[0].manifestDigest, `sha256:${digest}`)
  assert.equal(result.signatureClaims[0].payloadType, 'cosign container image signature')
  assert.equal(result.requiresReviewer, true)
  assert.equal(result.trustedForRelease, false)
  assert.equal(JSON.stringify(result).includes('untrustedAnnotation'), false)
})

test('accepts the documented uppercase Cosign payload fields', () => {
  const verificationBuffer = Buffer.from(JSON.stringify([{
    Critical: {
      Identity: { 'docker-reference': '' },
      Image: { 'Docker-manifest-digest': `sha256:${digest}` },
      Type: 'cosign container image signature',
    },
    Optional: null,
  }]))
  const result = normalizeContainerSignatureDiscovery({ policy, verificationBuffer, cosignExitCode: 0, expectedImage: image })
  assert.equal(result.verifiedSignatureCount, 1)
  assert.equal(result.signatureClaims[0].dockerReference, '')
})

test('accepts and retains the Cosign v3 image signature predicate type', () => {
  const verification = JSON.parse(payload().toString('utf8'))
  verification[0].critical.type = 'https://sigstore.dev/cosign/sign/v1'
  const result = normalizeContainerSignatureDiscovery({
    policy,
    verificationBuffer: Buffer.from(JSON.stringify(verification)),
    cosignExitCode: 0,
    expectedImage: image,
  })
  assert.equal(result.signatureClaims[0].payloadType, 'https://sigstore.dev/cosign/sign/v1')
})

test('accepts known attestations beside a direct Cosign v3 image signature', () => {
  const verification = JSON.parse(payload().toString('utf8'))
  verification[0].critical.type = 'https://sigstore.dev/cosign/sign/v1'
  verification.push({
    critical: {
      identity: { 'docker-reference': 'example/service' },
      image: { 'docker-manifest-digest': `sha256:${digest}` },
      type: 'https://cyclonedx.org/bom',
    },
  })
  const result = normalizeContainerSignatureDiscovery({
    policy,
    verificationBuffer: Buffer.from(JSON.stringify(verification)),
    cosignExitCode: 0,
    expectedImage: image,
  })
  assert.equal(result.verifiedSignatureCount, 1)
  assert.equal(result.verifiedAttestationCount, 1)
  assert.deepEqual(result.signatureClaims.map((claim) => claim.payloadType), ['https://sigstore.dev/cosign/sign/v1'])
})

test('rejects attestation-only successful discovery', () => {
  const verification = JSON.parse(payload().toString('utf8'))
  verification[0].critical.type = 'https://slsa.dev/provenance/v1'
  assert.throws(
    () => normalizeContainerSignatureDiscovery({ policy, verificationBuffer: Buffer.from(JSON.stringify(verification)), cosignExitCode: 0, expectedImage: image }),
    /direct container signature/,
  )
})

test('rejects wrong digests, payload types, and malformed successful output', () => {
  const wrongDigest = JSON.parse(payload().toString('utf8'))
  wrongDigest[0].critical.image['docker-manifest-digest'] = `sha256:${'b'.repeat(64)}`
  assert.throws(
    () => normalizeContainerSignatureDiscovery({ policy, verificationBuffer: Buffer.from(JSON.stringify(wrongDigest)), cosignExitCode: 0, expectedImage: image }),
    /requested manifest digest/,
  )

  const wrongType = JSON.parse(payload().toString('utf8'))
  wrongType[0].critical.type = 'other signature'
  assert.throws(
    () => normalizeContainerSignatureDiscovery({ policy, verificationBuffer: Buffer.from(JSON.stringify(wrongType)), cosignExitCode: 0, expectedImage: image }),
    /unexpected payload type/,
  )
  assert.throws(
    () => normalizeContainerSignatureDiscovery({ policy, verificationBuffer: Buffer.from('not-json'), cosignExitCode: 0, expectedImage: image }),
    /valid UTF-8 JSON/,
  )
  assert.throws(
    () => normalizeContainerSignatureDiscovery({ policy, verificationBuffer: Buffer.from('{\u0000}', 'utf16le'), cosignExitCode: 0, expectedImage: image }),
    /valid UTF-8 JSON/,
  )
})

test('records a failed discovery attempt without claiming signature absence or trust', () => {
  const result = normalizeContainerSignatureDiscovery({
    policy,
    verificationBuffer: Buffer.alloc(0),
    cosignExitCode: 1,
    expectedImage: image,
  })
  assert.equal(result.status, 'upstream-signature-unavailable-or-not-discovered')
  assert.equal(result.verificationPayloadSha256, null)
  assert.equal(result.verifiedSignatureCount, 0)
  assert.equal(result.requiresReviewer, true)
  assert.equal(result.trustedForRelease, false)
})

test('rejects unbounded payloads, invalid exit codes, and release-trusting policy drift', () => {
  const bounded = structuredClone(policy)
  bounded.signatureDiscoveryPolicy.maxPayloadBytes = 4
  assert.throws(
    () => normalizeContainerSignatureDiscovery({ policy: bounded, verificationBuffer: payload(), cosignExitCode: 0, expectedImage: image }),
    /bounded evidence limit/,
  )
  assert.throws(
    () => normalizeContainerSignatureDiscovery({ policy, verificationBuffer: payload(), cosignExitCode: -1, expectedImage: image }),
    /unsigned process exit code/,
  )
  const trusting = structuredClone(policy)
  trusting.signatureDiscoveryPolicy.trustedForRelease = true
  assert.throws(
    () => normalizeContainerSignatureDiscovery({ policy: trusting, verificationBuffer: payload(), cosignExitCode: 0, expectedImage: image }),
    /untrusted for release/,
  )
})
