import { execFileSync } from 'node:child_process'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const SHA = /^[0-9a-f]{40}$/
const SHA256 = /^[0-9a-f]{64}$/
const EXPECTED_REPOSITORY = 'dhawal-ss/mesh'
const IMMUTABLE_RUN_URI = new RegExp(`^https://github\\.com/${EXPECTED_REPOSITORY}/actions/runs/[1-9][0-9]*$`)
const IMMUTABLE_ARTIFACT_URI = new RegExp(`^https://github\\.com/${EXPECTED_REPOSITORY}/actions/runs/([1-9][0-9]*)/artifacts/[1-9][0-9]*$`)

function cleanVersion(command, args = ['--version']) {
  try {
    return execFileSync(command, args, { encoding: 'utf8', windowsHide: true }).trim().split(/\r?\n/)[0]
  } catch {
    return 'unavailable'
  }
}

function immutableHttps(value) {
  try {
    const uri = new URL(value)
    return uri.protocol === 'https:' && !uri.username && !uri.password && !uri.search && !uri.hash
      && !/(?:^|\/)(?:latest|mutable)(?:\/|$)/i.test(uri.pathname)
  } catch {
    return false
  }
}

function exactKeys(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  return Object.keys(value).sort().join('\n') === [...keys].sort().join('\n')
}

export function validateProtectedEvidenceManifest(manifest, { now = new Date() } = {}) {
  const errors = []
  const fail = (message) => errors.push(message)
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) return ['manifest must be an object']
  if (!exactKeys(manifest, ['schemaVersion', 'manifestId', 'sourceCommit', 'sourceTreeHash', 'workflow', 'runner', 'commands', 'artifacts', 'build', 'collectedAt', 'expiresAt', 'reviewer'])) {
    fail('manifest must contain only the protected evidence schema fields')
  }
  if (manifest.schemaVersion !== 1) fail('schemaVersion must be 1')
  if (manifest.manifestId !== 'mesh-protected-ci-evidence') fail('manifestId is invalid')
  if (!SHA.test(manifest.sourceCommit ?? '')) fail('sourceCommit must be an exact lowercase Git SHA')
  if (!SHA.test(manifest.sourceTreeHash ?? '')) fail('sourceTreeHash must be an exact lowercase Git tree hash')
  if (!exactKeys(manifest.workflow, ['name', 'runId', 'runAttempt', 'uri'])) fail('workflow must contain only the protected evidence schema fields')
  if (typeof manifest.workflow?.name !== 'string' || !manifest.workflow.name.trim()) fail('workflow.name is required')
  if (!IMMUTABLE_RUN_URI.test(manifest.workflow?.uri ?? '')) fail('workflow.uri must be an immutable GitHub Actions run URI')
  if (String(manifest.workflow?.runId ?? '') !== manifest.workflow?.uri?.split('/').at(-1)) fail('workflow runId must match workflow.uri')
  if (!Number.isInteger(manifest.workflow?.runAttempt) || manifest.workflow.runAttempt < 1) fail('workflow.runAttempt is invalid')
  if (!exactKeys(manifest.runner, ['os', 'arch', 'toolVersions'])) fail('runner must contain only the protected evidence schema fields')
  if (!manifest.runner?.os || !manifest.runner?.arch || !manifest.runner?.toolVersions || typeof manifest.runner.toolVersions !== 'object' || Array.isArray(manifest.runner.toolVersions) || Object.keys(manifest.runner.toolVersions).length === 0) fail('runner OS, architecture, and tool versions are required')
  if (!Array.isArray(manifest.commands) || manifest.commands.length === 0) fail('commands must be non-empty')
  for (const [index, command] of (manifest.commands ?? []).entries()) {
    if (!exactKeys(command, ['command', 'status', 'passed', 'failed', 'ignored', 'ignoredTests', 'durationMs'])) fail(`commands[${index}] contains fields outside the protected evidence schema`)
    if (typeof command.command !== 'string' || !command.command.trim() || !['pass', 'fail'].includes(command.status)) fail(`commands[${index}] is invalid`)
    for (const count of ['passed', 'failed', 'ignored', 'durationMs']) {
      if (!Number.isInteger(command[count]) || command[count] < 0) fail(`commands[${index}].${count} must be a non-negative integer`)
    }
    if (!Array.isArray(command.ignoredTests) || command.ignoredTests.length !== command.ignored) fail(`commands[${index}] ignored count must match ignoredTests`)
    if ((command.failed === 0) !== (command.status === 'pass')) fail(`commands[${index}] status must match failed count`)
  }
  if (!Array.isArray(manifest.artifacts) || manifest.artifacts.length === 0) fail('artifacts must be non-empty')
  for (const [index, artifact] of (manifest.artifacts ?? []).entries()) {
    if (!exactKeys(artifact, ['name', 'uri', 'sha256', 'sizeBytes'])) fail(`artifacts[${index}] contains fields outside the protected evidence schema`)
    if (!artifact.name || !immutableHttps(artifact.uri)) fail(`artifacts[${index}].uri must be immutable HTTPS`)
    const artifactRun = artifact.uri?.match(IMMUTABLE_ARTIFACT_URI)?.[1]
    if (!artifactRun) fail(`artifacts[${index}].uri must belong to ${EXPECTED_REPOSITORY}`)
    else if (artifactRun !== String(manifest.workflow?.runId ?? '')) fail(`artifacts[${index}].uri must belong to the manifest workflow run`)
    if (!SHA256.test(artifact.sha256 ?? '')) fail(`artifacts[${index}].sha256 is invalid`)
    if (!Number.isInteger(artifact.sizeBytes) || artifact.sizeBytes < 1) fail(`artifacts[${index}].sizeBytes is invalid`)
    const embeddedShas = artifact.uri?.match(/[0-9a-f]{40}/g) ?? []
    if (embeddedShas.some((sha) => sha !== manifest.sourceCommit)) fail(`artifacts[${index}].uri refers to another source SHA`)
  }
  if (!exactKeys(manifest.build, ['mode', 'features'])) fail('build must contain only the protected evidence schema fields')
  if (typeof manifest.build?.mode !== 'string' || !manifest.build.mode.trim() || !Array.isArray(manifest.build?.features) || manifest.build.features.length === 0 || manifest.build.features.some((feature) => typeof feature !== 'string' || !feature.trim())) fail('build mode and feature set are required')
  const collectedAt = Date.parse(manifest.collectedAt ?? '')
  const expiresAt = Date.parse(manifest.expiresAt ?? '')
  if (!Number.isFinite(collectedAt)) fail('collectedAt is invalid')
  else if (collectedAt > now.getTime()) fail('collectedAt cannot be in the future')
  if (!Number.isFinite(expiresAt)) fail('expiresAt is invalid')
  else {
    if (Number.isFinite(collectedAt) && expiresAt <= collectedAt) fail('expiresAt must be later than collectedAt')
    if (expiresAt <= now.getTime()) fail('evidence manifest is expired')
  }
  if (manifest.reviewer !== null && (typeof manifest.reviewer !== 'string' || !manifest.reviewer.trim())) fail('reviewer must be named or null')
  return errors
}

export async function writeProtectedEvidenceManifest({ outputPath, sourceCommit, sourceTreeHash, workflow, artifact, commands, mode, features, reviewer = null, retentionDays = 30 }) {
  const collectedAt = new Date()
  const expiresAt = new Date(collectedAt.getTime() + retentionDays * 86_400_000)
  const manifest = {
    schemaVersion: 1,
    manifestId: 'mesh-protected-ci-evidence',
    sourceCommit,
    sourceTreeHash,
    workflow,
    runner: {
      os: `${process.platform} ${process.env.RUNNER_OS ?? ''}`.trim(),
      arch: process.arch,
      toolVersions: {
        node: process.version,
        npm: cleanVersion(process.platform === 'win32' ? 'npm.cmd' : 'npm'),
        rustc: cleanVersion('rustc'),
        cargo: cleanVersion('cargo'),
      },
    },
    commands,
    artifacts: [artifact],
    build: { mode, features },
    collectedAt: collectedAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
    reviewer,
  }
  const errors = validateProtectedEvidenceManifest(manifest, { now: collectedAt })
  if (errors.length) throw new Error(errors.join('; '))
  await mkdir(path.dirname(outputPath), { recursive: true })
  await writeFile(outputPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  return manifest
}

async function main() {
  const args = new Map()
  for (let index = 2; index < process.argv.length; index += 2) args.set(process.argv[index], process.argv[index + 1])
  if (args.has('--validate')) {
    const manifest = JSON.parse(await readFile(path.resolve(args.get('--validate')), 'utf8'))
    const errors = validateProtectedEvidenceManifest(manifest)
    if (errors.length) throw new Error(errors.join('; '))
    console.log('Protected evidence manifest passed.')
    return
  }
  const payloadPath = path.resolve(args.get('--payload-path') ?? '')
  await stat(payloadPath)
  const payloadSize = Number(args.get('--payload-size') ?? 0)
  const command = args.get('--command') ?? 'protected workflow quality gate'
  await writeProtectedEvidenceManifest({
    outputPath: path.resolve(args.get('--output') ?? 'release/protected-evidence-manifest.json'),
    sourceCommit: args.get('--source-sha') ?? '',
    sourceTreeHash: args.get('--tree-hash') ?? '',
    workflow: {
      name: args.get('--workflow-name') ?? '',
      runId: args.get('--run-id') ?? '',
      runAttempt: Number(args.get('--run-attempt') ?? 0),
      uri: args.get('--workflow-uri') ?? '',
    },
    artifact: {
      name: args.get('--payload-name') ?? path.basename(payloadPath),
      uri: args.get('--payload-uri') ?? '',
      sha256: (args.get('--payload-digest') ?? '').replace(/^sha256:/, ''),
      sizeBytes: payloadSize,
    },
    commands: [{ command, status: 'pass', passed: 1, failed: 0, ignored: 0, ignoredTests: [], durationMs: Number(args.get('--duration-ms') ?? 0) }],
    mode: args.get('--build-mode') ?? 'matrix-text',
    features: (args.get('--features') ?? 'matrix-backend').split(',').filter(Boolean),
    retentionDays: Number(args.get('--retention-days') ?? 30),
  })
  console.log('Protected evidence manifest generated.')
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main()
