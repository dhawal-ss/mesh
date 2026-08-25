import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { inspectContainerCandidates, validateContainerCandidates } from './check-container-candidates.mjs'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

async function fixture() {
  const policy = JSON.parse(await readFile(path.join(projectRoot, 'infra/container-candidates/candidate-policy.json'), 'utf8'))
  const workflow = await readFile(path.resolve(projectRoot, '..', '.github/workflows/container-candidates.yml'), 'utf8')
  const maintenance = await readFile(path.join(projectRoot, 'docs/operations/CONTAINER_CANDIDATE_MAINTENANCE.md'), 'utf8')
  const dockerfiles = new Map()
  const patchFiles = new Map()
  for (const image of policy.images) {
    dockerfiles.set(image.dockerfile, await readFile(path.join(projectRoot, image.dockerfile), 'utf8'))
    for (const patch of image.sourcePatches) patchFiles.set(patch.path, await readFile(path.join(projectRoot, patch.path)))
  }
  return { policy, workflow, maintenance, dockerfiles, patchFiles }
}

test('accepts the owner-approved read-only candidate verification contract', async () => {
  const result = await inspectContainerCandidates(projectRoot)
  assert.equal(result.images.length, 2)
  assert.deepEqual(result.blocked.map((entry) => entry.name), ['synapse'])
})

test('rejects private registries and floating builders', async () => {
  const input = await fixture()
  input.policy.visibility = 'private'
  input.policy.builderImage = 'golang:latest'
  const errors = validateContainerCandidates(input).join('; ')
  assert.match(errors, /public GHCR/u)
  assert.match(errors, /exact tag and digest/u)
})

test('rejects root runtimes and source patch drift', async () => {
  const input = await fixture()
  const caddy = input.policy.images[0]
  input.dockerfiles.set(caddy.dockerfile, input.dockerfiles.get(caddy.dockerfile).replace('USER 65532:65532', 'USER 0:0'))
  input.patchFiles.set(caddy.sourcePatches[0].path, Buffer.from('drift'))
  const errors = validateContainerCandidates(input).join('; ')
  assert.match(errors, /USER 65532:65532/u)
  assert.match(errors, /source patch hash drifted/u)
})

test('requires the current immutable .2 tag and digest in the verification matrix', async () => {
  const input = await fixture()
  input.policy.images[1].publishedDigest = 'sha256:invalid'
  input.workflow = input.workflow.replace('tag: 0.5.0-mesh.2', 'tag: 0.5.0-mesh.1')
  const errors = validateContainerCandidates(input).join('; ')
  assert.match(errors, /published digest is invalid/u)
  assert.match(errors, /lk-jwt-service is missing from the verification matrix/u)
})

test('retires the publish input and every registry mutation capability', async () => {
  const input = await fixture()
  input.workflow = input.workflow
    .replace('workflow_dispatch:', 'workflow_dispatch:\n    inputs:\n      publish:\n        type: boolean')
    .concat(`
  retired-publication-regression:
    permissions:
      packages: write
      id-token: write
      attestations: write
    steps:
      - uses: docker/login-action@${'a'.repeat(40)}
      - uses: docker/build-push-action@${'b'.repeat(40)}
      - uses: actions/attest-build-provenance@${'c'.repeat(40)}
      - run: |
          docker buildx imagetools create image
          cosign sign --yes image
          cosign attest --yes image
`)
  const errors = validateContainerCandidates(input).join('; ')
  for (const forbidden of ['inputs:', 'publish:', 'packages: write', 'docker/login-action@', 'docker/build-push-action@', 'actions/attest-build-provenance@', 'docker buildx imagetools create', 'cosign sign --yes', 'cosign attest --yes']) {
    assert.match(errors, new RegExp(`publication authority: ${forbidden.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}`, 'u'))
  }
})

test('requires pinned read-only checkout and exact verification evidence flow', async () => {
  const input = await fixture()
  input.workflow = input.workflow
    .replace('persist-credentials: false', 'persist-credentials: true')
    .replace(/actions\/upload-artifact@[0-9a-f]{40}/u, 'actions/upload-artifact@main')
    .replace('--scope release', '--scope reference')
    .replace(input.policy.signaturePolicy.identityRegexp, '^https://example.invalid/$')
  const errors = validateContainerCandidates(input).join('; ')
  assert.match(errors, /sole read-only checkout/u)
  assert.match(errors, /actions\/upload-artifact must be SHA pinned/u)
  assert.match(errors, /candidate workflow is missing --scope release/u)
  assert.match(errors, /exact keyless identity/u)
})

test('rejects reintroducing the retired one-shot recovery jobs', async () => {
  const input = await fixture()
  input.workflow += '\n  verify-lk-jwt-service-mesh-2:\n    runs-on: ubuntu-latest\n  publish-lk-jwt-service-mesh-2:\n    runs-on: ubuntu-latest\n'
  const errors = validateContainerCandidates(input).join('; ')
  assert.match(errors, /publication authority: verify-lk-jwt-service-mesh-2:/u)
  assert.match(errors, /publication authority: publish-lk-jwt-service-mesh-2:/u)
})
