import assert from 'node:assert/strict'
import test from 'node:test'
import { loadOwnerDecisions, validateOwnerDecisions } from './check-owner-decisions.mjs'

function clone(value) {
  return structuredClone(value)
}

test('tracked owner decisions are internally consistent', async () => {
  assert.deepEqual(validateOwnerDecisions(await loadOwnerDecisions()), [])
})

test('rejects a placeholder or prerelease-suffixed MSI version', async () => {
  const contract = clone(await loadOwnerDecisions())
  contract.release.version = '0.2.0-beta.1'
  contract.release.tag = 'v0.2.0-beta.1'
  assert.ok(validateOwnerDecisions(contract).some((error) => error.includes('numeric three-part version')))
})

test('rejects enabling the updater', async () => {
  const contract = clone(await loadOwnerDecisions())
  contract.release.updaterEnabled = true
  assert.ok(validateOwnerDecisions(contract).some((error) => error.includes('updates must remain disabled')))
})

test('rejects installer-policy drift', async () => {
  const contract = clone(await loadOwnerDecisions())
  contract.windowsDistribution.canonicalInstaller = 'msi'
  assert.ok(validateOwnerDecisions(contract).some((error) => error.includes('NSIS current-user')))
})

test('rejects missing decisions', async () => {
  const contract = clone(await loadOwnerDecisions())
  delete contract.decisions.D5
  assert.ok(validateOwnerDecisions(contract).some((error) => error.includes('exactly D1 through D11')))
})

test('rejects hiding an unimplemented candidate requirement', async () => {
  const contract = clone(await loadOwnerDecisions())
  contract.decisions.D6.implementationStatus = 'partial'
  assert.ok(validateOwnerDecisions(contract).some((error) => error.includes('must remain an explicit blocker')))
})
