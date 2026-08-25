import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const PINNED_IMAGE = /^[A-Za-z0-9./_-]+:[A-Za-z0-9._-]+@sha256:([0-9a-f]{64})$/
const CONTROL_TEXT = /[\u0000-\u001f\u007f]/
const SIGNATURE_TYPES = new Set([
  'cosign container image signature',
  'https://sigstore.dev/cosign/sign/v1',
])
const ATTESTATION_TYPES = new Set([
  'https://cyclonedx.org/bom',
  'https://slsa.dev/provenance/v1',
])
const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true })

function parseJson(buffer) {
  return JSON.parse(UTF8_DECODER.decode(buffer).replace(/^\uFEFF/, ''))
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

function claimField(entry, field) {
  return entry?.[field] ?? entry?.[field.toLowerCase()]
}

function manifestDigest(entry) {
  const critical = claimField(entry, 'Critical')
  const image = claimField(critical, 'Image')
  return image?.['Docker-manifest-digest'] ?? image?.['docker-manifest-digest']
}

function signatureType(entry) {
  return claimField(claimField(entry, 'Critical'), 'Type')
}

function dockerReference(entry) {
  const critical = claimField(entry, 'Critical')
  const identity = claimField(critical, 'Identity')
  return identity?.['docker-reference']
}

export function normalizeContainerSignatureDiscovery({
  policy,
  verificationBuffer,
  cosignExitCode,
  expectedImage,
}) {
  const discoveryPolicy = policy.signatureDiscoveryPolicy ?? {}
  const imageMatch = PINNED_IMAGE.exec(expectedImage ?? '')
  const errors = []

  if (policy.schemaVersion !== 6) errors.push('container evidence policy schemaVersion must be 6')
  if (!imageMatch) errors.push('signature discovery image must use an exact tag and digest')
  if (!Buffer.isBuffer(verificationBuffer)) errors.push('signature discovery payload must be a byte buffer')
  if (!Number.isInteger(cosignExitCode) || cosignExitCode < 0 || cosignExitCode > 255) {
    errors.push('signature discovery exit code must be an unsigned process exit code')
  }
  if (verificationBuffer?.length > discoveryPolicy.maxPayloadBytes) {
    errors.push('signature discovery payload exceeds the bounded evidence limit')
  }
  if (discoveryPolicy.mode !== 'discovery-only'
    || discoveryPolicy.requiresReviewer !== true
    || discoveryPolicy.trustedForRelease !== false) {
    errors.push('signature discovery must remain reviewer-required and untrusted for release')
  }
  if (errors.length) throw new Error(errors.join('; '))

  const base = {
    schemaVersion: 1,
    image: expectedImage,
    cosignVersion: discoveryPolicy.cosignVersion,
    cosignExitCode,
    verificationPayloadSha256: verificationBuffer.length > 0 ? sha256(verificationBuffer) : null,
    requiresReviewer: true,
    trustedForRelease: false,
  }

  if (cosignExitCode !== 0) {
    return {
      ...base,
      status: 'upstream-signature-unavailable-or-not-discovered',
      verifiedSignatureCount: 0,
      signatureClaims: [],
    }
  }

  let verification
  try {
    verification = parseJson(verificationBuffer)
  } catch {
    throw new Error('successful signature discovery must contain valid UTF-8 JSON')
  }
  if (!Array.isArray(verification)
    || verification.length === 0
    || verification.length > discoveryPolicy.maxSignatures) {
    throw new Error('successful signature discovery must contain a bounded nonempty signature array')
  }

  const expectedDigest = `sha256:${imageMatch[1]}`
  const verifiedClaims = verification.map((entry) => {
    const digest = manifestDigest(entry)
    const type = signatureType(entry)
    const reference = dockerReference(entry)
    if (digest !== expectedDigest) throw new Error('discovered signature does not bind the requested manifest digest')
    if (!SIGNATURE_TYPES.has(type) && !ATTESTATION_TYPES.has(type)) throw new Error('discovered signature uses an unexpected payload type')
    if (typeof reference !== 'string' || reference.length > 512 || CONTROL_TEXT.test(reference)) {
      throw new Error('discovered signature contains an invalid Docker reference claim')
    }
    return {
      manifestDigest: digest,
      dockerReference: reference,
      payloadType: type,
      isDirectSignature: SIGNATURE_TYPES.has(type),
    }
  })
  const signatureClaims = verifiedClaims
    .filter((claim) => claim.isDirectSignature)
    .map((claim) => ({
      manifestDigest: claim.manifestDigest,
      dockerReference: claim.dockerReference,
      payloadType: claim.payloadType,
    }))
  if (signatureClaims.length === 0) throw new Error('successful signature discovery must include a direct container signature')

  return {
    ...base,
    status: 'signature-exists-identity-unreviewed',
    verifiedSignatureCount: signatureClaims.length,
    verifiedAttestationCount: verifiedClaims.length - signatureClaims.length,
    signatureClaims,
  }
}

export async function inspectContainerSignatureDiscovery(projectRoot, {
  verificationFile,
  cosignExitCode,
  expectedImage,
}) {
  const policy = parseJson(await readFile(path.join(projectRoot, 'infra', 'container-security-policy.json')))
  const verificationBuffer = await readFile(path.resolve(verificationFile))
  return normalizeContainerSignatureDiscovery({
    policy,
    verificationBuffer,
    cosignExitCode,
    expectedImage,
  })
}

async function main() {
  const verificationIndex = process.argv.indexOf('--verification')
  const exitCodeIndex = process.argv.indexOf('--cosign-exit')
  const imageIndex = process.argv.indexOf('--image')
  const outputIndex = process.argv.indexOf('--output')
  if (verificationIndex < 0 || !process.argv[verificationIndex + 1]
    || exitCodeIndex < 0 || !process.argv[exitCodeIndex + 1]
    || imageIndex < 0 || !process.argv[imageIndex + 1]
    || outputIndex < 0 || !process.argv[outputIndex + 1]) {
    throw new Error('Usage: node check-container-signature-evidence.mjs --verification <cosign.json> --cosign-exit <code> --image <exact-tag-and-digest> --output <discovery.json>')
  }
  const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const result = await inspectContainerSignatureDiscovery(projectRoot, {
    verificationFile: process.argv[verificationIndex + 1],
    cosignExitCode: Number(process.argv[exitCodeIndex + 1]),
    expectedImage: process.argv[imageIndex + 1],
  })
  await writeFile(path.resolve(process.argv[outputIndex + 1]), `${JSON.stringify(result, null, 2)}\n`, 'utf8')
  console.log(`Container signature discovery normalized (${result.image}, ${result.status}, trustedForRelease=false).`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main()
