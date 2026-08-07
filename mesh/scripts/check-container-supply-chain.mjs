import { readFile, readdir, writeFile, mkdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const PINNED_IMAGE = /^[A-Za-z0-9./_-]+:[A-Za-z0-9._-]+@sha256:[0-9a-f]{64}$/
const SHA256 = /^[0-9a-f]{64}$/
const TOOL_VERSION = /^v[0-9]+\.[0-9]+\.[0-9]+$/
const RELEASE_MILESTONES = new Set(['R2', 'R3'])

async function composeFiles(root) {
  const result = []
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const candidate = path.join(root, entry.name)
    if (entry.isDirectory()) result.push(...await composeFiles(candidate))
    else if (/^(?:docker-)?compose.*\.ya?ml$/i.test(entry.name)) result.push(candidate)
  }
  return result
}

export function collectComposeImages(source) {
  return [...source.matchAll(/^\s*image:\s*([^\s#]+)\s*$/gm)].map((match) => match[1])
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

function validateScanJob(jobText, { label, outputFile, grypeVersion }) {
  const errors = []
  if (!jobText) return [`${label} job is missing`]
  if (!/anchore\/sbom-action@[0-9a-f]{40}/.test(jobText)) errors.push(`${label} SBOM action is not SHA pinned`)
  if (!/anchore\/scan-action@[0-9a-f]{40}/.test(jobText)) errors.push(`${label} scanner action is not SHA pinned`)
  if (!jobText.includes(`grype-version: ${grypeVersion}`)) errors.push(`${label} must use policy Grype ${grypeVersion}`)
  if (!/severity-cutoff:\s*high/.test(jobText) || !/only-fixed:\s*true/.test(jobText)) errors.push(`${label} does not fail fixable high findings`)
  if (!/if-no-files-found:\s*error/.test(jobText)) errors.push(`${label} evidence upload must fail when evidence is absent`)
  if (!preservesFailedScanEvidence(jobText, outputFile)) errors.push(`${label} must retain scanner JSON when a fixable-high scan fails`)
  return errors
}

export function validateContainerPolicy({
  occurrences,
  policy,
  workflowText = '',
  candidateWorkflowText = '',
  r3WorkflowText = '',
  now = new Date(),
}) {
  const errors = []
  const images = [...new Set(occurrences.map((entry) => entry.image))].sort()
  for (const image of images) if (!PINNED_IMAGE.test(image)) errors.push(`container image is not exact tag+digest: ${image}`)

  if (policy.schemaVersion !== 2) errors.push('container security policy schemaVersion must be 2')
  const policyEntries = policy.images ?? []
  const policyImages = new Set()
  const policyNames = new Set()
  for (const entry of policyEntries) {
    if (!entry.name || typeof entry.name !== 'string') errors.push('container policy image requires a stable name')
    else if (policyNames.has(entry.name)) errors.push(`container policy contains duplicate name: ${entry.name}`)
    else policyNames.add(entry.name)
    if (!PINNED_IMAGE.test(entry.image ?? '')) errors.push(`container policy image is not exact tag+digest: ${entry.image ?? 'missing'}`)
    if (policyImages.has(entry.image)) errors.push(`container policy contains duplicate image: ${entry.image}`)
    else policyImages.add(entry.image)
    if (!RELEASE_MILESTONES.has(entry.milestone)) errors.push(`container policy image ${entry.name ?? entry.image ?? 'unknown'} requires milestone R2 or R3`)
  }
  for (const image of images) if (!policyImages.has(image)) errors.push(`container image is missing from security policy: ${image}`)
  for (const image of policyImages) if (!images.includes(image)) errors.push(`container security policy contains stale image: ${image}`)

  if (policy.scannerPolicy?.candidateOutage !== 'fail-closed') errors.push('candidate scanner outage policy must fail closed')
  if (policy.scannerPolicy?.developmentOutage !== 'blocked-unavailable') errors.push('development scanner outage must report a named unavailable gate')
  if (!TOOL_VERSION.test(policy.scannerPolicy?.grypeVersion ?? '')) errors.push('scanner policy must pin an exact Grype version')
  if (policy.scannerPolicy?.severityCutoff !== 'high' || policy.scannerPolicy?.onlyFixable !== true) errors.push('scanner must fail fixable high/critical findings')
  const requiredRegressions = new Set(policy.requiredUpdateRegressions ?? [])
  for (const required of ['disposable-federation', 'backup', 'restore', 'health', 'cleanup']) {
    if (!requiredRegressions.has(required)) errors.push(`container updates are missing ${required} regression coverage`)
  }
  for (const exception of policy.exceptions ?? []) {
    if (!SHA256.test(exception.digest ?? '') || !exception.vulnerabilityId || !exception.reason || !exception.reviewer) errors.push('container exception must bind exact digest, vulnerability, reason, and reviewer')
    if (!Number.isFinite(Date.parse(exception.expiresAt ?? '')) || Date.parse(exception.expiresAt) <= now.getTime()) errors.push(`container exception is expired or invalid for ${exception.vulnerabilityId ?? 'unknown finding'}`)
  }

  const r2Images = policyEntries.filter((entry) => entry.milestone === 'R2')
  const r3Images = policyEntries.filter((entry) => entry.milestone === 'R3')
  if (workflowText) {
    const sbomJob = workflowJob(workflowText, 'sbom')
    if (!/npm run build:matrix-voice\s*\r?\n\s*npm run (?:check|generate):release-sboms/.test(sbomJob)) {
      errors.push('protected SBOM job must build the Matrix voice artifact immediately before generating release SBOMs')
    }
    const r2Job = workflowJob(workflowText, 'container-supply-chain-r2')
    errors.push(...validateExactMatrix(collectWorkflowMatrixEntries(r2Job), r2Images, 'protected R2 container job'))
    errors.push(...validateScanJob(r2Job, { label: 'protected R2 container job', outputFile: 'r2-container-${{ matrix.name }}-grype.json', grypeVersion: policy.scannerPolicy?.grypeVersion }))

    const protectedJob = workflowJob(workflowText, 'protected-evidence')
    if (!/needs:\s*\[[^\]]*container-supply-chain-r2[^\]]*\]/.test(protectedJob) || /container-supply-chain-r3/.test(protectedJob)) {
      errors.push('protected security evidence must depend on R2 containers and not R3 voice')
    }
    if (!/R2_CONTAINERS:\s*\$\{\{ needs\.container-supply-chain-r2\.result \}\}/.test(protectedJob)) {
      errors.push('protected security evidence must record the explicit R2 container result')
    }
  }

  if (candidateWorkflowText) {
    const r2Job = workflowJob(candidateWorkflowText, 'container-supply-chain-r2')
    errors.push(...validateExactMatrix(collectWorkflowMatrixEntries(r2Job), r2Images, 'candidate R2 container job'))
    errors.push(...validateScanJob(r2Job, { label: 'candidate R2 container job', outputFile: 'candidate-${{ matrix.name }}-grype.json', grypeVersion: policy.scannerPolicy?.grypeVersion }))
    const r3Job = workflowJob(candidateWorkflowText, 'container-supply-chain-r3')
    errors.push(...validateExactMatrix(collectWorkflowMatrixEntries(r3Job), r3Images, 'candidate voice container job'))
    errors.push(...validateScanJob(r3Job, { label: 'candidate voice container job', outputFile: 'candidate-voice-${{ matrix.name }}-grype.json', grypeVersion: policy.scannerPolicy?.grypeVersion }))
    const windowsJob = workflowJob(candidateWorkflowText, 'windows')
    if (!/needs:\s*\[[^\]]*container-supply-chain-r2[^\]]*container-supply-chain-r3[^\]]*\]/.test(windowsJob)) {
      errors.push('Windows beta candidate must depend on both R2 and voice container scans')
    }
    if (!/matrixrtc-preflight\.ps1/i.test(candidateWorkflowText)
      || !/test-evidence-validation\.ps1/i.test(candidateWorkflowText)
      || !/operator-smoke\.ps1\s+-Milestone\s+R3/i.test(candidateWorkflowText)) {
      errors.push('beta candidate workflow must retain MatrixRTC, evidence, and R3 operator voice gates')
    }
  }

  if (r3WorkflowText) {
    const r3Job = workflowJob(r3WorkflowText, 'container-supply-chain-r3')
    errors.push(...validateExactMatrix(collectWorkflowMatrixEntries(r3Job), r3Images, 'R3 voice container job'))
    errors.push(...validateScanJob(r3Job, { label: 'R3 voice container job', outputFile: 'r3-container-${{ matrix.name }}-grype.json', grypeVersion: policy.scannerPolicy?.grypeVersion }))
    if (!/test-evidence-validation\.ps1/.test(r3WorkflowText) || !/matrixrtc-preflight\.ps1/.test(r3WorkflowText) || !/operator-smoke\.ps1\s+-Milestone\s+R3/.test(r3WorkflowText)) {
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
  const gitRoot = path.resolve(projectRoot, '..')
  const workflowText = await readFile(path.join(gitRoot, '.github', 'workflows', 'security.yml'), 'utf8')
  const candidateWorkflowText = await readFile(path.join(gitRoot, '.github', 'workflows', 'release-beta.yml'), 'utf8')
  const r3WorkflowText = await readFile(path.join(gitRoot, '.github', 'workflows', 'security-r3-voice.yml'), 'utf8')
  const errors = validateContainerPolicy({ occurrences, policy, workflowText, candidateWorkflowText, r3WorkflowText })
  if (errors.length) throw new Error(errors.join('; '))
  return {
    schemaVersion: 2,
    images: policy.images.map(({ name, milestone, image }) => ({ name, milestone, image })),
    occurrences,
    policy: policy.scannerPolicy,
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
