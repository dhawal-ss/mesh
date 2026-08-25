import { createHash } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SHA256 = /^[0-9a-f]{64}$/
const IMAGE_ID = /^sha256:[0-9a-f]{64}$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const DATABASE_SCHEMA = /^v[0-9]+\.[0-9]+\.[0-9]+$/
const BLOCKED_SIGNATURE = 'blocked-until-protected-registry-push'

function equalJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right)
}

function validTimestamp(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value))
}

function findDescriptor(entries, name) {
  return (entries ?? []).find((entry) => entry?.name === name)
}

function expectedBuilder(prototype) {
  const [uri, digest] = prototype.builderImage.split('@sha256:')
  return { uri: `docker://${uri}`, digest }
}

function inspectScannerEvidence(scan, policy, generatedAt, expectedImageId, prefix, errors, { allowFixableFindings = false } = {}) {
  const descriptor = scan?.descriptor ?? {}
  const configuration = descriptor.configuration ?? {}
  const databaseConfiguration = configuration.db ?? {}
  const databaseStatus = descriptor.db?.status ?? {}
  const scannedAt = descriptor.timestamp
  const built = databaseStatus.built
  const source = databaseStatus.from
  const matches = Array.isArray(scan?.matches) ? scan.matches : []
  const expectedGrypeVersion = policy.scannerPolicy?.grypeVersion?.replace(/^v/, '')
  const maxAgeHours = policy.scannerPolicy?.database?.maxAgeHours
  const expectedMaxAgeNanoseconds = maxAgeHours * 60 * 60 * 1_000_000_000
  let checksumSha256 = ''

  try {
    const checksum = new URL(source).searchParams.get('checksum') ?? ''
    const match = /^sha256:([0-9a-f]{64})$/i.exec(checksum)
    if (match) checksumSha256 = match[1].toLowerCase()
  } catch {
    // The exact source and checksum errors below describe malformed URLs.
  }

  if (descriptor.version !== expectedGrypeVersion) errors.push(`${prefix} scan must use the policy-pinned Grype version`)
  if (scan?.source?.type !== 'image' || scan?.source?.target?.userInput !== expectedImageId) {
    errors.push(`${prefix} scan source must bind the exact local image digest`)
  }
  if (configuration['only-fixed'] !== policy.scannerPolicy?.onlyFixable
    || configuration['fail-on-severity'] !== policy.scannerPolicy?.severityCutoff) {
    errors.push(`${prefix} scan configuration must enforce the policy severity and fixability boundary`)
  }
  if (databaseConfiguration['update-url']?.replace(/\/$/, '') !== policy.scannerPolicy?.database?.sourceOrigin?.replace(/\/$/, '')) {
    errors.push(`${prefix} scanner database update URL must use the policy-approved origin`)
  }
  if (policy.scannerPolicy?.database?.requireHashValidation === true
    && databaseConfiguration['validate-by-hash-on-start'] !== true) {
    errors.push(`${prefix} scanner database must validate its hash on startup`)
  }
  if (databaseConfiguration['validate-age'] !== true
    || databaseConfiguration['max-allowed-built-age'] !== expectedMaxAgeNanoseconds) {
    errors.push(`${prefix} scanner database age validation must match policy`)
  }
  if (!DATABASE_SCHEMA.test(databaseStatus.schemaVersion ?? '')) errors.push(`${prefix} scanner database schema version must be exact`)
  if (typeof source !== 'string' || !source.startsWith(policy.scannerPolicy?.database?.sourceOrigin ?? '')) {
    errors.push(`${prefix} scanner database source must use the policy-approved origin`)
  }
  if (!SHA256.test(checksumSha256)) errors.push(`${prefix} scanner database source must contain an exact SHA-256`)
  if (policy.scannerPolicy?.database?.requireValid === true && databaseStatus.valid !== true) {
    errors.push(`${prefix} scanner database status must be valid`)
  }
  if (!validTimestamp(scannedAt) || !validTimestamp(built)) {
    errors.push(`${prefix} scanner and database timestamps must be valid`)
  } else {
    const ageMilliseconds = Date.parse(scannedAt) - Date.parse(built)
    if (ageMilliseconds < 0 || ageMilliseconds > maxAgeHours * 60 * 60 * 1000) {
      errors.push(`${prefix} scanner database must not be future-dated or stale when scanned`)
    }
    if (validTimestamp(generatedAt) && Date.parse(scannedAt) > Date.parse(generatedAt)) {
      errors.push(`${prefix} scan timestamp must not follow the evidence summary`)
    }
  }
  if (!allowFixableFindings && policy.scannerPolicy?.requireZeroFixableFindings === true && matches.length !== 0) {
    errors.push(`${prefix} scan must contain zero fixable findings at every severity`)
  }

  return {
    fixedFindings: matches.length,
    fixedHighOrCriticalFindings: matches.filter((entry) => ['High', 'Critical'].includes(entry?.vulnerability?.severity)).length,
    scannedAt,
    database: {
      schemaVersion: databaseStatus.schemaVersion,
      built,
      source,
      checksumSha256,
      valid: databaseStatus.valid,
    },
  }
}

export function validateLocalPrototypeEvidence({
  policy,
  policySha256,
  buildScriptSha256,
  summary,
  artifactsByName = new Map(),
  blockedArtifactsByName = new Map(),
  contextFilesByName = new Map(),
}) {
  const errors = []
  const buildable = (policy.prototypes ?? []).filter((entry) => entry.status === 'buildable-local')
  const blocked = (policy.prototypes ?? []).filter((entry) => entry.status === 'blocked-upstream')
  const results = summary.results ?? []
  const resultNames = results.map((entry) => entry?.name)

  if (summary.schemaVersion !== 3) errors.push('prototype evidence summary schemaVersion must be 3')
  if (summary.mode !== 'local-only') errors.push('prototype evidence summary must remain local-only')
  if (summary.syftVersion !== policy.scannerPolicy?.syftVersion) errors.push('prototype evidence Syft version must match policy')
  if (summary.grypeVersion !== policy.scannerPolicy?.grypeVersion) errors.push('prototype evidence Grype version must match policy')
  if (summary.policySha256 !== policySha256) errors.push('prototype evidence summary must bind the exact policy')
  if (summary.buildScriptSha256 !== buildScriptSha256) errors.push('prototype evidence summary must bind the exact build script')
  if (!validTimestamp(summary.generatedAt)) errors.push('prototype evidence generatedAt must be a valid timestamp')
  if (new Set(resultNames).size !== resultNames.length) errors.push('prototype evidence result names must be unique')
  if (!equalJson([...resultNames].sort(), buildable.map((entry) => entry.name).sort())) {
    errors.push('prototype evidence results must exactly match buildable local prototypes')
  }

  const actualBlocked = (summary.blocked ?? []).map((entry) => entry?.name).sort()
  if (!equalJson(actualBlocked, blocked.map((entry) => entry.name).sort())) {
    errors.push('prototype evidence blocked results must exactly match upstream-blocked prototypes')
  }
  for (const prototype of blocked) {
    const evidence = (summary.blocked ?? []).find((entry) => entry?.name === prototype.name)
    if (evidence?.reason !== prototype.blockReason) {
      errors.push(`${prototype.name} blocked evidence must preserve the policy reason`)
    }
    const expectedScans = prototype.diagnosticScans ?? []
    const actualScans = evidence?.scans ?? []
    const actualScanNames = actualScans.map((entry) => entry?.name)
    if (new Set(actualScanNames).size !== actualScanNames.length
      || !equalJson([...actualScanNames].sort(), expectedScans.map((entry) => entry.name).sort())) {
      errors.push(`${prototype.name} blocked evidence must exactly reproduce every diagnostic scan`)
    }
    const artifactScans = blockedArtifactsByName.get(prototype.name)
    for (const expectedScan of expectedScans) {
      const prefix = `${prototype.name} ${expectedScan.name}`
      const actualScan = actualScans.find((entry) => entry?.name === expectedScan.name)
      const artifact = artifactScans?.get(expectedScan.name)
      if (!actualScan) continue
      if (actualScan.image !== expectedScan.image
        || actualScan.fixedFindings !== expectedScan.fixedFindings
        || actualScan.fixedHighOrCriticalFindings !== expectedScan.fixedHighOrCriticalFindings
        || actualScan.blockedAsExpected !== true
        || !SHA256.test(actualScan.sha256 ?? '')) {
        errors.push(`${prefix} blocked summary must preserve the exact image and expected finding counts`)
      }
      if (!artifact) {
        errors.push(`${prefix} blocked scan artifact is missing`)
        continue
      }
      if (artifact.sha256 !== actualScan.sha256) errors.push(`${prefix} blocked scan hash does not match summary`)
      const scannerEvidence = inspectScannerEvidence(
        artifact.scan,
        policy,
        summary.generatedAt,
        expectedScan.image,
        prefix,
        errors,
        { allowFixableFindings: true },
      )
      if (scannerEvidence.fixedFindings !== expectedScan.fixedFindings
        || scannerEvidence.fixedHighOrCriticalFindings !== expectedScan.fixedHighOrCriticalFindings) {
        errors.push(`${prefix} blocked scan findings must exactly match policy`)
      }
      if (scannerEvidence.scannedAt !== actualScan.scannedAt
        || !equalJson(scannerEvidence.database, actualScan.database)) {
        errors.push(`${prefix} blocked scanner database evidence must match the canonical summary`)
      }
    }
  }

  for (const prototype of buildable) {
    const prefix = prototype.name
    const result = results.find((entry) => entry?.name === prototype.name)
    const artifacts = artifactsByName.get(prototype.name)
    if (!result) continue

    if (result.localTag !== prototype.localTag) errors.push(`${prefix} evidence local tag must match policy`)
    if (!IMAGE_ID.test(result.localImageId ?? '')) errors.push(`${prefix} evidence image ID must be an exact sha256 digest`)
    if (result.sourceCommit !== prototype.source?.commit) errors.push(`${prefix} evidence source commit must match policy`)
    if (result.signing !== BLOCKED_SIGNATURE) errors.push(`${prefix} signing must remain blocked`)
    if (result.runtimeVerified !== true || !equalJson(result.runtime, prototype.runtime)) {
      errors.push(`${prefix} evidence runtime must match the verified non-root policy`)
    }
    if (result.containmentVerified !== true) errors.push(`${prefix} evidence must prove the reviewed runtime containment smoke check`)
    if (result.payload?.verified !== true
      || result.payload?.forbiddenPathsPresent !== 0
      || !SHA256.test(result.payload?.sha256 ?? '')) {
      errors.push(`${prefix} evidence must prove a reviewed runtime payload with no forbidden paths`)
    }
    if (result.reproducibility?.repeatedBuild !== true || result.reproducibility?.imageIdStable !== true) {
      errors.push(`${prefix} evidence must prove a stable repeated local image ID`)
    }
    if (result.scan?.passed !== true || result.scan?.fixedFindings !== 0 || !validTimestamp(result.scan?.scannedAt)) {
      errors.push(`${prefix} evidence must pass with zero fixable findings at every severity`)
    }
    if (!SHA256.test(result.sbom?.sha256 ?? '') || !SHA256.test(result.scan?.sha256 ?? '')) {
      errors.push(`${prefix} evidence must contain exact SBOM and scan hashes`)
    }
    if (result.sbom?.semanticVerified !== true || result.sbom?.componentCount !== prototype.sbom?.componentCount) {
      errors.push(`${prefix} evidence must prove the reviewed SBOM component graph`)
    }
    if (result.provenance?.signed !== false
      || result.provenance?.signatureStatus !== BLOCKED_SIGNATURE
      || result.provenance?.statementType !== policy.provenance?.statementType
      || result.provenance?.predicateType !== policy.provenance?.predicateType
      || !SHA256.test(result.provenance?.sha256 ?? '')) {
      errors.push(`${prefix} provenance summary must remain exact and explicitly unsigned`)
    }

    if (!artifacts) {
      errors.push(`${prefix} generated artifacts are missing`)
      continue
    }
    if (artifacts.sbomSha256 !== result.sbom?.sha256) errors.push(`${prefix} SBOM file hash does not match summary`)
    if (artifacts.scanSha256 !== result.scan?.sha256) errors.push(`${prefix} scan file hash does not match summary`)
    if (artifacts.provenanceSha256 !== result.provenance?.sha256) errors.push(`${prefix} provenance file hash does not match summary`)
    if (artifacts.payloadSha256 !== result.payload?.sha256) errors.push(`${prefix} payload manifest file hash does not match summary`)
    if (artifacts.sbom?.bomFormat !== 'CycloneDX') errors.push(`${prefix} SBOM must be CycloneDX JSON`)
    const sbomComponents = artifacts.sbom?.components ?? []
    if (artifacts.sbom?.specVersion !== prototype.sbom?.specVersion
      || sbomComponents.length !== prototype.sbom?.componentCount
      || artifacts.sbom?.metadata?.component?.name !== 'sha256'
      || artifacts.sbom?.metadata?.component?.version !== result.localImageId?.slice(7)) {
      errors.push(`${prefix} SBOM identity and component count must match policy`)
    }
    for (const required of prototype.sbom?.requiredComponents ?? []) {
      const matches = sbomComponents.filter((component) => component?.type === required.type
        && component?.name === required.name
        && (component?.version ?? '') === (required.version ?? ''))
      if (matches.length !== 1) errors.push(`${prefix} SBOM must contain exactly one ${required.name}@${required.version ?? ''}`)
    }
    for (const forbiddenName of prototype.sbom?.forbiddenComponentNames ?? []) {
      if (sbomComponents.some((component) => component?.name?.toLowerCase() === forbiddenName.toLowerCase())) {
        errors.push(`${prefix} SBOM must exclude builder component ${forbiddenName}`)
      }
    }
    const scannerEvidence = inspectScannerEvidence(
      artifacts.scan,
      policy,
      summary.generatedAt,
      result.localImageId,
      prefix,
      errors,
    )
    if (scannerEvidence.fixedFindings !== result.scan?.fixedFindings) {
      errors.push(`${prefix} scan finding count does not match summary`)
    }
    if (scannerEvidence.scannedAt !== result.scan?.scannedAt
      || !equalJson(scannerEvidence.database, result.scan?.database)) {
      errors.push(`${prefix} scan database evidence must match the canonical summary`)
    }

    const statement = artifacts.provenance ?? {}
    const definition = statement.predicate?.buildDefinition ?? {}
    const run = statement.predicate?.runDetails ?? {}
    const external = definition.externalParameters ?? {}
    const internal = definition.internalParameters ?? {}
    const subjects = statement.subject ?? []
    if (statement._type !== policy.provenance?.statementType
      || statement.predicateType !== policy.provenance?.predicateType) {
      errors.push(`${prefix} provenance statement types must match policy`)
    }
    if (subjects.length !== 1
      || subjects[0]?.name !== prototype.localTag
      || subjects[0]?.digest?.sha256 !== result.localImageId?.slice(7)) {
      errors.push(`${prefix} provenance subject must bind the exact local image digest`)
    }
    if (definition.buildType !== policy.provenance?.buildType) errors.push(`${prefix} provenance build type must match policy`)
    if (external.mode !== 'local-only' || external.localTag !== prototype.localTag) {
      errors.push(`${prefix} provenance external parameters must remain local-only`)
    }
    if (!equalJson(external.source, prototype.source)) errors.push(`${prefix} provenance source must match policy`)
    if (!equalJson(external.sourcePatches, prototype.sourcePatches)) errors.push(`${prefix} provenance source patches must match policy`)
    if (!equalJson(external.builderPackages, prototype.builderPackages)) errors.push(`${prefix} provenance builder packages must match policy`)
    if (!equalJson(external.dependencyOverrides, prototype.dependencyOverrides)) errors.push(`${prefix} provenance dependency overrides must match policy`)
    if (internal.dockerfile !== prototype.dockerfile || internal.context !== prototype.context) {
      errors.push(`${prefix} provenance build paths must match policy`)
    }
    if (!equalJson(internal.runtime, prototype.runtime)) errors.push(`${prefix} provenance runtime must match the verified non-root policy`)
    if (!equalJson(internal.localBuild, policy.localBuild)) errors.push(`${prefix} provenance local build controls must match policy`)
    if (!equalJson(internal.payloadPolicy, policy.payloadPolicy)) errors.push(`${prefix} provenance payload policy must match policy`)
    if (!equalJson(internal.sbomPolicy, prototype.sbom)) errors.push(`${prefix} provenance SBOM policy must match policy`)
    if (artifacts.payload?.schemaVersion !== 1
      || artifacts.payload?.imageId !== result.localImageId
      || !equalJson(artifacts.payload?.entries, prototype.runtime?.payloadPermissions)
      || !Array.isArray(artifacts.payload?.forbiddenPathsPresent)
      || artifacts.payload.forbiddenPathsPresent.length !== 0) {
      errors.push(`${prefix} payload manifest must bind reviewed permissions and contain no forbidden paths`)
    }
    if (!equalJson(internal.contextFiles, contextFilesByName.get(prototype.name))) {
      errors.push(`${prefix} provenance context hashes must match the current build context`)
    }
    if (!equalJson(internal.scannerPolicy, policy.scannerPolicy)) {
      errors.push(`${prefix} provenance scanner policy must match the checksum-pinned tools`)
    }
    if (!equalJson(internal.scannerDatabase, scannerEvidence.database)) {
      errors.push(`${prefix} provenance scanner database must match the validated scan database`)
    }

    const source = findDescriptor(definition.resolvedDependencies, `${prototype.name}-source`)
    if (source?.uri !== `${prototype.source.repository}#${prototype.source.commit}`
      || source?.digest?.gitCommit !== prototype.source.commit) {
      errors.push(`${prefix} provenance resolved source must bind the exact commit`)
    }
    for (const [index, sourcePatch] of (prototype.sourcePatches ?? []).entries()) {
      const patchDescriptor = findDescriptor(definition.resolvedDependencies, `${prototype.name}-source-patch-${index}`)
      if (patchDescriptor?.uri !== `file:${sourcePatch.path}`
        || patchDescriptor?.digest?.sha256 !== sourcePatch.sha256) {
        errors.push(`${prefix} provenance source patch ${index} must bind the exact file digest`)
      }
    }
    const expected = expectedBuilder(prototype)
    const builder = findDescriptor(definition.resolvedDependencies, 'go-builder')
    if (builder?.uri !== expected.uri || builder?.digest?.sha256 !== expected.digest) {
      errors.push(`${prefix} provenance builder must bind the exact image digest`)
    }
    const policyDescriptor = findDescriptor(definition.resolvedDependencies, 'prototype-policy')
    if (policyDescriptor?.uri !== 'file:infra/container-prototypes/prototype-policy.json'
      || policyDescriptor?.digest?.sha256 !== policySha256) {
      errors.push(`${prefix} provenance must bind the exact prototype policy`)
    }
    const scriptDescriptor = findDescriptor(definition.resolvedDependencies, 'local-build-script')
    if (scriptDescriptor?.uri !== 'file:scripts/build-local-container-prototypes.ps1'
      || scriptDescriptor?.digest?.sha256 !== buildScriptSha256) {
      errors.push(`${prefix} provenance must bind the exact local build script`)
    }
    const databaseDescriptor = findDescriptor(definition.resolvedDependencies, 'grype-vulnerability-database')
    if (databaseDescriptor?.uri !== scannerEvidence.database.source
      || databaseDescriptor?.digest?.sha256 !== scannerEvidence.database.checksumSha256) {
      errors.push(`${prefix} provenance must bind the exact Grype vulnerability database`)
    }

    if (run.builder?.id !== policy.provenance?.builderId || !run.builder?.version?.docker) {
      errors.push(`${prefix} provenance builder identity must match policy and name Docker`)
    }
    const metadata = run.metadata ?? {}
    if (!UUID.test(metadata.invocationId ?? '')) errors.push(`${prefix} provenance invocation ID must be a UUID`)
    if (!validTimestamp(metadata.startedOn) || !validTimestamp(metadata.finishedOn)
      || Date.parse(metadata.finishedOn) < Date.parse(metadata.startedOn)) {
      errors.push(`${prefix} provenance timestamps must be valid and ordered`)
    }
    const sbom = findDescriptor(run.byproducts, `${prototype.name}.cdx.json`)
    if (sbom?.mediaType !== 'application/vnd.cyclonedx+json' || sbom?.digest?.sha256 !== result.sbom?.sha256) {
      errors.push(`${prefix} provenance must bind the CycloneDX SBOM byproduct`)
    }
    const scan = findDescriptor(run.byproducts, `${prototype.name}-grype.json`)
    if (scan?.mediaType !== 'application/json' || scan?.digest?.sha256 !== result.scan?.sha256) {
      errors.push(`${prefix} provenance must bind the Grype scan byproduct`)
    }
    const payload = findDescriptor(run.byproducts, `${prototype.name}-payload.json`)
    if (payload?.mediaType !== 'application/json' || payload?.digest?.sha256 !== result.payload?.sha256) {
      errors.push(`${prefix} provenance must bind the runtime payload manifest byproduct`)
    }
  }
  return errors
}

function parseJson(buffer) {
  return JSON.parse(buffer.toString('utf8').replace(/^\uFEFF/, ''))
}

function hash(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

async function hashContext(root) {
  const entries = []
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const candidate = path.join(directory, entry.name)
      if (entry.isDirectory()) await visit(candidate)
      else if (entry.isFile()) {
        entries.push({
          path: path.relative(root, candidate).replaceAll('\\', '/'),
          sha256: hash(await readFile(candidate)),
        })
      }
    }
  }
  await visit(root)
  return entries.sort((left, right) => left.path.localeCompare(right.path))
}

function samePath(left, right) {
  const normalize = (value) => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value)
  return normalize(left) === normalize(right)
}

export async function inspectLocalPrototypeEvidence(projectRoot, summaryFile) {
  const policyPath = path.join(projectRoot, 'infra', 'container-prototypes', 'prototype-policy.json')
  const buildScriptPath = path.join(projectRoot, 'scripts', 'build-local-container-prototypes.ps1')
  const policyBuffer = await readFile(policyPath)
  const buildScriptBuffer = await readFile(buildScriptPath)
  const summaryPath = path.resolve(summaryFile)
  const outputRoot = path.dirname(summaryPath)
  const summary = parseJson(await readFile(summaryPath))
  const policy = parseJson(policyBuffer)
  const artifactsByName = new Map()
  const blockedArtifactsByName = new Map()
  const contextFilesByName = new Map()
  const pathErrors = []

  for (const prototype of policy.prototypes.filter((entry) => entry.status === 'buildable-local')) {
    const result = (summary.results ?? []).find((entry) => entry?.name === prototype.name)
    if (!result) continue
    const expectedPaths = {
      sbom: path.join(outputRoot, `${prototype.name}.cdx.json`),
      scan: path.join(outputRoot, `${prototype.name}-grype.json`),
      provenance: path.join(outputRoot, `${prototype.name}.provenance.json`),
      payload: path.join(outputRoot, `${prototype.name}-payload.json`),
    }
    for (const [kind, expectedPath] of Object.entries(expectedPaths)) {
      if (!samePath(result[kind]?.path ?? '', expectedPath)) pathErrors.push(`${prototype.name} ${kind} path must remain inside the evidence directory`)
    }
    if (pathErrors.length) continue

    const sbomBuffer = await readFile(expectedPaths.sbom)
    const scanBuffer = await readFile(expectedPaths.scan)
    const provenanceBuffer = await readFile(expectedPaths.provenance)
    const payloadBuffer = await readFile(expectedPaths.payload)
    const scan = parseJson(scanBuffer)
    artifactsByName.set(prototype.name, {
      sbom: parseJson(sbomBuffer),
      sbomSha256: hash(sbomBuffer),
      scan,
      scanSha256: hash(scanBuffer),
      provenance: parseJson(provenanceBuffer),
      provenanceSha256: hash(provenanceBuffer),
      payload: parseJson(payloadBuffer),
      payloadSha256: hash(payloadBuffer),
    })
    contextFilesByName.set(prototype.name, await hashContext(path.join(projectRoot, prototype.context)))
  }

  for (const prototype of policy.prototypes.filter((entry) => entry.status === 'blocked-upstream')) {
    const evidence = (summary.blocked ?? []).find((entry) => entry?.name === prototype.name)
    const scans = new Map()
    for (const diagnostic of prototype.diagnosticScans ?? []) {
      const result = (evidence?.scans ?? []).find((entry) => entry?.name === diagnostic.name)
      if (!result) continue
      const expectedPath = path.join(outputRoot, `${prototype.name}-${diagnostic.name}-grype.json`)
      if (!samePath(result.path ?? '', expectedPath)) {
        pathErrors.push(`${prototype.name} ${diagnostic.name} scan path must remain inside the evidence directory`)
        continue
      }
      const scanBuffer = await readFile(expectedPath)
      scans.set(diagnostic.name, { scan: parseJson(scanBuffer), sha256: hash(scanBuffer) })
    }
    blockedArtifactsByName.set(prototype.name, scans)
  }

  const errors = [
    ...pathErrors,
    ...validateLocalPrototypeEvidence({
      policy,
      policySha256: hash(policyBuffer),
      buildScriptSha256: hash(buildScriptBuffer),
      summary,
      artifactsByName,
      blockedArtifactsByName,
      contextFilesByName,
    }),
  ]
  if (errors.length) throw new Error(errors.join('; '))
  return {
    builtCount: artifactsByName.size,
    blockedScanCount: [...blockedArtifactsByName.values()].reduce((count, scans) => count + scans.size, 0),
    mode: summary.mode,
    signatureStatus: BLOCKED_SIGNATURE,
  }
}

async function main() {
  const summaryIndex = process.argv.indexOf('--summary')
  if (summaryIndex < 0 || !process.argv[summaryIndex + 1]) throw new Error('Usage: node check-local-container-prototype-evidence.mjs --summary <prototype-summary.json>')
  const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const result = await inspectLocalPrototypeEvidence(projectRoot, process.argv[summaryIndex + 1])
  console.log(`Local container prototype evidence passed (${result.builtCount} built images, ${result.blockedScanCount} blocked upstream scans, ${result.mode}, unsigned).`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main()
