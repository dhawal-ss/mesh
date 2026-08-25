import assert from 'node:assert/strict'
import test from 'node:test'
import {
  validateContainerArtifactEvidence,
  validateContainerSbomEvidence,
  validateContainerScanEvidence,
} from './check-container-scan-evidence.mjs'

const digest = 'a'.repeat(64)
const databaseDigest = 'b'.repeat(64)
const image = `example/service:1.2.3@sha256:${digest}`
const policy = {
  schemaVersion: 6,
  scannerPolicy: {
    grypeVersion: 'v0.116.1',
    severityCutoff: 'high',
    onlyFixable: true,
    database: {
      sourceOrigin: 'https://grype.anchore.io/databases/',
      maxAgeHours: 120,
      requireValid: true,
      requireHashValidation: true,
    },
  },
  sbomPolicy: {
    syftVersion: 'v1.50.0',
    format: 'CycloneDX',
    specVersion: '1.7',
    minimumComponents: 1,
    maxScanSkewMinutes: 60,
  },
  images: [
    { name: 'service', image, derivedScope: 'release' },
  ],
}
const scan = {
  descriptor: {
    name: 'grype',
    version: '0.116.1',
    timestamp: '2026-08-08T07:00:00Z',
    configuration: {
      'only-fixed': true,
      'fail-on-severity': 'high',
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
        from: `https://grype.anchore.io/databases/v6/database.tar.zst?checksum=sha256%3A${databaseDigest}`,
        built: '2026-08-07T06:32:51Z',
        valid: true,
      },
    },
  },
  source: {
    type: 'image',
    target: {
      userInput: image,
      repoDigests: [`example/service@sha256:${digest}`],
    },
  },
  matches: [],
}
const sbom = {
  bomFormat: 'CycloneDX',
  specVersion: '1.7',
  serialNumber: 'urn:uuid:12345678-1234-4234-8234-123456789abc',
  version: 1,
  metadata: {
    timestamp: '2026-08-08T06:55:00Z',
    tools: {
      components: [{ author: 'anchore', name: 'syft', version: '1.50.0' }],
    },
    component: {
      type: 'container',
      name: 'example/service',
      version: '1.2.3',
      'bom-ref': 'container-root',
    },
  },
  components: [
    { type: 'library', name: 'example-package', version: '1.0.0', 'bom-ref': 'package-1' },
  ],
  dependencies: [
    { ref: 'container-root', dependsOn: ['package-1'] },
    { ref: 'package-1', dependsOn: [] },
  ],
}

test('accepts an exact clean scan with a fresh hash-validated database', () => {
  assert.deepEqual(validateContainerScanEvidence({ policy, scan, expectedImage: image }), [])
})

test('accepts a paired exact-image scan and internally consistent CycloneDX SBOM', () => {
  assert.deepEqual(validateContainerArtifactEvidence({ policy, sbom, scan, expectedImage: image }), [])
})

test('rejects scanner version, configuration, image, and repository digest drift', () => {
  const invalid = structuredClone(scan)
  invalid.descriptor.version = '0.115.0'
  invalid.descriptor.configuration['fail-on-severity'] = 'medium'
  invalid.source.target.userInput = `example/other:1.2.3@sha256:${digest}`
  invalid.source.target.repoDigests = [`example/service@sha256:${'c'.repeat(64)}`]
  const errors = validateContainerScanEvidence({ policy, scan: invalid, expectedImage: image })
  assert.match(errors.join('; '), /policy-pinned Grype version/)
  assert.match(errors.join('; '), /fixability and severity policy/)
  assert.match(errors.join('; '), /source must bind the requested exact image/)
  assert.match(errors.join('; '), /repository digest must bind the requested digest/)
})

test('rejects fixable high findings or findings that contradict only-fixed mode', () => {
  const invalid = structuredClone(scan)
  invalid.matches = [
    { vulnerability: { severity: 'High', fix: { state: 'fixed' } } },
    { vulnerability: { severity: 'Low', fix: { state: 'not-fixed' } } },
  ]
  const errors = validateContainerScanEvidence({ policy, scan: invalid, expectedImage: image })
  assert.match(errors.join('; '), /zero fixable high or critical findings/)
  assert.match(errors.join('; '), /must not contain an unfixed finding/)
})

test('does not apply policy exceptions as a release finding ignore mechanism', () => {
  const withException = structuredClone(policy)
  withException.exceptions = [{ vulnerabilityId: 'CVE-example' }]
  const findings = structuredClone(scan)
  findings.matches = [{ vulnerability: { id: 'CVE-example', severity: 'High', fix: { state: 'fixed' } } }]

  assert.match(
    validateContainerScanEvidence({ policy: withException, scan: findings, expectedImage: image }).join('; '),
    /zero fixable high or critical findings/,
  )
})

test('records fixable high findings for reference scope without failing validation', () => {
  const referencePolicy = structuredClone(policy)
  referencePolicy.images[0].derivedScope = 'reference'
  const findings = structuredClone(scan)
  findings.matches = [
    { vulnerability: { severity: 'High', fix: { state: 'fixed' } } },
    { vulnerability: { severity: 'Critical', fix: { state: 'fixed' } } },
  ]

  assert.deepEqual(validateContainerScanEvidence({
    policy: referencePolicy,
    scan: findings,
    expectedImage: image,
    expectedScope: 'reference',
  }), [])
  assert.match(
    validateContainerScanEvidence({
      policy: referencePolicy,
      scan: findings,
      expectedImage: image,
      expectedScope: 'release',
    }).join('; '),
    /scan scope release does not match policy scope reference/,
  )
})

test('rejects stale, future-dated, invalid, untrusted, or unhashed databases', () => {
  const stale = structuredClone(scan)
  stale.descriptor.db.status.built = '2026-07-01T00:00:00Z'
  assert.match(validateContainerScanEvidence({ policy, scan: stale, expectedImage: image }).join('; '), /future-dated or stale/)

  const future = structuredClone(scan)
  future.descriptor.db.status.built = '2026-08-09T00:00:00Z'
  assert.match(validateContainerScanEvidence({ policy, scan: future, expectedImage: image }).join('; '), /future-dated or stale/)

  const invalid = structuredClone(scan)
  invalid.descriptor.db.status.valid = false
  assert.match(validateContainerScanEvidence({ policy, scan: invalid, expectedImage: image }).join('; '), /status must be valid/)

  const untrusted = structuredClone(scan)
  untrusted.descriptor.db.status.from = `https://example.test/database?checksum=sha256%3A${databaseDigest}`
  assert.match(validateContainerScanEvidence({ policy, scan: untrusted, expectedImage: image }).join('; '), /policy-approved origin/)

  const unhashed = structuredClone(scan)
  unhashed.descriptor.db.status.from = 'https://grype.anchore.io/databases/database.tar.zst'
  assert.match(validateContainerScanEvidence({ policy, scan: unhashed, expectedImage: image }).join('; '), /exact SHA-256/)
})

test('rejects disabled database integrity and age validation', () => {
  const invalid = structuredClone(scan)
  invalid.descriptor.configuration.db['validate-by-hash-on-start'] = false
  invalid.descriptor.configuration.db['validate-age'] = false
  const errors = validateContainerScanEvidence({ policy, scan: invalid, expectedImage: image })
  assert.match(errors.join('; '), /validate its hash on startup/)
  assert.match(errors.join('; '), /age validation must match policy/)
})

test('rejects SBOM format, Syft version, and image identity drift', () => {
  const invalid = structuredClone(sbom)
  invalid.specVersion = '1.6'
  invalid.metadata.tools.components[0].version = '1.49.0'
  invalid.metadata.component.name = 'other-service'
  const errors = validateContainerSbomEvidence({ policy, sbom: invalid, scan, expectedImage: image })
  assert.match(errors.join('; '), /versioned CycloneDX document/)
  assert.match(errors.join('; '), /policy-pinned Syft version/)
  assert.match(errors.join('; '), /root component must match/)
})

test('rejects empty, duplicate, or dangling SBOM graph references', () => {
  const empty = structuredClone(sbom)
  empty.components = []
  assert.match(
    validateContainerSbomEvidence({ policy, sbom: empty, scan, expectedImage: image }).join('; '),
    /nonempty component graph/,
  )

  const invalid = structuredClone(sbom)
  invalid.components.push({ type: 'library', name: 'duplicate', 'bom-ref': 'package-1' })
  invalid.dependencies[0].dependsOn.push('missing-package')
  invalid.dependencies.push({ ref: 'package-1', dependsOn: [] })
  const errors = validateContainerSbomEvidence({ policy, sbom: invalid, scan, expectedImage: image })
  assert.match(errors.join('; '), /bom-ref values must be unique/)
  assert.match(errors.join('; '), /dependency refs must be unique/)
  assert.match(errors.join('; '), /dependencies must reference known components/)
})

test('rejects SBOMs generated outside the paired scan evidence window', () => {
  const stale = structuredClone(sbom)
  stale.metadata.timestamp = '2026-08-07T00:00:00Z'
  assert.match(
    validateContainerSbomEvidence({ policy, sbom: stale, scan, expectedImage: image }).join('; '),
    /same bounded evidence run/,
  )
})
