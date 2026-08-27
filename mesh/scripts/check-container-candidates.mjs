import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SHA40 = /^[0-9a-f]{40}$/u
const PINNED_BUILDER = /^[A-Za-z0-9./_-]+:[A-Za-z0-9._-]+@sha256:[0-9a-f]{64}$/u
const CANDIDATE_IMAGE = /^ghcr\.io\/dhawal-ss\/[a-z0-9-]+:[A-Za-z0-9._-]+$/u
const OCI_DIGEST = /^sha256:[0-9a-f]{64}$/u

function hash(contents) {
  return createHash('sha256').update(contents).digest('hex')
}

export function validateContainerCandidates({ policy, workflow, dockerfiles, patchFiles, maintenance }) {
  const errors = []
  const fail = (message) => errors.push(message)
  if (policy?.schemaVersion !== 1 || policy?.mode !== 'mesh-maintained-candidate') fail('candidate policy identity is invalid')
  if (policy?.registry !== 'ghcr.io/dhawal-ss' || policy?.visibility !== 'public-required') fail('candidate registry must be public GHCR under the owner namespace')
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(policy?.ownerApproval?.approvedAt ?? '') || !policy?.ownerApproval?.scope) fail('candidate policy must record owner approval')
  if (policy?.workflow !== '.github/workflows/container-candidates.yml') fail('candidate policy must bind the verification workflow')
  if (!PINNED_BUILDER.test(policy?.builderImage ?? '')) fail('candidate builder must use an exact tag and digest')
  if (JSON.stringify(policy?.platforms) !== JSON.stringify(['linux/amd64', 'linux/arm64'])) fail('candidate platforms must be Linux AMD64 and ARM64')
  if (policy?.tooling?.syftVersion !== 'v1.50.0' || policy?.tooling?.grypeVersion !== 'v0.116.1' || policy?.tooling?.cosignVersion !== 'v3.0.6') fail('candidate tooling must match the reviewed release tools')
  if (policy?.signaturePolicy?.issuer !== 'https://token.actions.githubusercontent.com'
    || policy?.signaturePolicy?.maxPayloadBytes !== 1_048_576
    || policy?.signaturePolicy?.maxSignatures !== 16
    || !policy?.signaturePolicy?.identityRegexp?.includes('container-candidates')) fail('candidate signature policy must be bounded to the verification workflow')
  if (policy?.maintenance?.scheduledScan !== 'weekly' || policy?.maintenance?.fixableHighResponseHours !== 24) fail('candidate maintenance must retain the weekly and 24-hour response contract')

  const images = policy?.images ?? []
  if (images.map((entry) => entry.name).join(',') !== 'caddy,lk-jwt-service') fail('candidate policy must contain exactly Caddy and lk-jwt-service')
  for (const image of images) {
    if (!CANDIDATE_IMAGE.test(image?.image ?? '')) fail(`${image?.name ?? 'candidate'} image tag is invalid`)
    if (!OCI_DIGEST.test(image?.publishedDigest ?? '')) fail(`${image?.name ?? 'candidate'} published digest is invalid`)
    if (!SHA40.test(image?.sourceCommit ?? '')) fail(`${image?.name ?? 'candidate'} source commit is invalid`)
    if (!image?.sourceRelease?.startsWith('v')) fail(`${image?.name ?? 'candidate'} source release is invalid`)
    if (!image?.context?.startsWith(`infra/container-candidates/${image.name}`)
      || image?.dockerfile !== `${image.context}/Dockerfile`) fail(`${image?.name ?? 'candidate'} build paths escape the candidate root`)
    if (image?.runtimeUser !== '65532:65532') fail(`${image?.name ?? 'candidate'} runtime user must be numeric and non-root`)
    const dockerfile = dockerfiles.get(image.dockerfile) ?? ''
    for (const required of [
      `FROM --platform=$BUILDPLATFORM ${policy.builderImage} AS builder`,
      'ARG TARGETOS',
      'ARG TARGETARCH',
      image.sourceCommit,
      image.sourceRelease,
      'FROM scratch',
      `USER ${image.runtimeUser}`,
      'org.mesh.image.channel="candidate"',
    ]) if (!dockerfile.includes(required)) fail(`${image.name} Dockerfile is missing ${required}`)
    if (dockerfile.includes('mesh-local') || dockerfile.includes('local-only') || dockerfile.includes('prototype')) fail(`${image.name} candidate Dockerfile retains local-only identity`)
    if (!dockerfile.includes('go test') || !dockerfile.includes('CGO_ENABLED=0 GOOS=${TARGETOS} GOARCH=${TARGETARCH} go build')) fail(`${image.name} candidate must test natively and cross-compile explicitly`)
    for (const patch of image.sourcePatches ?? []) {
      const contents = patchFiles.get(patch.path)
      if (!contents || hash(contents) !== patch.sha256) fail(`${image.name} source patch hash drifted`)
      if (!dockerfile.includes(path.posix.basename(patch.path)) || !dockerfile.includes(patch.sha256) || !dockerfile.includes('git apply --check')) fail(`${image.name} source patch is not checksum-bound and preflighted`)
    }
    const [repository, tag] = image.image.split(/:(?=[^/]+$)/u)
    if (!workflow.includes(`image: ${repository}`)
      || !workflow.includes(`tag: ${tag}`)
      || !workflow.includes(`digest: ${image.publishedDigest}`)) fail(`${image.name} is missing from the verification matrix`)
  }
  if ((policy?.blocked ?? []).length !== 1 || policy.blocked[0]?.name !== 'synapse' || !policy.blocked[0]?.reason) fail('Synapse must remain an explicit blocked candidate')

  for (const required of [
    'workflow_dispatch:',
    'branches: [main]',
    'verify:',
    'permissions:\n  contents: read',
    'persist-credentials: false',
    'anchore/sbom-action@',
    'anchore/scan-action@',
    'severity-cutoff: high',
    'only-fixed: true',
    'check-container-scan-evidence.mjs',
    'check-candidate-container-signature-evidence.mjs',
    '--scope release',
    'if: always()',
  ]) if (!workflow.includes(required)) fail(`candidate workflow is missing ${required}`)

  const forbiddenMutation = [
    'inputs:',
    'publish:',
    'inputs.publish',
    'packages: write',
    'id-token: write',
    'attestations: write',
    'docker/login-action@',
    'docker/build-push-action@',
    'actions/attest-build-provenance@',
    'docker buildx imagetools create',
    'push-to-registry: true',
    'cosign sign --yes',
    'cosign attest --yes',
    'verify-lk-jwt-service-mesh-2:',
    'publish-lk-jwt-service-mesh-2:',
  ]
  for (const forbidden of forbiddenMutation) {
    if (workflow.includes(forbidden)) fail(`retired candidate workflow must not contain publication authority: ${forbidden}`)
  }
  if ((workflow.match(/persist-credentials:\s*false/gu) ?? []).length !== 1) fail('the sole read-only checkout must disable persisted credentials')
  for (const action of ['actions/checkout', 'actions/setup-node', 'docker/setup-buildx-action', 'sigstore/cosign-installer', 'anchore/sbom-action', 'anchore/scan-action', 'actions/upload-artifact']) {
    if (!new RegExp(`${action.replace('/', '\\/')}@[0-9a-f]{40}`, 'u').test(workflow)) fail(`${action} must be SHA pinned`)
  }
  if (!workflow.includes(policy.signaturePolicy.identityRegexp) || !workflow.includes(policy.signaturePolicy.issuer)) fail('candidate workflow must verify its exact keyless identity and issuer')
  if (!maintenance.includes('Candidate packages must be public') || !maintenance.includes('Synapse is not covered') || !maintenance.includes('within 24 hours')) fail('candidate maintenance document is incomplete')
  return errors
}

export async function inspectContainerCandidates(projectRoot) {
  const policy = JSON.parse(await readFile(path.join(projectRoot, 'infra/container-candidates/candidate-policy.json'), 'utf8'))
  const gitRoot = path.resolve(projectRoot, '..')
  const workflow = await readFile(path.join(gitRoot, '.github/workflows/container-candidates.yml'), 'utf8')
  const maintenance = await readFile(path.join(projectRoot, 'docs/operations/CONTAINER_CANDIDATE_MAINTENANCE.md'), 'utf8')
  const dockerfiles = new Map()
  const patchFiles = new Map()
  for (const image of policy.images ?? []) {
    dockerfiles.set(image.dockerfile, await readFile(path.join(projectRoot, image.dockerfile), 'utf8'))
    for (const patch of image.sourcePatches ?? []) patchFiles.set(patch.path, await readFile(path.join(projectRoot, patch.path)))
  }
  const errors = validateContainerCandidates({ policy, workflow, dockerfiles, patchFiles, maintenance })
  if (errors.length) throw new Error(errors.join('; '))
  return { images: policy.images.map(({ name, image }) => ({ name, image })), blocked: policy.blocked }
}

async function main() {
  const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const result = await inspectContainerCandidates(projectRoot)
  console.log(`Container candidate policy passed (${result.images.length} publishable, ${result.blocked.length} blocked).`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main()
