import assert from 'node:assert/strict'
import test from 'node:test'
import { validateProtectedSecurityResults } from './protected-security-results.mjs'

const sha = 'a'.repeat(40)
const successful = {
  codeql: 'success',
  dependencyReview: 'success',
  featureMatrix: 'success',
  dependencyAudit: 'success',
  sbom: 'success',
  r2Containers: 'success',
}

test('accepts every required security job on pull requests', () => {
  assert.deepEqual(validateProtectedSecurityResults(successful, {
    eventName: 'pull_request',
    sourceSha: sha,
  }), [])
})

test('allows only dependency review to skip on push', () => {
  const results = { ...successful, dependencyReview: 'skipped' }
  assert.deepEqual(validateProtectedSecurityResults(results, {
    eventName: 'push',
    sourceSha: sha,
  }), [])

  for (const name of Object.keys(results).filter((key) => key !== 'dependencyReview')) {
    const invalid = { ...results, [name]: 'skipped' }
    assert.ok(validateProtectedSecurityResults(invalid, {
      eventName: 'push',
      sourceSha: sha,
    }).some((error) => error.includes(`${name} must be success`)))
  }
})

test('rejects skipped dependency review on pull requests', () => {
  const errors = validateProtectedSecurityResults({
    ...successful,
    dependencyReview: 'skipped',
  }, { eventName: 'pull_request', sourceSha: sha })
  assert.ok(errors.some((error) => error.includes('dependencyReview must be success')))
})

test('rejects failed jobs, unknown events, source drift, and result-key drift', () => {
  assert.ok(validateProtectedSecurityResults({ ...successful, codeql: 'failure' }, {
    eventName: 'pull_request',
    sourceSha: sha,
  }).some((error) => error.includes('codeql must be success')))
  assert.ok(validateProtectedSecurityResults(successful, {
    eventName: 'workflow_dispatch',
    sourceSha: 'not-a-sha',
  }).length >= 2)
  assert.ok(validateProtectedSecurityResults({ ...successful, unexpected: 'success' }, {
    eventName: 'pull_request',
    sourceSha: sha,
  }).some((error) => error.includes('exact required job keys')))
})
