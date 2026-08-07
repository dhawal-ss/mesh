import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDirectory = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(scriptDirectory, '..')
const contractPath = resolve(repoRoot, 'release', 'owner-decisions.json')
const EXPECTED_IDS = Object.freeze(Array.from({ length: 11 }, (_, index) => `D${index + 1}`))

function nonEmpty(value) {
  return typeof value === 'string' && value.trim() === value && value.length > 0
}

export function validateOwnerDecisions(contract) {
  const errors = []
  const fail = (message) => errors.push(message)
  if (!contract || typeof contract !== 'object' || Array.isArray(contract)) return ['owner decision contract must be an object']
  if (contract.schemaVersion !== 1) fail('schemaVersion must be 1')
  if (!/^\d{4}-\d{2}-\d{2}\.\d+$/u.test(contract.contractVersion ?? '')) fail('contractVersion must be a dated revision')
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(contract.approvedAt ?? '')) fail('approvedAt must be an ISO date')
  if (contract.releaseScope !== 'first-public-beta') fail('releaseScope must be first-public-beta')
  if (!nonEmpty(contract.authority)) fail('authority must record the approval basis')

  const release = contract.release ?? {}
  if (!/^\d+\.\d+\.\d+$/u.test(release.version ?? '') || release.version === '0.1.0') fail('release.version must be a non-placeholder numeric three-part version')
  if (release.tag !== `v${release.version}`) fail('release.tag must exactly match release.version')
  if (release.channel !== 'beta' || release.githubPrerelease !== true) fail('the first release must remain a GitHub beta prerelease')
  if (release.updaterEnabled !== false) fail('automatic updates must remain disabled for the first beta')
  if (release.license !== 'AGPL-3.0-only') fail('release license must remain AGPL-3.0-only')
  if (release.contributionPolicy !== 'DCO-1.1-inbound-equals-outbound-no-CLA') fail('the approved DCO contribution policy is missing')

  const windows = contract.windowsDistribution ?? {}
  if (windows.canonicalInstaller !== 'nsis' || windows.canonicalInstallMode !== 'currentUser') fail('NSIS current-user installation must be the canonical consumer path')
  if (windows.secondaryInstaller !== 'msi' || windows.secondaryAudience !== 'managed-deployment') fail('MSI must remain the secondary managed-deployment path')
  if (windows.crossFormatBehavior !== 'block-with-guidance' || windows.automaticMigration !== false) fail('cross-format replacement must block with guidance and no automatic migration')
  if (windows.userDataOnUninstall !== 'retain-by-default') fail('uninstall must retain user data by default')

  const acceptance = contract.acceptance ?? {}
  if (acceptance.windowsMilestone !== 'R2' || acceptance.windowsRequiredCases !== 55) fail('R2 must require 55 Windows and operations cases')
  if (acceptance.allPlatformMilestone !== 'R4' || acceptance.allPlatformRequiredCases !== 63) fail('R4 must require all 63 cases')

  const implementation = contract.implementation ?? {}
  const candidateBlockers = Array.isArray(implementation.candidateBlockers) ? implementation.candidateBlockers : []
  if (implementation.candidateSourceReady !== (candidateBlockers.length === 0)) fail('candidateSourceReady must exactly reflect whether candidateBlockers is empty')
  const blockerIds = new Set()
  for (const blocker of candidateBlockers) {
    if (!EXPECTED_IDS.includes(blocker?.id)) fail('candidate blocker id must name D1 through D11')
    if (blockerIds.has(blocker?.id)) fail(`duplicate candidate blocker: ${blocker?.id}`)
    blockerIds.add(blocker?.id)
    if (!nonEmpty(blocker?.reason)) fail(`candidate blocker ${blocker?.id ?? 'unknown'} requires a reason`)
  }

  const decisions = contract.decisions ?? {}
  const ids = Object.keys(decisions).sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)))
  if (ids.join(',') !== EXPECTED_IDS.join(',')) fail('decisions must contain exactly D1 through D11')
  for (const id of EXPECTED_IDS) {
    const decision = decisions[id]
    if (!decision) continue
    if (decision.status !== 'approved') fail(`${id} must be approved`)
    for (const field of ['selection', 'summary', 'implementationStatus', 'implementationGate', 'rollbackOwner']) {
      if (!nonEmpty(decision[field])) fail(`${id}.${field} must be a non-empty string`)
    }
    if (decision.implementationGate === 'required-before-candidate' && decision.implementationStatus !== 'implemented' && !blockerIds.has(id)) {
      fail(`${id} is required before candidate creation and must remain an explicit blocker until implemented`)
    }
    if (decision.implementationStatus === 'implemented' && blockerIds.has(id)) fail(`${id} cannot be implemented and candidate-blocking at the same time`)
  }

  const requiredSelections = {
    D1: 'session-only-decrypted-media',
    D2: 'single-canonical-owner-no-beta-transfer',
    D3: 'operational-receipts-not-authoritative-audit',
    D4: 'standard-matrix-invite-and-knock',
    D5: 'risk-tiered-native-presence-plus-provider-reauth',
    D6: 'nsis-consumer-msi-managed',
    D7: 'signed-draft-prerelease-no-updater',
    D8: 'best-effort-community-hosting-no-sla',
    D9: 'standard-moderation-and-rate-limits-only',
    D10: 'mobile-unsupported-in-first-beta',
    D11: 'no-third-party-apps-in-first-beta',
  }
  for (const [id, selection] of Object.entries(requiredSelections)) {
    if (decisions[id]?.selection !== selection) fail(`${id} must use the approved selection ${selection}`)
  }
  return errors
}

export async function loadOwnerDecisions(path = contractPath) {
  return JSON.parse(await readFile(path, 'utf8'))
}

async function main() {
  const contract = await loadOwnerDecisions()
  const errors = validateOwnerDecisions(contract)
  if (errors.length > 0) throw new Error(`Owner decision contract failed:\n- ${errors.join('\n- ')}`)
  console.log(`Owner decision contract passed (${Object.keys(contract.decisions).length} approved decisions, ${contract.release.tag}).`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
