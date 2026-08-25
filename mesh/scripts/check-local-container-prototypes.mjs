import { createHash } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SHA = /^[0-9a-f]{40}$/
const SHA256 = /^[0-9a-f]{64}$/
const PINNED_IMAGE = /^[A-Za-z0-9./_-]+:[A-Za-z0-9._-]+@sha256:[0-9a-f]{64}$/
const LOCAL_TAG = /^mesh-local\/[A-Za-z0-9./_-]+:[A-Za-z0-9._-]+$/
const TOOL_VERSION = /^v[0-9]+\.[0-9]+\.[0-9]+$/
const NON_ROOT_USER = /^[1-9][0-9]*:[1-9][0-9]*$/
const RELEASE_ARGUMENT = /^[A-Z][A-Z0-9_]+$/

function equalStringSets(left, right) {
  return Array.isArray(left)
    && left.length === new Set(left).size
    && JSON.stringify([...left].sort()) === JSON.stringify([...right].sort())
}

async function filesBelow(root) {
  const files = []
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const candidate = path.join(root, entry.name)
    if (entry.isDirectory()) files.push(...await filesBelow(candidate))
    else files.push(candidate)
  }
  return files
}

function isInfrastructureSource(file) {
  return /\.(?:conf|json|md|ps1|psm1|py|rst|sh|toml|ya?ml)$/i.test(file)
    || /(?:^|[\\/])Caddyfile$/i.test(file)
    || /(?:^|[\\/])\.env(?:\.|$)/i.test(file)
}

function expectedWindowsAmd64Url(tool, version) {
  const numericVersion = version.startsWith('v') ? version.slice(1) : version
  return `https://github.com/anchore/${tool}/releases/download/${version}/${tool}_${numericVersion}_windows_amd64.zip`
}

export function validateLocalContainerPrototypePolicy({ policy, dockerfiles = new Map(), patchFiles = new Map(), productionSources = [], buildScript = '' }) {
  const errors = []
  if (policy.schemaVersion !== 1) errors.push('local container prototype policy schemaVersion must be 1')
  if (policy.mode !== 'local-only') errors.push('local container prototype policy must remain local-only')
  if (!PINNED_IMAGE.test(policy.dockerfileFrontend ?? '')) errors.push('prototype Dockerfile frontend must use an exact tag and digest')
  if (!TOOL_VERSION.test(policy.scannerPolicy?.grypeVersion ?? '')) errors.push('prototype Grype version must be exact')
  if (!TOOL_VERSION.test(policy.scannerPolicy?.syftVersion ?? '')) errors.push('prototype Syft version must be exact')
  for (const tool of ['grype', 'syft']) {
    const field = `${tool}WindowsAmd64`
    const displayName = tool === 'grype' ? 'Grype' : 'Syft'
    if (policy.scannerPolicy?.[`${field}Url`] !== expectedWindowsAmd64Url(tool, policy.scannerPolicy?.[`${tool}Version`] ?? '')) {
      errors.push(`prototype ${displayName} download must use the exact official release asset`)
    }
    if (!SHA256.test(policy.scannerPolicy?.[`${field}ArchiveSha256`] ?? '')) errors.push(`prototype ${displayName} archive hash must be exact`)
    if (!SHA256.test(policy.scannerPolicy?.[`${field}Sha256`] ?? '')) errors.push(`prototype ${displayName} executable hash must be exact`)
  }
  if (policy.scannerPolicy?.severityCutoff !== 'negligible'
    || policy.scannerPolicy?.onlyFixable !== true
    || policy.scannerPolicy?.requireZeroFixableFindings !== true) {
    errors.push('prototype scanner must fail every fixable finding at every severity')
  }
  if (policy.scannerPolicy?.database?.sourceOrigin !== 'https://grype.anchore.io/databases/'
    || policy.scannerPolicy?.database?.maxAgeHours !== 120
    || policy.scannerPolicy?.database?.requireValid !== true
    || policy.scannerPolicy?.database?.requireHashValidation !== true) {
    errors.push('prototype scanner database must use the official origin with bounded age, validity, and hash checks')
  }
  if (policy.signing?.status !== 'blocked-until-protected-registry-push'
    || policy.signing?.requiredMode !== 'keyless-oidc'
    || policy.signing?.issuer !== 'https://token.actions.githubusercontent.com'
    || policy.signing?.repository !== 'dhawal-ss/mesh'
    || policy.signing?.requiresDigest !== true) {
    errors.push('prototype signing must remain blocked until a digest-bound protected GitHub OIDC push exists')
  }
  if (policy.provenance?.status !== 'local-unsigned-only'
    || policy.provenance?.statementType !== 'https://in-toto.io/Statement/v1'
    || policy.provenance?.predicateType !== 'https://slsa.dev/provenance/v1'
    || policy.provenance?.buildType !== 'urn:mesh:buildtype:local-container-prototype:v1'
    || policy.provenance?.builderId !== 'urn:mesh:local-container-prototype:windows-amd64'
    || policy.provenance?.signatureStatus !== 'blocked-until-protected-registry-push') {
    errors.push('prototype provenance must remain local, unsigned, and bound to the reviewed statement contract')
  }
  if (policy.localBuild?.buildkitProvenance !== 'disabled-replaced-by-explicit-local-statement'
    || policy.localBuild?.verifyRepeatImageId !== true) {
    errors.push('local prototype builds must replace volatile BuildKit attestations and verify a repeated image ID')
  }
  if (!buildScript.includes('docker build --provenance=false')
    || !buildScript.includes('$repeatImageId')
    || !buildScript.includes('$repeatImageId -ne $imageId')) {
    errors.push('local prototype build script must disable implicit provenance and compare a repeated image ID')
  }
  if (!buildScript.includes('--read-only')
    || !buildScript.includes('--cap-drop')
    || !buildScript.includes('no-new-privileges:true')
    || !buildScript.includes('--tmpfs')) {
    errors.push('local prototype smoke checks must enforce the reviewed runtime containment flags')
  }
  const requiredForbiddenPaths = ['.git/', 'bin/bash', 'bin/sh', 'go/', 'sbin/apk', 'src/', 'usr/bin/bash', 'usr/bin/git', 'usr/bin/sh']
  if (!equalStringSets(policy.payloadPolicy?.forbiddenPaths, requiredForbiddenPaths)) {
    errors.push('local prototype payload policy must reject shells, package managers, source trees, and Git metadata')
  }
  if (!buildScript.includes('forbiddenPathsPresent') || !buildScript.includes('docker export')) {
    errors.push('local prototype build script must inspect the exported runtime payload')
  }
  if (!buildScript.includes('--fail-on $policy.scannerPolicy.severityCutoff')
    || !buildScript.includes('$findings = @($scan.matches)')
    || !buildScript.includes("'validate-by-hash-on-start'")
    || !buildScript.includes("'max-allowed-built-age'")
    || !buildScript.includes('grype-vulnerability-database')) {
    errors.push('local prototype build script must reject all fixable findings and bind a validated Grype database')
  }
  if (!buildScript.includes("status -eq \"blocked-upstream\"")
    || !buildScript.includes('$prototype.diagnosticScans')
    || !buildScript.includes('$blockedResults')) {
    errors.push('local prototype build script must reproduce blocked upstream scan evidence')
  }
  for (const required of ['production-reference', 'registry-push', 'deployment', 'release-readiness-claim']) {
    if (!(policy.prohibitions ?? []).includes(required)) errors.push(`prototype policy is missing ${required} prohibition`)
  }

  const prototypes = policy.prototypes ?? []
  const names = new Set()
  const localTags = new Set()
  for (const prototype of prototypes) {
    if (!prototype.name || names.has(prototype.name)) errors.push(`prototype requires a unique name: ${prototype.name ?? 'missing'}`)
    names.add(prototype.name)
    if (!SHA.test(prototype.source?.commit ?? '')) errors.push(`${prototype.name ?? 'prototype'} source commit must be exact`)
    if (!/^v[0-9]/.test(prototype.source?.release ?? '')) errors.push(`${prototype.name ?? 'prototype'} source release must be explicit`)
    if (!/^https:\/\/github\.com\/.+\.git$/.test(prototype.source?.repository ?? '')) errors.push(`${prototype.name ?? 'prototype'} source repository must be an HTTPS Git repository`)

    if (prototype.status === 'buildable-local') {
      if (!PINNED_IMAGE.test(prototype.builderImage ?? '')) errors.push(`${prototype.name} builder image must use exact tag and digest`)
      if (!LOCAL_TAG.test(prototype.localTag ?? '')) errors.push(`${prototype.name} local tag must use the mesh-local namespace`)
      else if (localTags.has(prototype.localTag)) errors.push(`${prototype.name} local tag must be unique`)
      else localTags.add(prototype.localTag)
      if (!prototype.dockerfile?.startsWith('infra/container-prototypes/')
        || !prototype.context?.startsWith('infra/container-prototypes/')
        || prototype.dockerfile.split('/').includes('..')
        || prototype.context.split('/').includes('..')) {
        errors.push(`${prototype.name} build paths must stay inside infra/container-prototypes`)
      }
      if (!(prototype.builderPackages?.length > 0)) errors.push(`${prototype.name} must declare exact builder packages`)
      if (!(prototype.dependencyOverrides?.length > 0)) errors.push(`${prototype.name} must declare bounded dependency overrides`)
      if (!Array.isArray(prototype.sourcePatches)) {
        errors.push(`${prototype.name} source patches must be an explicit array`)
      } else {
        const patchPaths = new Set()
        const upstreamRepository = prototype.source.repository.replace(/\.git$/, '')
        for (const sourcePatch of prototype.sourcePatches) {
          const patchPrefix = `infra/container-prototypes/${prototype.name}/patches/`
          if (typeof sourcePatch?.path !== 'string'
            || !sourcePatch.path.startsWith(patchPrefix)
            || !sourcePatch.path.endsWith('.patch')
            || sourcePatch.path.split('/').includes('..')
            || patchPaths.has(sourcePatch.path)) {
            errors.push(`${prototype.name} source patch paths must be unique and bounded to the prototype patch directory`)
          }
          patchPaths.add(sourcePatch?.path)
          if (!SHA256.test(sourcePatch?.sha256 ?? '') || patchFiles.get(sourcePatch?.path) !== sourcePatch?.sha256) {
            errors.push(`${prototype.name} source patch must match its exact SHA-256`)
          }
          if (sourcePatch?.upstreamRepository !== upstreamRepository
            || !SHA.test(sourcePatch?.upstreamCommit ?? '')
            || !new RegExp(`^${upstreamRepository.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/pull/[1-9][0-9]*$`).test(sourcePatch?.upstreamPullRequest ?? '')
            || typeof sourcePatch?.purpose !== 'string'
            || sourcePatch.purpose.length < 10) {
            errors.push(`${prototype.name} source patch must bind an upstream repository, commit, pull request, and purpose`)
          }
        }
      }
      if (prototype.sbom?.specVersion !== '1.7'
        || !Number.isInteger(prototype.sbom?.componentCount)
        || prototype.sbom.componentCount < 1
        || !(prototype.sbom?.requiredComponents?.length > 0)
        || !equalStringSets(prototype.sbom?.forbiddenComponentNames, ['apk-tools', 'bash', 'busybox', 'git'])) {
        errors.push(`${prototype.name} SBOM policy must bind the full component count, required graph, and excluded builder tools`)
      }
      const requiredComponentKeys = new Set((prototype.sbom?.requiredComponents ?? []).map((component) => `${component.type}:${component.name}@${component.version ?? ''}`))
      if (requiredComponentKeys.size !== (prototype.sbom?.requiredComponents ?? []).length
        || (prototype.sbom?.requiredComponents ?? []).some((component) => !['file', 'library'].includes(component?.type)
          || !component?.name
          || (component.type === 'library' && !component.version))) {
        errors.push(`${prototype.name} SBOM required components must be unique and exact`)
      }
      for (const dependency of prototype.dependencyOverrides ?? []) {
        if (!requiredComponentKeys.has(`library:${dependency.module}@${dependency.version}`)) {
          errors.push(`${prototype.name} SBOM policy must require dependency override ${dependency.module}@${dependency.version}`)
        }
      }
      if (!(prototype.smokeChecks?.length > 0)) errors.push(`${prototype.name} must declare smoke checks`)
      if (!(prototype.adoptionBlockers?.length > 0)) errors.push(`${prototype.name} must retain explicit adoption blockers`)
      if (!RELEASE_ARGUMENT.test(prototype.source?.releaseArgument ?? '')) errors.push(`${prototype.name} must declare a safe release argument`)
      if (!NON_ROOT_USER.test(prototype.runtime?.user ?? '')) errors.push(`${prototype.name} runtime must use an explicit non-root numeric user and group`)
      if (!prototype.runtime?.workingDirectory?.startsWith('/') || prototype.runtime.workingDirectory.split('/').includes('..')) {
        errors.push(`${prototype.name} runtime working directory must be an absolute bounded path`)
      }
      if (!(prototype.runtime?.command?.length > 0) || prototype.runtime.command.some((part) => typeof part !== 'string' || !part)) {
        errors.push(`${prototype.name} runtime command must be explicit`)
      }
      const exposedPorts = prototype.runtime?.exposedPorts ?? []
      if (!exposedPorts.length || new Set(exposedPorts).size !== exposedPorts.length || exposedPorts.some((port) => !/^[1-9][0-9]{0,4}\/(?:tcp|udp)$/.test(port))) {
        errors.push(`${prototype.name} runtime ports must be explicit and unique`)
      }
      const containment = prototype.runtime?.containment
      if (containment?.readOnlyRootFilesystem !== true
        || containment?.dropAllCapabilities !== true
        || containment?.noNewPrivileges !== true
        || !Array.isArray(containment?.temporaryFilesystems)) {
        errors.push(`${prototype.name} runtime containment must require read-only root, dropped capabilities, and no-new-privileges`)
      }
      const [runtimeUid, runtimeGid] = (prototype.runtime?.user ?? '').split(':')
      const temporaryFilesystems = containment?.temporaryFilesystems ?? []
      const temporaryPaths = temporaryFilesystems.map((entry) => entry?.path)
      if (new Set(temporaryPaths).size !== temporaryPaths.length
        || temporaryFilesystems.some((entry) => !entry?.path?.startsWith('/')
          || entry.path === '/'
          || entry.path.split('/').includes('..')
          || entry.options !== `rw,noexec,nosuid,nodev,uid=${runtimeUid},gid=${runtimeGid},mode=0700`)) {
        errors.push(`${prototype.name} temporary filesystems must be private, bounded, and owned by the runtime user`)
      }
      const payloadPermissions = prototype.runtime?.payloadPermissions ?? []
      if (!payloadPermissions.length) errors.push(`${prototype.name} must declare reviewed runtime payload permissions`)
      for (const permission of payloadPermissions) {
        const numericMode = /^[0][0-7]{3}$/.test(permission?.mode ?? '') ? Number.parseInt(permission.mode, 8) : Number.NaN
        if (!permission?.path?.startsWith('/') || permission.path === '/' || permission.path.split('/').includes('..')
          || !permission?.buildPath?.startsWith('/') || permission.buildPath.split('/').includes('..')
          || !['directory', 'file'].includes(permission?.type)
          || !/^[0-9]+:[0-9]+$/.test(permission?.owner ?? '')
          || !Number.isFinite(numericMode)
          || (numericMode & 0o002) !== 0) {
          errors.push(`${prototype.name} payload permission entries must be absolute, exact, and not world-writable`)
          continue
        }
        if (/(?:Caddyfile|\.html)$/i.test(permission.path) && (numericMode & 0o111) !== 0) {
          errors.push(`${prototype.name} static runtime files must not be executable`)
        }
      }
      const requiredLabels = prototype.runtime?.labels ?? {}
      if (requiredLabels['org.mesh.prototype.mode'] !== 'local-only'
        || requiredLabels['org.opencontainers.image.revision'] !== prototype.source?.commit
        || !requiredLabels['org.opencontainers.image.source']
        || !requiredLabels['org.opencontainers.image.title']
        || !requiredLabels['org.opencontainers.image.version']
        || !requiredLabels['org.opencontainers.image.licenses']) {
        errors.push(`${prototype.name} runtime labels must preserve local mode, source, revision, version, title, and license`)
      }
      const dockerfile = dockerfiles.get(prototype.dockerfile) ?? ''
      if (!dockerfile) errors.push(`${prototype.name} Dockerfile is missing`)
      else {
        if (!dockerfile.startsWith(`# syntax=${policy.dockerfileFrontend}\n`)) errors.push(`${prototype.name} Dockerfile must pin the policy frontend`)
        if (!dockerfile.includes(`FROM ${prototype.builderImage} AS builder`)) errors.push(`${prototype.name} Dockerfile must pin the policy builder image`)
        if (!dockerfile.includes(prototype.source.commit)) errors.push(`${prototype.name} Dockerfile must bind the source commit`)
        if (!dockerfile.includes(prototype.source.release)) errors.push(`${prototype.name} Dockerfile must bind the source release`)
        if (!dockerfile.includes(`ARG ${prototype.source.releaseArgument}=${prototype.source.release}`)
          || !dockerfile.includes(`refs/tags/\${${prototype.source.releaseArgument}}:refs/tags/\${${prototype.source.releaseArgument}}`)
          || !dockerfile.includes(`\${${prototype.source.releaseArgument}}^{commit}`)
          || !dockerfile.includes('git rev-list -n 1')) {
          errors.push(`${prototype.name} Dockerfile must prove the release tag resolves to the source commit`)
        }
        if (!dockerfile.includes(`org.opencontainers.image.revision=\"${prototype.source.commit}\"`)) errors.push(`${prototype.name} Dockerfile must label the source revision`)
        if (!dockerfile.includes(`USER ${prototype.runtime?.user}`)) errors.push(`${prototype.name} Dockerfile must enforce the non-root runtime user`)
        if (!dockerfile.includes(`WORKDIR ${prototype.runtime?.workingDirectory}`)) errors.push(`${prototype.name} Dockerfile must enforce the runtime working directory`)
        for (const permission of payloadPermissions) {
          if (!dockerfile.includes(permission.buildPath)
            || !dockerfile.includes(`chown ${permission.owner}`)
            || !dockerfile.includes(`chmod ${permission.mode}`)) {
            errors.push(`${prototype.name} Dockerfile must enforce payload permissions for ${permission.path}`)
          }
        }
        for (const [label, value] of Object.entries(requiredLabels)) {
          if (!dockerfile.includes(`LABEL ${label}=\"${value}\"`)) errors.push(`${prototype.name} Dockerfile is missing runtime label ${label}`)
        }
        for (const dependency of [...prototype.builderPackages, ...prototype.dependencyOverrides]) {
          const dependencyName = dependency.name ?? dependency.module
          if (!dockerfile.includes(dependencyName) || !dockerfile.includes(dependency.version)) {
            errors.push(`${prototype.name} Dockerfile is missing declared dependency ${dependencyName}@${dependency.version}`)
          }
        }
        for (const sourcePatch of prototype.sourcePatches ?? []) {
          if (!dockerfile.includes(path.posix.basename(sourcePatch.path))
            || !dockerfile.includes(sourcePatch.sha256)
            || !dockerfile.includes('git apply --check')
            || !dockerfile.includes('git apply ')) {
            errors.push(`${prototype.name} Dockerfile must checksum and apply source patch ${sourcePatch.path}`)
          }
        }
        if (/\bdocker\s+push\b|\bbuildx\s+build\b[^\n]*--push\b/i.test(dockerfile)) errors.push(`${prototype.name} Dockerfile must not push an image`)
      }
    } else if (prototype.status === 'blocked-upstream') {
      if (prototype.dockerfile || prototype.localTag || prototype.builderImage) errors.push(`${prototype.name} blocked prototype must not define a build`)
      const diagnosticScans = prototype.diagnosticScans ?? []
      const scanNames = diagnosticScans.map((entry) => entry?.name)
      if (!equalStringSets(scanNames, ['release', 'development'])) {
        errors.push(`${prototype.name} blocked evidence must define unique release and development scans`)
      }
      for (const scan of diagnosticScans) {
        if (!PINNED_IMAGE.test(scan?.image ?? '')) errors.push(`${prototype.name} ${scan?.name ?? 'diagnostic'} scan must bind an exact image`)
        if (!Number.isInteger(scan?.fixedFindings) || scan.fixedFindings <= 0
          || !Number.isInteger(scan?.fixedHighOrCriticalFindings) || scan.fixedHighOrCriticalFindings <= 0
          || scan.fixedHighOrCriticalFindings > scan.fixedFindings) {
          errors.push(`${prototype.name} ${scan?.name ?? 'diagnostic'} scan must preserve positive coherent finding counts`)
        }
      }
      if (!prototype.blockReason) errors.push(`${prototype.name} blocked prototype requires a reason`)
    } else {
      errors.push(`${prototype.name ?? 'prototype'} has unsupported status ${prototype.status ?? 'missing'}`)
    }
  }

  for (const requiredName of ['caddy', 'lk-jwt-service', 'synapse']) {
    if (!names.has(requiredName)) errors.push(`prototype policy is missing ${requiredName}`)
  }
  for (const source of productionSources) {
    for (const localTag of localTags) if (source.text.includes(localTag)) errors.push(`production source ${source.path} references local prototype ${localTag}`)
    if (/mesh-local\//.test(source.text)) errors.push(`production source ${source.path} references the local prototype namespace`)
  }
  return errors
}

export async function inspectLocalContainerPrototypes(projectRoot) {
  const prototypeRoot = path.join(projectRoot, 'infra', 'container-prototypes')
  const policy = JSON.parse(await readFile(path.join(prototypeRoot, 'prototype-policy.json'), 'utf8'))
  const buildScript = await readFile(path.join(projectRoot, 'scripts', 'build-local-container-prototypes.ps1'), 'utf8')
  const dockerfiles = new Map()
  const patchFiles = new Map()
  for (const prototype of policy.prototypes ?? []) {
    if (prototype.dockerfile) dockerfiles.set(prototype.dockerfile, await readFile(path.join(projectRoot, prototype.dockerfile), 'utf8'))
    for (const sourcePatch of prototype.sourcePatches ?? []) {
      const contents = await readFile(path.join(projectRoot, sourcePatch.path))
      patchFiles.set(sourcePatch.path, createHash('sha256').update(contents).digest('hex'))
    }
  }

  const productionSources = []
  const gitRoot = path.resolve(projectRoot, '..')
  for (const file of await filesBelow(path.join(gitRoot, '.github', 'workflows'))) {
    productionSources.push({ path: path.relative(gitRoot, file).replaceAll('\\', '/'), text: await readFile(file, 'utf8') })
  }
  for (const file of await filesBelow(path.join(projectRoot, 'infra'))) {
    if (file.startsWith(`${prototypeRoot}${path.sep}`)) continue
    if (file.includes(`${path.sep}runtime${path.sep}`) || !isInfrastructureSource(file)) continue
    productionSources.push({ path: path.relative(projectRoot, file).replaceAll('\\', '/'), text: await readFile(file, 'utf8') })
  }

  const errors = validateLocalContainerPrototypePolicy({ policy, dockerfiles, patchFiles, productionSources, buildScript })
  if (errors.length) throw new Error(errors.join('; '))
  return {
    mode: policy.mode,
    buildable: policy.prototypes.filter((entry) => entry.status === 'buildable-local').map((entry) => entry.name),
    blocked: policy.prototypes.filter((entry) => entry.status === 'blocked-upstream').map((entry) => entry.name),
  }
}

async function main() {
  const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const result = await inspectLocalContainerPrototypes(projectRoot)
  console.log(`Local container prototype policy passed (${result.buildable.length} buildable, ${result.blocked.length} blocked upstream).`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main()
