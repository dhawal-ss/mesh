import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { validateInstallerCoexistence } from './installer-coexistence-contract.mjs'

const root = new URL('../', import.meta.url)
const read = async (path) => readFile(new URL(path, root), 'utf8')
const [contract, ownerDecisions, tauriConfig, cargoConfig, packageConfig, viteConfig, supportPage, nsisHooks, wixFragment] = await Promise.all([
  read('release/beta-contract.json').then(JSON.parse),
  read('release/owner-decisions.json').then(JSON.parse),
  read('src-tauri/tauri.conf.json').then(JSON.parse),
  read('src-tauri/Cargo.toml'),
  read('package.json').then(JSON.parse),
  read('vite.config.ts'),
  read('../site/support/index.html'),
  read('src-tauri/windows/installer-coexistence.nsh'),
  read('src-tauri/windows/installer-coexistence.wxs'),
])

assert.equal(contract.schemaVersion, 1)
assert.equal(contract.releaseState, 'developer-preview')
assert.equal(contract.candidate.platform, 'windows')
assert.equal(contract.candidate.backend, 'matrix')
assert.equal(contract.candidate.version, ownerDecisions.release.version)
assert.equal(contract.candidate.releaseChannel, 'beta')
assert.equal(contract.candidate.publicationState, 'draft-prerelease-until-acceptance')
assert.equal(packageConfig.version, ownerDecisions.release.version)
assert.equal(tauriConfig.version, ownerDecisions.release.version)
assert.match(cargoConfig, new RegExp(`\\[package\\][\\s\\S]*?\\nversion = "${ownerDecisions.release.version.replaceAll('.', '\\.')}"`))
assert.deepEqual(tauriConfig.bundle.targets, ['msi', 'nsis'])
assert.equal(tauriConfig.bundle.windows.nsis.installMode, 'currentUser')
assert.deepEqual(validateInstallerCoexistence({
  config: tauriConfig,
  nsisHooks,
  wixFragment,
}), [])
assert.deepEqual(contract.distribution, {
  canonicalInstaller: ownerDecisions.windowsDistribution.canonicalInstaller,
  canonicalInstallMode: ownerDecisions.windowsDistribution.canonicalInstallMode,
  secondaryInstaller: ownerDecisions.windowsDistribution.secondaryInstaller,
  secondaryAudience: ownerDecisions.windowsDistribution.secondaryAudience,
  crossFormatBehavior: ownerDecisions.windowsDistribution.crossFormatBehavior,
  userDataOnUninstall: ownerDecisions.windowsDistribution.userDataOnUninstall,
  automaticUpdates: ownerDecisions.release.updaterEnabled,
})

const excluded = new Set(contract.candidate.excludedCapabilities)
assert.equal(contract.candidate.capabilities.includes('matrix-voice'), true,
  'the signed draft beta candidate must include Matrix voice for physical acceptance')
assert.equal(excluded.has('matrix-voice'), false,
  'Matrix voice cannot remain excluded from a useful consumer beta candidate')
for (const capability of ['legacy-p2p', 'automatic-updates']) {
  assert.equal(excluded.has(capability), true, `${capability} must remain outside the beta`)
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
  'Voice is included in the signed draft candidate',
  'Automatic updates remain disabled',
  'macOS and Linux are not advertised as supported',
]) {
  assert.equal(supportPage.includes(statement), true, `support page is missing: ${statement}`)
}

console.log(`Beta contract passed: ${ownerDecisions.release.tag} Windows Matrix voice developer preview; NSIS consumer path; voice included for acceptance; LAN and updater excluded.`)
