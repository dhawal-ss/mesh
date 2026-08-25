import { readFile, readdir, stat, writeFile, mkdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const PINNED_IMAGE = /^[A-Za-z0-9./_-]+:[A-Za-z0-9._-]+@sha256:[0-9a-f]{64}$/
const PINNED_IMAGE_REFERENCE = /[A-Za-z0-9./_-]+:[A-Za-z0-9._-]+@sha256:[0-9a-f]{64}/g
const SHA256 = /^[0-9a-f]{64}$/
const TOOL_VERSION = /^v[0-9]+\.[0-9]+\.[0-9]+$/
const RELEASE_MILESTONES = new Set(['R2', 'R3'])
const ACCOUNTABILITY_SCOPES = new Set(['release', 'reference'])

async function composeFiles(root) {
  const result = []
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const candidate = path.join(root, entry.name)
    if (entry.isDirectory()) result.push(...await composeFiles(candidate))
    else if (/^(?:docker-)?compose.*\.ya?ml$/i.test(entry.name)) result.push(candidate)
  }
  return result
}

async function allFiles(root) {
  let metadata
  try {
    metadata = await stat(root)
  } catch (error) {
    if (error?.code === 'ENOENT') return []
    throw error
  }
  if (metadata.isFile()) return [root]
  if (!metadata.isDirectory()) return []
  const result = []
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const candidate = path.join(root, entry.name)
    if (entry.isDirectory()) result.push(...await allFiles(candidate))
    else if (entry.isFile()) result.push(candidate)
  }
  return result
}

export function collectComposeImages(source) {
  return [...source.matchAll(/^\s*image:\s*([^\s#]+)\s*$/gm)].map((match) => match[1])
}

export function collectPinnedImages(source) {
  return [...new Set(source.match(PINNED_IMAGE_REFERENCE) ?? [])]
}

function repositoryPath(value) {
  return value.replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/$/, '')
}

function pathIsWithin(candidate, directory) {
  const normalizedCandidate = repositoryPath(candidate)
  const normalizedDirectory = repositoryPath(directory)
  return normalizedCandidate === normalizedDirectory || normalizedCandidate.startsWith(`${normalizedDirectory}/`)
}

export function deriveContainerScope({ image, occurrences, callPathComposeDirectories }) {
  const meshMaintained = image?.startsWith('ghcr.io/dhawal-ss/')
  const onCallPath = occurrences.some((occurrence) => occurrence.image === image
    && typeof occurrence.composeFile === 'string'
    && callPathComposeDirectories.some((directory) => pathIsWithin(occurrence.composeFile, directory)))
  return meshMaintained || onCallPath ? 'release' : 'reference'
}

function workflowJob(workflowText, jobId) {
  const escapedId = jobId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const startMatch = new RegExp(`^  ${escapedId}:\\s*$`, 'm').exec(workflowText)
  if (!startMatch) return ''
  const start = startMatch.index
  const remainder = workflowText.slice(start + startMatch[0].length)
  const nextJob = /^  [A-Za-z0-9_-]+:\s*$/m.exec(remainder)
  return workflowText.slice(start, nextJob ? start + startMatch[0].length + nextJob.index : workflowText.length)
}

function collectWorkflowMatrixEntries(jobText) {
  return [...jobText.matchAll(/^\s+- name:\s*([^\s#]+)\s*\r?\n\s+image:\s*([^\s#]+)\s*$/gm)]
    .map((match) => ({ name: match[1], image: match[2] }))
}

function validateExactMatrix(entries, expected, label) {
  const errors = []
  const actualNames = new Set()
  const actualImages = new Set()
  for (const entry of entries) {
    if (actualNames.has(entry.name)) errors.push(`${label} contains duplicate image name ${entry.name}`)
    if (actualImages.has(entry.image)) errors.push(`${label} contains duplicate image ${entry.image}`)
    actualNames.add(entry.name)
    actualImages.add(entry.image)
  }
  const expectedByName = new Map(expected.map((entry) => [entry.name, entry.image]))
  for (const [name, image] of expectedByName) {
    const actual = entries.find((entry) => entry.name === name)
    if (!actual) errors.push(`${label} is missing ${name}`)
    else if (actual.image !== image) errors.push(`${label} does not scan the policy image for ${name}`)
  }
  for (const entry of entries) {
    if (!expectedByName.has(entry.name)) errors.push(`${label} contains non-policy image name ${entry.name}`)
  }
  return errors
}

function preservesFailedScanEvidence(jobText, outputFile) {
  const scanOutput = jobText.indexOf(`output-file: ${outputFile}`)
  if (scanOutput < 0) return false
  const always = jobText.indexOf('if: always()', scanOutput)
  const upload = jobText.indexOf('actions/upload-artifact@', scanOutput)
  const uploadedOutput = jobText.indexOf(outputFile, upload)
  return always > scanOutput && upload > always && uploadedOutput > upload
}

function validateSignatureDiscovery(jobText, {
  label,
  signatureFile,
  signatureRawFile,
  signaturePolicy,
}) {
  const errors = []
  const installer = jobText.search(/sigstore\/cosign-installer@[0-9a-f]{40}/)
  const normalization = jobText.indexOf('node mesh/scripts/check-container-signature-evidence.mjs')
  const discoveryBlock = installer >= 0 && normalization > installer ? jobText.slice(installer, normalization) : ''
  if (installer < 0) errors.push(`${label} Cosign installer action is not SHA pinned`)
  if (!discoveryBlock.includes(`cosign-release: ${signaturePolicy?.cosignVersion}`)) {
    errors.push(`${label} must pin policy Cosign ${signaturePolicy?.cosignVersion}`)
  }
  if (!discoveryBlock.includes('cosign verify')
    || !discoveryBlock.includes(`--certificate-identity-regexp='${signaturePolicy?.identityRegexp}'`)
    || !discoveryBlock.includes(`--certificate-oidc-issuer-regexp='${signaturePolicy?.issuerRegexp}'`)
    || !discoveryBlock.includes('--output=json')
    || !discoveryBlock.includes("'${{ matrix.image }}'")
    || !discoveryBlock.includes(`> ${signatureRawFile}`)) {
    errors.push(`${label} must run the bounded untrusted signature discovery against the exact image`)
  }
  if (normalization < 0
    || !jobText.includes(`--verification "${signatureRawFile}"`)
    || !jobText.includes('--cosign-exit "$status"')
    || !jobText.includes("--image '${{ matrix.image }}'")
    || !jobText.includes(`--output "${signatureFile}"`)) {
    errors.push(`${label} must normalize signature discovery without granting release trust`)
  }
  const upload = jobText.indexOf('actions/upload-artifact@', normalization)
  if (upload < 0 || jobText.indexOf(signatureFile, upload) < 0) {
    errors.push(`${label} must upload normalized signature discovery evidence`)
  }
  if (upload >= 0 && jobText.indexOf(signatureRawFile, upload) >= 0) {
    errors.push(`${label} must not upload arbitrary raw signature annotations`)
  }
  if (!jobText.includes(`rm -f ${signatureRawFile}`)) {
    errors.push(`${label} must remove raw signature annotations before artifact upload`)
  }
  return errors
}

function validateMeshCandidateTrust(jobText, {
  label,
  signatureFile,
  signatureRawFile,
  trustPolicy,
}) {
  if (!trustPolicy) return []
  const errors = []
  const verification = jobText.indexOf('Verify Mesh-maintained candidate signature')
  const verificationBlock = verification >= 0 ? jobText.slice(verification) : ''
  if (verification < 0
    || !verificationBlock.includes("if: startsWith(matrix.image, 'ghcr.io/dhawal-ss/')")
    || !verificationBlock.includes('cosign verify')
    || !verificationBlock.includes(`--certificate-identity-regexp='${trustPolicy.identityRegexp}'`)
    || !verificationBlock.includes(`--certificate-oidc-issuer='${trustPolicy.issuer}'`)
    || !verificationBlock.includes('--output=json')
    || !verificationBlock.includes("'${{ matrix.image }}'")
    || !verificationBlock.includes(`> ${signatureRawFile}`)
    || !verificationBlock.includes('node mesh/scripts/check-candidate-container-signature-evidence.mjs')
    || !verificationBlock.includes(`--verification "${signatureRawFile}"`)
    || !verificationBlock.includes(`--output "${signatureFile}"`)
    || !verificationBlock.includes(`rm -f ${signatureRawFile}`)) {
    errors.push(`${label} must strictly verify and normalize Mesh keyless candidate signatures`)
  }
  const upload = jobText.indexOf('actions/upload-artifact@', verification)
  if (upload < 0 || jobText.indexOf(signatureFile, upload) < 0) errors.push(`${label} must upload Mesh candidate signature evidence`)
  if (upload >= 0 && jobText.indexOf(signatureRawFile, upload) >= 0) errors.push(`${label} must not upload raw Mesh signature annotations`)
  return errors
}

function validateScanJob(jobText, {
  label,
  outputFile,
  sbomFile,
  evidenceFile,
  grypeVersion,
  syftVersion,
  signatureFile,
  signatureRawFile,
  signaturePolicy,
  meshSignatureFile,
  meshSignatureRawFile,
  meshTrustPolicy,
  failBuild,
  expectedScope,
}) {
  const errors = []
  if (!jobText) return [`${label} job is missing`]
  const sbomAction = jobText.search(/anchore\/sbom-action@[0-9a-f]{40}/)
  const scanAction = jobText.search(/anchore\/scan-action@[0-9a-f]{40}/)
  const validation = jobText.indexOf('node mesh/scripts/check-container-scan-evidence.mjs')
  const sbomBlock = sbomAction >= 0 && scanAction > sbomAction ? jobText.slice(sbomAction, scanAction) : ''
  const scanBlock = scanAction >= 0 && validation > scanAction ? jobText.slice(scanAction, validation) : ''
  if (sbomAction < 0) errors.push(`${label} SBOM action is not SHA pinned`)
  if (scanAction < 0) errors.push(`${label} scanner action is not SHA pinned`)
  if (!sbomBlock.includes('image: ${{ matrix.image }}')) errors.push(`${label} SBOM action must use the exact matrix image`)
  if (!scanBlock.includes('image: ${{ matrix.image }}')) errors.push(`${label} scanner action must use the exact matrix image`)
  if (!sbomBlock.includes(`syft-version: ${syftVersion}`)) errors.push(`${label} must use policy Syft ${syftVersion}`)
  if (!sbomBlock.includes('format: cyclonedx-json') || !sbomBlock.includes(`output-file: ${sbomFile}`)) {
    errors.push(`${label} must generate the expected CycloneDX SBOM`)
  }
  if (!scanBlock.includes(`grype-version: ${grypeVersion}`)) errors.push(`${label} must use policy Grype ${grypeVersion}`)
  if (!/severity-cutoff:\s*high/.test(scanBlock) || !/only-fixed:\s*true/.test(scanBlock)) errors.push(`${label} must retain the fixable High/Critical scanner policy`)
  if (typeof failBuild === 'boolean' && !new RegExp(`fail-build:\\s*${failBuild}`).test(scanBlock)) {
    errors.push(`${label} must set fail-build to ${failBuild}`)
  }
  if (!jobText.includes('node mesh/scripts/check-container-scan-evidence.mjs')
    || !jobText.includes(`--sbom "${sbomFile}"`)
    || !jobText.includes(`--scan "${outputFile}"`)
    || !jobText.includes("--image '${{ matrix.image }}'")
    || !jobText.includes(`--output "${evidenceFile}"`)) {
    errors.push(`${label} must semantically validate and bind the SBOM, exact image, and scanner database evidence`)
  }
  if (expectedScope && !new RegExp(`--scope\\s+['"]?${expectedScope}['"]?(?:\\s|$)`).test(jobText)) {
    errors.push(`${label} must bind scan evidence to derived ${expectedScope} scope`)
  }
  const sbomOutput = jobText.indexOf(`output-file: ${sbomFile}`)
  const scanOutput = jobText.indexOf(`output-file: ${outputFile}`)
  if (!(sbomOutput >= 0 && scanOutput > sbomOutput && validation > scanOutput)) {
    errors.push(`${label} must generate the SBOM and scan before binding their evidence`)
  }
  if (!/if-no-files-found:\s*error/.test(jobText)) errors.push(`${label} evidence upload must fail when evidence is absent`)
  if (!preservesFailedScanEvidence(jobText, outputFile)) errors.push(`${label} must retain scanner JSON when a fixable-high scan fails`)
  const upload = jobText.indexOf('actions/upload-artifact@', validation)
  if (upload < 0
    || jobText.indexOf(sbomFile, upload) < 0
    || jobText.indexOf(outputFile, upload) < 0
    || jobText.indexOf(evidenceFile, upload) < 0) {
    errors.push(`${label} must upload the SBOM, scan, and paired evidence manifest`)
  }
  errors.push(...validateSignatureDiscovery(jobText, {
    label,
    signatureFile,
    signatureRawFile,
    signaturePolicy,
  }))
  errors.push(...validateMeshCandidateTrust(jobText, {
    label,
    signatureFile: meshSignatureFile,
    signatureRawFile: meshSignatureRawFile,
    trustPolicy: meshTrustPolicy,
  }))
  return errors
}

export function validateContainerPolicy({
  occurrences,
  policy,
  distributionOccurrences = [],
  workflowText = '',
  candidateWorkflowText = '',
  r3WorkflowText = '',
  now = new Date(),
}) {
  const errors = []
  const images = [...new Set(occurrences.map((entry) => entry.image))].sort()
  for (const image of images) if (!PINNED_IMAGE.test(image)) errors.push(`container image is not exact tag+digest: ${image}`)

  if (policy.schemaVersion !== 6) errors.push('container security policy schemaVersion must be 6')
  const configuredCallPaths = policy.scopePolicy?.callPathComposeDirectories
  const callPathComposeDirectories = Array.isArray(configuredCallPaths) ? configuredCallPaths : []
  if (!Array.isArray(configuredCallPaths) || configuredCallPaths.length === 0) {
    errors.push('container scope policy requires an enumerated call path compose directory set')
  }
  const uniqueCallPaths = new Set()
  for (const directory of callPathComposeDirectories) {
    const normalized = typeof directory === 'string' ? repositoryPath(directory) : ''
    if (!/^infra\/[A-Za-z0-9._/-]+$/.test(normalized)
      || normalized.includes('/../')
      || normalized !== directory) {
      errors.push(`container call path compose directory must be a normalized infra path: ${directory ?? 'missing'}`)
    } else if (uniqueCallPaths.has(normalized)) {
      errors.push(`container call path compose directory is duplicated: ${normalized}`)
    } else {
      uniqueCallPaths.add(normalized)
    }
  }
  const policyEntries = policy.images ?? []
  const policyImages = new Set()
  const policyNames = new Set()
  const authoritativeScopes = new Map()
  for (const entry of policyEntries) {
    if (!entry.name || typeof entry.name !== 'string') errors.push('container policy image requires a stable name')
    else if (policyNames.has(entry.name)) errors.push(`container policy contains duplicate name: ${entry.name}`)
    else policyNames.add(entry.name)
    if (!PINNED_IMAGE.test(entry.image ?? '')) errors.push(`container policy image is not exact tag+digest: ${entry.image ?? 'missing'}`)
    if (policyImages.has(entry.image)) errors.push(`container policy contains duplicate image: ${entry.image}`)
    else policyImages.add(entry.image)
    if (!RELEASE_MILESTONES.has(entry.milestone)) errors.push(`container policy image ${entry.name ?? entry.image ?? 'unknown'} requires milestone R2 or R3`)
    if (entry.signaturePolicy !== 'discover-upstream-support-before-candidate') {
      errors.push(`container policy image ${entry.name ?? entry.image ?? 'unknown'} must retain reviewer-gated signature discovery`)
    }
    const meshMaintained = entry.image?.startsWith('ghcr.io/dhawal-ss/')
    const authoritativeScope = deriveContainerScope({
      image: entry.image,
      occurrences,
      callPathComposeDirectories: [...uniqueCallPaths],
    })
    authoritativeScopes.set(entry.image, authoritativeScope)
    if (!ACCOUNTABILITY_SCOPES.has(entry.derivedScope)) {
      errors.push(`container policy image ${entry.name ?? entry.image ?? 'unknown'} must record derived scope release or reference`)
    } else if (entry.derivedScope !== authoritativeScope) {
      errors.push(`container policy image ${entry.name ?? entry.image ?? 'unknown'} recorded derived scope ${entry.derivedScope} does not match authoritative ${authoritativeScope} scope`)
    }
    if (meshMaintained && entry.candidateTrustPolicy !== 'mesh-keyless-github-actions') {
      errors.push(`Mesh-maintained image ${entry.name ?? entry.image ?? 'unknown'} must require keyless GitHub Actions trust`)
    }
    if (!meshMaintained && entry.candidateTrustPolicy) {
      errors.push(`upstream image ${entry.name ?? entry.image ?? 'unknown'} must not claim Mesh candidate trust`)
    }
  }
  for (const image of images) if (!policyImages.has(image)) errors.push(`container image is missing from security policy: ${image}`)
  for (const image of policyImages) if (!images.includes(image)) errors.push(`container security policy contains stale image: ${image}`)
  const policyByImage = new Map(policyEntries.map((entry) => [entry.image, entry]))
  for (const occurrence of distributionOccurrences) {
    const entry = policyByImage.get(occurrence.image)
    if (!entry) {
      errors.push(`${occurrence.sourceKind ?? 'distribution surface'} contains image missing from security policy: ${occurrence.image}`)
    } else if (authoritativeScopes.get(occurrence.image) === 'reference') {
      errors.push(`reference scoped image ${entry.name} appears in ${occurrence.sourceKind ?? 'distribution surface'} at ${occurrence.sourceFile ?? 'unknown'}`)
    }
  }

  if (policy.scannerPolicy?.candidateOutage !== 'fail-closed') errors.push('candidate scanner outage policy must fail closed')
  if (policy.scannerPolicy?.developmentOutage !== 'blocked-unavailable') errors.push('development scanner outage must report a named unavailable gate')
  if (!TOOL_VERSION.test(policy.scannerPolicy?.grypeVersion ?? '')) errors.push('scanner policy must pin an exact Grype version')
  if (policy.scannerPolicy?.severityCutoff !== 'high' || policy.scannerPolicy?.onlyFixable !== true) errors.push('scanner must fail fixable high/critical findings')
  if (policy.scannerPolicy?.database?.sourceOrigin !== 'https://grype.anchore.io/databases/'
    || policy.scannerPolicy?.database?.maxAgeHours !== 120
    || policy.scannerPolicy?.database?.requireValid !== true
    || policy.scannerPolicy?.database?.requireHashValidation !== true) {
    errors.push('scanner database must use the official origin with bounded age, validity, and hash checks')
  }
  if (!TOOL_VERSION.test(policy.sbomPolicy?.syftVersion ?? '')) errors.push('SBOM policy must pin an exact Syft version')
  if (policy.sbomPolicy?.format !== 'CycloneDX'
    || policy.sbomPolicy?.specVersion !== '1.7'
    || policy.sbomPolicy?.minimumComponents !== 1
    || policy.sbomPolicy?.maxScanSkewMinutes !== 60) {
    errors.push('SBOM policy must require a nonempty CycloneDX graph generated in the bounded scan run')
  }
  if (policy.signatureDiscoveryPolicy?.cosignVersion !== 'v3.0.6'
    || policy.signatureDiscoveryPolicy?.mode !== 'discovery-only'
    || policy.signatureDiscoveryPolicy?.identityRegexp !== '^.+$'
    || policy.signatureDiscoveryPolicy?.issuerRegexp !== '^https://.+$'
    || policy.signatureDiscoveryPolicy?.maxPayloadBytes !== 1_048_576
    || policy.signatureDiscoveryPolicy?.maxSignatures !== 64
    || policy.signatureDiscoveryPolicy?.requiresReviewer !== true
    || policy.signatureDiscoveryPolicy?.trustedForRelease !== false) {
    errors.push('signature discovery policy must pin bounded Cosign and remain reviewer-required and release-untrusted')
  }
  const requiresMeshCandidateTrust = policyEntries.some((entry) => entry.candidateTrustPolicy === 'mesh-keyless-github-actions')
  if (requiresMeshCandidateTrust && (policy.meshCandidateTrustPolicy?.cosignVersion !== 'v3.0.6'
    || policy.meshCandidateTrustPolicy?.mode !== 'keyless-github-actions'
    || !policy.meshCandidateTrustPolicy?.identityRegexp?.includes('container-candidates')
    || policy.meshCandidateTrustPolicy?.issuer !== 'https://token.actions.githubusercontent.com'
    || policy.meshCandidateTrustPolicy?.maxPayloadBytes !== 1_048_576
    || policy.meshCandidateTrustPolicy?.maxSignatures !== 16
    || policy.meshCandidateTrustPolicy?.trustedForCandidate !== true
    || policy.meshCandidateTrustPolicy?.trustedForRelease !== false)) {
    errors.push('Mesh candidate trust must be bounded to the reviewed keyless publishing workflow')
  }
  const requiredRegressions = new Set(policy.requiredUpdateRegressions ?? [])
  for (const required of ['disposable-federation', 'backup', 'restore', 'health', 'cleanup']) {
    if (!requiredRegressions.has(required)) errors.push(`container updates are missing ${required} regression coverage`)
  }
  for (const exception of policy.exceptions ?? []) {
    if (!SHA256.test(exception.digest ?? '') || !exception.vulnerabilityId || !exception.reason || !exception.reviewer) errors.push('container exception must bind exact digest, vulnerability, reason, and reviewer')
    if (!Number.isFinite(Date.parse(exception.expiresAt ?? '')) || Date.parse(exception.expiresAt) <= now.getTime()) errors.push(`container exception is expired or invalid for ${exception.vulnerabilityId ?? 'unknown finding'}`)
  }

  const r2Images = policyEntries.filter((entry) => entry.milestone === 'R2')
  const r2ReleaseImages = r2Images.filter((entry) => authoritativeScopes.get(entry.image) === 'release')
  const r2ReferenceImages = r2Images.filter((entry) => authoritativeScopes.get(entry.image) === 'reference')
  const r3Images = policyEntries.filter((entry) => entry.milestone === 'R3')
  if (workflowText) {
    const sbomJob = workflowJob(workflowText, 'sbom')
    if (!/npm run build:matrix-voice\s*\r?\n\s*npm run (?:check|generate):release-sboms/.test(sbomJob)) {
      errors.push('protected SBOM job must build the Matrix voice artifact immediately before generating release SBOMs')
    }
    const r2Job = workflowJob(workflowText, 'container-supply-chain-r2')
    errors.push(...validateExactMatrix(collectWorkflowMatrixEntries(r2Job), r2ReleaseImages, 'protected R2 container job'))
    errors.push(...validateScanJob(r2Job, {
      label: 'protected R2 container job',
      outputFile: 'r2-container-${{ matrix.name }}-grype.json',
      sbomFile: 'r2-container-${{ matrix.name }}.cdx.json',
      evidenceFile: 'r2-container-${{ matrix.name }}-evidence.json',
      grypeVersion: policy.scannerPolicy?.grypeVersion,
      syftVersion: policy.sbomPolicy?.syftVersion,
      signatureFile: 'r2-container-${{ matrix.name }}-signature.json',
      signatureRawFile: 'r2-container-${{ matrix.name }}-signature-raw.json',
      signaturePolicy: policy.signatureDiscoveryPolicy,
      meshSignatureFile: 'r2-container-${{ matrix.name }}-mesh-signature.json',
      meshSignatureRawFile: 'r2-container-${{ matrix.name }}-mesh-signature-raw.json',
      meshTrustPolicy: policy.meshCandidateTrustPolicy,
      failBuild: true,
      expectedScope: 'release',
    }))

    const r2ReferenceJob = workflowJob(workflowText, 'container-reference-scan-r2')
    errors.push(...validateExactMatrix(collectWorkflowMatrixEntries(r2ReferenceJob), r2ReferenceImages, 'reference R2 container job'))
    errors.push(...validateScanJob(r2ReferenceJob, {
      label: 'reference R2 container job',
      outputFile: 'r2-reference-container-${{ matrix.name }}-grype.json',
      sbomFile: 'r2-reference-container-${{ matrix.name }}.cdx.json',
      evidenceFile: 'r2-reference-container-${{ matrix.name }}-evidence.json',
      grypeVersion: policy.scannerPolicy?.grypeVersion,
      syftVersion: policy.sbomPolicy?.syftVersion,
      signatureFile: 'r2-reference-container-${{ matrix.name }}-signature.json',
      signatureRawFile: 'r2-reference-container-${{ matrix.name }}-signature-raw.json',
      signaturePolicy: policy.signatureDiscoveryPolicy,
      meshSignatureFile: 'r2-reference-container-${{ matrix.name }}-mesh-signature.json',
      meshSignatureRawFile: 'r2-reference-container-${{ matrix.name }}-mesh-signature-raw.json',
      meshTrustPolicy: undefined,
      failBuild: false,
      expectedScope: 'reference',
    }))

    const protectedJob = workflowJob(workflowText, 'protected-evidence')
    if (!/needs:\s*\[[^\]]*container-supply-chain-r2[^\]]*\]/.test(protectedJob)
      || !/needs:\s*\[[^\]]*container-reference-scan-r2[^\]]*\]/.test(protectedJob)
      || /container-supply-chain-r3/.test(protectedJob)) {
      errors.push('protected security evidence must depend on release and reference R2 containers and not R3 voice')
    }
    if (!/R2_CONTAINERS:\s*\$\{\{ needs\.container-supply-chain-r2\.result \}\}/.test(protectedJob)) {
      errors.push('protected security evidence must record the explicit R2 container result')
    }
    if (!/R2_REFERENCE_CONTAINERS:\s*\$\{\{ needs\.container-reference-scan-r2\.result \}\}/.test(protectedJob)) {
      errors.push('protected security evidence must record the explicit reference R2 container result')
    }
  }

  if (candidateWorkflowText) {
    const r2Job = workflowJob(candidateWorkflowText, 'container-supply-chain-r2')
    errors.push(...validateExactMatrix(collectWorkflowMatrixEntries(r2Job), r2Images, 'candidate R2 container job'))
    errors.push(...validateScanJob(r2Job, {
      label: 'candidate R2 container job',
      outputFile: 'candidate-${{ matrix.name }}-grype.json',
      sbomFile: 'candidate-${{ matrix.name }}.cdx.json',
      evidenceFile: 'candidate-${{ matrix.name }}-evidence.json',
      grypeVersion: policy.scannerPolicy?.grypeVersion,
      syftVersion: policy.sbomPolicy?.syftVersion,
      signatureFile: 'candidate-${{ matrix.name }}-signature.json',
      signatureRawFile: 'candidate-${{ matrix.name }}-signature-raw.json',
      signaturePolicy: policy.signatureDiscoveryPolicy,
      meshSignatureFile: 'candidate-${{ matrix.name }}-mesh-signature.json',
      meshSignatureRawFile: 'candidate-${{ matrix.name }}-mesh-signature-raw.json',
      meshTrustPolicy: policy.meshCandidateTrustPolicy,
    }))
    const r3Job = workflowJob(candidateWorkflowText, 'container-supply-chain-r3')
    errors.push(...validateExactMatrix(collectWorkflowMatrixEntries(r3Job), r3Images, 'candidate voice container job'))
    errors.push(...validateScanJob(r3Job, {
      label: 'candidate voice container job',
      outputFile: 'candidate-voice-${{ matrix.name }}-grype.json',
      sbomFile: 'candidate-voice-${{ matrix.name }}.cdx.json',
      evidenceFile: 'candidate-voice-${{ matrix.name }}-evidence.json',
      grypeVersion: policy.scannerPolicy?.grypeVersion,
      syftVersion: policy.sbomPolicy?.syftVersion,
      signatureFile: 'candidate-voice-${{ matrix.name }}-signature.json',
      signatureRawFile: 'candidate-voice-${{ matrix.name }}-signature-raw.json',
      signaturePolicy: policy.signatureDiscoveryPolicy,
      meshSignatureFile: 'candidate-voice-${{ matrix.name }}-mesh-signature.json',
      meshSignatureRawFile: 'candidate-voice-${{ matrix.name }}-mesh-signature-raw.json',
      meshTrustPolicy: policy.meshCandidateTrustPolicy,
    }))
    const windowsJob = workflowJob(candidateWorkflowText, 'windows')
    if (!/needs:\s*\[[^\]]*container-supply-chain-r2[^\]]*container-supply-chain-r3[^\]]*\]/.test(windowsJob)) {
      errors.push('Windows beta candidate must depend on both R2 and voice container scans')
    }
    if (!/matrixrtc-preflight\.ps1\s+-RequireCompose/i.test(candidateWorkflowText)
      || !/test-evidence-validation\.ps1/i.test(candidateWorkflowText)
      || !/operator-smoke\.ps1\s+-Milestone\s+R3/i.test(candidateWorkflowText)) {
      errors.push('beta candidate workflow must retain MatrixRTC, evidence, and R3 operator voice gates')
    }
  }

  if (r3WorkflowText) {
    const r3Job = workflowJob(r3WorkflowText, 'container-supply-chain-r3')
    errors.push(...validateExactMatrix(collectWorkflowMatrixEntries(r3Job), r3Images, 'R3 voice container job'))
    errors.push(...validateScanJob(r3Job, {
      label: 'R3 voice container job',
      outputFile: 'r3-container-${{ matrix.name }}-grype.json',
      sbomFile: 'r3-container-${{ matrix.name }}.cdx.json',
      evidenceFile: 'r3-container-${{ matrix.name }}-evidence.json',
      grypeVersion: policy.scannerPolicy?.grypeVersion,
      syftVersion: policy.sbomPolicy?.syftVersion,
      signatureFile: 'r3-container-${{ matrix.name }}-signature.json',
      signatureRawFile: 'r3-container-${{ matrix.name }}-signature-raw.json',
      signaturePolicy: policy.signatureDiscoveryPolicy,
      meshSignatureFile: 'r3-container-${{ matrix.name }}-mesh-signature.json',
      meshSignatureRawFile: 'r3-container-${{ matrix.name }}-mesh-signature-raw.json',
      meshTrustPolicy: policy.meshCandidateTrustPolicy,
    }))
    if (!/test-evidence-validation\.ps1/.test(r3WorkflowText) || !/matrixrtc-preflight\.ps1\s+-RequireCompose/.test(r3WorkflowText) || !/operator-smoke\.ps1\s+-Milestone\s+R3/.test(r3WorkflowText)) {
      errors.push('R3 workflow must retain MatrixRTC evidence, preflight, and R3 operator-smoke gates')
    }
  }
  return errors
}

export async function inspectContainerSupplyChain(projectRoot) {
  const files = await composeFiles(path.join(projectRoot, 'infra'))
  const occurrences = []
  for (const file of files) {
    for (const image of collectComposeImages(await readFile(file, 'utf8'))) {
      occurrences.push({ image, composeFile: path.relative(projectRoot, file).replaceAll('\\', '/') })
    }
  }
  const policy = JSON.parse(await readFile(path.join(projectRoot, 'infra', 'container-security-policy.json'), 'utf8'))
  const distributionOccurrences = []
  const installerRoot = path.join(projectRoot, 'release', 'installer-payload')
  for (const file of await allFiles(installerRoot)) {
    for (const image of collectPinnedImages((await readFile(file)).toString('utf8'))) {
      distributionOccurrences.push({
        image,
        sourceFile: path.relative(projectRoot, file).replaceAll('\\', '/'),
        sourceKind: 'installer-payload',
      })
    }
  }
  const tauriRoot = path.join(projectRoot, 'src-tauri')
  for (const entry of await readdir(tauriRoot, { withFileTypes: true })) {
    if (!entry.isFile() || !/^tauri.*\.conf\.json$/i.test(entry.name)) continue
    const configFile = path.join(tauriRoot, entry.name)
    const config = JSON.parse(await readFile(configFile, 'utf8'))
    for (const resource of config.bundle?.resources ?? []) {
      if (typeof resource !== 'string') continue
      for (const image of collectPinnedImages(resource)) {
        distributionOccurrences.push({ image, sourceFile: path.relative(projectRoot, configFile).replaceAll('\\', '/'), sourceKind: 'tauri-bundle-resource' })
      }
      const resourcePath = path.resolve(tauriRoot, resource)
      for (const file of await allFiles(resourcePath)) {
        for (const image of collectPinnedImages((await readFile(file)).toString('utf8'))) {
          distributionOccurrences.push({
            image,
            sourceFile: path.relative(projectRoot, file).replaceAll('\\', '/'),
            sourceKind: 'tauri-bundle-resource',
          })
        }
      }
    }
  }
  const gitRoot = path.resolve(projectRoot, '..')
  const workflowText = await readFile(path.join(gitRoot, '.github', 'workflows', 'security.yml'), 'utf8')
  const candidateWorkflowText = await readFile(path.join(gitRoot, '.github', 'workflows', 'release-beta.yml'), 'utf8')
  const r3WorkflowText = await readFile(path.join(gitRoot, '.github', 'workflows', 'security-r3-voice.yml'), 'utf8')
  const errors = validateContainerPolicy({ occurrences, policy, distributionOccurrences, workflowText, candidateWorkflowText, r3WorkflowText })
  if (errors.length) throw new Error(errors.join('; '))
  return {
    schemaVersion: policy.schemaVersion,
    images: policy.images.map(({ name, milestone, derivedScope, image }) => ({ name, milestone, derivedScope, image })),
    occurrences,
    distributionOccurrences,
    policy: policy.scannerPolicy,
    sbomPolicy: policy.sbomPolicy,
    signatureDiscoveryPolicy: policy.signatureDiscoveryPolicy,
  }
}

async function main() {
  const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const inventory = await inspectContainerSupplyChain(projectRoot)
  const outputIndex = process.argv.indexOf('--output')
  if (outputIndex >= 0) {
    const output = path.resolve(projectRoot, process.argv[outputIndex + 1])
    await mkdir(path.dirname(output), { recursive: true })
    await writeFile(output, `${JSON.stringify(inventory, null, 2)}\n`, 'utf8')
  }
  console.log(`Container supply-chain policy passed (${inventory.images.length} exact images across R2 and R3).`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main()
