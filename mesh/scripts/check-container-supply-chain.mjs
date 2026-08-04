import { readFile, readdir, writeFile, mkdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const PINNED_IMAGE = /^[A-Za-z0-9./_-]+:[A-Za-z0-9._-]+@sha256:[0-9a-f]{64}$/
const SHA256 = /^[0-9a-f]{64}$/

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

export function validateContainerPolicy({ occurrences, policy, workflowText = '', now = new Date() }) {
  const errors = []
  const images = [...new Set(occurrences.map((entry) => entry.image))].sort()
  for (const image of images) if (!PINNED_IMAGE.test(image)) errors.push(`container image is not exact tag+digest: ${image}`)
  const policyImages = new Set((policy.images ?? []).map((entry) => entry.image))
  for (const image of images) if (!policyImages.has(image)) errors.push(`container image is missing from security policy: ${image}`)
  for (const image of policyImages) if (!images.includes(image)) errors.push(`container security policy contains stale image: ${image}`)
  if (policy.scannerPolicy?.candidateOutage !== 'fail-closed') errors.push('candidate scanner outage policy must fail closed')
  if (policy.scannerPolicy?.developmentOutage !== 'blocked-unavailable') errors.push('development scanner outage must report a named unavailable gate')
  if (policy.scannerPolicy?.severityCutoff !== 'high' || policy.scannerPolicy?.onlyFixable !== true) errors.push('scanner must fail fixable high/critical findings')
  const requiredRegressions = new Set(policy.requiredUpdateRegressions ?? [])
  for (const required of ['disposable-federation', 'backup', 'restore', 'health', 'cleanup']) {
    if (!requiredRegressions.has(required)) errors.push(`container updates are missing ${required} regression coverage`)
  }
  for (const exception of policy.exceptions ?? []) {
    if (!SHA256.test(exception.digest ?? '') || !exception.vulnerabilityId || !exception.reason || !exception.reviewer) errors.push('container exception must bind exact digest, vulnerability, reason, and reviewer')
    if (!Number.isFinite(Date.parse(exception.expiresAt ?? '')) || Date.parse(exception.expiresAt) <= now.getTime()) errors.push(`container exception is expired or invalid for ${exception.vulnerabilityId ?? 'unknown finding'}`)
  }
  if (workflowText) {
    for (const image of images) if (!workflowText.includes(image)) errors.push(`security workflow does not scan ${image}`)
    if (!/anchore\/sbom-action@[0-9a-f]{40}/.test(workflowText)) errors.push('container SBOM action is not SHA pinned')
    if (!/anchore\/scan-action@[0-9a-f]{40}/.test(workflowText)) errors.push('container scanner action is not SHA pinned')
    if (!/severity-cutoff:\s*high/.test(workflowText) || !/only-fixed:\s*true/.test(workflowText)) errors.push('container workflow does not fail fixable high findings')
    if (!/if-no-files-found:\s*error/.test(workflowText)) errors.push('container evidence upload must fail when evidence is absent')
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
  const errors = validateContainerPolicy({ occurrences, policy, workflowText })
  if (errors.length) throw new Error(errors.join('; '))
  return { schemaVersion: 1, images: [...new Set(occurrences.map((entry) => entry.image))].sort(), occurrences, policy: policy.scannerPolicy }
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
  console.log(`Container supply-chain policy passed (${inventory.images.length} exact images).`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main()
