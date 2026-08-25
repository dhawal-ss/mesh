import assert from 'node:assert/strict'
import test from 'node:test'
import { normalizeCandidateSignature } from './check-candidate-container-signature-evidence.mjs'

const digest = 'a'.repeat(64)
const image = `ghcr.io/dhawal-ss/mesh-caddy:2.11.4-mesh.1@sha256:${digest}`
const policy = {
  tooling: { cosignVersion: 'v3.0.6' },
  signaturePolicy: {
    identityRegexp: '^workflow$',
    issuer: 'https://token.actions.githubusercontent.com',
    maxPayloadBytes: 1_048_576,
    maxSignatures: 16,
  },
}
const payload = (boundDigest = digest) => Buffer.from(JSON.stringify([{
  critical: {
    image: { 'docker-manifest-digest': `sha256:${boundDigest}` },
    identity: { 'docker-reference': 'ghcr.io/dhawal-ss/mesh-caddy' },
    type: 'https://sigstore.dev/cosign/sign/v1',
  },
}]))

test('normalizes a digest-bound Mesh candidate signature', () => {
  const result = normalizeCandidateSignature({ policy, verificationBuffer: payload(), expectedImage: image })
  assert.equal(result.trustedForCandidate, true)
  assert.equal(result.trustedForRelease, false)
  assert.equal(result.claims[0].manifestDigest, `sha256:${digest}`)
  assert.equal(result.claims[0].payloadType, 'https://sigstore.dev/cosign/sign/v1')
})

test('rejects a signature for another digest', () => {
  assert.throws(() => normalizeCandidateSignature({ policy, verificationBuffer: payload('b'.repeat(64)), expectedImage: image }), /requested digest/u)
})

test('accepts known attestations only beside a direct candidate signature', () => {
  const verification = JSON.parse(payload().toString('utf8'))
  verification.push({
    critical: {
      image: { 'docker-manifest-digest': `sha256:${digest}` },
      identity: { 'docker-reference': 'ghcr.io/dhawal-ss/mesh-caddy' },
      type: 'https://cyclonedx.org/bom',
    },
  })
  const result = normalizeCandidateSignature({ policy, verificationBuffer: Buffer.from(JSON.stringify(verification)), expectedImage: image })
  assert.equal(result.verifiedSignatureCount, 1)
  assert.equal(result.verifiedAttestationCount, 1)
  assert.equal(result.claims.length, 1)

  verification[0].critical.type = 'https://slsa.dev/provenance/v1'
  assert.throws(
    () => normalizeCandidateSignature({ policy, verificationBuffer: Buffer.from(JSON.stringify(verification)), expectedImage: image }),
    /direct container signature/u,
  )
})

test('rejects unknown candidate payload types', () => {
  const verification = JSON.parse(payload().toString('utf8'))
  verification[0].critical.type = 'https://example.invalid/predicate'
  assert.throws(
    () => normalizeCandidateSignature({ policy, verificationBuffer: Buffer.from(JSON.stringify(verification)), expectedImage: image }),
    /unexpected payload type/u,
  )
})
