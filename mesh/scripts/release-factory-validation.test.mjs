import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { deriveReleaseIntent } from './release-factory-validation.mjs'

test('protected main is validation-only', () => {
  assert.deepEqual(deriveReleaseIntent({ eventName: 'push', ref: 'refs/heads/main' }), {
    mode: 'validation-only', createCandidate: false, releaseTag: '',
  })
})

test('a generic manual invocation cannot bypass candidate checks', () => {
  assert.throws(
    () => deriveReleaseIntent({ eventName: 'workflow_dispatch', validationOnly: false }),
    /requires an explicit release tag/,
  )
})

test('validation-only cannot smuggle a release tag', () => {
  assert.throws(
    () => deriveReleaseIntent({ eventName: 'workflow_dispatch', validationOnly: true, releaseTag: 'v1.2.3' }),
    /cannot name a release tag/,
  )
})

test('validation job is read-only and cannot reference secret or variable contexts', async () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
  const workflow = await readFile(path.join(root, '.github', 'workflows', 'release-beta.yml'), 'utf8')
  const qualityJob = workflow.slice(workflow.indexOf('  quality-gate:'), workflow.indexOf('\n  windows:'))
  assert.match(workflow, /permissions:\s*\n\s*actions: read\s*\n\s*contents: read/)
  assert.match(qualityJob, /-ValidationOnly/)
  assert.doesNotMatch(qualityJob, /\$\{\{\s*(?:secrets|vars)\./)
  assert.match(workflow, /if: \$\{\{ needs\.quality-gate\.outputs\.create_candidate == 'true' \}\}/)
})

test('tag candidates normalize the release version before the Windows job', async () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
  const workflow = await readFile(path.join(root, '.github', 'workflows', 'release-beta.yml'), 'utf8')
  const qualityJob = workflow.slice(workflow.indexOf('  quality-gate:'), workflow.indexOf('\n  container-supply-chain-r2:'))
  const windowsJob = workflow.slice(workflow.indexOf('  windows:'))

  assert.match(qualityJob, /release_version="\$\{MESH_RELEASE_VERSION#v\}"/)
  assert.match(qualityJob, /echo "release_version=\$release_version" >> "\$GITHUB_OUTPUT"/)
  assert.match(qualityJob, /echo "MESH_RELEASE_VERSION=\$release_version" >> "\$GITHUB_ENV"/)
  assert.match(windowsJob, /MESH_RELEASE_VERSION: \$\{\{ needs\.quality-gate\.outputs\.release_version \}\}/)
})

test('candidate container scans use the exact source selected by the quality gate', async () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
  const workflow = await readFile(path.join(root, '.github', 'workflows', 'release-beta.yml'), 'utf8')
  const containerJob = workflow.slice(
    workflow.indexOf('  container-supply-chain-r2:'),
    workflow.indexOf('\n  windows:'),
  )

  assert.match(containerJob, /needs: quality-gate/)
  assert.match(containerJob, /if: \$\{\{ needs\.quality-gate\.outputs\.create_candidate == 'true' \}\}/)
  assert.match(containerJob, /ref: \$\{\{ needs\.quality-gate\.outputs\.source_sha \}\}/)
  assert.match(containerJob, /candidate-container-\$\{\{ matrix\.name \}\}-\$\{\{ needs\.quality-gate\.outputs\.source_sha \}\}/)
  assert.doesNotMatch(containerJob, /candidate-container-.*\$\{\{ github\.sha \}\}/)
})
