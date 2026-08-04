import assert from 'node:assert/strict'
import test from 'node:test'
import { collectComposeImages, validateContainerPolicy } from './check-container-supply-chain.mjs'

const exact = `example/image:1.2.3@sha256:${'a'.repeat(64)}`
const policy = {
  scannerPolicy: { candidateOutage: 'fail-closed', developmentOutage: 'blocked-unavailable', severityCutoff: 'high', onlyFixable: true },
  requiredUpdateRegressions: ['disposable-federation', 'backup', 'restore', 'health', 'cleanup'],
  images: [{ image: exact }],
  exceptions: [],
}
const workflow = `${exact}\nuses: anchore/sbom-action@${'b'.repeat(40)}\nuses: anchore/scan-action@${'c'.repeat(40)}\nseverity-cutoff: high\nonly-fixed: true\nif-no-files-found: error`

test('extracts Compose image references', () => {
  assert.deepEqual(collectComposeImages(`services:\n  app:\n    image: ${exact}\n`), [exact])
})

test('accepts exact images with fail-closed scanning and update regressions', () => {
  assert.deepEqual(validateContainerPolicy({ occurrences: [{ image: exact }], policy, workflowText: workflow }), [])
})

test('rejects floating images and broad or expired exceptions', () => {
  const bad = structuredClone(policy)
  bad.images = [{ image: 'example/image:latest' }]
  bad.exceptions = [{ digest: 'not-exact', vulnerabilityId: 'CVE-test', reason: '', reviewer: '', expiresAt: '2020-01-01T00:00:00Z' }]
  const errors = validateContainerPolicy({ occurrences: [{ image: 'example/image:latest' }], policy: bad })
  assert.ok(errors.some((error) => error.includes('not exact tag+digest')))
  assert.ok(errors.some((error) => error.includes('exception must bind')))
  assert.ok(errors.some((error) => error.includes('expired')))
})
