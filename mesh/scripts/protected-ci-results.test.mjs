import assert from 'node:assert/strict'
import test from 'node:test'
import { validateProtectedCiResults } from './protected-ci-results.mjs'

const sha = 'a'.repeat(40)
const successful = { matrixRust: 'success', legacyRust: 'success', frontend: 'success' }

test('accepts only a complete successful protected CI result set', () => {
  assert.deepEqual(validateProtectedCiResults(successful, { sourceSha: sha }), [])
})

test('rejects failed, skipped, missing, extra, and source-drifted results', () => {
  assert.ok(validateProtectedCiResults({ ...successful, matrixRust: 'failure' }, { sourceSha: sha })
    .some((error) => error.includes('matrixRust must be success')))
  assert.ok(validateProtectedCiResults({ ...successful, frontend: 'skipped' }, { sourceSha: sha })
    .some((error) => error.includes('frontend must be success')))
  assert.ok(validateProtectedCiResults({ matrixRust: 'success', legacyRust: 'success' }, { sourceSha: sha })
    .some((error) => error.includes('exact required job keys')))
  assert.ok(validateProtectedCiResults({ ...successful, other: 'success' }, { sourceSha: sha })
    .some((error) => error.includes('exact required job keys')))
  assert.ok(validateProtectedCiResults(successful, { sourceSha: 'not-a-sha' })
    .some((error) => error.includes('exact source SHA')))
})
