import assert from 'node:assert/strict'
import test from 'node:test'
import { validateLocalPrototypeEvidence } from './check-local-container-prototype-evidence.mjs'

const sha = (character) => character.repeat(64)
const sourceCommit = 'a'.repeat(40)
const policySha256 = sha('1')
const buildScriptSha256 = sha('2')
const imageDigest = sha('3')
const sbomSha256 = sha('4')
const scanSha256 = sha('5')
const provenanceSha256 = sha('6')
const payloadSha256 = sha('b')
const databaseSha256 = sha('c')
const scannedAt = '2026-08-07T12:00:30.000Z'
const databaseBuilt = '2026-08-07T06:32:51Z'
const databaseSource = `https://grype.anchore.io/databases/v6/vulnerability-db_v6.1.9.tar.zst?checksum=sha256%3A${databaseSha256}`
const blockedReleaseImage = `example/synapse:1.2.3@sha256:${sha('d')}`
const blockedDevelopmentImage = `example/synapse:develop@sha256:${sha('e')}`
const blockedReleaseScanSha256 = sha('f')
const blockedDevelopmentScanSha256 = sha('0')
const contextFiles = [{ path: 'Dockerfile', sha256: sha('7') }]
const prototype = {
  name: 'caddy',
  status: 'buildable-local',
  localTag: 'mesh-local/caddy:1.2.3-patched.1',
  context: 'infra/container-prototypes/caddy',
  dockerfile: 'infra/container-prototypes/caddy/Dockerfile',
  builderImage: `golang:1.26.5-alpine3.23@sha256:${sha('8')}`,
  builderPackages: [{ name: 'git', version: '2.52.0-r0' }],
  sourcePatches: [],
  dependencyOverrides: [{ module: 'example/module', version: 'v1.2.3' }],
  source: {
    repository: 'https://github.com/example/caddy.git',
    release: 'v1.2.3',
    commit: sourceCommit,
  },
  runtime: {
    user: '65532:65532',
    workingDirectory: '/srv',
    command: ['/service'],
    exposedPorts: ['8080/tcp'],
    labels: {
      'org.mesh.prototype.mode': 'local-only',
      'org.opencontainers.image.revision': sourceCommit,
    },
    containment: {
      readOnlyRootFilesystem: true,
      dropAllCapabilities: true,
      noNewPrivileges: true,
      temporaryFilesystems: [],
    },
    payloadPermissions: [{ path: '/service', buildPath: '/out/service', type: 'file', owner: '0:0', mode: '0755' }],
  },
  sbom: {
    specVersion: '1.7',
    componentCount: 2,
    requiredComponents: [
      { type: 'file', name: '/service' },
      { type: 'library', name: 'example/module', version: 'v1.2.3' },
    ],
    forbiddenComponentNames: ['apk-tools', 'bash', 'busybox', 'git'],
  },
}
const blocked = {
  name: 'synapse',
  status: 'blocked-upstream',
  diagnosticScans: [
    { name: 'release', image: blockedReleaseImage, fixedFindings: 2, fixedHighOrCriticalFindings: 1 },
    { name: 'development', image: blockedDevelopmentImage, fixedFindings: 2, fixedHighOrCriticalFindings: 1 },
  ],
  blockReason: 'The supported stack remains vulnerable.',
}
const policy = {
  scannerPolicy: {
    syftVersion: 'v1.50.0',
    syftWindowsAmd64Sha256: sha('9'),
    grypeVersion: 'v0.116.1',
    grypeWindowsAmd64Sha256: sha('a'),
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
  provenance: {
    statementType: 'https://in-toto.io/Statement/v1',
    predicateType: 'https://slsa.dev/provenance/v1',
    buildType: 'urn:mesh:buildtype:local-container-prototype:v1',
    builderId: 'urn:mesh:local-container-prototype:windows-amd64',
  },
  localBuild: {
    buildkitProvenance: 'disabled-replaced-by-explicit-local-statement',
    verifyRepeatImageId: true,
  },
  payloadPolicy: {
    forbiddenPaths: ['.git/', 'bin/bash', 'bin/sh', 'go/', 'sbin/apk', 'src/', 'usr/bin/bash', 'usr/bin/git', 'usr/bin/sh'],
  },
  prototypes: [prototype, blocked],
}
const provenance = {
  _type: policy.provenance.statementType,
  subject: [{ name: prototype.localTag, digest: { sha256: imageDigest } }],
  predicateType: policy.provenance.predicateType,
  predicate: {
    buildDefinition: {
      buildType: policy.provenance.buildType,
      externalParameters: {
        mode: 'local-only',
        localTag: prototype.localTag,
        source: prototype.source,
        sourcePatches: prototype.sourcePatches,
        builderPackages: prototype.builderPackages,
        dependencyOverrides: prototype.dependencyOverrides,
      },
      internalParameters: {
        dockerfile: prototype.dockerfile,
        context: prototype.context,
        contextFiles,
        runtime: prototype.runtime,
        localBuild: policy.localBuild,
        payloadPolicy: policy.payloadPolicy,
        sbomPolicy: prototype.sbom,
        scannerPolicy: policy.scannerPolicy,
        scannerDatabase: {
          schemaVersion: 'v6.1.9',
          built: databaseBuilt,
          source: databaseSource,
          checksumSha256: databaseSha256,
          valid: true,
        },
      },
      resolvedDependencies: [
        { name: 'caddy-source', uri: `${prototype.source.repository}#${sourceCommit}`, digest: { gitCommit: sourceCommit } },
        { name: 'go-builder', uri: 'docker://golang:1.26.5-alpine3.23', digest: { sha256: sha('8') } },
        { name: 'prototype-policy', uri: 'file:infra/container-prototypes/prototype-policy.json', digest: { sha256: policySha256 } },
        { name: 'local-build-script', uri: 'file:scripts/build-local-container-prototypes.ps1', digest: { sha256: buildScriptSha256 } },
        { name: 'grype-vulnerability-database', uri: databaseSource, digest: { sha256: databaseSha256 } },
      ],
    },
    runDetails: {
      builder: { id: policy.provenance.builderId, version: { docker: '28.3.2' } },
      metadata: {
        invocationId: '12345678-1234-4123-8123-123456789abc',
        startedOn: '2026-08-07T12:00:00.000Z',
        finishedOn: '2026-08-07T12:01:00.000Z',
      },
      byproducts: [
        { name: 'caddy.cdx.json', mediaType: 'application/vnd.cyclonedx+json', digest: { sha256: sbomSha256 } },
        { name: 'caddy-grype.json', mediaType: 'application/json', digest: { sha256: scanSha256 } },
        { name: 'caddy-payload.json', mediaType: 'application/json', digest: { sha256: payloadSha256 } },
      ],
    },
  },
}
const summary = {
  schemaVersion: 3,
  mode: 'local-only',
  generatedAt: '2026-08-07T12:01:00.000Z',
  syftVersion: policy.scannerPolicy.syftVersion,
  grypeVersion: policy.scannerPolicy.grypeVersion,
  policySha256,
  buildScriptSha256,
  results: [{
    name: prototype.name,
    localTag: prototype.localTag,
    localImageId: `sha256:${imageDigest}`,
    sourceCommit,
    sbom: { path: 'caddy.cdx.json', sha256: sbomSha256, componentCount: 2, semanticVerified: true },
    scan: {
      path: 'caddy-grype.json',
      sha256: scanSha256,
      fixedFindings: 0,
      scannedAt,
      database: {
        schemaVersion: 'v6.1.9',
        built: databaseBuilt,
        source: databaseSource,
        checksumSha256: databaseSha256,
        valid: true,
      },
      passed: true,
    },
    runtime: prototype.runtime,
    runtimeVerified: true,
    containmentVerified: true,
    payload: { path: 'caddy-payload.json', sha256: payloadSha256, verified: true, forbiddenPathsPresent: 0 },
    reproducibility: { repeatedBuild: true, imageIdStable: true },
    provenance: {
      path: 'caddy.provenance.json',
      sha256: provenanceSha256,
      statementType: policy.provenance.statementType,
      predicateType: policy.provenance.predicateType,
      signed: false,
      signatureStatus: 'blocked-until-protected-registry-push',
    },
    signing: 'blocked-until-protected-registry-push',
  }],
  blocked: [{
    name: blocked.name,
    reason: blocked.blockReason,
    scans: blocked.diagnosticScans.map((entry) => ({
      ...entry,
      path: `synapse-${entry.name}-grype.json`,
      sha256: entry.name === 'release' ? blockedReleaseScanSha256 : blockedDevelopmentScanSha256,
      scannedAt,
      database: {
        schemaVersion: 'v6.1.9',
        built: databaseBuilt,
        source: databaseSource,
        checksumSha256: databaseSha256,
        valid: true,
      },
      blockedAsExpected: true,
    })),
  }],
}

function scannerDocument(expectedSource, matches = []) {
  return {
    descriptor: {
      version: '0.116.1',
      timestamp: scannedAt,
      configuration: {
        'only-fixed': true,
        'fail-on-severity': 'negligible',
        db: {
          'update-url': 'https://grype.anchore.io/databases',
          'validate-by-hash-on-start': true,
          'validate-age': true,
          'max-allowed-built-age': 432000000000000,
        },
      },
      db: {
        status: {
          schemaVersion: 'v6.1.9',
          from: databaseSource,
          built: databaseBuilt,
          valid: true,
        },
      },
    },
    source: { type: 'image', target: { userInput: expectedSource } },
    matches,
  }
}

const artifacts = {
  sbom: {
    bomFormat: 'CycloneDX',
    specVersion: '1.7',
    metadata: { component: { name: 'sha256', version: imageDigest } },
    components: [
      { type: 'file', name: '/service' },
      { type: 'library', name: 'example/module', version: 'v1.2.3' },
    ],
  },
  sbomSha256,
  scan: scannerDocument(`sha256:${imageDigest}`),
  scanSha256,
  provenance,
  provenanceSha256,
  payload: { schemaVersion: 1, imageId: `sha256:${imageDigest}`, entries: prototype.runtime.payloadPermissions, forbiddenPathsPresent: [] },
  payloadSha256,
}
const blockedArtifacts = new Map([
  ['release', {
    scan: scannerDocument(blockedReleaseImage, [
      { vulnerability: { severity: 'High', fix: { state: 'fixed' } } },
      { vulnerability: { severity: 'Medium', fix: { state: 'fixed' } } },
    ]),
    sha256: blockedReleaseScanSha256,
  }],
  ['development', {
    scan: scannerDocument(blockedDevelopmentImage, [
      { vulnerability: { severity: 'Critical', fix: { state: 'fixed' } } },
      { vulnerability: { severity: 'Low', fix: { state: 'fixed' } } },
    ]),
    sha256: blockedDevelopmentScanSha256,
  }],
])

function validate(overrides = {}) {
  return validateLocalPrototypeEvidence({
    policy: overrides.policy ?? policy,
    policySha256,
    buildScriptSha256,
    summary: overrides.summary ?? summary,
    artifactsByName: overrides.artifactsByName ?? new Map([['caddy', artifacts]]),
    blockedArtifactsByName: overrides.blockedArtifactsByName ?? new Map([['synapse', blockedArtifacts]]),
    contextFilesByName: overrides.contextFilesByName ?? new Map([['caddy', contextFiles]]),
  })
}

test('accepts internally bound local unsigned provenance', () => {
  assert.deepEqual(validate(), [])
})

test('rejects a summary that is not bound to the exact policy and build script', () => {
  const invalid = structuredClone(summary)
  invalid.policySha256 = sha('a')
  invalid.buildScriptSha256 = sha('b')
  const errors = validate({ summary: invalid })
  assert.match(errors.join('; '), /bind the exact policy/)
  assert.match(errors.join('; '), /bind the exact build script/)
})

test('rejects missing or drifted blocked upstream scan artifacts', () => {
  const missing = new Map(blockedArtifacts)
  missing.delete('release')
  assert.match(
    validate({ blockedArtifactsByName: new Map([['synapse', missing]]) }).join('; '),
    /release blocked scan artifact is missing/,
  )

  const drifted = structuredClone(blockedArtifacts)
  drifted.get('development').scan.matches.pop()
  const errors = validate({ blockedArtifactsByName: new Map([['synapse', drifted]]) })
  assert.match(errors.join('; '), /development blocked scan findings must exactly match policy/)
})

test('rejects signed or signing-ready local evidence', () => {
  const invalid = structuredClone(summary)
  invalid.results[0].provenance.signed = true
  invalid.results[0].signing = 'ready'
  assert.match(validate({ summary: invalid }).join('; '), /explicitly unsigned/)
  assert.match(validate({ summary: invalid }).join('; '), /signing must remain blocked/)
})

test('rejects image subject and source revision drift', () => {
  const invalid = structuredClone(artifacts)
  invalid.provenance.predicate.buildDefinition.externalParameters.source.commit = 'b'.repeat(40)
  invalid.provenance.subject[0].digest.sha256 = sha('c')
  const errors = validate({ artifactsByName: new Map([['caddy', invalid]]) })
  assert.match(errors.join('; '), /subject must bind the exact local image digest/)
  assert.match(errors.join('; '), /provenance source must match policy/)
})

test('rejects source patch provenance drift', () => {
  const invalid = structuredClone(artifacts)
  invalid.provenance.predicate.buildDefinition.externalParameters.sourcePatches = [{
    path: 'infra/container-prototypes/caddy/patches/unreviewed.patch',
    sha256: sha('d'),
  }]
  assert.match(validate({ artifactsByName: new Map([['caddy', invalid]]) }).join('; '), /source patches must match policy/)
})

test('rejects SBOM, scan, and provenance hash drift', () => {
  const invalid = structuredClone(artifacts)
  invalid.sbomSha256 = sha('d')
  invalid.scanSha256 = sha('e')
  invalid.provenanceSha256 = sha('f')
  const errors = validate({ artifactsByName: new Map([['caddy', invalid]]) })
  assert.match(errors.join('; '), /SBOM file hash does not match summary/)
  assert.match(errors.join('; '), /scan file hash does not match summary/)
  assert.match(errors.join('; '), /provenance file hash does not match summary/)
})

test('rejects byproduct, build input, and finding-count drift', () => {
  const invalid = structuredClone(artifacts)
  invalid.provenance.predicate.runDetails.byproducts[0].digest.sha256 = sha('0')
  invalid.scan.matches.push({ vulnerability: { severity: 'Low', fix: { state: 'fixed' } } })
  const errors = validate({
    artifactsByName: new Map([['caddy', invalid]]),
    contextFilesByName: new Map([['caddy', [{ path: 'Dockerfile', sha256: sha('b') }]]]),
  })
  assert.match(errors.join('; '), /scan finding count does not match summary/)
  assert.match(errors.join('; '), /context hashes must match/)
  assert.match(errors.join('; '), /bind the CycloneDX SBOM byproduct/)
})

test('rejects fixable findings below the old high severity cutoff', () => {
  for (const severity of ['Medium', 'Low', 'Negligible']) {
    const invalid = structuredClone(artifacts)
    invalid.scan.matches = [{ vulnerability: { severity, fix: { state: 'fixed' } } }]
    assert.match(
      validate({ artifactsByName: new Map([['caddy', invalid]]) }).join('; '),
      /zero fixable findings at every severity/,
    )
  }
})

test('rejects stale, future-dated, invalid, or untrusted scanner databases', () => {
  const stale = structuredClone(artifacts)
  stale.scan.descriptor.db.status.built = '2026-07-01T00:00:00Z'
  assert.match(validate({ artifactsByName: new Map([['caddy', stale]]) }).join('; '), /future-dated or stale/)

  const future = structuredClone(artifacts)
  future.scan.descriptor.db.status.built = '2026-08-08T00:00:00Z'
  assert.match(validate({ artifactsByName: new Map([['caddy', future]]) }).join('; '), /future-dated or stale/)

  const invalid = structuredClone(artifacts)
  invalid.scan.descriptor.db.status.valid = false
  assert.match(validate({ artifactsByName: new Map([['caddy', invalid]]) }).join('; '), /status must be valid/)

  const untrusted = structuredClone(artifacts)
  untrusted.scan.descriptor.db.status.from = `https://example.test/database.tar.zst?checksum=sha256%3A${databaseSha256}`
  assert.match(validate({ artifactsByName: new Map([['caddy', untrusted]]) }).join('; '), /policy-approved origin/)
})

test('rejects unhashed databases and scanner database provenance drift', () => {
  const unhashed = structuredClone(artifacts)
  unhashed.scan.descriptor.db.status.from = 'https://grype.anchore.io/databases/database.tar.zst'
  assert.match(validate({ artifactsByName: new Map([['caddy', unhashed]]) }).join('; '), /exact SHA-256/)

  const drifted = structuredClone(artifacts)
  drifted.provenance.predicate.buildDefinition.internalParameters.scannerDatabase.checksumSha256 = sha('d')
  drifted.provenance.predicate.buildDefinition.resolvedDependencies.find(
    (entry) => entry.name === 'grype-vulnerability-database',
  ).digest.sha256 = sha('e')
  const errors = validate({ artifactsByName: new Map([['caddy', drifted]]) })
  assert.match(errors.join('; '), /scanner database must match the validated scan database/)
  assert.match(errors.join('; '), /bind the exact Grype vulnerability database/)
})

test('rejects missing or extra build results', () => {
  const missing = structuredClone(summary)
  missing.results = []
  assert.match(validate({ summary: missing }).join('; '), /must exactly match buildable local prototypes/)

  const extra = structuredClone(summary)
  extra.results.push({ name: 'unexpected' })
  assert.match(validate({ summary: extra }).join('; '), /must exactly match buildable local prototypes/)
})

test('rejects root or unbound runtime evidence', () => {
  const invalidSummary = structuredClone(summary)
  invalidSummary.results[0].runtime.user = '0:0'
  invalidSummary.results[0].runtimeVerified = false
  const invalidArtifacts = structuredClone(artifacts)
  invalidArtifacts.provenance.predicate.buildDefinition.internalParameters.runtime.user = '0:0'
  const errors = validate({ summary: invalidSummary, artifactsByName: new Map([['caddy', invalidArtifacts]]) })
  assert.match(errors.join('; '), /runtime must match the verified non-root policy/)
  assert.match(errors.join('; '), /provenance runtime must match the verified non-root policy/)
})

test('rejects missing reproducibility proof or drifted local build controls', () => {
  const invalidSummary = structuredClone(summary)
  invalidSummary.results[0].reproducibility.imageIdStable = false
  const invalidArtifacts = structuredClone(artifacts)
  invalidArtifacts.provenance.predicate.buildDefinition.internalParameters.localBuild.buildkitProvenance = 'default'
  const errors = validate({ summary: invalidSummary, artifactsByName: new Map([['caddy', invalidArtifacts]]) })
  assert.match(errors.join('; '), /prove a stable repeated local image ID/)
  assert.match(errors.join('; '), /local build controls must match policy/)
})

test('rejects missing contained-runtime smoke evidence', () => {
  const invalid = structuredClone(summary)
  invalid.results[0].containmentVerified = false
  assert.match(validate({ summary: invalid }).join('; '), /prove the reviewed runtime containment smoke check/)
})

test('rejects forbidden runtime payloads and payload-manifest hash drift', () => {
  const invalid = structuredClone(artifacts)
  invalid.payload.forbiddenPathsPresent = ['bin/sh']
  invalid.payloadSha256 = sha('c')
  const errors = validate({ artifactsByName: new Map([['caddy', invalid]]) })
  assert.match(errors.join('; '), /payload manifest file hash does not match summary/)
  assert.match(errors.join('; '), /payload manifest must bind reviewed permissions and contain no forbidden paths/)
})

test('rejects truncated SBOMs, missing overrides, and leaked builder components', () => {
  const invalid = structuredClone(artifacts)
  invalid.sbom.components = [{ type: 'library', name: 'git', version: '2.0.0' }]
  const errors = validate({ artifactsByName: new Map([['caddy', invalid]]) })
  assert.match(errors.join('; '), /SBOM identity and component count must match policy/)
  assert.match(errors.join('; '), /SBOM must contain exactly one example\/module@v1\.2\.3/)
  assert.match(errors.join('; '), /SBOM must exclude builder component git/)
})
