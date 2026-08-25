import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const PINNED_IMAGE = /^[A-Za-z0-9./_-]+:[A-Za-z0-9._-]+@sha256:([0-9a-f]{64})$/u
const UTF8 = new TextDecoder('utf-8', { fatal: true })
const SIGNATURE_TYPES = new Set([
  'cosign container image signature',
  'https://sigstore.dev/cosign/sign/v1',
])
const ATTESTATION_TYPES = new Set([
  'https://cyclonedx.org/bom',
  'https://slsa.dev/provenance/v1',
])

function field(entry, name) {
  return entry?.[name] ?? entry?.[name.toLowerCase()]
}

export function normalizeCandidateSignature({ policy, verificationBuffer, expectedImage }) {
  const match = PINNED_IMAGE.exec(expectedImage ?? '')
  if (!match) throw new Error('candidate signature image must use an exact tag and digest')
  if (!Buffer.isBuffer(verificationBuffer) || verificationBuffer.length === 0) throw new Error('candidate signature payload must be a nonempty byte buffer')
  if (verificationBuffer.length > policy.signaturePolicy.maxPayloadBytes) throw new Error('candidate signature payload exceeds the bounded evidence limit')
  let verification
  try {
    verification = JSON.parse(UTF8.decode(verificationBuffer).replace(/^\uFEFF/u, ''))
  } catch {
    throw new Error('candidate signature payload must be valid UTF-8 JSON')
  }
  if (!Array.isArray(verification) || verification.length === 0 || verification.length > policy.signaturePolicy.maxSignatures) throw new Error('candidate signature count is invalid')
  const expectedDigest = `sha256:${match[1]}`
  const verifiedClaims = verification.map((entry) => {
    const critical = field(entry, 'Critical')
    const image = field(critical, 'Image')
    const identity = field(critical, 'Identity')
    const digest = image?.['Docker-manifest-digest'] ?? image?.['docker-manifest-digest']
    const dockerReference = identity?.['docker-reference']
    const payloadType = field(critical, 'Type')
    if (digest !== expectedDigest) throw new Error('candidate signature does not bind the requested digest')
    if (typeof dockerReference !== 'string' || dockerReference.length > 512) throw new Error('candidate signature Docker reference is invalid')
    if (!SIGNATURE_TYPES.has(payloadType) && !ATTESTATION_TYPES.has(payloadType)) throw new Error('candidate signature uses an unexpected payload type')
    return { manifestDigest: digest, dockerReference, payloadType, isDirectSignature: SIGNATURE_TYPES.has(payloadType) }
  })
  const claims = verifiedClaims
    .filter((claim) => claim.isDirectSignature)
    .map((claim) => ({
      manifestDigest: claim.manifestDigest,
      dockerReference: claim.dockerReference,
      payloadType: claim.payloadType,
    }))
  if (claims.length === 0) throw new Error('candidate verification must include a direct container signature')
  return {
    schemaVersion: 1,
    image: expectedImage,
    status: 'verified-mesh-keyless-candidate',
    cosignVersion: policy.tooling.cosignVersion,
    certificateIdentityRegexp: policy.signaturePolicy.identityRegexp,
    certificateIssuer: policy.signaturePolicy.issuer,
    verificationPayloadSha256: createHash('sha256').update(verificationBuffer).digest('hex'),
    verifiedSignatureCount: claims.length,
    verifiedAttestationCount: verifiedClaims.length - claims.length,
    trustedForCandidate: true,
    trustedForRelease: false,
    claims,
  }
}

async function main() {
  const verificationIndex = process.argv.indexOf('--verification')
  const imageIndex = process.argv.indexOf('--image')
  const outputIndex = process.argv.indexOf('--output')
  if (verificationIndex < 0 || imageIndex < 0 || outputIndex < 0) throw new Error('Usage: node check-candidate-container-signature-evidence.mjs --verification <cosign.json> --image <exact-image> --output <evidence.json>')
  const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const policy = JSON.parse(await readFile(path.join(projectRoot, 'infra/container-candidates/candidate-policy.json'), 'utf8'))
  const verificationBuffer = await readFile(path.resolve(process.argv[verificationIndex + 1]))
  const result = normalizeCandidateSignature({ policy, verificationBuffer, expectedImage: process.argv[imageIndex + 1] })
  await writeFile(path.resolve(process.argv[outputIndex + 1]), `${JSON.stringify(result, null, 2)}\n`, 'utf8')
  console.log(`Candidate signature verified (${result.image}, trustedForCandidate=true, trustedForRelease=false).`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
