import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const root = new URL('../', import.meta.url)
const read = async (path) => readFile(new URL(path, root), 'utf8')
const [contract, tauriConfig, packageConfig, viteConfig, supportPage] = await Promise.all([
  read('release/beta-contract.json').then(JSON.parse),
  read('src-tauri/tauri.conf.json').then(JSON.parse),
  read('package.json').then(JSON.parse),
  read('vite.config.ts'),
  read('../site/support/index.html'),
])

assert.equal(contract.schemaVersion, 1)
assert.equal(contract.releaseState, 'developer-preview')
assert.equal(contract.candidate.platform, 'windows')
assert.equal(contract.candidate.backend, 'matrix')
assert.deepEqual(tauriConfig.bundle.targets, ['msi', 'nsis'])

const excluded = new Set(contract.candidate.excludedCapabilities)
for (const capability of ['matrix-voice', 'legacy-p2p', 'automatic-updates']) {
  assert.equal(excluded.has(capability), true, `${capability} must remain outside the text beta`)
}

assert.equal(contract.claims.consumerBeta, false)
assert.equal(contract.claims.productionReady, false)
assert.equal(contract.claims.communityHostingOptional, true)
assert.equal(contract.claims.accountHostingIndependent, true)
assert.equal(contract.claims.voiceReady, false)

assert.match(packageConfig.scripts['build:matrix'], /--mode matrix(?:\s|$)/)
assert.match(packageConfig.scripts['build:matrix-voice'], /--mode matrix-voice(?:\s|$)/)
assert.match(viteConfig, /__MESH_MATRIX_VOICE_FRONTEND__/)
assert.match(viteConfig, /mode === "matrix-voice" \|\| mode === "test"/)
assert.match(viteConfig, /livekit-voice\.disabled\.ts/)

for (const statement of [
  'Windows is the only candidate platform',
  'Voice is not included in the text and community beta',
  'Automatic updates remain disabled',
  'macOS and Linux are not advertised as supported',
]) {
  assert.equal(supportPage.includes(statement), true, `support page is missing: ${statement}`)
}

console.log('Beta contract passed: Windows Matrix text/community developer preview; voice, LAN, and updater excluded.')
