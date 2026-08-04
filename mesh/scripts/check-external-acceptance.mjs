import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { createReadStream } from 'node:fs'
import { readFile, realpath, stat } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, isAbsolute, relative, resolve } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const scriptDirectory = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(scriptDirectory, '..')
const templatePath = resolve(repoRoot, 'release', 'external-acceptance.example.json')
const schemaPath = resolve(repoRoot, 'release', 'external-acceptance.schema.json')
const ownerDecisionPath = resolve(repoRoot, 'release', 'owner-decisions.json')
const ownerDecisionContract = JSON.parse(await readFile(ownerDecisionPath, 'utf8'))
export const APPROVED_RELEASE_TAG = ownerDecisionContract.release.tag
const SHA_PATTERN = /^[0-9a-f]{40}$/u
const DIGEST_PATTERN = /^[0-9a-f]{64}$/u
const TAG_PATTERN = /^v\d+\.\d+\.\d+(?:[.-][0-9A-Za-z.-]+)?$/u
const ID_PATTERN = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/u
const STATUSES = new Set(['not-run', 'passed', 'failed', 'blocked'])
const PLACEHOLDER_PATTERN = /(?:placeholder|\btodo\b|\btbd\b|example|unknown|replace[-_ ]?me)/iu
const EVIDENCE_SIZE_LIMITS = new Map([
  ['text/plain', 2 * 1024 * 1024],
  ['application/json', 4 * 1024 * 1024],
  ['application/pdf', 20 * 1024 * 1024],
  ['image/png', 20 * 1024 * 1024],
  ['image/jpeg', 20 * 1024 * 1024],
  ['image/webp', 20 * 1024 * 1024],
  ['video/mp4', 100 * 1024 * 1024],
])
const SCREENSHOT_MEDIA_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp'])

export const REQUIRED_EXTERNAL_ACCEPTANCE_IDS = Object.freeze([
  'windows.download',
  'windows.signature-verification',
  'windows.install',
  'windows.invitation-open',
  'windows.service-choice',
  'windows.account-creation',
  'windows.provider-sso',
  'windows.community-join',
  'windows.restart-resume',
  'windows.update',
  'windows.cross-format-msi-to-nsis',
  'windows.cross-format-nsis-to-msi',
  'windows.uninstall',
  'windows.residue',
  'public-release.signed-installer',
  'public-release.checksums',
  'public-release.sbom',
  'public-release.github-asset',
  'public-release.canonical-latest-route',
  'public-release.updater-manifest',
  'public-release.updater-rollback',
  'public-release.legal-approval',
  'public-release.live-download',
  'provider.production-registrations',
  'provider.callback-routing',
  'provider.cancel-retry',
  'provider.session-refresh',
  'provider.account-removal',
  'provider.revocation',
  'community-hosted.dns',
  'community-hosted.tls',
  'community-hosted.federation-independent-account',
  'community-hosted.backup',
  'community-hosted.destructive-restore-cycle-1',
  'community-hosted.destructive-restore-cycle-2',
  'community-hosted.monitoring',
  'community-hosted.rate-limits',
  'community-hosted.abuse-handling',
  'community-hosted.signing-key-backup',
  'community-hosted.migration-material',
  'community-hosted.incident-response',
  'incident.client-tabletop',
  'incident.community-service-tabletop',
  'community-hosted.failure-recovery',
  'accessibility.nvda',
  'accessibility.voiceover',
  'accessibility.orca',
  'accessibility.webview2',
  'accessibility.wkwebview',
  'accessibility.webkitgtk',
  'accessibility.keyboard-only',
  'accessibility.zoom-200',
  'accessibility.large-text',
  'accessibility.reduced-motion',
  'accessibility.high-contrast',
  'public-service.matrix-org',
  'public-service.tchncs-de',
  'public-service.quassel-io',
  'native-invite.macos-installed-protocol',
  'native-invite.macos-cold-start',
  'native-invite.linux-installed-protocol',
  'native-invite.linux-cold-start',
])

const R4_ONLY_EXTERNAL_ACCEPTANCE_IDS = new Set([
  'accessibility.voiceover',
  'accessibility.orca',
  'accessibility.wkwebview',
  'accessibility.webkitgtk',
  'native-invite.macos-installed-protocol',
  'native-invite.macos-cold-start',
  'native-invite.linux-installed-protocol',
  'native-invite.linux-cold-start',
])

export function requiredExternalAcceptanceIdsForMilestone(milestone) {
  if (milestone === 'R4') return [...REQUIRED_EXTERNAL_ACCEPTANCE_IDS]
  if (milestone === 'R2') return REQUIRED_EXTERNAL_ACCEPTANCE_IDS.filter((id) => !R4_ONLY_EXTERNAL_ACCEPTANCE_IDS.has(id))
  return []
}

function nonEmpty(value) {
  return typeof value === 'string' && value.trim() === value && value.length > 0
}

function nonPlaceholder(value) {
  return nonEmpty(value) && !PLACEHOLDER_PATTERN.test(value)
}

function isoDate(value) {
  return nonEmpty(value) && Number.isFinite(Date.parse(value)) && /Z$/u.test(value)
}

function exactKeys(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  return Object.keys(value).sort().join('\n') === [...keys].sort().join('\n')
}

function evidenceText(bytes) {
  const utf8 = new TextDecoder('utf-8', { fatal: false }).decode(bytes)
  const ascii = Buffer.from(bytes).toString('latin1').replace(/[^\x20-\x7E]/g, ' ')
  return `${utf8}\n${ascii}`
}

function contentCategories(text) {
  const categories = new Set()
  const decoded = [text]
  try { decoded.push(decodeURIComponent(text)) } catch { /* malformed percent encoding stays inspected as-is */ }
  for (const candidate of text.matchAll(/(?:^|[^A-Za-z0-9+/])([A-Za-z0-9+/]{20,}={0,2})(?=$|[^A-Za-z0-9+/])/g)) {
    try {
      const value = Buffer.from(candidate[1], 'base64').toString('utf8')
      if (/^[\x09\x0A\x0D\x20-\x7E]+$/.test(value)) decoded.push(value)
    } catch { /* invalid base64 is not evidence of a secret */ }
  }
  for (const value of decoded) {
    const compact = value.toLowerCase().replace(/[^a-z0-9]/g, '')
    if (/(?:access|refresh|registration|invite|update|signing)(?:token|secret|key)[a-z0-9]{12,}/.test(compact)
      || /-----begin(?:rsa|ec|openssh)?privatekey-----/i.test(value)) categories.add('credential material')
    if (/(?:password|passphrase|recoverykey)[a-z0-9]{12,}/.test(compact)
      || /\b(?:[A-Z0-9]{4}[- ]+){6,}[A-Z0-9]{4}\b/.test(value)) categories.add('account recovery material')
    if (/(?:^|[\s"'(<])(?:@|!|\$)[A-Za-z0-9._=+\/-]+:[A-Za-z0-9.-]+(?=$|[\s"')>,])/m.test(value)) categories.add('direct Matrix identifier')
    if (/\b(?:message(?:body|content)|room(?:member|state)|memberlist|rawdiagnostics?)\s*[:=]/i.test(value)) categories.add('private conversation or diagnostic data')
    if (/(?:^|[\s"'])(?:[A-Za-z]:\\Users\\[^\s"']+|\/(?:Users|home)\/[^\s"']+)/m.test(value)) categories.add('private absolute path')
  }
  return [...categories]
}

export function inspectEvidenceContent(bytes, mediaType, { privacyReviewer = null } = {}) {
  const errors = []
  const limit = EVIDENCE_SIZE_LIMITS.get(mediaType)
  if (!limit) return ['evidence media type is not supported for bounded inspection']
  if (bytes.byteLength > limit) return ['evidence exceeds the bounded inspection size limit']
  if (SCREENSHOT_MEDIA_TYPES.has(mediaType) && !nonPlaceholder(privacyReviewer)) {
    errors.push('screenshot evidence requires a named human privacy reviewer')
  }
  for (const category of contentCategories(evidenceText(bytes))) {
    errors.push(`evidence content contains prohibited ${category}`)
  }
  return errors
}

export function validateExternalAcceptance(document, {
  requireLive = false,
  templateMode = false,
  commitSha = null,
  now = new Date(),
} = {}) {
  const errors = []
  const fail = (message) => errors.push(message)
  const rootKeys = ['schemaVersion', 'acceptanceMilestone', 'sourceSha', 'releaseTag', 'status', 'testedAt', 'expiresAt', 'operator', 'results', 'artifacts']
  if (!exactKeys(document, rootKeys)) return ['document must contain only the external-acceptance schema fields']
  if (document.schemaVersion !== 1) fail('schemaVersion must be 1')
  if (![null, 'R2', 'R4'].includes(document.acceptanceMilestone)) fail('acceptanceMilestone must be null, R2, or R4')
  if (document.sourceSha !== null && !SHA_PATTERN.test(document.sourceSha)) fail('sourceSha must be null or a lowercase 40-character SHA')
  if (document.releaseTag !== null && !TAG_PATTERN.test(document.releaseTag)) fail('releaseTag must be null or a v-prefixed semantic version')
  if (!STATUSES.has(document.status)) fail('document status is invalid')
  if (document.testedAt !== null && !isoDate(document.testedAt)) fail('testedAt must be null or an ISO UTC timestamp')
  if (document.expiresAt !== null && !isoDate(document.expiresAt)) fail('expiresAt must be null or an ISO UTC timestamp')
  if (document.operator !== null && !nonEmpty(document.operator)) fail('operator must be null or a non-empty string')

  const results = Array.isArray(document.results) ? document.results : []
  const resultIds = new Set()
  for (const [index, result] of results.entries()) {
    if (!exactKeys(result, ['id', 'status', 'environment', 'notes', 'evidenceIds'])) {
      fail(`results[${index}] must contain only the result schema fields`)
      continue
    }
    if (!ID_PATTERN.test(result.id ?? '')) fail(`results[${index}].id is invalid`)
    if (resultIds.has(result.id)) fail(`duplicate result id: ${result.id}`)
    resultIds.add(result.id)
    if (!STATUSES.has(result.status)) fail(`result ${result.id} status is invalid`)
    if (result.environment !== null && !nonPlaceholder(result.environment)) fail(`result ${result.id} environment is invalid or placeholder text`)
    if (result.notes !== null && !nonPlaceholder(result.notes)) fail(`result ${result.id} notes are invalid or placeholder text`)
    if (!Array.isArray(result.evidenceIds) || new Set(result.evidenceIds).size !== result.evidenceIds.length || result.evidenceIds.some((id) => !ID_PATTERN.test(id))) {
      fail(`result ${result.id} evidenceIds must be unique valid IDs`)
    }
  }
  for (const requiredId of REQUIRED_EXTERNAL_ACCEPTANCE_IDS) {
    if (!resultIds.has(requiredId)) fail(`missing required external acceptance result: ${requiredId}`)
  }
  for (const resultId of resultIds) {
    if (!REQUIRED_EXTERNAL_ACCEPTANCE_IDS.includes(resultId)) fail(`unknown external acceptance result: ${resultId}`)
  }
  if (results.length !== REQUIRED_EXTERNAL_ACCEPTANCE_IDS.length) {
    fail(`external acceptance must contain exactly ${REQUIRED_EXTERNAL_ACCEPTANCE_IDS.length} results`)
  }

  const artifacts = Array.isArray(document.artifacts) ? document.artifacts : []
  const artifactById = new Map()
  for (const [index, artifact] of artifacts.entries()) {
    if (!exactKeys(artifact, ['id', 'path', 'sha256', 'bytes', 'mediaType', 'collectedAt', 'sanitized', 'privacyReviewer', 'resultIds'])) {
      fail(`artifacts[${index}] must contain only the artifact schema fields`)
      continue
    }
    if (!ID_PATTERN.test(artifact.id ?? '')) fail(`artifacts[${index}].id is invalid`)
    if (artifactById.has(artifact.id)) fail(`duplicate artifact id: ${artifact.id}`)
    artifactById.set(artifact.id, artifact)
    if (!nonEmpty(artifact.path) || isAbsolute(artifact.path) || relative('.', artifact.path).startsWith('..')) fail(`artifact ${artifact.id} path must be relative`)
    if (!DIGEST_PATTERN.test(artifact.sha256 ?? '')) fail(`artifact ${artifact.id} sha256 is invalid`)
    if (!Number.isSafeInteger(artifact.bytes) || artifact.bytes < 1) fail(`artifact ${artifact.id} bytes must be a positive integer`)
    if (!nonEmpty(artifact.mediaType)) fail(`artifact ${artifact.id} mediaType is required`)
    if (!isoDate(artifact.collectedAt)) fail(`artifact ${artifact.id} collectedAt is invalid`)
    if (typeof artifact.sanitized !== 'boolean') fail(`artifact ${artifact.id} sanitized must remain explicit metadata`)
    if (artifact.privacyReviewer !== null && !nonPlaceholder(artifact.privacyReviewer)) fail(`artifact ${artifact.id} privacyReviewer must be named or null`)
    if (SCREENSHOT_MEDIA_TYPES.has(artifact.mediaType) && !nonPlaceholder(artifact.privacyReviewer)) fail(`artifact ${artifact.id} screenshot requires a named human privacy reviewer`)
    if (!Array.isArray(artifact.resultIds) || artifact.resultIds.length < 1 || new Set(artifact.resultIds).size !== artifact.resultIds.length) {
      fail(`artifact ${artifact.id} resultIds must be a non-empty unique array`)
    } else {
      for (const resultId of artifact.resultIds) if (!resultIds.has(resultId)) fail(`artifact ${artifact.id} references unknown result ${resultId}`)
    }
  }

  const referencedArtifacts = new Set()
  for (const result of results) {
    if (!Array.isArray(result.evidenceIds)) continue
    for (const evidenceId of result.evidenceIds) {
      referencedArtifacts.add(evidenceId)
      const artifact = artifactById.get(evidenceId)
      if (!artifact) fail(`result ${result.id} references unknown evidence ${evidenceId}`)
      else if (!artifact.resultIds.includes(result.id)) fail(`artifact ${evidenceId} is not bound to result ${result.id}`)
    }
  }
  for (const artifactId of artifactById.keys()) if (!referencedArtifacts.has(artifactId)) fail(`artifact ${artifactId} is not referenced by a result`)
  for (const artifact of artifactById.values()) {
    for (const resultId of artifact.resultIds) {
      const result = results.find((candidate) => candidate.id === resultId)
      if (result && !result.evidenceIds.includes(artifact.id)) fail(`artifact ${artifact.id} claims result ${resultId}, but that result does not reference the artifact`)
    }
  }

  if (templateMode) {
    if (document.status !== 'not-run' || document.acceptanceMilestone !== null || document.sourceSha !== null || document.releaseTag !== null ||
        document.testedAt !== null || document.expiresAt !== null || document.operator !== null || artifacts.length !== 0 ||
        results.some((result) => result.status !== 'not-run' || result.environment !== null || result.notes !== null || result.evidenceIds.length !== 0)) {
      fail('the tracked external acceptance template must make no live claim')
    }
  }

  if (requireLive) {
    if (document.status !== 'passed') fail('live external acceptance requires document status passed')
    if (!['R2', 'R4'].includes(document.acceptanceMilestone)) fail('live external acceptance requires acceptanceMilestone R2 or R4')
    if (!SHA_PATTERN.test(document.sourceSha ?? '')) fail('live external acceptance requires sourceSha')
    if (document.releaseTag !== APPROVED_RELEASE_TAG) fail(`live external acceptance requires the approved releaseTag ${APPROVED_RELEASE_TAG}`)
    if (!isoDate(document.testedAt) || !isoDate(document.expiresAt)) fail('live external acceptance requires testedAt and expiresAt')
    if (isoDate(document.testedAt) && Date.parse(document.testedAt) > now.getTime()) fail('live external acceptance testedAt cannot be in the future')
    if (isoDate(document.testedAt) && isoDate(document.expiresAt) && Date.parse(document.expiresAt) <= Date.parse(document.testedAt)) fail('live external acceptance expiresAt must be later than testedAt')
    if (isoDate(document.expiresAt) && Date.parse(document.expiresAt) <= now.getTime()) fail(`live external acceptance expired at ${document.expiresAt}`)
    if (!nonPlaceholder(document.operator)) fail('live external acceptance requires a non-placeholder operator')
    if (commitSha === null || !SHA_PATTERN.test(commitSha)) fail('live validation requires an exact --commit-sha')
    else if (document.sourceSha !== commitSha) fail(`evidence sourceSha ${document.sourceSha} does not match requested commit ${commitSha}`)
    const requiredLiveIds = new Set(requiredExternalAcceptanceIdsForMilestone(document.acceptanceMilestone))
    for (const result of results) {
      if (requiredLiveIds.has(result.id) && result.status !== 'passed') fail(`live external acceptance is incomplete through ${document.acceptanceMilestone}: ${result.id} is ${result.status}`)
      if (result.status === 'passed') {
        if (!nonPlaceholder(result.environment)) fail(`passed result ${result.id} requires a non-placeholder environment`)
        if (!Array.isArray(result.evidenceIds) || result.evidenceIds.length < 1) fail(`passed result ${result.id} requires evidence`)
      }
    }
    if (artifacts.length < 1) fail('live external acceptance requires evidence artifacts')
    for (const artifact of artifacts) {
      if (isoDate(artifact.collectedAt) && Date.parse(artifact.collectedAt) > now.getTime()) fail(`artifact ${artifact.id} collectedAt cannot be in the future`)
      if (isoDate(document.testedAt) && isoDate(artifact.collectedAt) && Date.parse(artifact.collectedAt) < Date.parse(document.testedAt)) fail(`artifact ${artifact.id} predates the acceptance campaign`)
    }
  }
  return errors
}

function pathInside(root, candidate) {
  const delta = relative(root, candidate)
  return delta === '' || (!delta.startsWith('..') && !isAbsolute(delta))
}

async function verifyLiveArtifacts(document, evidenceRoot) {
  const errors = []
  const canonicalRoot = await realpath(evidenceRoot)
  const canonicalSource = await realpath(repoRoot)
  if (pathInside(canonicalSource, canonicalRoot)) errors.push('live external acceptance evidence root must be outside the source worktree')
  for (const artifact of document.artifacts) {
    try {
      const candidate = resolve(canonicalRoot, artifact.path)
      const canonical = await realpath(candidate)
      if (!pathInside(canonicalRoot, canonical)) {
        errors.push(`artifact ${artifact.id} resolves outside the evidence root`)
        continue
      }
      const info = await stat(canonical)
      if (!info.isFile()) errors.push(`artifact ${artifact.id} is not a file`)
      else if (info.size !== artifact.bytes) errors.push(`artifact ${artifact.id} byte size does not match`)
      const sizeLimit = EVIDENCE_SIZE_LIMITS.get(artifact.mediaType)
      if (!sizeLimit || info.size > sizeLimit) {
        errors.push(`artifact ${artifact.id} cannot be boundedly inspected for its declared media type and size`)
        continue
      }
      const digest = await sha256File(canonical)
      if (digest !== artifact.sha256) errors.push(`artifact ${artifact.id} SHA-256 does not match`)
      const bytes = await readFile(canonical)
      for (const contentError of inspectEvidenceContent(bytes, artifact.mediaType, { privacyReviewer: artifact.privacyReviewer })) {
        errors.push(`artifact ${artifact.id}: ${contentError}`)
      }
    } catch {
      errors.push(`artifact ${artifact.id} could not be verified`)
    }
  }
  return errors
}

async function sha256File(path) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

function parseArgs(argv) {
  const options = { file: templatePath, evidenceRoot: null, commitSha: null, requireLive: false }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--file') options.file = resolve(argv[++index] ?? '')
    else if (argument === '--evidence-root') options.evidenceRoot = resolve(argv[++index] ?? '')
    else if (argument === '--commit-sha') options.commitSha = argv[++index] ?? null
    else if (argument === '--require-live') options.requireLive = true
    else throw new Error(`Unknown argument: ${argument}`)
  }
  return options
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv)
  JSON.parse(await readFile(schemaPath, 'utf8'))
  const document = JSON.parse(await readFile(options.file, 'utf8'))
  const errors = validateExternalAcceptance(document, {
    requireLive: options.requireLive,
    templateMode: resolve(options.file) === templatePath,
    commitSha: options.commitSha,
  })
  if (options.requireLive) {
    if (options.evidenceRoot === null) errors.push('live validation requires --evidence-root')
    else errors.push(...await verifyLiveArtifacts(document, options.evidenceRoot))
    try {
      const canonicalSource = await realpath(repoRoot)
      const canonicalDocument = await realpath(options.file)
      if (pathInside(canonicalSource, canonicalDocument)) errors.push('live external acceptance manifest must be outside the source worktree')
      const { stdout } = await execFileAsync('git', ['-C', repoRoot, 'status', '--porcelain', '--untracked-files=all'], { windowsHide: true })
      if (stdout.trim() !== '') errors.push('live external acceptance requires a clean tracked and untracked source worktree')
      const { stdout: head } = await execFileAsync('git', ['-C', repoRoot, 'rev-parse', 'HEAD'], { windowsHide: true })
      if (head.trim() !== options.commitSha) errors.push('requested commit does not match source HEAD')
    } catch {
      errors.push('live external acceptance could not validate the source worktree')
    }
  }
  if (errors.length > 0) {
    console.error('Mesh external acceptance validation failed:')
    for (const error of errors) console.error(`- ${error}`)
    return 1
  }
  console.log(JSON.stringify({
    status: options.requireLive ? 'live-pass' : 'template-valid',
    sourceSha: document.sourceSha,
    results: document.results.length,
    artifacts: document.artifacts.length,
  }, null, 2))
  return 0
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await main()
