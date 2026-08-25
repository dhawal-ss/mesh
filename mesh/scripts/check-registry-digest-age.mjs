import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const DAY_MS = 24 * 60 * 60 * 1000
const OCI_DIGEST = /^sha256:[0-9a-f]{64}$/u
const CONTROL_BLOCK = /<!-- BEGIN MESH REGISTRY MAINTENANCE CONTROL\r?\n([\s\S]+?)\r?\nEND MESH REGISTRY MAINTENANCE CONTROL -->/gu
const EXPECTED_PLATFORMS = ['linux/amd64', 'linux/arm64']
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024
const MANIFEST_ACCEPT = [
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
  'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.docker.distribution.manifest.v2+json',
].join(', ')

function requireInteger(value, name, minimum, maximum, errors) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    errors.push(`${name} must be an integer from ${minimum} through ${maximum}`)
  }
}

export function parseRegistryMaintenanceControl(markdown) {
  const matches = [...markdown.matchAll(CONTROL_BLOCK)]
  if (matches.length !== 1) throw new Error('registry maintenance document must contain exactly one machine-enforced control block')
  let control
  try {
    control = JSON.parse(matches[0][1])
  } catch {
    throw new Error('registry maintenance control block must be valid JSON')
  }

  const errors = []
  if (control?.schemaVersion !== 1) errors.push('registry maintenance schemaVersion must be 1')
  if (control?.registry !== 'ghcr.io/dhawal-ss') errors.push('registry maintenance namespace must remain ghcr.io/dhawal-ss')
  if (control?.primaryOwner !== 'Dhawal Shah') errors.push('registry maintenance primary owner must be Dhawal Shah')
  const namedBackup = typeof control?.backupOwner === 'string' && control.backupOwner.trim().length > 0
  const explicitlyUnresolved = control?.backupOwner === null
    && control?.backupOwnerStatus === 'UNRESOLVED_OWNER_ASSIGNMENT_REQUIRED'
  if (!namedBackup && !explicitlyUnresolved) errors.push('registry maintenance must name a backup owner or explicitly record the unresolved backup-owner requirement')
  if (namedBackup && control.backupOwner.trim() === control.primaryOwner) errors.push('registry maintenance backup owner must differ from the primary owner')
  requireInteger(control?.rebuildCadenceDays, 'registry rebuild cadence', 1, 90, errors)
  requireInteger(control?.maximumDigestAgeDays, 'maximum digest age', 1, 90, errors)
  requireInteger(control?.fixableHighOrCriticalResponseHours, 'fixable High or Critical response window', 1, 168, errors)
  requireInteger(control?.upstreamSecurityPatchWindowHours, 'upstream security patch window', 1, 168, errors)
  if (Number.isInteger(control?.rebuildCadenceDays)
    && Number.isInteger(control?.maximumDigestAgeDays)
    && control.maximumDigestAgeDays < control.rebuildCadenceDays) {
    errors.push('maximum digest age must not be shorter than the rebuild cadence')
  }
  if (control?.manualPublicationWorkflow !== '.github/workflows/container-candidates.yml') {
    errors.push('manual publication workflow must remain .github/workflows/container-candidates.yml')
  }
  if (errors.length) throw new Error(errors.join('; '))
  return control
}

export function registryCandidateEntries(policy, control) {
  const errors = []
  if (policy?.schemaVersion !== 1 || policy?.mode !== 'mesh-maintained-candidate') errors.push('candidate policy identity is invalid')
  if (policy?.registry !== control?.registry) errors.push('candidate policy registry must match the maintenance contract')
  if (policy?.workflow !== control?.manualPublicationWorkflow) errors.push('candidate policy workflow must match the maintenance contract')
  if (JSON.stringify(policy?.platforms) !== JSON.stringify(EXPECTED_PLATFORMS)) errors.push('candidate policy platforms must be Linux AMD64 and ARM64')
  const images = policy?.images
  if (!Array.isArray(images) || images.length === 0 || images.length > 10) errors.push('candidate policy must contain one through ten maintained images')
  const entries = []
  const seen = new Set()
  for (const image of Array.isArray(images) ? images : []) {
    const prefix = `${control.registry}/`
    const reference = image?.image ?? ''
    if (!reference.startsWith(prefix) || reference.includes('@')) {
      errors.push(`${image?.name ?? 'candidate'} image must be a tag in the maintained registry`)
      continue
    }
    const relative = reference.slice(prefix.length)
    const separator = relative.lastIndexOf(':')
    const repository = separator > 0 ? relative.slice(0, separator) : ''
    const tag = separator > 0 ? relative.slice(separator + 1) : ''
    if (!/^[a-z0-9]+(?:[._/-][a-z0-9]+)*$/u.test(repository)
      || !/^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/u.test(tag)) {
      errors.push(`${image?.name ?? 'candidate'} image tag is invalid`)
    }
    if (!OCI_DIGEST.test(image?.publishedDigest ?? '')) errors.push(`${image?.name ?? 'candidate'} published digest is invalid`)
    if (seen.has(reference)) errors.push(`duplicate maintained image ${reference}`)
    seen.add(reference)
    entries.push({ name: image?.name, image: reference, repository, tag, digest: image?.publishedDigest })
  }
  if (errors.length) throw new Error(errors.join('; '))
  return entries
}

export function validateRegistryDigestAges({ entries, evidenceByImage, maximumDigestAgeDays, now }) {
  const errors = []
  const results = []
  const nowMs = now instanceof Date ? now.getTime() : Number.NaN
  if (!Number.isFinite(nowMs)) return { errors: ['registry digest-age check requires a valid current time'], results }
  for (const entry of entries) {
    const evidence = evidenceByImage.get(entry.image)
    if (!evidence) {
      errors.push(`${entry.name} digest-age evidence is missing`)
      continue
    }
    if (evidence.digest !== entry.digest) errors.push(`${entry.name} digest-age evidence does not bind the policy digest`)
    const createdTimes = []
    const platforms = evidence.platformCreatedAt ?? {}
    for (const platform of EXPECTED_PLATFORMS) {
      const raw = platforms[platform]
      const createdMs = typeof raw === 'string' ? Date.parse(raw) : Number.NaN
      if (!Number.isFinite(createdMs)) {
        errors.push(`${entry.name} ${platform} immutable config creation time is missing or invalid`)
        continue
      }
      if (createdMs > nowMs) errors.push(`${entry.name} ${platform} immutable config creation time is in the future`)
      createdTimes.push(createdMs)
    }
    const extraPlatforms = Object.keys(platforms).filter((platform) => !EXPECTED_PLATFORMS.includes(platform))
    if (extraPlatforms.length) errors.push(`${entry.name} digest-age evidence contains unexpected platforms: ${extraPlatforms.join(', ')}`)
    if (createdTimes.length !== EXPECTED_PLATFORMS.length) continue
    const oldestCreatedMs = Math.min(...createdTimes)
    const ageMs = nowMs - oldestCreatedMs
    const ageDays = ageMs / DAY_MS
    if (ageMs > maximumDigestAgeDays * DAY_MS) {
      errors.push(`${entry.name} published digest is expired at ${ageDays.toFixed(2)} days (maximum ${maximumDigestAgeDays})`)
    }
    results.push({ name: entry.name, image: entry.image, digest: entry.digest, oldestCreatedAt: new Date(oldestCreatedMs).toISOString(), ageDays })
  }
  return { errors, results }
}

async function boundedJson(response, label) {
  if (!response.ok) throw new Error(`${label} failed with HTTP ${response.status}`)
  const declaredLength = Number(response.headers.get('content-length'))
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) throw new Error(`${label} exceeds the response size limit`)
  const bytes = new Uint8Array(await response.arrayBuffer())
  if (bytes.byteLength > MAX_RESPONSE_BYTES) throw new Error(`${label} exceeds the response size limit`)
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  } catch {
    throw new Error(`${label} did not return strict UTF-8 JSON`)
  }
}

async function ghcrToken(repository, fetchImpl) {
  const url = new URL('https://ghcr.io/token')
  url.searchParams.set('service', 'ghcr.io')
  url.searchParams.set('scope', `repository:dhawal-ss/${repository}:pull`)
  const response = await fetchImpl(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(15_000) })
  const payload = await boundedJson(response, `${repository} registry token request`)
  if (typeof payload?.token !== 'string' || payload.token.length < 32 || payload.token.length > 16_384) {
    throw new Error(`${repository} registry token response is invalid`)
  }
  return payload.token
}

async function ghcrJson({ repository, reference, token, accept, label, fetchImpl }) {
  const encodedReference = encodeURIComponent(reference)
  const response = await fetchImpl(`https://ghcr.io/v2/dhawal-ss/${repository}/manifests/${encodedReference}`, {
    headers: { authorization: `Bearer ${token}`, accept },
    signal: AbortSignal.timeout(20_000),
  })
  const payload = await boundedJson(response, label)
  return { payload, digest: response.headers.get('docker-content-digest') }
}

async function ghcrConfig({ repository, digest, token, label, fetchImpl }) {
  const response = await fetchImpl(`https://ghcr.io/v2/dhawal-ss/${repository}/blobs/${encodeURIComponent(digest)}`, {
    headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.oci.image.config.v1+json' },
    redirect: 'follow',
    signal: AbortSignal.timeout(20_000),
  })
  return boundedJson(response, label)
}

export async function loadGhcrDigestEvidence(entry, { fetchImpl = fetch } = {}) {
  const token = await ghcrToken(entry.repository, fetchImpl)
  const indexResponse = await ghcrJson({
    repository: entry.repository,
    reference: entry.digest,
    token,
    accept: MANIFEST_ACCEPT,
    label: `${entry.name} digest manifest`,
    fetchImpl,
  })
  if (indexResponse.digest !== entry.digest) throw new Error(`${entry.name} registry response does not bind the policy digest`)
  const descriptors = indexResponse.payload?.manifests
  if (!Array.isArray(descriptors)) throw new Error(`${entry.name} policy digest is not a multi-platform image index`)
  const platformCreatedAt = {}
  for (const platformName of EXPECTED_PLATFORMS) {
    const [os, architecture] = platformName.split('/')
    const matches = descriptors.filter((descriptor) => descriptor?.platform?.os === os && descriptor?.platform?.architecture === architecture)
    if (matches.length !== 1 || !OCI_DIGEST.test(matches[0]?.digest ?? '')) {
      throw new Error(`${entry.name} must contain exactly one ${platformName} manifest`)
    }
    const manifestResponse = await ghcrJson({
      repository: entry.repository,
      reference: matches[0].digest,
      token,
      accept: MANIFEST_ACCEPT,
      label: `${entry.name} ${platformName} manifest`,
      fetchImpl,
    })
    if (manifestResponse.digest !== matches[0].digest) throw new Error(`${entry.name} ${platformName} manifest digest binding failed`)
    const configDigest = manifestResponse.payload?.config?.digest
    if (!OCI_DIGEST.test(configDigest ?? '')) throw new Error(`${entry.name} ${platformName} config digest is invalid`)
    const config = await ghcrConfig({ repository: entry.repository, digest: configDigest, token, label: `${entry.name} ${platformName} config`, fetchImpl })
    if (config?.os !== os || config?.architecture !== architecture) throw new Error(`${entry.name} ${platformName} config platform does not match its index descriptor`)
    if (typeof config?.created !== 'string') throw new Error(`${entry.name} ${platformName} config has no immutable creation time`)
    platformCreatedAt[platformName] = config.created
  }
  return { digest: entry.digest, platformCreatedAt }
}

export async function inspectRegistryDigestAge(projectRoot, { now = new Date(), loadEvidence = loadGhcrDigestEvidence } = {}) {
  const [policyText, maintenance] = await Promise.all([
    readFile(path.join(projectRoot, 'infra/container-candidates/candidate-policy.json'), 'utf8'),
    readFile(path.join(projectRoot, 'infra/REGISTRY_MAINTENANCE.md'), 'utf8'),
  ])
  const control = parseRegistryMaintenanceControl(maintenance)
  const policy = JSON.parse(policyText)
  const entries = registryCandidateEntries(policy, control)
  const evidence = await Promise.all(entries.map(async (entry) => [entry.image, await loadEvidence(entry)]))
  const result = validateRegistryDigestAges({
    entries,
    evidenceByImage: new Map(evidence),
    maximumDigestAgeDays: control.maximumDigestAgeDays,
    now,
  })
  if (result.errors.length) throw new Error(result.errors.join('; '))
  return { ...result, control }
}

async function main() {
  const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const result = await inspectRegistryDigestAge(projectRoot)
  const oldestAge = Math.max(...result.results.map((entry) => entry.ageDays))
  const backup = result.control.backupOwner ?? result.control.backupOwnerStatus
  console.log(`Registry digest age passed (${result.results.length} digests, oldest ${oldestAge.toFixed(2)} days, maximum ${result.control.maximumDigestAgeDays} days; backup owner: ${backup}).`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main()
