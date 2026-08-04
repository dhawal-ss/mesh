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
  assert.match(workflow, /permissions:\s*\n\s*contents: read/)
  assert.match(qualityJob, /-ValidationOnly/)
  assert.doesNotMatch(qualityJob, /\$\{\{\s*(?:secrets|vars)\./)
  assert.match(workflow, /if: \$\{\{ needs\.quality-gate\.outputs\.create_candidate == 'true' \}\}/)
})
