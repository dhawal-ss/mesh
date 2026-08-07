import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'

const online = process.argv.includes('--online')
const root = new URL('../../', import.meta.url)
const [policy, publicPage, supportPage, incidentGuide] = await Promise.all([
  readFile(new URL('SECURITY.md', root), 'utf8'),
  readFile(new URL('site/security/index.html', root), 'utf8'),
  readFile(new URL('site/support/index.html', root), 'utf8'),
  readFile(new URL('mesh/docs/operations/INCIDENT_RESPONSE.rst', root), 'utf8'),
])

const unavailable = policy.includes('Confidential route status: unavailable')
const enabled = policy.includes('Confidential route status: enabled')
assert.notEqual(unavailable, enabled, 'SECURITY.md must declare exactly one confidential route state')

if (unavailable) {
  assert.doesNotMatch(publicPage, /security\/advisories\/new/)
  assert.match(publicPage, /Confidential reporting is not available yet/)
  assert.match(policy, /production beta is blocked/i)
  assert.doesNotMatch(supportPage, /private security report/i)
  assert.match(supportPage, /security reporting status/i)
  assert.doesNotMatch(incidentGuide, /vulnerabilities use GitHub private vulnerability reporting/i)
  assert.match(incidentGuide, /consumer beta remains\s+blocked/i)
} else {
  assert.match(policy, /security\/advisories\/new|mailto:/)
  assert.match(publicPage, /security\/advisories\/new|mailto:/)
}

if (online) {
  const result = spawnSync(
    'gh',
    ['api', 'repos/dhawal-ss/mesh/private-vulnerability-reporting'],
    { encoding: 'utf8', windowsHide: true },
  )
  assert.equal(result.status, 0, `GitHub route check failed: ${result.stderr.trim()}`)
  const state = JSON.parse(result.stdout)
  assert.equal(state.enabled, enabled, 'documented confidential route state differs from GitHub')
}

console.log(`Security disclosure drill passed (${enabled ? 'enabled' : 'fail-closed unavailable'} route${online ? ', online verified' : ''}).`)
