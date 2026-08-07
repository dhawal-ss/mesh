import { createHash } from 'node:crypto'
import { validateExternalAcceptance } from './check-external-acceptance.mjs'
import {
  downloadGitHubActionsArtifact,
  extractSingleJsonArchive,
  MAX_PROTECTED_ARCHIVE_BYTES,
  MAX_PROTECTED_JSON_BYTES,
  parseProtectedArtifactUrl,
} from './protected-readiness-evidence.mjs'

const SHA256_PATTERN = /^[0-9a-f]{64}$/u
const ZIP_LOCAL_FILE_HEADER = Buffer.from([0x50, 0x4b, 0x03, 0x04])
const EXTERNAL_GATE_MILESTONES = new Set(['R1', 'R2', 'R4'])

export const PROTECTED_EXTERNAL_ACCEPTANCE_WORKFLOW = 'CI'
export const PROTECTED_EXTERNAL_ACCEPTANCE_ENTRY = 'external-acceptance.json'

function asBuffer(value) {
  if (Buffer.isBuffer(value)) return value
  if (value instanceof Uint8Array) return Buffer.from(value)
  throw new TypeError('external acceptance artifact downloader must return bytes')
}

function archiveDigest(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function requiredExternalGates(ledger, milestone) {
  const includedMilestones = milestone === 'R4'
    ? new Set(['R1', 'R2', 'R4'])
    : new Set(['R1', 'R2'])
  return Array.isArray(ledger?.gates)
    ? ledger.gates.filter((gate) => gate?.required === true
      && EXTERNAL_GATE_MILESTONES.has(gate?.milestone)
      && includedMilestones.has(gate.milestone))
    : []
}

export async function verifyProtectedExternalAcceptanceEvidence(ledger, {
  milestone = 'R2',
  now = new Date(),
  token = process.env.GITHUB_TOKEN,
  downloadArtifact = downloadGitHubActionsArtifact,
  extractSingleJson = extractSingleJsonArchive,
  maxArchiveBytes = MAX_PROTECTED_ARCHIVE_BYTES,
} = {}) {
  if (!['R2', 'R4'].includes(milestone)) {
    return ['protected external acceptance verification requires milestone R2 or R4']
  }

  const errors = []
  const gates = requiredExternalGates(ledger, milestone)
  if (gates.length === 0) return [`protected ${milestone} verification found no required external acceptance gates`]

  const references = new Map()
  for (const gate of gates) {
    const prefix = `gate ${gate.id ?? '<unknown>'}`
    const evidence = gate.evidence ?? {}
    if (gate.status !== 'live-pass') {
      errors.push(`${prefix} must be live-pass before protected external acceptance can be verified`)
      continue
    }
    if (evidence.testedCommit !== ledger.sourceCommit || evidence.testedTreeHash !== ledger.sourceTreeHash) {
      errors.push(`${prefix} tested source does not match the readiness ledger`)
    }
    if (!parseProtectedArtifactUrl(evidence.artifactUri)) {
      errors.push(`${prefix} external acceptance URL must be an immutable dhawal-ss/mesh GitHub Actions artifact URL`)
      continue
    }
    if (!SHA256_PATTERN.test(evidence.artifactSha256 ?? '')) {
      errors.push(`${prefix} external acceptance archive requires a lowercase SHA-256 digest`)
      continue
    }
    if (!Number.isSafeInteger(evidence.artifactRunAttempt) || evidence.artifactRunAttempt < 1) {
      errors.push(`${prefix} external acceptance archive requires an exact GitHub Actions run attempt`)
      continue
    }
    const referenceKey = `${evidence.artifactUri}\n${evidence.artifactSha256}\n${evidence.artifactRunAttempt}`
    if (!references.has(referenceKey)) references.set(referenceKey, evidence)
  }

  if (errors.length > 0) return errors
  if (references.size !== 1) {
    return ['all required external acceptance gates must reference one comprehensive protected campaign artifact and digest']
  }

  const evidence = references.values().next().value
  try {
    const value = await downloadArtifact(evidence.artifactUri, {
      token,
      maxBytes: maxArchiveBytes,
      expectedSourceCommit: ledger.sourceCommit,
      expectedWorkflowName: PROTECTED_EXTERNAL_ACCEPTANCE_WORKFLOW,
      expectedRunAttempt: evidence.artifactRunAttempt,
    })
    const archive = asBuffer(value)
    if (archive.length < 1 || archive.length > maxArchiveBytes) {
      throw new Error(`external acceptance archive must be between 1 and ${maxArchiveBytes} bytes`)
    }
    if (archive.length < ZIP_LOCAL_FILE_HEADER.length
        || !archive.subarray(0, ZIP_LOCAL_FILE_HEADER.length).equals(ZIP_LOCAL_FILE_HEADER)) {
      throw new Error('external acceptance artifact is not a non-empty ZIP archive')
    }
    if (archiveDigest(archive) !== evidence.artifactSha256) {
      throw new Error('external acceptance archive SHA-256 does not match the readiness ledger')
    }

    const extracted = await extractSingleJson(archive, {
      maxJsonBytes: MAX_PROTECTED_JSON_BYTES,
      artifactUrl: evidence.artifactUri,
    })
    if (!extracted || typeof extracted !== 'object' || Array.isArray(extracted)
        || Object.keys(extracted).sort().join('\n') !== 'entryName\nvalue'
        || extracted.entryName !== PROTECTED_EXTERNAL_ACCEPTANCE_ENTRY) {
      throw new Error(`protected external acceptance archive must contain exactly ${PROTECTED_EXTERNAL_ACCEPTANCE_ENTRY}`)
    }

    const document = extracted.value
    const acceptanceErrors = validateExternalAcceptance(document, {
      requireLive: true,
      commitSha: ledger.sourceCommit,
      now,
    })
    if (acceptanceErrors.length > 0) {
      throw new Error(`protected external acceptance document is invalid: ${acceptanceErrors.join('; ')}`)
    }
    if (document.acceptanceMilestone !== milestone) {
      throw new Error(`protected external acceptance milestone must be ${milestone}`)
    }

    for (const gate of gates) {
      if (gate.evidence.collectedAt !== document.testedAt
          || gate.evidence.expiresAt !== document.expiresAt) {
        errors.push(`gate ${gate.id} collection and expiry timestamps must match the protected external acceptance campaign`)
      }
    }
  } catch (error) {
    errors.push(error instanceof Error ? error.message : 'protected external acceptance verification failed')
  }
  return errors
}
