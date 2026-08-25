import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SHA256 = /^[0-9a-f]{64}$/
const PINNED_IMAGE = /^[A-Za-z0-9./_-]+:[A-Za-z0-9._-]+@sha256:([0-9a-f]{64})$/
const DATABASE_SCHEMA = /^v[0-9]+\.[0-9]+\.[0-9]+$/
const UUID_URN = /^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function validTimestamp(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value))
}

function databaseChecksum(source) {
  try {
    const checksum = new URL(source).searchParams.get('checksum') ?? ''
    const match = /^sha256:([0-9a-f]{64})$/i.exec(checksum)
    return match?.[1]?.toLowerCase() ?? ''
  } catch {
    return ''
  }
}

function imageIdentity(image) {
  const tagAndName = image?.split('@sha256:')[0] ?? ''
  const tagSeparator = tagAndName.lastIndexOf(':')
  const repository = tagSeparator < 0 ? '' : tagAndName.slice(0, tagSeparator)
  return {
    name: repository,
    version: tagSeparator < 0 ? '' : tagAndName.slice(tagSeparator + 1),
  }
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

export function validateContainerScanEvidence({ policy, scan, expectedImage, expectedScope }) {
  const errors = []
  const imageMatch = PINNED_IMAGE.exec(expectedImage ?? '')
  const scannerPolicy = policy.scannerPolicy ?? {}
  const descriptor = scan?.descriptor ?? {}
  const configuration = descriptor.configuration ?? {}
  const databaseConfiguration = configuration.db ?? {}
  const databaseStatus = descriptor.db?.status ?? {}
  const matches = scan?.matches
  const scannedAt = descriptor.timestamp
  const databaseBuilt = databaseStatus.built
  const databaseSource = databaseStatus.from
  const checksumSha256 = databaseChecksum(databaseSource)
  const expectedMaxAgeNanoseconds = scannerPolicy.database?.maxAgeHours * 60 * 60 * 1_000_000_000
  const policyEntry = (policy.images ?? []).find((entry) => entry.image === expectedImage)
  const recordedScope = policyEntry?.derivedScope
  const releaseScoped = recordedScope !== 'reference'

  if (!imageMatch) errors.push('container scan expected image must use an exact tag and digest')
  if (policy.schemaVersion !== 6) errors.push('container evidence policy schemaVersion must be 6')
  if (!policyEntry) errors.push('container scan expected image must exist in the security policy')
  if (!['release', 'reference'].includes(recordedScope)) errors.push('container scan image must have a recorded derived scope')
  if (expectedScope && expectedScope !== recordedScope) {
    errors.push(`container scan scope ${expectedScope} does not match policy scope ${recordedScope ?? 'missing'}`)
  }
  if (expectedImage?.startsWith('ghcr.io/dhawal-ss/') && recordedScope !== 'release') {
    errors.push('Mesh-published container scan images must remain release scoped')
  }
  if (descriptor.name !== 'grype' || descriptor.version !== scannerPolicy.grypeVersion?.replace(/^v/, '')) {
    errors.push('container scan must use the policy-pinned Grype version')
  }
  if (scan?.source?.type !== 'image' || scan?.source?.target?.userInput !== expectedImage) {
    errors.push('container scan source must bind the requested exact image')
  }
  if (imageMatch && !(scan?.source?.target?.repoDigests ?? []).some((entry) => entry.endsWith(`@sha256:${imageMatch[1]}`))) {
    errors.push('container scan repository digest must bind the requested digest')
  }
  if (configuration['only-fixed'] !== scannerPolicy.onlyFixable
    || configuration['fail-on-severity'] !== scannerPolicy.severityCutoff) {
    errors.push('container scan configuration must match the fixability and severity policy')
  }
  if (!Array.isArray(matches)) {
    errors.push('container scan must contain a findings array')
  } else {
    if (matches.some((entry) => entry?.vulnerability?.fix?.state !== 'fixed')) {
      errors.push('container scan configured for only-fixed must not contain an unfixed finding')
    }
    if (releaseScoped && matches.some((entry) => ['High', 'Critical'].includes(entry?.vulnerability?.severity))) {
      errors.push('container scan must contain zero fixable high or critical findings')
    }
  }

  if (databaseConfiguration['update-url']?.replace(/\/$/, '') !== scannerPolicy.database?.sourceOrigin?.replace(/\/$/, '')) {
    errors.push('container scanner database update URL must use the policy-approved origin')
  }
  if (scannerPolicy.database?.requireHashValidation === true
    && databaseConfiguration['validate-by-hash-on-start'] !== true) {
    errors.push('container scanner database must validate its hash on startup')
  }
  if (databaseConfiguration['validate-age'] !== true
    || databaseConfiguration['max-allowed-built-age'] !== expectedMaxAgeNanoseconds) {
    errors.push('container scanner database age validation must match policy')
  }
  if (!DATABASE_SCHEMA.test(databaseStatus.schemaVersion ?? '')) {
    errors.push('container scanner database schema version must be exact')
  }
  if (typeof databaseSource !== 'string' || !databaseSource.startsWith(scannerPolicy.database?.sourceOrigin ?? '')) {
    errors.push('container scanner database source must use the policy-approved origin')
  }
  if (!SHA256.test(checksumSha256)) errors.push('container scanner database source must contain an exact SHA-256')
  if (scannerPolicy.database?.requireValid === true && databaseStatus.valid !== true) {
    errors.push('container scanner database status must be valid')
  }
  if (!validTimestamp(scannedAt) || !validTimestamp(databaseBuilt)) {
    errors.push('container scan and database timestamps must be valid')
  } else {
    const ageMilliseconds = Date.parse(scannedAt) - Date.parse(databaseBuilt)
    if (ageMilliseconds < 0 || ageMilliseconds > scannerPolicy.database.maxAgeHours * 60 * 60 * 1000) {
      errors.push('container scanner database must not be future-dated or stale when scanned')
    }
  }

  return errors
}

export function validateContainerSbomEvidence({ policy, sbom, scan, expectedImage }) {
  const errors = []
  const sbomPolicy = policy.sbomPolicy ?? {}
  const identity = imageIdentity(expectedImage)
  const metadata = sbom?.metadata ?? {}
  const root = metadata.component ?? {}
  const components = sbom?.components
  const dependencies = sbom?.dependencies
  const toolComponents = metadata.tools?.components
  const expectedSyftVersion = sbomPolicy.syftVersion?.replace(/^v/, '')

  if (!PINNED_IMAGE.test(expectedImage ?? '')) errors.push('container SBOM expected image must use an exact tag and digest')
  if (policy.schemaVersion !== 6) errors.push('container evidence policy schemaVersion must be 6')
  if (sbom?.bomFormat !== sbomPolicy.format
    || sbom?.specVersion !== sbomPolicy.specVersion
    || sbom?.version !== 1
    || !UUID_URN.test(sbom?.serialNumber ?? '')) {
    errors.push('container SBOM must be a versioned CycloneDX document with a UUID serial number')
  }
  if (!Array.isArray(toolComponents)
    || !toolComponents.some((tool) => tool?.author === 'anchore'
      && tool?.name === 'syft'
      && tool?.version === expectedSyftVersion)) {
    errors.push('container SBOM must use the policy-pinned Syft version')
  }
  if (root.type !== 'container' || root.name !== identity.name || root.version !== identity.version) {
    errors.push('container SBOM root component must match the requested image name and tag')
  }
  if (typeof root['bom-ref'] !== 'string' || root['bom-ref'].length === 0) {
    errors.push('container SBOM root component must have a stable bom-ref')
  }

  if (!Array.isArray(components) || components.length < (sbomPolicy.minimumComponents ?? 1)) {
    errors.push('container SBOM must contain a nonempty component graph')
  } else {
    const componentRefs = components.map((component) => component?.['bom-ref'])
    if (components.some((component) => typeof component?.['bom-ref'] !== 'string'
      || component['bom-ref'].length === 0
      || typeof component?.name !== 'string'
      || component.name.length === 0
      || typeof component?.type !== 'string'
      || component.type.length === 0)) {
      errors.push('container SBOM components must have bom-ref, name, and type values')
    }
    if (new Set([root['bom-ref'], ...componentRefs]).size !== componentRefs.length + 1) {
      errors.push('container SBOM bom-ref values must be unique')
    }

    if (!Array.isArray(dependencies)) {
      errors.push('container SBOM must contain a dependency graph')
    } else {
      const knownRefs = new Set([root['bom-ref'], ...componentRefs])
      const dependencyRefs = dependencies.map((dependency) => dependency?.ref)
      if (new Set(dependencyRefs).size !== dependencyRefs.length) {
        errors.push('container SBOM dependency refs must be unique')
      }
      if (dependencies.some((dependency) => !knownRefs.has(dependency?.ref)
        || !Array.isArray(dependency?.dependsOn)
        || dependency.dependsOn.some((reference) => !knownRefs.has(reference)))) {
        errors.push('container SBOM dependencies must reference known components')
      }
    }
  }

  const sbomTimestamp = metadata.timestamp
  const scanTimestamp = scan?.descriptor?.timestamp
  if (!validTimestamp(sbomTimestamp) || !validTimestamp(scanTimestamp)) {
    errors.push('container SBOM and scan timestamps must be valid')
  } else {
    const skewMilliseconds = Math.abs(Date.parse(scanTimestamp) - Date.parse(sbomTimestamp))
    if (skewMilliseconds > (sbomPolicy.maxScanSkewMinutes ?? 0) * 60 * 1000) {
      errors.push('container SBOM and exact-image scan must be generated in the same bounded evidence run')
    }
  }

  return errors
}

export function validateContainerArtifactEvidence({ policy, sbom, scan, expectedImage, expectedScope }) {
  return [
    ...validateContainerScanEvidence({ policy, scan, expectedImage, expectedScope }),
    ...validateContainerSbomEvidence({ policy, sbom, scan, expectedImage }),
  ]
}

function parseJson(buffer) {
  return JSON.parse(buffer.toString('utf8').replace(/^\uFEFF/, ''))
}

export async function inspectContainerArtifactEvidence(projectRoot, {
  scanFile,
  sbomFile,
  expectedImage,
  expectedScope,
}) {
  const policy = parseJson(await readFile(path.join(projectRoot, 'infra', 'container-security-policy.json')))
  const scanBuffer = await readFile(path.resolve(scanFile))
  const sbomBuffer = await readFile(path.resolve(sbomFile))
  const scan = parseJson(scanBuffer)
  const sbom = parseJson(sbomBuffer)
  const errors = validateContainerArtifactEvidence({ policy, sbom, scan, expectedImage, expectedScope })
  if (errors.length) throw new Error(errors.join('; '))
  const policyEntry = policy.images.find((entry) => entry.image === expectedImage)
  const fixedHighOrCriticalFindings = scan.matches.filter(
    (entry) => ['High', 'Critical'].includes(entry?.vulnerability?.severity),
  ).length
  return {
    schemaVersion: 1,
    status: 'pass',
    image: expectedImage,
    accountabilityScope: policyEntry.derivedScope,
    sbom: {
      sha256: sha256(sbomBuffer),
      format: sbom.bomFormat,
      specVersion: sbom.specVersion,
      syftVersion: policy.sbomPolicy.syftVersion,
      generatedAt: sbom.metadata.timestamp,
      componentCount: sbom.components.length,
    },
    scan: {
      sha256: sha256(scanBuffer),
      grypeVersion: policy.scannerPolicy.grypeVersion,
      scannedAt: scan.descriptor.timestamp,
      databaseSchema: scan.descriptor.db.status.schemaVersion,
      fixedHighOrCriticalFindings,
    },
  }
}

async function main() {
  const scanIndex = process.argv.indexOf('--scan')
  const sbomIndex = process.argv.indexOf('--sbom')
  const imageIndex = process.argv.indexOf('--image')
  const scopeIndex = process.argv.indexOf('--scope')
  const outputIndex = process.argv.indexOf('--output')
  if (scanIndex < 0 || !process.argv[scanIndex + 1]
    || sbomIndex < 0 || !process.argv[sbomIndex + 1]
    || imageIndex < 0 || !process.argv[imageIndex + 1]
    || outputIndex < 0 || !process.argv[outputIndex + 1]) {
    throw new Error('Usage: node check-container-scan-evidence.mjs --sbom <cyclonedx.json> --scan <grype.json> --image <exact-tag-and-digest> --output <evidence.json>')
  }
  const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const result = await inspectContainerArtifactEvidence(projectRoot, {
    scanFile: process.argv[scanIndex + 1],
    sbomFile: process.argv[sbomIndex + 1],
    expectedImage: process.argv[imageIndex + 1],
    expectedScope: scopeIndex < 0 ? undefined : process.argv[scopeIndex + 1],
  })
  await writeFile(path.resolve(process.argv[outputIndex + 1]), `${JSON.stringify(result, null, 2)}\n`, 'utf8')
  console.log(`Paired container evidence passed (${result.image}, ${result.accountabilityScope} scope, ${result.sbom.componentCount} components, ${result.scan.databaseSchema}, ${result.scan.fixedHighOrCriticalFindings} recorded fixable high or critical findings).`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main()
