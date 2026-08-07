import assert from 'node:assert/strict'
import test from 'node:test'
import { validateProtectedEvidenceManifest } from './protected-evidence-manifest.mjs'

const sha = 'a'.repeat(40)
const base = {
  schemaVersion: 1,
  manifestId: 'mesh-protected-ci-evidence',
  sourceCommit: sha,
  sourceTreeHash: 'b'.repeat(40),
  workflow: { name: 'CI', runId: '123', runAttempt: 1, uri: 'https://github.com/dhawal-ss/mesh/actions/runs/123' },
  runner: { os: 'linux', arch: 'x64', toolVersions: { node: 'v22' } },
  commands: [{ command: 'npm test', status: 'pass', passed: 10, failed: 0, ignored: 1, ignoredTests: ['documented fixture'], durationMs: 100 }],
  artifacts: [{ name: 'evidence', uri: 'https://github.com/dhawal-ss/mesh/actions/runs/123/artifacts/456', sha256: 'c'.repeat(64), sizeBytes: 42 }],
  build: { mode: 'matrix-text', features: ['matrix-backend'] },
  collectedAt: '2026-08-01T00:00:00.000Z',
  expiresAt: '2026-09-01T00:00:00.000Z',
  reviewer: null,
}

test('accepts exact immutable protected evidence', () => {
  assert.deepEqual(validateProtectedEvidenceManifest(base, { now: new Date('2026-08-02') }), [])
})

for (const [name, mutate, expected] of [
  ['mutable latest URI', (value) => { value.artifacts[0].uri = 'https://github.com/example/mesh/releases/latest' }, 'immutable HTTPS'],
  ['cross-SHA artifact', (value) => { value.artifacts[0].uri += `/${'d'.repeat(40)}` }, 'another source SHA'],
  ['missing digest', (value) => { value.artifacts[0].sha256 = null }, 'sha256 is invalid'],
  ['expired evidence', (value) => { value.expiresAt = '2026-08-01T00:00:00.000Z' }, 'expired'],
  ['prose-only command claim', (value) => { value.commands = [] }, 'commands must be non-empty'],
  ['ignored count drift', (value) => { value.commands[0].ignored = 2 }, 'ignored count'],
  ['foreign workflow repository', (value) => { value.workflow.uri = 'https://github.com/example/mesh/actions/runs/123' }, 'immutable GitHub Actions run URI'],
  ['foreign artifact repository', (value) => { value.artifacts[0].uri = 'https://github.com/example/mesh/actions/runs/123/artifacts/456' }, 'must belong to dhawal-ss/mesh'],
  ['artifact from another run', (value) => { value.artifacts[0].uri = 'https://github.com/dhawal-ss/mesh/actions/runs/999/artifacts/456' }, 'manifest workflow run'],
  ['future collection time', (value) => { value.collectedAt = '2099-01-01T00:00:00.000Z'; value.expiresAt = '2100-01-01T00:00:00.000Z' }, 'cannot be in the future'],
  ['expiry before collection', (value) => { value.expiresAt = '2026-07-31T00:00:00.000Z' }, 'later than collectedAt'],
  ['unknown manifest field', (value) => { value.unreviewedClaim = true }, 'only the protected evidence schema fields'],
  ['empty workflow name', (value) => { value.workflow.name = '' }, 'workflow.name is required'],
]) {
  test(`rejects ${name}`, () => {
    const value = structuredClone(base)
    mutate(value)
    assert.ok(validateProtectedEvidenceManifest(value, { now: new Date('2026-08-02') }).some((error) => error.includes(expected)))
  })
}
