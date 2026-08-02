import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'

const online = process.argv.includes('--online')
const root = new URL('../../', import.meta.url)
const [policy, publicPage] = await Promise.all([
  readFile(new URL('SECURITY.md', root), 'utf8'),
  readFile(new URL('site/security/index.html', root), 'utf8'),
])

const unavailable = policy.includes('Confidential route status: unavailable')
const enabled = policy.includes('Confidential route status: enabled')
assert.notEqual(unavailable, enabled, 'SECURITY.md must declare exactly one confidential route state')

if (unavailable) {
  assert.doesNotMatch(publicPage, /security\/advisories\/new/)
  assert.match(publicPage, /Confidential reporting is not available yet/)
  assert.match(policy, /production beta is blocked/i)
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
