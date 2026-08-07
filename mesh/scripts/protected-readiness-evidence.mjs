import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { promisify } from 'node:util'
import { validateProtectedCiResults } from './protected-ci-results.mjs'
import { validateProtectedEvidenceManifest } from './protected-evidence-manifest.mjs'
import { validateProtectedSecurityResults } from './protected-security-results.mjs'

const execFileAsync = promisify(execFile)
const EXPECTED_REPOSITORY = 'dhawal-ss/mesh'
const PROTECTED_WORKFLOW_RUNS = new Map([
  ['CI', { name: 'CI', path: '.github/workflows/ci.yml' }],
  ['Security', { name: 'Security and feature boundary', path: '.github/workflows/security.yml' }],
])
const PROTECTED_ARTIFACT_URL = new RegExp(
  `^https://github\\.com/${EXPECTED_REPOSITORY}/actions/runs/([1-9][0-9]*)/artifacts/([1-9][0-9]*)$`,
  'u',
)
const SHA_PATTERN = /^[0-9a-f]{40}$/u
const SHA256_PATTERN = /^[0-9a-f]{64}$/u
const ROOT_JSON_ENTRY = /^[A-Za-z0-9][A-Za-z0-9._-]*\.json$/u
const ZIP_LOCAL_FILE_HEADER = Buffer.from([0x50, 0x4b, 0x03, 0x04])
const R0_GATE_WORKFLOW = new Map([
  ['r0.frontend-tests', 'CI'],
  ['r0.frontend-build', 'CI'],
  ['r0.rust-matrix', 'CI'],
  ['r0.rust-legacy', 'CI'],
  ['r0.browser-e2e', 'CI'],
  ['r0.ipc-contract', 'CI'],
  ['r0.security-invariants', 'CI'],
  ['r0.public-surfaces', 'CI'],
  ['r0.dependency-advisory-policy', 'Security'],
])

export const MAX_PROTECTED_ARCHIVE_BYTES = 4 * 1024 * 1024
export const MAX_PROTECTED_JSON_BYTES = 512 * 1024

function exactKeys(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  return Object.keys(value).sort().join('\n') === [...keys].sort().join('\n')
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim() === value && value.length > 0
}

function asBuffer(value) {
  if (Buffer.isBuffer(value)) return value
  if (value instanceof Uint8Array) return Buffer.from(value)
  throw new TypeError('artifact downloader must return bytes')
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function hasZipHeader(bytes) {
  return bytes.length >= ZIP_LOCAL_FILE_HEADER.length
    && bytes.subarray(0, ZIP_LOCAL_FILE_HEADER.length).equals(ZIP_LOCAL_FILE_HEADER)
}

export function parseProtectedArtifactUrl(value) {
  if (typeof value !== 'string') return null
  const match = value.match(PROTECTED_ARTIFACT_URL)
  return match ? { runId: match[1], artifactId: match[2] } : null
}

async function readBoundedResponse(response, maxBytes) {
  const declaredLength = Number(response.headers.get('content-length'))
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new Error(`artifact exceeds the ${maxBytes}-byte download limit`)
  }
  if (!response.body) throw new Error('artifact response has no body')

  const chunks = []
  let total = 0
  const reader = response.body.getReader()
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > maxBytes) {
        await reader.cancel()
        throw new Error(`artifact exceeds the ${maxBytes}-byte download limit`)
      }
      chunks.push(Buffer.from(value))
    }
  } finally {
    reader.releaseLock()
  }
  return Buffer.concat(chunks, total)
}

export async function downloadGitHubActionsArtifact(artifactUrl, {
  token = process.env.GITHUB_TOKEN,
  maxBytes = MAX_PROTECTED_ARCHIVE_BYTES,
  expectedSourceCommit,
  expectedWorkflowName,
  expectedRunAttempt = null,
  fetchImpl = globalThis.fetch,
  timeoutMs = 30_000,
} = {}) {
  const parsed = parseProtectedArtifactUrl(artifactUrl)
  if (!parsed) {
    throw new Error(`artifact URL must be an immutable ${EXPECTED_REPOSITORY} GitHub Actions artifact URL`)
  }
  if (typeof fetchImpl !== 'function') throw new Error('artifact download is unavailable in this Node runtime')
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error('artifact download limit is invalid')
  if (!SHA_PATTERN.test(expectedSourceCommit ?? '')) throw new Error('artifact download requires an exact expected source commit')
  const workflowContract = PROTECTED_WORKFLOW_RUNS.get(expectedWorkflowName)
  if (!workflowContract) throw new Error('artifact download requires the exact protected CI or Security workflow identity')
  if (expectedRunAttempt !== null && (!Number.isSafeInteger(expectedRunAttempt) || expectedRunAttempt < 1)) {
    throw new Error('artifact download run attempt is invalid')
  }

  const headers = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'mesh-readiness-evidence-verifier',
  }
  if (nonEmptyString(token)) headers.Authorization = `Bearer ${token}`
  const metadataUrl = `https://api.github.com/repos/${EXPECTED_REPOSITORY}/actions/artifacts/${parsed.artifactId}`
  const apiUrl = `${metadataUrl}/zip`

  let metadataResponse
  try {
    metadataResponse = await fetchImpl(metadataUrl, {
      headers,
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch {
    throw new Error('GitHub Actions artifact metadata request failed before a response was received')
  }
  if (!metadataResponse.ok) {
    const authHint = [401, 403, 404].includes(metadataResponse.status)
      ? '; set GITHUB_TOKEN to a token with Actions read access when the artifact is not public'
      : ''
    throw new Error(`GitHub Actions artifact metadata returned HTTP ${metadataResponse.status}${authHint}`)
  }

  let metadata
  try {
    const metadataBytes = await readBoundedResponse(metadataResponse, 64 * 1024)
    metadata = JSON.parse(metadataBytes.toString('utf8'))
  } catch {
    throw new Error('GitHub Actions artifact metadata is unavailable, oversized, or invalid')
  }
  if (String(metadata?.id ?? '') !== parsed.artifactId
      || metadata?.expired !== false
      || metadata?.archive_download_url !== apiUrl
      || String(metadata?.workflow_run?.id ?? '') !== parsed.runId
      || metadata?.workflow_run?.head_sha !== expectedSourceCommit
      || metadata?.workflow_run?.head_branch !== 'main') {
    throw new Error('GitHub Actions artifact metadata does not bind the requested main-branch run and source commit')
  }
  if (!Number.isSafeInteger(metadata.size_in_bytes) || metadata.size_in_bytes < 1 || metadata.size_in_bytes > maxBytes) {
    throw new Error(`GitHub Actions artifact metadata exceeds the ${maxBytes}-byte download limit`)
  }

  const runUrl = expectedRunAttempt === null
    ? `https://api.github.com/repos/${EXPECTED_REPOSITORY}/actions/runs/${parsed.runId}`
    : `https://api.github.com/repos/${EXPECTED_REPOSITORY}/actions/runs/${parsed.runId}/attempts/${expectedRunAttempt}`
  let runResponse
  try {
    runResponse = await fetchImpl(runUrl, {
      headers,
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch {
    throw new Error('GitHub Actions workflow-run metadata request failed before a response was received')
  }
  if (!runResponse.ok) throw new Error(`GitHub Actions workflow-run metadata returned HTTP ${runResponse.status}`)

  let run
  try {
    const runBytes = await readBoundedResponse(runResponse, 128 * 1024)
    run = JSON.parse(runBytes.toString('utf8'))
  } catch {
    throw new Error('GitHub Actions workflow-run metadata is unavailable, oversized, or invalid')
  }
  const workflowPath = typeof run?.path === 'string' ? run.path.split('@', 1)[0] : null
  if (String(run?.id ?? '') !== parsed.runId
      || run?.name !== workflowContract.name
      || workflowPath !== workflowContract.path
      || run?.event !== 'push'
      || run?.status !== 'completed'
      || run?.conclusion !== 'success'
      || run?.head_sha !== expectedSourceCommit
      || run?.head_branch !== 'main'
      || run?.repository?.full_name !== EXPECTED_REPOSITORY
      || run?.head_repository?.full_name !== EXPECTED_REPOSITORY
      || !Number.isSafeInteger(run?.run_attempt)
      || run.run_attempt < 1
      || (expectedRunAttempt !== null && run.run_attempt !== expectedRunAttempt)) {
    throw new Error(`GitHub Actions run does not prove a successful protected ${expectedWorkflowName} push on main`)
  }
  if (expectedRunAttempt !== null) {
    const artifactCreatedAt = Date.parse(metadata?.created_at ?? '')
    const runStartedAt = Date.parse(run?.run_started_at ?? '')
    const runUpdatedAt = Date.parse(run?.updated_at ?? '')
    if (!Number.isFinite(artifactCreatedAt)
        || !Number.isFinite(runStartedAt)
        || !Number.isFinite(runUpdatedAt)
        || artifactCreatedAt < runStartedAt
        || artifactCreatedAt > runUpdatedAt) {
      throw new Error('GitHub Actions artifact creation time does not bind it to the expected workflow run attempt')
    }
  }

  let response
  try {
    response = await fetchImpl(apiUrl, {
      headers,
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch {
    throw new Error('GitHub Actions artifact download failed before a response was received')
  }
  if (!response.ok) throw new Error(`GitHub Actions artifact download returned HTTP ${response.status}`)

  const bytes = await readBoundedResponse(response, maxBytes)
  if (!hasZipHeader(bytes)) throw new Error('GitHub Actions artifact response is not a non-empty ZIP archive')
  if (bytes.length !== metadata.size_in_bytes) throw new Error('GitHub Actions artifact download size does not match immutable metadata')
  return bytes
}

export async function extractSingleJsonArchive(archiveBytes, {
  maxJsonBytes = MAX_PROTECTED_JSON_BYTES,
  runCommand = execFileAsync,
} = {}) {
  const bytes = asBuffer(archiveBytes)
  if (!hasZipHeader(bytes)) throw new Error('protected artifact is not a non-empty ZIP archive')
  if (!Number.isSafeInteger(maxJsonBytes) || maxJsonBytes < 1) throw new Error('JSON extraction limit is invalid')

  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'mesh-protected-evidence-'))
  const archivePath = join(temporaryDirectory, 'artifact.zip')
  try {
    await writeFile(archivePath, bytes)
    let listing
    try {
      const result = await runCommand('unzip', ['-Z1', archivePath], {
        encoding: 'utf8',
        maxBuffer: 64 * 1024,
        windowsHide: true,
      })
      listing = result.stdout
    } catch {
      throw new Error('could not inspect the protected artifact ZIP with system unzip')
    }
    const entries = listing.split(/\r?\n/u).filter(Boolean)
    if (entries.length !== 1 || !ROOT_JSON_ENTRY.test(entries[0]) || basename(entries[0]) !== entries[0]) {
      throw new Error('protected artifact ZIP must contain exactly one root-level JSON file')
    }

    let extracted
    try {
      const result = await runCommand('unzip', ['-p', archivePath], {
        encoding: 'buffer',
        maxBuffer: maxJsonBytes,
        windowsHide: true,
      })
      extracted = asBuffer(result.stdout)
    } catch {
      throw new Error(`could not extract protected JSON within the ${maxJsonBytes}-byte limit`)
    }
    if (extracted.length < 1 || extracted.length > maxJsonBytes) {
      throw new Error(`protected JSON must be between 1 and ${maxJsonBytes} bytes`)
    }
    try {
      return { entryName: entries[0], value: JSON.parse(extracted.toString('utf8')) }
    } catch {
      throw new Error('protected artifact JSON is invalid')
    }
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true })
  }
}

function validateManifestSchemaDetails(manifest) {
  const errors = []
  if (typeof manifest?.workflow?.runId !== 'string' || !/^[1-9][0-9]*$/u.test(manifest.workflow.runId)) {
    errors.push('workflow.runId must be a positive integer string')
  }
  const toolVersions = manifest?.runner?.toolVersions
  if (!nonEmptyString(manifest?.runner?.os) || !nonEmptyString(manifest?.runner?.arch)) {
    errors.push('runner.os and runner.arch must be non-empty strings')
  }
  if (!toolVersions || typeof toolVersions !== 'object' || Array.isArray(toolVersions)
      || Object.values(toolVersions).some((value) => !nonEmptyString(value))) {
    errors.push('runner.toolVersions values must be non-empty strings')
  }
  for (const [index, command] of (Array.isArray(manifest?.commands) ? manifest.commands : []).entries()) {
    if (Array.isArray(command.ignoredTests) && command.ignoredTests.some((value) => !nonEmptyString(value))) {
      errors.push(`commands[${index}].ignoredTests entries must be non-empty strings`)
    }
  }
  for (const [index, artifact] of (Array.isArray(manifest?.artifacts) ? manifest.artifacts : []).entries()) {
    if (!nonEmptyString(artifact.name)) errors.push(`artifacts[${index}].name must be a non-empty string`)
  }
  const features = manifest?.build?.features
  if (Array.isArray(features) && new Set(features).size !== features.length) {
    errors.push('build.features must contain unique values')
  }
  for (const field of ['collectedAt', 'expiresAt']) {
    if (typeof manifest?.[field] !== 'string'
        || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/u.test(manifest[field])) {
      errors.push(`${field} must be an ISO UTC date-time string`)
    }
  }
  return errors
}

export function validateProtectedJobPayload(document, { workflowName, sourceCommit } = {}) {
  const errors = []
  if (!exactKeys(document, ['schemaVersion', 'sourceSha', 'results'])) {
    return ['protected job payload must contain only schemaVersion, sourceSha, and results']
  }
  if (document.schemaVersion !== 1) errors.push('protected job payload schemaVersion must be 1')
  if (document.sourceSha !== sourceCommit) errors.push('protected job payload sourceSha does not match the manifest sourceCommit')

  if (workflowName === 'CI') {
    errors.push(...validateProtectedCiResults(document.results, { sourceSha: document.sourceSha }))
  } else if (workflowName === 'Security') {
    errors.push(...validateProtectedSecurityResults(document.results, {
      eventName: 'push',
      sourceSha: document.sourceSha,
    }))
  } else {
    errors.push('protected manifest workflow.name must be CI or Security')
  }
  return errors
}

function expectedArtifactContract(workflowName, sourceCommit) {
  if (workflowName === 'CI') {
    return {
      manifestEntry: 'ci-protected-evidence-manifest.json',
      payloadEntry: 'ci-run-results.json',
      payloadName: `ci-r0-payload-${sourceCommit}`,
      command: 'matrix-rust + legacy-rust + check-frontend protected jobs',
      buildMode: 'matrix-voice',
      features: ['matrix-voice', 'legacy-p2p'],
    }
  }
  if (workflowName === 'Security') {
    return {
      manifestEntry: 'security-protected-evidence-manifest.json',
      payloadEntry: 'security-run-results.json',
      payloadName: `security-r0-payload-${sourceCommit}`,
      command: 'all protected R2 security workflow jobs',
      buildMode: 'r2-source-and-container-security',
      features: ['matrix-backend', 'legacy-p2p', 'r2-container-scan'],
    }
  }
  return null
}

export async function verifyProtectedR0Evidence(ledger, {
  now = new Date(),
  token = process.env.GITHUB_TOKEN,
  downloadArtifact = downloadGitHubActionsArtifact,
  extractSingleJson = extractSingleJsonArchive,
  maxArchiveBytes = MAX_PROTECTED_ARCHIVE_BYTES,
} = {}) {
  const errors = []
  const archiveCache = new Map()
  const extractedCache = new Map()

  async function cachedArchive(url, expectedWorkflowName, expectedRunAttempt = null) {
    const cacheKey = `${url}\n${expectedWorkflowName}\n${expectedRunAttempt ?? ''}`
    if (!archiveCache.has(cacheKey)) {
      archiveCache.set(cacheKey, Promise.resolve().then(async () => {
        const value = await downloadArtifact(url, {
          token,
          maxBytes: maxArchiveBytes,
          expectedSourceCommit: ledger.sourceCommit,
          expectedWorkflowName,
          expectedRunAttempt,
        })
        const bytes = asBuffer(value)
        if (bytes.length < 1 || bytes.length > maxArchiveBytes) {
          throw new Error(`artifact must be between 1 and ${maxArchiveBytes} bytes`)
        }
        return bytes
      }))
    }
    return archiveCache.get(cacheKey)
  }

  async function cachedJson(url, bytes) {
    if (!extractedCache.has(url)) {
      extractedCache.set(url, Promise.resolve().then(() => extractSingleJson(bytes, {
        maxJsonBytes: MAX_PROTECTED_JSON_BYTES,
        artifactUrl: url,
      })))
    }
    return extractedCache.get(url)
  }

  const requiredR0Gates = Array.isArray(ledger?.gates)
    ? ledger.gates.filter((gate) => gate?.milestone === 'R0' && gate.required === true)
    : []
  if (requiredR0Gates.length === 0) return ['protected R0 verification found no required R0 gates']

  for (const gate of requiredR0Gates) {
    const prefix = `gate ${gate.id ?? '<unknown>'}`
    const evidence = gate.evidence ?? {}
    const expectedWorkflowName = R0_GATE_WORKFLOW.get(gate.id)
    if (!expectedWorkflowName) {
      errors.push(`${prefix} has no protected workflow evidence contract`)
      continue
    }
    const manifestUrl = evidence.artifactUri
    const manifestArtifactLocation = parseProtectedArtifactUrl(manifestUrl)
    if (!manifestArtifactLocation) {
      errors.push(`${prefix} protected evidence URL must be an immutable ${EXPECTED_REPOSITORY} GitHub Actions artifact URL`)
      continue
    }
    if (!SHA256_PATTERN.test(evidence.artifactSha256 ?? '')) {
      errors.push(`${prefix} protected evidence archive requires a lowercase SHA-256 digest`)
      continue
    }

    try {
      const manifestArchive = await cachedArchive(manifestUrl, expectedWorkflowName)
      if (sha256(manifestArchive) !== evidence.artifactSha256) {
        throw new Error('protected evidence archive SHA-256 does not match the readiness ledger')
      }
      const extractedManifest = await cachedJson(manifestUrl, manifestArchive)
      if (!exactKeys(extractedManifest, ['entryName', 'value'])) {
        throw new Error('protected artifact extractor returned an invalid result')
      }
      const manifest = extractedManifest.value
      const manifestErrors = [
        ...validateProtectedEvidenceManifest(manifest, { now }),
        ...validateManifestSchemaDetails(manifest),
      ]
      if (manifestErrors.length > 0) {
        throw new Error(`protected manifest is invalid: ${manifestErrors.join('; ')}`)
      }
      if (manifestArtifactLocation.runId !== manifest.workflow.runId) {
        throw new Error('protected manifest archive URL run does not match the manifest workflow run')
      }
      if (manifest.sourceCommit !== ledger.sourceCommit || manifest.sourceTreeHash !== ledger.sourceTreeHash) {
        throw new Error('protected manifest sourceCommit/sourceTreeHash does not match the readiness ledger')
      }
      if (evidence.testedCommit !== manifest.sourceCommit || evidence.testedTreeHash !== manifest.sourceTreeHash) {
        throw new Error('readiness evidence tested source does not match the protected manifest')
      }
      if (evidence.collectedAt !== manifest.collectedAt || evidence.expiresAt !== manifest.expiresAt) {
        throw new Error('readiness evidence collection and expiry timestamps must match the protected manifest')
      }
      if (manifest.commands.some((command) => command.status !== 'pass' || command.failed !== 0 || command.passed < 1)) {
        throw new Error('protected manifest contains a non-passing or empty command claim')
      }
      if (manifest.artifacts.length !== 1) throw new Error('protected manifest must reference exactly one job-result payload artifact')

      if (manifest.workflow.name !== expectedWorkflowName) {
        throw new Error(`required R0 gate ${gate.id} must use ${expectedWorkflowName} protected evidence`)
      }

      const contract = expectedArtifactContract(manifest.workflow.name, manifest.sourceCommit)
      if (!contract) throw new Error('protected manifest workflow.name must be CI or Security')
      if (extractedManifest.entryName !== contract.manifestEntry) {
        throw new Error(`protected manifest archive must contain ${contract.manifestEntry}`)
      }
      if (manifest.commands.length !== 1 || manifest.commands[0].command !== contract.command) {
        throw new Error(`protected ${manifest.workflow.name} manifest command contract is invalid`)
      }
      if (manifest.build.mode !== contract.buildMode
          || manifest.build.features.length !== contract.features.length
          || manifest.build.features.some((feature, index) => feature !== contract.features[index])) {
        throw new Error(`protected ${manifest.workflow.name} manifest build contract is invalid`)
      }
      const payloadArtifact = manifest.artifacts[0]
      if (payloadArtifact.name !== contract.payloadName) {
        throw new Error(`protected manifest payload name must be ${contract.payloadName}`)
      }
      if (!parseProtectedArtifactUrl(payloadArtifact.uri)) {
        throw new Error(`protected payload URL must be an immutable ${EXPECTED_REPOSITORY} GitHub Actions artifact URL`)
      }
      if (payloadArtifact.sizeBytes > maxArchiveBytes) {
        throw new Error(`protected payload exceeds the ${maxArchiveBytes}-byte archive limit`)
      }

      const payloadArchive = await cachedArchive(
        payloadArtifact.uri,
        manifest.workflow.name,
        manifest.workflow.runAttempt,
      )
      if (payloadArchive.length !== payloadArtifact.sizeBytes) {
        throw new Error('protected payload archive byte size does not match the manifest')
      }
      if (sha256(payloadArchive) !== payloadArtifact.sha256) {
        throw new Error('protected payload archive SHA-256 does not match the manifest')
      }
      const extractedPayload = await cachedJson(payloadArtifact.uri, payloadArchive)
      if (!exactKeys(extractedPayload, ['entryName', 'value']) || extractedPayload.entryName !== contract.payloadEntry) {
        throw new Error(`protected payload archive must contain exactly ${contract.payloadEntry}`)
      }
      const payloadErrors = validateProtectedJobPayload(extractedPayload.value, {
        workflowName: manifest.workflow.name,
        sourceCommit: manifest.sourceCommit,
      })
      if (payloadErrors.length > 0) throw new Error(`protected job-result payload is invalid: ${payloadErrors.join('; ')}`)
    } catch (error) {
      errors.push(`${prefix}: ${error instanceof Error ? error.message : 'protected evidence verification failed'}`)
    }
  }
  return errors
}
