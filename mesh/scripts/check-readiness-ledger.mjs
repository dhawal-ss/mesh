import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, isAbsolute, relative, resolve } from 'node:path'

const scriptDirectory = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(scriptDirectory, '..')
const ledgerPath = resolve(repoRoot, 'release', 'readiness.json')
const schemaPath = resolve(repoRoot, 'release', 'readiness.schema.json')
const SHA_PATTERN = /^[0-9a-f]{40}$/
const MILESTONES = ['R0', 'R1', 'R2', 'R3', 'R4']
const STATUSES = ['unverified', 'local-pass', 'live-pass', 'blocked', 'waived']
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim() === value && value.length > 0
}

function isIsoDate(value) {
  return typeof value === 'string' && ISO_DATE_PATTERN.test(value) && Number.isFinite(Date.parse(value))
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

export function validateReadinessLedger(ledger, { now = new Date(), milestone = null, requireLive = false, commitSha = null } = {}) {
  const errors = []
  const fail = (message) => errors.push(message)

  if (!ledger || typeof ledger !== 'object' || Array.isArray(ledger)) {
    return ['ledger must be an object']
  }

  if (ledger.schemaVersion !== 1) fail('schemaVersion must be 1')
  if (ledger.ledgerId !== 'mesh-production-readiness') fail('ledgerId is invalid')
  if (!SHA_PATTERN.test(ledger.releaseSha ?? '')) fail('releaseSha must be a lowercase 40-character SHA')
  if (!isIsoDate(ledger.updatedAt)) fail('updatedAt must be an ISO UTC timestamp')
  if (commitSha !== null && ledger.releaseSha !== commitSha) {
    fail(`releaseSha ${ledger.releaseSha} does not match requested commit ${commitSha}`)
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
    if (evidence.commitSha !== null && !SHA_PATTERN.test(evidence.commitSha ?? '')) fail(`${path}.evidence.commitSha is invalid`)
    if (evidence.command !== null && !isNonEmptyString(evidence.command)) fail(`${path}.evidence.command must be a string or null`)
    if (evidence.artifactPath !== null && !pathIsInsideRepo(evidence.artifactPath)) fail(`${path}.evidence.artifactPath must be a relative path inside the repository`)
    if (evidence.environment !== null && !isNonEmptyString(evidence.environment)) fail(`${path}.evidence.environment must be a string or null`)
    if (evidence.collectedAt !== null && !isIsoDate(evidence.collectedAt)) fail(`${path}.evidence.collectedAt must be an ISO UTC timestamp or null`)
    if (evidence.expiresAt !== null && !isIsoDate(evidence.expiresAt)) fail(`${path}.evidence.expiresAt must be an ISO UTC timestamp or null`)

    if (gate.status === 'live-pass') {
      if (evidence.commitSha !== ledger.releaseSha) fail(`${path} live-pass evidence must use releaseSha`)
      if (evidence.artifactPath === null || !existsSync(resolve(repoRoot, evidence.artifactPath))) fail(`${path} live-pass evidence artifact is missing`)
      if (evidence.collectedAt === null || evidence.expiresAt === null) fail(`${path} live-pass evidence requires collectedAt and expiresAt`)
      if (evidence.expiresAt !== null && Date.parse(evidence.expiresAt) <= now.getTime()) fail(`${path} live-pass evidence expired at ${evidence.expiresAt}`)
      if (gate.blockReason !== null) fail(`${path} live-pass cannot have blockReason`)
      if (gate.waiver !== null) fail(`${path} live-pass cannot have a waiver`)
    } else if (gate.status === 'waived') {
      const waiver = gate.waiver
      if (!waiver || !isNonEmptyString(waiver.approver) || !isNonEmptyString(waiver.reason) || !isIsoDate(waiver.expiresAt)) fail(`${path} waived status requires approver, reason, and expiry`)
      else if (Date.parse(waiver.expiresAt) <= now.getTime()) fail(`${path} waiver expired at ${waiver.expiresAt}`)
    } else if (!isNonEmptyString(gate.nextAction)) {
      fail(`${path} non-live status requires nextAction`)
    }

    if (gate.status === 'blocked' && !isNonEmptyString(gate.blockReason)) fail(`${path} blocked status requires blockReason`)
    if (gate.status !== 'waived' && gate.waiver !== null) fail(`${path} waiver is only valid for waived status`)
    if (evidence.commitSha !== null && evidence.commitSha !== ledger.releaseSha) fail(`${path}.evidence.commitSha must equal releaseSha`)

    if (milestone !== null && milestoneRank(gate.milestone) <= milestoneRank(milestone) && gate.required && requireLive) {
      const satisfiesReleaseStatus = gate.releaseStatus === 'local-pass'
        ? gate.status === 'local-pass' || gate.status === 'live-pass'
        : gate.status === 'live-pass'
      if (!satisfiesReleaseStatus) fail(`${path} is required for ${milestone} but status is ${gate.status}; minimum is ${gate.releaseStatus}`)
    }
  }

  if (milestone !== null && !MILESTONES.includes(milestone)) fail(`requested milestone ${milestone} is invalid`)
  return errors
}

function parseArgs(argv) {
  const options = { milestone: null, requireLive: false, commitSha: null }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--require-live') options.requireLive = true
    else if (argument === '--milestone') options.milestone = argv[++index] ?? null
    else if (argument === '--commit-sha') options.commitSha = argv[++index] ?? null
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
  const errors = validateReadinessLedger(ledger, options)
  if (errors.length > 0) {
    console.error('Mesh readiness ledger validation failed:')
    for (const error of errors) console.error(`- ${error}`)
    return 1
  }
  console.log(JSON.stringify({
    ledger: ledger.ledgerId,
    releaseSha: ledger.releaseSha,
    gates: ledger.gates.length,
    requiredLiveThrough: options.requireLive ? options.milestone : null,
    status: 'valid',
  }, null, 2))
  return 0
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main()
}
