import assert from 'node:assert/strict'
import test from 'node:test'
import { validateLocalContainerPrototypePolicy } from './check-local-container-prototypes.mjs'

const digest = (character) => `sha256:${character.repeat(64)}`
const builder = `golang:1.26.5-alpine3.23@${digest('a')}`
const source = {
  repository: 'https://github.com/example/service.git',
  release: 'v1.2.3',
  commit: 'b'.repeat(40),
  releaseArgument: 'RELEASE_VERSION',
}
const buildable = {
  name: 'caddy',
  status: 'buildable-local',
  localTag: 'mesh-local/caddy:1.2.3-patched.1',
  context: 'infra/container-prototypes/caddy',
  dockerfile: 'infra/container-prototypes/caddy/Dockerfile',
  builderImage: builder,
  builderPackages: [{ name: 'git', version: '2.52.0-r0' }],
  source,
  sourcePatches: [],
  dependencyOverrides: [{ module: 'example/module', version: 'v1.2.3' }],
  sbom: {
    specVersion: '1.7',
    componentCount: 2,
    requiredComponents: [
      { type: 'file', name: '/service' },
      { type: 'library', name: 'example/module', version: 'v1.2.3' },
    ],
    forbiddenComponentNames: ['apk-tools', 'bash', 'busybox', 'git'],
  },
  smokeChecks: ['version'],
  adoptionBlockers: ['protected build required'],
  runtime: {
    user: '65532:65532',
    workingDirectory: '/srv',
    command: ['/service'],
    exposedPorts: ['8080/tcp'],
    labels: {
      'org.mesh.prototype.mode': 'local-only',
      'org.opencontainers.image.licenses': 'Apache-2.0',
      'org.opencontainers.image.revision': source.commit,
      'org.opencontainers.image.source': 'https://github.com/example/service',
      'org.opencontainers.image.title': 'Example service',
      'org.opencontainers.image.version': 'v1.2.3-mesh-prototype',
    },
    containment: {
      readOnlyRootFilesystem: true,
      dropAllCapabilities: true,
      noNewPrivileges: true,
      temporaryFilesystems: [],
    },
    payloadPermissions: [{ path: '/service', buildPath: '/out/service', type: 'file', owner: '0:0', mode: '0755' }],
  },
}
const voice = {
  ...structuredClone(buildable),
  name: 'lk-jwt-service',
  localTag: 'mesh-local/lk-jwt-service:1.2.3-patched.1',
  context: 'infra/container-prototypes/lk-jwt-service',
  dockerfile: 'infra/container-prototypes/lk-jwt-service/Dockerfile',
}
const blocked = {
  name: 'synapse',
  status: 'blocked-upstream',
  source,
  diagnosticScans: [
    { name: 'release', image: `example/synapse:1.2.3@${digest('c')}`, fixedFindings: 5, fixedHighOrCriticalFindings: 3 },
    { name: 'development', image: `example/synapse:develop@${digest('d')}`, fixedFindings: 4, fixedHighOrCriticalFindings: 2 },
  ],
  blockReason: 'No supported fixed dependency set exists.',
}
const policy = {
  schemaVersion: 1,
  mode: 'local-only',
  dockerfileFrontend: `docker/dockerfile:1.7@${digest('e')}`,
  scannerPolicy: {
    grypeVersion: 'v0.116.1',
    grypeWindowsAmd64Url: 'https://github.com/anchore/grype/releases/download/v0.116.1/grype_0.116.1_windows_amd64.zip',
    grypeWindowsAmd64ArchiveSha256: '1'.repeat(64),
    grypeWindowsAmd64Sha256: 'f'.repeat(64),
    syftVersion: 'v1.50.0',
    syftWindowsAmd64Url: 'https://github.com/anchore/syft/releases/download/v1.50.0/syft_1.50.0_windows_amd64.zip',
    syftWindowsAmd64ArchiveSha256: '2'.repeat(64),
    syftWindowsAmd64Sha256: '0'.repeat(64),
    severityCutoff: 'negligible',
    onlyFixable: true,
    requireZeroFixableFindings: true,
    database: {
      sourceOrigin: 'https://grype.anchore.io/databases/',
      maxAgeHours: 120,
      requireValid: true,
      requireHashValidation: true,
    },
  },
  signing: {
    status: 'blocked-until-protected-registry-push',
    requiredMode: 'keyless-oidc',
    issuer: 'https://token.actions.githubusercontent.com',
    repository: 'dhawal-ss/mesh',
    requiresDigest: true,
  },
  provenance: {
    status: 'local-unsigned-only',
    statementType: 'https://in-toto.io/Statement/v1',
    predicateType: 'https://slsa.dev/provenance/v1',
    buildType: 'urn:mesh:buildtype:local-container-prototype:v1',
    builderId: 'urn:mesh:local-container-prototype:windows-amd64',
    signatureStatus: 'blocked-until-protected-registry-push',
  },
  localBuild: {
    buildkitProvenance: 'disabled-replaced-by-explicit-local-statement',
    verifyRepeatImageId: true,
  },
  payloadPolicy: {
    forbiddenPaths: ['.git/', 'bin/bash', 'bin/sh', 'go/', 'sbin/apk', 'src/', 'usr/bin/bash', 'usr/bin/git', 'usr/bin/sh'],
  },
  prohibitions: ['production-reference', 'registry-push', 'deployment', 'release-readiness-claim'],
  prototypes: [buildable, voice, blocked],
}
const dockerfile = (entry) => `# syntax=${policy.dockerfileFrontend}
FROM ${entry.builderImage} AS builder
ARG SOURCE_COMMIT=${entry.source.commit}
ARG ${entry.source.releaseArgument}=${entry.source.release}
RUN git fetch origin "refs/tags/\${${entry.source.releaseArgument}}:refs/tags/\${${entry.source.releaseArgument}}" && test "$(git rev-list -n 1 "\${${entry.source.releaseArgument}}^{commit}")" = "\${SOURCE_COMMIT}"
RUN use ${entry.builderPackages[0].name}@${entry.builderPackages[0].version} ${entry.dependencyOverrides[0].module}@${entry.dependencyOverrides[0].version}
${Object.entries(entry.runtime.labels).map(([label, value]) => `LABEL ${label}=\"${value}\"`).join('\n')}
RUN chown 0:0 /out/service && chmod 0755 /out/service
WORKDIR ${entry.runtime.workingDirectory}
USER ${entry.runtime.user}
`
const dockerfiles = new Map([
  [buildable.dockerfile, dockerfile(buildable)],
  [voice.dockerfile, dockerfile(voice)],
])
const buildScript = "docker build --provenance=false\n$repeatImageId = image\nif ($repeatImageId -ne $imageId) { throw }\ndocker run --read-only --cap-drop ALL --security-opt no-new-privileges:true --tmpfs /data\ndocker export image\n$forbiddenPathsPresent = @()\n& $GrypePath image --fail-on $policy.scannerPolicy.severityCutoff --only-fixed\n$findings = @($scan.matches)\n'validate-by-hash-on-start'\n'max-allowed-built-age'\ngrype-vulnerability-database\nstatus -eq \"blocked-upstream\"\n$prototype.diagnosticScans\n$blockedResults\n"

test('accepts bounded local builds and a fail-closed upstream blocker', () => {
  assert.deepEqual(validateLocalContainerPrototypePolicy({ policy, dockerfiles, productionSources: [], buildScript }), [])
})

test('accepts an exact upstream source patch and rejects patch hash drift', () => {
  const patchedPolicy = structuredClone(policy)
  const sourcePatch = {
    path: 'infra/container-prototypes/caddy/patches/compat.patch',
    sha256: '3'.repeat(64),
    upstreamRepository: 'https://github.com/example/service',
    upstreamCommit: '4'.repeat(40),
    upstreamPullRequest: 'https://github.com/example/service/pull/42',
    purpose: 'preserve compatibility with the bounded dependency update',
  }
  patchedPolicy.prototypes[0].sourcePatches = [sourcePatch]
  const patchedDockerfiles = new Map(dockerfiles)
  patchedDockerfiles.set(buildable.dockerfile, `${dockerfile(patchedPolicy.prototypes[0])}
COPY patches/compat.patch /tmp/compat.patch
ARG PATCH_SHA256=${sourcePatch.sha256}
RUN git apply --check /tmp/compat.patch && git apply /tmp/compat.patch
`)
  const patchFiles = new Map([[sourcePatch.path, sourcePatch.sha256]])
  assert.deepEqual(validateLocalContainerPrototypePolicy({
    policy: patchedPolicy,
    dockerfiles: patchedDockerfiles,
    patchFiles,
    productionSources: [],
    buildScript,
  }), [])

  patchFiles.set(sourcePatch.path, '5'.repeat(64))
  assert.match(validateLocalContainerPrototypePolicy({
    policy: patchedPolicy,
    dockerfiles: patchedDockerfiles,
    patchFiles,
    buildScript,
  }).join('; '), /source patch must match its exact SHA-256/)
})

test('rejects floating builders, non-local tags, and unbound source revisions', () => {
  const invalid = structuredClone(policy)
  invalid.prototypes[0].builderImage = 'golang:latest'
  invalid.prototypes[0].localTag = 'example/caddy:release'
  const invalidDockerfiles = new Map(dockerfiles)
  invalidDockerfiles.set(invalid.prototypes[0].dockerfile, 'FROM golang:latest AS builder\n')
  const errors = validateLocalContainerPrototypePolicy({ policy: invalid, dockerfiles: invalidDockerfiles, buildScript })
  assert.match(errors.join('; '), /builder image must use exact tag and digest/)
  assert.match(errors.join('; '), /local tag must use the mesh-local namespace/)
  assert.match(errors.join('; '), /must bind the source commit/)
})

test('rejects unpinned tools, path escapes, duplicate tags, and dependency drift', () => {
  const invalid = structuredClone(policy)
  invalid.dockerfileFrontend = 'docker/dockerfile:latest'
  invalid.scannerPolicy.grypeWindowsAmd64Url = 'https://example.test/grype.zip'
  invalid.scannerPolicy.syftWindowsAmd64ArchiveSha256 = 'unknown'
  invalid.scannerPolicy.grypeWindowsAmd64Sha256 = 'unknown'
  invalid.prototypes[0].context = 'infra/container-prototypes/../homeserver'
  invalid.prototypes[0].builderPackages[0].version = '2.99.0-r0'
  invalid.prototypes[1].localTag = invalid.prototypes[0].localTag
  const errors = validateLocalContainerPrototypePolicy({ policy: invalid, dockerfiles, buildScript })
  assert.match(errors.join('; '), /frontend must use an exact tag and digest/)
  assert.match(errors.join('; '), /Grype download must use the exact official release asset/)
  assert.match(errors.join('; '), /Syft archive hash must be exact/)
  assert.match(errors.join('; '), /Grype executable hash must be exact/)
  assert.match(errors.join('; '), /build paths must stay inside infra\/container-prototypes/)
  assert.match(errors.join('; '), /local tag must be unique/)
  assert.match(errors.join('; '), /missing declared dependency git@2\.99\.0-r0/)
})

test('rejects partial severity coverage or an unbounded scanner database', () => {
  const invalid = structuredClone(policy)
  invalid.scannerPolicy.severityCutoff = 'high'
  invalid.scannerPolicy.requireZeroFixableFindings = false
  invalid.scannerPolicy.database.sourceOrigin = 'https://example.test/databases/'
  invalid.scannerPolicy.database.maxAgeHours = 720
  invalid.scannerPolicy.database.requireHashValidation = false
  const errors = validateLocalContainerPrototypePolicy({ policy: invalid, dockerfiles, buildScript })
  assert.match(errors.join('; '), /fail every fixable finding at every severity/)
  assert.match(errors.join('; '), /official origin with bounded age, validity, and hash checks/)
})

test('rejects a build script that stops enforcing the scanner policy or database binding', () => {
  const errors = validateLocalContainerPrototypePolicy({
    policy,
    dockerfiles,
    buildScript: buildScript
      .replace('--fail-on $policy.scannerPolicy.severityCutoff', '--fail-on high')
      .replace("'validate-by-hash-on-start'", "'auto-update'"),
  })
  assert.match(errors.join('; '), /reject all fixable findings and bind a validated Grype database/)
})

test('rejects production references to local prototypes', () => {
  const errors = validateLocalContainerPrototypePolicy({
    policy,
    dockerfiles,
    productionSources: [{ path: 'infra/compose.yml', text: `image: ${buildable.localTag}` }],
    buildScript,
  })
  assert.match(errors.join('; '), /production source infra\/compose.yml references local prototype/)
})

test('rejects a build path for Synapse while its supported stack remains blocked', () => {
  const invalid = structuredClone(policy)
  invalid.prototypes[2].dockerfile = 'infra/container-prototypes/synapse/Dockerfile'
  invalid.prototypes[2].localTag = 'mesh-local/synapse:unsafe'
  assert.match(
    validateLocalContainerPrototypePolicy({ policy: invalid, dockerfiles, buildScript }).join('; '),
    /blocked prototype must not define a build/,
  )
})

test('rejects incomplete or incoherent blocked upstream scan evidence', () => {
  const invalid = structuredClone(policy)
  invalid.prototypes[2].diagnosticScans = [
    { name: 'release', image: 'example/synapse:latest', fixedFindings: 1, fixedHighOrCriticalFindings: 2 },
  ]
  const errors = validateLocalContainerPrototypePolicy({ policy: invalid, dockerfiles, buildScript })
  assert.match(errors.join('; '), /unique release and development scans/)
  assert.match(errors.join('; '), /scan must bind an exact image/)
  assert.match(errors.join('; '), /positive coherent finding counts/)
})

test('rejects push-capable Dockerfiles and release-ready signing claims', () => {
  const invalid = structuredClone(policy)
  invalid.signing.status = 'ready'
  invalid.provenance.signatureStatus = 'signed'
  const invalidDockerfiles = new Map(dockerfiles)
  invalidDockerfiles.set(buildable.dockerfile, `${dockerfile(buildable)}RUN docker push example/image\n`)
  const errors = validateLocalContainerPrototypePolicy({ policy: invalid, dockerfiles: invalidDockerfiles, buildScript })
  assert.match(errors.join('; '), /signing must remain blocked/)
  assert.match(errors.join('; '), /provenance must remain local, unsigned/)
  assert.match(errors.join('; '), /must not push an image/)
})

test('rejects root runtimes and release tags that are not commit-bound', () => {
  const invalid = structuredClone(policy)
  invalid.prototypes[0].runtime.user = '0:0'
  const invalidDockerfiles = new Map(dockerfiles)
  invalidDockerfiles.set(buildable.dockerfile, dockerfile(buildable).replace('git rev-list -n 1', 'git describe'))
  const errors = validateLocalContainerPrototypePolicy({ policy: invalid, dockerfiles: invalidDockerfiles, buildScript })
  assert.match(errors.join('; '), /runtime must use an explicit non-root numeric user and group/)
  assert.match(errors.join('; '), /must prove the release tag resolves to the source commit/)
  assert.match(errors.join('; '), /must enforce the non-root runtime user/)
})

test('rejects volatile implicit attestations or a missing repeat-build comparison', () => {
  const invalid = structuredClone(policy)
  invalid.localBuild.buildkitProvenance = 'default'
  invalid.localBuild.verifyRepeatImageId = false
  const errors = validateLocalContainerPrototypePolicy({
    policy: invalid,
    dockerfiles,
    buildScript: 'docker build --file Dockerfile',
  })
  assert.match(errors.join('; '), /replace volatile BuildKit attestations and verify a repeated image ID/)
  assert.match(errors.join('; '), /disable implicit provenance and compare a repeated image ID/)
})

test('rejects weak runtime containment and world-writable payload permissions', () => {
  const invalid = structuredClone(policy)
  invalid.prototypes[0].runtime.containment.readOnlyRootFilesystem = false
  invalid.prototypes[0].runtime.payloadPermissions[0].mode = '0777'
  const errors = validateLocalContainerPrototypePolicy({
    policy: invalid,
    dockerfiles,
    buildScript: buildScript.replace('--read-only', '--read-write').replace('--cap-drop ALL', ''),
  })
  assert.match(errors.join('; '), /runtime containment must require read-only root/)
  assert.match(errors.join('; '), /not world-writable/)
  assert.match(errors.join('; '), /runtime containment flags/)
  assert.match(errors.join('; '), /must enforce payload permissions/)
})

test('rejects payload policies or build scripts that stop inspecting final image contents', () => {
  const invalid = structuredClone(policy)
  invalid.payloadPolicy.forbiddenPaths = ['bin/sh']
  const errors = validateLocalContainerPrototypePolicy({
    policy: invalid,
    dockerfiles,
    buildScript: buildScript.replace('docker export image', 'docker inspect image'),
  })
  assert.match(errors.join('; '), /payload policy must reject shells, package managers, source trees, and Git metadata/)
  assert.match(errors.join('; '), /must inspect the exported runtime payload/)
})

test('rejects incomplete SBOM policies and missing dependency overrides', () => {
  const invalid = structuredClone(policy)
  invalid.prototypes[0].sbom.componentCount = 0
  invalid.prototypes[0].sbom.requiredComponents = [{ type: 'file', name: '/service' }]
  invalid.prototypes[0].sbom.forbiddenComponentNames = ['git']
  const errors = validateLocalContainerPrototypePolicy({ policy: invalid, dockerfiles, buildScript })
  assert.match(errors.join('; '), /SBOM policy must bind the full component count/)
  assert.match(errors.join('; '), /SBOM policy must require dependency override example\/module@v1\.2\.3/)
})
