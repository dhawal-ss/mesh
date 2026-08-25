import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseRegistryMaintenanceControl, registryCandidateEntries } from './check-registry-digest-age.mjs'

const OCI_DIGEST = /^sha256:[0-9a-f]{64}$/u
const MANIFEST_ACCEPT = 'application/vnd.oci.image.index.v1+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.docker.distribution.manifest.v2+json'
const MUTATION_SURFACE = /packages:\s*write|docker\/login-action@|docker\/build-push-action@|docker buildx imagetools create|push-to-registry:\s*true|cosign (?:sign|attest) --yes/iu

export function manualPublicationAuthorization() {
  return { authorized: false, reason: 'registry-mutation-not-authorized' }
}

export function validateManualPublicationWorkflow({ workflows, control }) {
  const errors = []
  const verificationPath = control.manualPublicationWorkflow
  const verificationWorkflow = workflows.get(verificationPath)
  if (typeof verificationWorkflow !== 'string') return [`registry verification workflow is missing: ${verificationPath}`]

  for (const [workflowPath, contents] of workflows) {
    if (MUTATION_SURFACE.test(contents)) errors.push(`${workflowPath} exposes registry mutation while the checked-in repository must remain read-only`)
  }

  for (const required of [
    'workflow_dispatch:',
    'verify:',
    'permissions:\n  contents: read',
    'persist-credentials: false',
    'tag: 0.5.0-mesh.2',
    'digest: sha256:78bf2f1e8535928037abc35a9886614b3f722885b54f1f707a570e6991252710',
  ]) {
    if (!verificationWorkflow.includes(required)) errors.push(`registry verification workflow is missing ${required}`)
  }
  for (const retired of [
    'inputs:',
    'publish:',
    'inputs.publish',
    'packages: read',
    'packages: write',
    'id-token: write',
    'attestations: write',
    'verify-lk-jwt-service-mesh-2:',
    'publish-lk-jwt-service-mesh-2:',
    'SOURCE_IMAGE:',
    'TARGET_IMAGE:',
    'EXPECTED_DIGEST:',
    'GHCR recovery-tag probe',
  ]) {
    if (verificationWorkflow.includes(retired)) errors.push(`retired incident publication path remains in the verification workflow: ${retired}`)
  }
  if ((verificationWorkflow.match(/persist-credentials:\s*false/gu) ?? []).length !== 1) errors.push('registry verification workflow must contain exactly one credential-free checkout')
  return errors
}

export function validateRegistryTagBindings({ entries, observedByImage, publicationAuthorization }) {
  const errors = []
  const results = []
  for (const entry of entries) {
    const observed = observedByImage.get(entry.image)
    if (!observed || !['present', 'absent'].includes(observed.status)) {
      errors.push(`${entry.name} live tag evidence is missing or invalid`)
      continue
    }
    if (observed.status === 'absent') {
      if (!publicationAuthorization.authorized) {
        errors.push(`${entry.name} release tag is missing while the checked-in repository has no authorized publication path`)
      } else {
        results.push({ name: entry.name, image: entry.image, status: 'new-tag-pending-manual-publication' })
      }
      continue
    }
    if (!OCI_DIGEST.test(observed.digest ?? '')) {
      errors.push(`${entry.name} live tag returned an invalid digest`)
      continue
    }
    if (observed.digest !== entry.digest) {
      errors.push(`${entry.name} release tag moved outside the immutable publication contract: expected ${entry.digest}, observed ${observed.digest}`)
      continue
    }
    results.push({ name: entry.name, image: entry.image, status: 'immutable-tag-confirmed', digest: entry.digest })
  }
  return { errors, results }
}

async function registryToken(repository, fetchImpl) {
  const url = new URL('https://ghcr.io/token')
  url.searchParams.set('service', 'ghcr.io')
  url.searchParams.set('scope', `repository:dhawal-ss/${repository}:pull`)
  const response = await fetchImpl(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(15_000) })
  if (!response.ok) throw new Error(`${repository} registry token request failed with HTTP ${response.status}`)
  let payload
  try {
    payload = await response.json()
  } catch {
    throw new Error(`${repository} registry token response is not JSON`)
  }
  if (typeof payload?.token !== 'string' || payload.token.length < 32 || payload.token.length > 16_384) {
    throw new Error(`${repository} registry token response is invalid`)
  }
  return payload.token
}

export async function resolveGhcrTag(entry, { fetchImpl = fetch } = {}) {
  const token = await registryToken(entry.repository, fetchImpl)
  const response = await fetchImpl(`https://ghcr.io/v2/dhawal-ss/${entry.repository}/manifests/${encodeURIComponent(entry.tag)}`, {
    method: 'HEAD',
    headers: { authorization: `Bearer ${token}`, accept: MANIFEST_ACCEPT },
    signal: AbortSignal.timeout(20_000),
  })
  if (response.status === 404) return { status: 'absent' }
  if (!response.ok) throw new Error(`${entry.name} live tag lookup failed with HTTP ${response.status}`)
  const digest = response.headers.get('docker-content-digest')
  if (!OCI_DIGEST.test(digest ?? '')) throw new Error(`${entry.name} live tag lookup did not return an exact OCI digest`)
  return { status: 'present', digest }
}

async function readWorkflowMap(gitRoot) {
  const workflowRoot = path.join(gitRoot, '.github/workflows')
  const names = (await readdir(workflowRoot)).filter((name) => /\.ya?ml$/u.test(name)).sort()
  if (names.length === 0) throw new Error('no GitHub Actions workflows were found')
  const pairs = await Promise.all(names.map(async (name) => [`.github/workflows/${name}`, await readFile(path.join(workflowRoot, name), 'utf8')]))
  return new Map(pairs)
}

export async function inspectRegistryTagMovement(projectRoot, {
  environment = process.env,
  resolveTag = resolveGhcrTag,
  workflowMap,
} = {}) {
  const [policyText, maintenance] = await Promise.all([
    readFile(path.join(projectRoot, 'infra/container-candidates/candidate-policy.json'), 'utf8'),
    readFile(path.join(projectRoot, 'infra/REGISTRY_MAINTENANCE.md'), 'utf8'),
  ])
  const control = parseRegistryMaintenanceControl(maintenance)
  const policy = JSON.parse(policyText)
  const entries = registryCandidateEntries(policy, control)
  const workflows = workflowMap ?? await readWorkflowMap(path.resolve(projectRoot, '..'))
  const workflowErrors = validateManualPublicationWorkflow({ workflows, control })
  const publicationAuthorization = manualPublicationAuthorization({
    eventName: environment.GITHUB_EVENT_NAME,
    repository: environment.GITHUB_REPOSITORY,
    workflowRef: environment.GITHUB_WORKFLOW_REF,
    ref: environment.GITHUB_REF,
    publish: environment.MESH_REGISTRY_PUBLISH,
  }, control)
  const observations = await Promise.all(entries.map(async (entry) => [entry.image, await resolveTag(entry)]))
  const result = validateRegistryTagBindings({ entries, observedByImage: new Map(observations), publicationAuthorization })
  const errors = [...workflowErrors, ...result.errors]
  if (errors.length) throw new Error(errors.join('; '))
  return { ...result, publicationAuthorization }
}

async function main() {
  const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const result = await inspectRegistryTagMovement(projectRoot)
  console.log(`Registry tag movement guard passed (${result.results.length} tags; mutation context: ${result.publicationAuthorization.reason}).`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main()
