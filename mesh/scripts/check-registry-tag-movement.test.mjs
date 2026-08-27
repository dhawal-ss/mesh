import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { parseRegistryMaintenanceControl, registryCandidateEntries } from './check-registry-digest-age.mjs'
import {
  inspectRegistryTagMovement,
  manualPublicationAuthorization,
  validateManualPublicationWorkflow,
  validateRegistryTagBindings,
} from './check-registry-tag-movement.mjs'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

async function fixture() {
  const [markdown, policyText, workflow] = await Promise.all([
    readFile(path.join(projectRoot, 'infra/REGISTRY_MAINTENANCE.md'), 'utf8'),
    readFile(path.join(projectRoot, 'infra/container-candidates/candidate-policy.json'), 'utf8'),
    readFile(path.resolve(projectRoot, '..', '.github/workflows/container-candidates.yml'), 'utf8'),
  ])
  const control = parseRegistryMaintenanceControl(markdown)
  const entries = registryCandidateEntries(JSON.parse(policyText), control)
  return { control, entries, workflow }
}

const denied = { authorized: false, reason: 'registry-mutation-not-authorized' }

test('accepts current live bindings and the retired read-only workflow', async () => {
  const result = await inspectRegistryTagMovement(projectRoot, {
    environment: {},
    resolveTag: async (entry) => ({ status: 'present', digest: entry.digest }),
  })
  assert.equal(result.results.length, 2)
  assert.ok(result.results.every((entry) => entry.status === 'immutable-tag-confirmed'))
  assert.deepEqual(result.publicationAuthorization, denied)
})

test('rejects a moved tag without any checked-in mutation exception', async () => {
  const { entries } = await fixture()
  const observed = new Map(entries.map((entry) => [entry.image, { status: 'present', digest: entry.digest }]))
  observed.get(entries[1].image).digest = `sha256:${'a'.repeat(64)}`
  const errors = validateRegistryTagBindings({ entries, observedByImage: observed, publicationAuthorization: denied }).errors
  assert.equal(errors.length, 1)
  assert.match(errors[0], /release tag moved/u)
})

test('never authorizes publication from the permanent checked-in workflow', async () => {
  const { control, entries } = await fixture()
  for (const ref of ['refs/heads/main']) {
    const authorization = manualPublicationAuthorization({
      eventName: 'workflow_dispatch',
      repository: 'dhawal-ss/mesh',
      workflowRef: `dhawal-ss/mesh/.github/workflows/container-candidates.yml@${ref}`,
      ref,
      publish: 'true',
    }, control)
    assert.deepEqual(authorization, denied)
  }
  const absent = new Map(entries.map((entry) => [entry.image, { status: 'absent' }]))
  const result = validateRegistryTagBindings({ entries, observedByImage: absent, publicationAuthorization: denied })
  assert.equal(result.errors.length, 2)
  assert.ok(result.errors.every((error) => /no authorized publication path/u.test(error)))
})

test('accepts the permanent read-only verification workflow contract', async () => {
  const { control, workflow } = await fixture()
  const errors = validateManualPublicationWorkflow({ workflows: new Map([[control.manualPublicationWorkflow, workflow]]), control })
  assert.deepEqual(errors, [])
})

test('rejects registry mutation in the former publication workflow or any other workflow', async () => {
  const { control, workflow } = await fixture()
  const mutations = [
    'permissions:\n  packages: write',
    `steps:\n  - uses: docker/login-action@${'a'.repeat(40)}`,
    `steps:\n  - uses: docker/build-push-action@${'b'.repeat(40)}`,
    'steps:\n  - run: docker buildx imagetools create image',
    'steps:\n  - run: cosign sign --yes image',
    'steps:\n  - run: cosign attest --yes image',
    'steps:\n  - run: true\n    with:\n      push-to-registry: true',
  ]
  for (const mutation of mutations) {
    const approvedMutation = `${workflow}\n${mutation}\n`
    let errors = validateManualPublicationWorkflow({ workflows: new Map([[control.manualPublicationWorkflow, approvedMutation]]), control })
    assert.ok(errors.some((error) => /exposes registry mutation while the checked-in repository must remain read-only/u.test(error)), mutation)

    errors = validateManualPublicationWorkflow({ workflows: new Map([
      [control.manualPublicationWorkflow, workflow],
      ['.github/workflows/other.yml', mutation],
    ]), control })
    assert.ok(errors.some((error) => /other\.yml exposes registry mutation/u.test(error)), mutation)
  }
})

test('rejects restoring a publish input, fixed incident variables, or one-shot jobs', async () => {
  const { control, workflow } = await fixture()
  const restored = workflow
    .replace('workflow_dispatch:', 'workflow_dispatch:\n    inputs:\n      publish:\n        type: boolean')
    .concat(`
  verify-lk-jwt-service-mesh-2:
    env:
      SOURCE_IMAGE: source
      TARGET_IMAGE: target
      EXPECTED_DIGEST: digest
  publish-lk-jwt-service-mesh-2:
    runs-on: ubuntu-latest
`)
  const errors = validateManualPublicationWorkflow({ workflows: new Map([[control.manualPublicationWorkflow, restored]]), control })
  for (const marker of ['inputs:', 'publish:', 'verify-lk-jwt-service-mesh-2:', 'publish-lk-jwt-service-mesh-2:', 'SOURCE_IMAGE:', 'TARGET_IMAGE:', 'EXPECTED_DIGEST:']) {
    assert.ok(errors.some((error) => error.includes(marker)), marker)
  }
})

test('requires the current .2 tag and exact digest in the read-only workflow', async () => {
  const { control, workflow } = await fixture()
  const stale = workflow.replace('tag: 0.5.0-mesh.2', 'tag: 0.5.0-mesh.1')
  const errors = validateManualPublicationWorkflow({ workflows: new Map([[control.manualPublicationWorkflow, stale]]), control })
  assert.ok(errors.some((error) => /missing tag: 0\.5\.0-mesh\.2/u.test(error)))
})
