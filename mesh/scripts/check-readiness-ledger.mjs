import { readFile } from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, isAbsolute, relative, resolve } from 'node:path'
import { promisify } from 'node:util'

const scriptDirectory = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(scriptDirectory, '..')
const ledgerPath = resolve(repoRoot, 'release', 'readiness.json')
const schemaPath = resolve(repoRoot, 'release', 'readiness.schema.json')
const execFileAsync = promisify(execFile)
const LEDGER_RELATIVE_PATH = 'release/readiness.json'
const SHA_PATTERN = /^[0-9a-f]{40}$/
const MILESTONES = ['R0', 'R1', 'R2', 'R3', 'R4']
const STATUSES = ['unverified', 'local-pass', 'live-pass', 'blocked', 'waived']
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/
const SHA256_PATTERN = /^[0-9a-f]{64}$/

export const REQUIRED_RELEASE_GATES = Object.freeze([
  { id: 'r1.provider-identity-lifecycle', milestone: 'R1', required: true, releaseStatus: 'live-pass' },
  { id: 'r1.community-hosted-operations', milestone: 'R1', required: true, releaseStatus: 'live-pass' },
  { id: 'r1.public-service-review', milestone: 'R1', required: true, releaseStatus: 'live-pass' },
  { id: 'r2.signed-windows-beta', milestone: 'R2', required: true, releaseStatus: 'live-pass' },
  { id: 'r2.public-release', milestone: 'R2', required: true, releaseStatus: 'live-pass' },
  { id: 'r2.manual-accessibility-windows', milestone: 'R2', required: true, releaseStatus: 'live-pass' },
  { id: 'r2.public-page-legal-approval', milestone: 'R2', required: true, releaseStatus: 'live-pass' },
  { id: 'r3.voice-live', milestone: 'R3', required: true, releaseStatus: 'live-pass' },
  { id: 'r4.native-invitation-delivery', milestone: 'R4', required: true, releaseStatus: 'live-pass' },
  { id: 'r4.manual-accessibility-cross-platform', milestone: 'R4', required: true, releaseStatus: 'live-pass' },
  { id: 'r0.dependency-advisory-policy', milestone: 'R0', required: true, releaseStatus: 'local-pass' },
])

export const DEFERRED_RELEASE_GATES = Object.freeze([
  { id: 'r1.admission-openid-verifier', required: false },
  { id: 'r1.admission-service-authority', required: false },
  { id: 'r1.moderation-audit-authority', required: false },
])

export function ledgerPathFromGitRoot(gitRoot) {
  const pathFromGitRoot = relative(resolve(gitRoot), ledgerPath).replaceAll('\\', '/')
  return pathFromGitRoot || LEDGER_RELATIVE_PATH
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim() === value && value.length > 0
}

function isIsoDate(value) {
  return typeof value === 'string' && ISO_DATE_PATTERN.test(value) && Number.isFinite(Date.parse(value))
}

function rejectUnknownKeys(value, allowedKeys, path, fail) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return
  for (const key of Object.keys(value)) {
    if (!allowedKeys.includes(key)) fail(`${path}.${key} is not allowed by the readiness schema`)
  }
}

function pathIsInsideRepo(candidate) {
  if (!isNonEmptyString(candidate) || isAbsolute(candidate)) return false
  const resolved = resolve(repoRoot, candidate)
  const relativePath = relative(repoRoot, resolved)
  return relativePath !== '' && !relativePath.startsWith('..') && !isAbsolute(relativePath)
}

function milestoneRank(milestone) {
  return MILESTONES.indexOf(milestone)
}

export function validateReadinessLedger(ledger, {
  now = new Date(),
  milestone = null,
  requireLive = false,
  commitSha = null,
  allowSourceCommitMismatch = false,
  enforceGateContract = false,
} = {}) {
  const errors = []
  const fail = (message) => errors.push(message)

  if (!ledger || typeof ledger !== 'object' || Array.isArray(ledger)) {
    return ['ledger must be an object']
  }
  rejectUnknownKeys(ledger, ['schemaVersion', 'ledgerId', 'sourceCommit', 'sourceTreeHash', 'updatedAt', 'gates'], 'ledger', fail)

  if (ledger.schemaVersion !== 2) fail('schemaVersion must be 2')
  if (ledger.ledgerId !== 'mesh-production-readiness') fail('ledgerId is invalid')
  if (!SHA_PATTERN.test(ledger.sourceCommit ?? '')) fail('sourceCommit must be a lowercase 40-character SHA')
  if (!SHA_PATTERN.test(ledger.sourceTreeHash ?? '')) fail('sourceTreeHash must be a lowercase 40-character Git tree hash')
  if (!isIsoDate(ledger.updatedAt)) fail('updatedAt must be an ISO UTC timestamp')
  if (commitSha !== null && ledger.sourceCommit !== commitSha && !allowSourceCommitMismatch) {
    fail(`sourceCommit ${ledger.sourceCommit} does not match requested commit ${commitSha}`)
  }

  const gates = Array.isArray(ledger.gates) ? ledger.gates : []
  if (gates.length === 0) fail('gates must be a non-empty array')
  const ids = new Set()

  for (const [index, gate] of gates.entries()) {
    const path = `gates[${index}]`
    if (!gate || typeof gate !== 'object' || Array.isArray(gate)) {
      fail(`${path} must be an object`)
      continue
    }
    rejectUnknownKeys(gate, ['id', 'milestone', 'required', 'releaseStatus', 'status', 'evidence', 'owner', 'capability', 'blockReason', 'nextAction', 'waiver'], path, fail)
    if (!isNonEmptyString(gate.id) || !/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(gate.id)) fail(`${path}.id is invalid`)
    if (ids.has(gate.id)) fail(`${path}.id duplicates ${gate.id}`)
    ids.add(gate.id)
    if (!MILESTONES.includes(gate.milestone)) fail(`${path}.milestone is invalid`)
    if (typeof gate.required !== 'boolean') fail(`${path}.required must be boolean`)
    if (!['local-pass', 'live-pass'].includes(gate.releaseStatus)) fail(`${path}.releaseStatus is invalid`)
    if (!STATUSES.includes(gate.status)) fail(`${path}.status is invalid`)
    if (!isNonEmptyString(gate.owner)) fail(`${path}.owner is required`)
    if (!isNonEmptyString(gate.capability)) fail(`${path}.capability is required`)
    if (gate.blockReason !== null && !isNonEmptyString(gate.blockReason)) fail(`${path}.blockReason must be a string or null`)
    if (gate.nextAction !== null && !isNonEmptyString(gate.nextAction)) fail(`${path}.nextAction must be a string or null`)

    const evidence = gate.evidence
    if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) {
      fail(`${path}.evidence must be an object`)
      continue
    }
    rejectUnknownKeys(evidence, ['testedCommit', 'testedTreeHash', 'command', 'artifactPath', 'artifactUri', 'artifactSha256', 'environment', 'collectedAt', 'expiresAt'], `${path}.evidence`, fail)
    if (evidence.testedCommit !== null && !SHA_PATTERN.test(evidence.testedCommit ?? '')) fail(`${path}.evidence.testedCommit is invalid`)
    if (evidence.testedTreeHash !== null && !SHA_PATTERN.test(evidence.testedTreeHash ?? '')) fail(`${path}.evidence.testedTreeHash is invalid`)
    if (evidence.command !== null && !isNonEmptyString(evidence.command)) fail(`${path}.evidence.command must be a string or null`)
    if (evidence.artifactPath !== null && !pathIsInsideRepo(evidence.artifactPath)) fail(`${path}.evidence.artifactPath must be a relative path inside the repository`)
    if (evidence.artifactUri !== undefined && evidence.artifactUri !== null) {
      try {
        const artifactUrl = new URL(evidence.artifactUri)
        if (artifactUrl.protocol !== 'https:') fail(`${path}.evidence.artifactUri must use HTTPS`)
        if (artifactUrl.username || artifactUrl.password || artifactUrl.search || artifactUrl.hash) fail(`${path}.evidence.artifactUri must not contain credentials, query parameters, or fragments`)
        if (/(?:^|\/)(?:latest|mutable)(?:\/|$)/i.test(artifactUrl.pathname)) fail(`${path}.evidence.artifactUri must not use a mutable or latest URL`)
        const embeddedShas = artifactUrl.pathname.match(/[0-9a-f]{40}/g) ?? []
        if (embeddedShas.some((sha) => sha !== ledger.sourceCommit)) fail(`${path}.evidence.artifactUri refers to another source SHA`)
      } catch {
        fail(`${path}.evidence.artifactUri must be a valid HTTPS URI or null`)
      }
    }
    if (evidence.artifactSha256 !== undefined && evidence.artifactSha256 !== null && !SHA256_PATTERN.test(evidence.artifactSha256)) {
      fail(`${path}.evidence.artifactSha256 must be a lowercase SHA-256 or null`)
    }
    if (evidence.environment !== null && !isNonEmptyString(evidence.environment)) fail(`${path}.evidence.environment must be a string or null`)
    if (evidence.collectedAt !== null && !isIsoDate(evidence.collectedAt)) fail(`${path}.evidence.collectedAt must be an ISO UTC timestamp or null`)
    if (evidence.expiresAt !== null && !isIsoDate(evidence.expiresAt)) fail(`${path}.evidence.expiresAt must be an ISO UTC timestamp or null`)

    if (gate.status === 'local-pass' || gate.status === 'live-pass') {
      if (evidence.testedCommit !== ledger.sourceCommit) fail(`${path} ${gate.status} evidence must use sourceCommit`)
      if (evidence.testedTreeHash !== ledger.sourceTreeHash) fail(`${path} ${gate.status} evidence must use sourceTreeHash`)
      if (!isNonEmptyString(evidence.command)) fail(`${path} ${gate.status} evidence requires command`)
      if (!isNonEmptyString(evidence.environment)) fail(`${path} ${gate.status} evidence requires environment`)
      if (!isIsoDate(evidence.collectedAt)) fail(`${path} ${gate.status} evidence requires collectedAt`)
      if (gate.blockReason !== null) fail(`${path} ${gate.status} cannot have blockReason`)
      if (gate.waiver !== null) fail(`${path} ${gate.status} cannot have a waiver`)
    }

    if (gate.status === 'live-pass') {
      const hasRepositoryArtifact = evidence.artifactPath !== null && evidence.artifactPath !== undefined
      const hasExternalArtifact = evidence.artifactUri !== null && evidence.artifactUri !== undefined
      if (hasRepositoryArtifact === hasExternalArtifact) fail(`${path} live-pass requires exactly one artifactPath or immutable artifactUri`)
      if (!SHA256_PATTERN.test(evidence.artifactSha256 ?? '')) fail(`${path} live-pass evidence requires artifactSha256`)
      if (hasRepositoryArtifact) {
        const artifact = resolve(repoRoot, evidence.artifactPath)
        if (!existsSync(artifact)) fail(`${path} live-pass evidence artifact is missing`)
        else {
          const actualDigest = createHash('sha256').update(readFileSync(artifact)).digest('hex')
          if (actualDigest !== evidence.artifactSha256) fail(`${path} live-pass evidence artifact SHA-256 does not match`)
        }
      }
      if (evidence.collectedAt === null || evidence.expiresAt === null) fail(`${path} live-pass evidence requires collectedAt and expiresAt`)
      if (evidence.expiresAt !== null && Date.parse(evidence.expiresAt) <= now.getTime()) fail(`${path} live-pass evidence expired at ${evidence.expiresAt}`)
    } else if (gate.status === 'waived') {
      const waiver = gate.waiver
      rejectUnknownKeys(waiver, ['approver', 'reason', 'expiresAt'], `${path}.waiver`, fail)
      if (!waiver || !isNonEmptyString(waiver.approver) || !isNonEmptyString(waiver.reason) || !isIsoDate(waiver.expiresAt)) fail(`${path} waived status requires approver, reason, and expiry`)
      else if (Date.parse(waiver.expiresAt) <= now.getTime()) fail(`${path} waiver expired at ${waiver.expiresAt}`)
    } else if (!isNonEmptyString(gate.nextAction)) {
      fail(`${path} non-live status requires nextAction`)
    }

    if (gate.status === 'blocked' && !isNonEmptyString(gate.blockReason)) fail(`${path} blocked status requires blockReason`)
    if (gate.status !== 'waived' && gate.waiver !== null) fail(`${path} waiver is only valid for waived status`)
    if (evidence.testedCommit !== null && evidence.testedCommit !== ledger.sourceCommit) fail(`${path}.evidence.testedCommit must equal sourceCommit`)
    if (evidence.testedTreeHash !== null && evidence.testedTreeHash !== ledger.sourceTreeHash) fail(`${path}.evidence.testedTreeHash must equal sourceTreeHash`)

    if (milestone !== null && milestoneRank(gate.milestone) <= milestoneRank(milestone) && gate.required && requireLive) {
      const satisfiesReleaseStatus = gate.releaseStatus === 'local-pass'
        ? gate.status === 'local-pass' || gate.status === 'live-pass'
        : gate.status === 'live-pass'
      if (!satisfiesReleaseStatus) fail(`${path} (${gate.id}) is required for ${milestone} but status is ${gate.status}; minimum is ${gate.releaseStatus}`)
      if (gate.milestone === 'R0') {
        if (!isNonEmptyString(evidence.artifactUri)) fail(`${path} (${gate.id}) release-relevant R0 evidence requires an immutable protected artifact URI`)
        if (!SHA256_PATTERN.test(evidence.artifactSha256 ?? '')) fail(`${path} (${gate.id}) release-relevant R0 evidence requires an artifact digest`)
        if (!isIsoDate(evidence.expiresAt) || Date.parse(evidence.expiresAt) <= now.getTime()) fail(`${path} (${gate.id}) release-relevant R0 evidence requires an unexpired evidence manifest`)
      }
    }
  }

  if (enforceGateContract) {
    const gatesById = new Map(gates.map((gate) => [gate.id, gate]))
    for (const expected of REQUIRED_RELEASE_GATES) {
      const actual = gatesById.get(expected.id)
      if (!actual) {
        fail(`required release gate is missing: ${expected.id}`)
        continue
      }
      for (const property of ['milestone', 'required', 'releaseStatus']) {
        if (actual[property] !== expected[property]) fail(`${expected.id}.${property} must be ${expected[property]}`)
      }
    }
    for (const expected of DEFERRED_RELEASE_GATES) {
      const actual = gatesById.get(expected.id)
      if (!actual) {
        fail(`deferred release gate is missing: ${expected.id}`)
        continue
      }
      if (actual.required !== expected.required) {
        fail(`${expected.id}.required must be false because the capability is disabled or outside the beta claim`)
      }
    }
  }

  if (milestone !== null && !MILESTONES.includes(milestone)) fail(`requested milestone ${milestone} is invalid`)
  return errors
}

async function validateLedgerOnlyCommit(ledger, commitSha) {
  if (ledger.sourceCommit === commitSha) return []

  let gitRoot
  try {
    const result = await execFileAsync('git', [
      '-C',
      repoRoot,
      'rev-parse',
      '--show-toplevel',
    ], { windowsHide: true })
    gitRoot = result.stdout.trim()
  } catch {
    return ['could not determine the Git root while validating the readiness ledger source delta']
  }

  try {
    await execFileAsync('git', [
      '-C',
      repoRoot,
      'merge-base',
      '--is-ancestor',
      ledger.sourceCommit,
      commitSha,
    ], { windowsHide: true })
  } catch {
    return [`sourceCommit ${ledger.sourceCommit} must be an ancestor of requested commit ${commitSha}`]
  }

  let changedPaths
  try {
    const result = await execFileAsync('git', [
      '-C',
      repoRoot,
      'diff',
      '--name-only',
      `${ledger.sourceCommit}..${commitSha}`,
      '--',
    ], { windowsHide: true })
    changedPaths = result.stdout
      .split(/\r?\n/u)
      .map((path) => path.trim())
      .filter(Boolean)
  } catch {
    return [`could not inspect the source delta between ${ledger.sourceCommit} and ${commitSha}`]
  }

  const ledgerGitPath = ledgerPathFromGitRoot(gitRoot)
  const unexpectedPaths = changedPaths.filter((path) => path !== ledgerGitPath)
  if (unexpectedPaths.length > 0) {
    return [
      `sourceCommit ${ledger.sourceCommit} is stale: the requested commit changed source files besides ${ledgerGitPath}: ${unexpectedPaths.join(', ')}`,
    ]
  }

  return []
}

export async function validateSourceTreeBinding(ledger, runGit = execFileAsync) {
  if (!SHA_PATTERN.test(ledger?.sourceCommit ?? '') || !SHA_PATTERN.test(ledger?.sourceTreeHash ?? '')) {
    return []
  }

  try {
    const result = await runGit('git', [
      '-C',
      repoRoot,
      'rev-parse',
      `${ledger.sourceCommit}^{tree}`,
    ], { windowsHide: true })
    const actualTreeHash = result.stdout.trim()
    return actualTreeHash === ledger.sourceTreeHash
      ? []
      : [`sourceTreeHash ${ledger.sourceTreeHash} does not match Git tree ${actualTreeHash} for sourceCommit ${ledger.sourceCommit}`]
  } catch {
    return [`could not resolve the Git tree for sourceCommit ${ledger.sourceCommit}`]
  }
}

function parseArgs(argv) {
  const options = {
    milestone: null,
    requireLive: false,
    commitSha: null,
    allowLedgerOnlyCommit: false,
  }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--require-live') options.requireLive = true
    else if (argument === '--milestone') options.milestone = argv[++index] ?? null
    else if (argument === '--commit-sha') options.commitSha = argv[++index] ?? null
    else if (argument === '--allow-ledger-only-commit') options.allowLedgerOnlyCommit = true
    else throw new Error(`Unknown argument: ${argument}`)
  }
  return options
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv)
  const [ledgerText, schemaText] = await Promise.all([
    readFile(ledgerPath, 'utf8'),
    readFile(schemaPath, 'utf8'),
  ])
  JSON.parse(schemaText)
  const ledger = JSON.parse(ledgerText)
  let bindingErrors = []
  let allowSourceCommitMismatch = false
  if (options.allowLedgerOnlyCommit && options.commitSha !== null) {
    bindingErrors = await validateLedgerOnlyCommit(ledger, options.commitSha)
    allowSourceCommitMismatch = bindingErrors.length === 0
  }
  const errors = [
    ...await validateSourceTreeBinding(ledger),
    ...bindingErrors,
    ...validateReadinessLedger(ledger, { ...options, allowSourceCommitMismatch, enforceGateContract: true }),
  ]
  if (errors.length > 0) {
    console.error('Mesh readiness ledger validation failed:')
    for (const error of errors) console.error(`- ${error}`)
    return 1
  }
  console.log(JSON.stringify({
    ledger: ledger.ledgerId,
    sourceCommit: ledger.sourceCommit,
    sourceTreeHash: ledger.sourceTreeHash,
    gates: ledger.gates.length,
    requiredLiveThrough: options.requireLive ? options.milestone : null,
    status: 'valid',
  }, null, 2))
  return 0
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main()
}
