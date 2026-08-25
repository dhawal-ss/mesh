import assert from 'node:assert/strict'
import test from 'node:test'
import { collectComposeImages, validateContainerPolicy } from './check-container-supply-chain.mjs'

const r2Image = `example/text-service:1.2.3@sha256:${'a'.repeat(64)}`
const r3Image = `example/voice-service:4.5.6@sha256:${'b'.repeat(64)}`
const referenceImage = `example/reference-service:7.8.9@sha256:${'c'.repeat(64)}`
const policy = {
  schemaVersion: 6,
  scopePolicy: {
    callPathComposeDirectories: ['infra/matrixrtc'],
  },
  scannerPolicy: {
    candidateOutage: 'fail-closed',
    developmentOutage: 'blocked-unavailable',
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
  signatureDiscoveryPolicy: {
    cosignVersion: 'v3.0.6',
    mode: 'discovery-only',
    identityRegexp: '^.+$',
    issuerRegexp: '^https://.+$',
    maxPayloadBytes: 1_048_576,
    maxSignatures: 64,
    requiresReviewer: true,
    trustedForRelease: false,
  },
  requiredUpdateRegressions: ['disposable-federation', 'backup', 'restore', 'health', 'cleanup'],
  images: [
    { name: 'text-service', milestone: 'R2', derivedScope: 'release', image: r2Image, signaturePolicy: 'discover-upstream-support-before-candidate' },
    { name: 'reference-service', milestone: 'R2', derivedScope: 'reference', image: referenceImage, signaturePolicy: 'discover-upstream-support-before-candidate' },
    { name: 'voice-service', milestone: 'R3', derivedScope: 'release', image: r3Image, signaturePolicy: 'discover-upstream-support-before-candidate' },
  ],
  exceptions: [],
}

function scanJob(id, entries, prefix, { failBuild = true, scope } = {}) {
  const matrix = entries.map(({ name, image }) => `          - name: ${name}\n            image: ${image}`).join('\n')
  return `  ${id}:
    strategy:
      matrix:
        include:
${matrix}
    steps:
      - uses: anchore/sbom-action@${'c'.repeat(40)}
        with:
          image: \${{ matrix.image }}
          format: cyclonedx-json
          syft-version: v1.50.0
          output-file: ${prefix}-\${{ matrix.name }}.cdx.json
      - uses: anchore/scan-action@${'d'.repeat(40)}
        with:
          image: \${{ matrix.image }}
          fail-build: ${failBuild}
          severity-cutoff: high
          only-fixed: true
          grype-version: v0.116.1
          output-file: ${prefix}-\${{ matrix.name }}-grype.json
      - name: Validate paired SBOM, exact image, and scanner database evidence
        run: >-
          node mesh/scripts/check-container-scan-evidence.mjs
          --sbom "${prefix}-\${{ matrix.name }}.cdx.json"
          --scan "${prefix}-\${{ matrix.name }}-grype.json"
           --image '\${{ matrix.image }}'
${scope ? `          --scope ${scope}\n` : ''}          --output "${prefix}-\${{ matrix.name }}-evidence.json"
      - name: Install pinned Cosign for signature discovery
        uses: sigstore/cosign-installer@${'f'.repeat(40)}
        with:
          cosign-release: v3.0.6
      - name: Normalize untrusted upstream signature discovery
        run: |
          cosign verify \\
            --certificate-identity-regexp='^.+$' \\
            --certificate-oidc-issuer-regexp='^https://.+$' \\
            --output=json \\
            '\${{ matrix.image }}' > ${prefix}-\${{ matrix.name }}-signature-raw.json
          status=$?
          node mesh/scripts/check-container-signature-evidence.mjs \\
            --verification "${prefix}-\${{ matrix.name }}-signature-raw.json" \\
            --cosign-exit "$status" \\
            --image '\${{ matrix.image }}' \\
            --output "${prefix}-\${{ matrix.name }}-signature.json"
          rm -f ${prefix}-\${{ matrix.name }}-signature-raw.json ${prefix}-\${{ matrix.name }}-signature-error.txt
      - name: Upload scan evidence
        if: always()
        uses: actions/upload-artifact@${'e'.repeat(40)}
        with:
          path: |
            ${prefix}-\${{ matrix.name }}.cdx.json
            ${prefix}-\${{ matrix.name }}-grype.json
            ${prefix}-\${{ matrix.name }}-evidence.json
            ${prefix}-\${{ matrix.name }}-signature.json
          if-no-files-found: error
`
}

const r2Entry = policy.images[0]
const referenceEntry = policy.images[1]
const r3Entry = policy.images[2]
const protectedWorkflow = `  sbom:
    steps:
      - run: |
          npm run build:matrix-voice
          npm run check:release-sboms
${scanJob('container-supply-chain-r2', [r2Entry], 'r2-container', { scope: 'release' })}
${scanJob('container-reference-scan-r2', [referenceEntry], 'r2-reference-container', { failBuild: false, scope: 'reference' })}
  protected-evidence:
    needs: [codeql, container-supply-chain-r2, container-reference-scan-r2]
    steps:
      - name: Validate protected results
        env:
          R2_CONTAINERS: \${{ needs.container-supply-chain-r2.result }}
          R2_REFERENCE_CONTAINERS: \${{ needs.container-reference-scan-r2.result }}
`
const candidateWorkflow = `  quality-gate:
    steps:
      - run: |
          ./scripts/matrixrtc-preflight.ps1 -RequireCompose
          ./infra/matrixrtc/test-evidence-validation.ps1
          ./scripts/operator-smoke.ps1 -Milestone R3
${scanJob('container-supply-chain-r2', [r2Entry, referenceEntry], 'candidate')}
${scanJob('container-supply-chain-r3', [r3Entry], 'candidate-voice')}
  windows:
    needs: [quality-gate, container-supply-chain-r2, container-supply-chain-r3]
    steps:
      - run: build-beta
`
const r3Workflow = `  matrixrtc-contracts-r3:
    steps:
      - run: |
          ./infra/matrixrtc/test-evidence-validation.ps1
          ./scripts/matrixrtc-preflight.ps1 -RequireCompose
          ./scripts/operator-smoke.ps1 -Milestone R3
${scanJob('container-supply-chain-r3', [r3Entry], 'r3-container')}`

const validInput = {
  occurrences: [
    { image: r2Image, composeFile: 'infra/matrixrtc/docker-compose.yml' },
    { image: referenceImage, composeFile: 'infra/homeserver/docker-compose.yml' },
    { image: r3Image, composeFile: 'infra/matrixrtc/docker-compose.yml' },
  ],
  policy,
  workflowText: protectedWorkflow,
  candidateWorkflowText: candidateWorkflow,
  r3WorkflowText: r3Workflow,
}

test('extracts Compose image references', () => {
  assert.deepEqual(collectComposeImages(`services:\n  app:\n    image: ${r2Image}\n`), [r2Image])
})

test('accepts exact R2 and voice candidate scans plus protected boundaries', () => {
  assert.deepEqual(validateContainerPolicy(validInput), [])
})

test('derives reference scope from repository placement and rejects hand labels', () => {
  const callPathReference = structuredClone(validInput)
  callPathReference.occurrences[1].composeFile = 'infra/matrixrtc/reference-compose.yml'
  assert.match(
    validateContainerPolicy(callPathReference).join('; '),
    /reference-service recorded derived scope reference does not match authoritative release scope/,
  )

  const handLabeled = structuredClone(validInput)
  handLabeled.policy.images[0].derivedScope = 'reference'
  assert.match(
    validateContainerPolicy(handLabeled).join('; '),
    /text-service recorded derived scope reference does not match authoritative release scope/,
  )
})

test('Mesh-published and call-path images can never be reference scoped', () => {
  const meshPublished = structuredClone(validInput)
  meshPublished.policy.images[1].image = `ghcr.io/dhawal-ss/reference-service:7.8.9@sha256:${'c'.repeat(64)}`
  meshPublished.occurrences[1].image = meshPublished.policy.images[1].image
  assert.match(
    validateContainerPolicy(meshPublished).join('; '),
    /reference-service recorded derived scope reference does not match authoritative release scope/,
  )

  const callPath = structuredClone(validInput)
  callPath.occurrences[1].composeFile = 'infra/matrixrtc/docker-compose.reference.yml'
  assert.match(
    validateContainerPolicy(callPath).join('; '),
    /reference-service recorded derived scope reference does not match authoritative release scope/,
  )
})

test('rejects reference or unknown images in installer and Tauri bundle resources', () => {
  const referenceBundled = validateContainerPolicy({
    ...validInput,
    distributionOccurrences: [
      { image: referenceImage, sourceFile: 'release/installer-payload/container.json', sourceKind: 'installer-payload' },
      { image: referenceImage, sourceFile: 'src-tauri/tauri.conf.json', sourceKind: 'tauri-bundle-resource' },
    ],
  })
  assert.match(referenceBundled.join('; '), /reference scoped image reference-service appears in installer-payload/)
  assert.match(referenceBundled.join('; '), /reference scoped image reference-service appears in tauri-bundle-resource/)

  const unknownImage = `example/untracked:1.0.0@sha256:${'d'.repeat(64)}`
  assert.match(
    validateContainerPolicy({
      ...validInput,
      distributionOccurrences: [{ image: unknownImage, sourceFile: 'release/installer-payload/unknown.json', sourceKind: 'installer-payload' }],
    }).join('; '),
    /installer-payload contains image missing from security policy/,
  )
})

test('rejects floating images, invalid milestones, and broad or expired exceptions', () => {
  const bad = structuredClone(policy)
  bad.images[0].image = 'example/image:latest'
  bad.images[1].milestone = 'R4'
  bad.exceptions = [{ digest: 'not-exact', vulnerabilityId: 'CVE-test', reason: '', reviewer: '', expiresAt: '2020-01-01T00:00:00Z' }]
  const errors = validateContainerPolicy({ occurrences: [{ image: 'example/image:latest' }, { image: r3Image }], policy: bad })
  assert.ok(errors.some((error) => error.includes('not exact tag+digest')))
  assert.ok(errors.some((error) => error.includes('requires milestone R2 or R3')))
  assert.ok(errors.some((error) => error.includes('exception must bind')))
  assert.ok(errors.some((error) => error.includes('expired')))
})

test('rejects candidate R2 or voice image omissions', () => {
  const omitted = candidateWorkflow.replace(`          - name: text-service\n            image: ${r2Image}\n`, '')
  assert.match(validateContainerPolicy({ ...validInput, candidateWorkflowText: omitted }).join('; '), /candidate R2 container job is missing text-service/)

  const missingVoice = candidateWorkflow.replace(`          - name: voice-service\n            image: ${r3Image}\n`, '')
  const errors = validateContainerPolicy({ ...validInput, candidateWorkflowText: missingVoice })
  assert.match(errors.join('; '), /candidate voice container job is missing voice-service/)
})

test('rejects R3 workflows that stop scanning a voice image', () => {
  const withoutVoice = r3Workflow.replace(`          - name: voice-service\n            image: ${r3Image}\n`, '')
  assert.match(validateContainerPolicy({ ...validInput, r3WorkflowText: withoutVoice }).join('; '), /R3 voice container job is missing voice-service/)
})

test('rejects removal of MatrixRTC candidate gates or R3 protected-result coupling', () => {
  const withoutCandidateVoice = candidateWorkflow.replace('./scripts/matrixrtc-preflight.ps1', './scripts/no-voice-validation.ps1')
  assert.match(validateContainerPolicy({ ...validInput, candidateWorkflowText: withoutCandidateVoice }).join('; '), /must retain MatrixRTC/)

  const optionalCandidateCompose = candidateWorkflow.replace('matrixrtc-preflight.ps1 -RequireCompose', 'matrixrtc-preflight.ps1')
  assert.match(validateContainerPolicy({ ...validInput, candidateWorkflowText: optionalCandidateCompose }).join('; '), /must retain MatrixRTC/)

  const optionalR3Compose = r3Workflow.replace('matrixrtc-preflight.ps1 -RequireCompose', 'matrixrtc-preflight.ps1')
  assert.match(validateContainerPolicy({ ...validInput, r3WorkflowText: optionalR3Compose }).join('; '), /must retain MatrixRTC/)

  const coupledProtected = protectedWorkflow
    .replace('container-supply-chain-r2]', 'container-supply-chain-r3]')
    .replace('R2_CONTAINERS: ${{ needs.container-supply-chain-r2.result }}', 'R2_CONTAINERS: ${{ needs.container-supply-chain-r3.result }}')
  assert.match(validateContainerPolicy({ ...validInput, workflowText: coupledProtected }).join('; '), /must depend on release and reference R2 containers and not R3 voice/)
})

test('rejects workflows that discard JSON after a failed scan', () => {
  const errors = validateContainerPolicy({
    ...validInput,
    workflowText: protectedWorkflow.replaceAll('if: always()', 'if: success()'),
    candidateWorkflowText: candidateWorkflow.replaceAll('if: always()', 'if: success()'),
    r3WorkflowText: r3Workflow.replace('if: always()', 'if: success()'),
  })

  assert.match(errors.join('; '), /protected R2 container job must retain scanner JSON/)
  assert.match(errors.join('; '), /reference R2 container job must retain scanner JSON/)
  assert.match(errors.join('; '), /candidate R2 container job must retain scanner JSON/)
  assert.match(errors.join('; '), /candidate voice container job must retain scanner JSON/)
  assert.match(errors.join('; '), /R3 voice container job must retain scanner JSON/)
})

test('keeps release findings failing and reference findings non-failing without weakening scan inputs', () => {
  const releaseNonFailing = protectedWorkflow.replace('fail-build: true', 'fail-build: false')
  assert.match(
    validateContainerPolicy({ ...validInput, workflowText: releaseNonFailing }).join('; '),
    /protected R2 container job must set fail-build to true/,
  )

  const referenceFailing = protectedWorkflow.replace('fail-build: false', 'fail-build: true')
  assert.match(
    validateContainerPolicy({ ...validInput, workflowText: referenceFailing }).join('; '),
    /reference R2 container job must set fail-build to false/,
  )

  const referenceJobStart = protectedWorkflow.indexOf('  container-reference-scan-r2:')
  const weakenedReference = protectedWorkflow.slice(0, referenceJobStart) + protectedWorkflow.slice(referenceJobStart)
    .replace('          --scope reference\n', '')
    .replace('          only-fixed: true', '          only-fixed: false')
  const errors = validateContainerPolicy({ ...validInput, workflowText: weakenedReference })
  assert.match(errors.join('; '), /reference R2 container job must bind scan evidence to derived reference scope/)
  assert.match(errors.join('; '), /must retain the fixable High\/Critical scanner policy/)
})

test('rejects a protected SBOM job that builds the ordinary Matrix artifact', () => {
  const ordinaryArtifact = protectedWorkflow.replace('npm run build:matrix-voice', 'npm run build:matrix')
  assert.match(
    validateContainerPolicy({ ...validInput, workflowText: ordinaryArtifact }).join('; '),
    /must build the Matrix voice artifact immediately before generating release SBOMs/,
  )
})

test('rejects floating or workflow-drifted scanner and SBOM tool versions', () => {
  const floatingPolicy = structuredClone(policy)
  delete floatingPolicy.scannerPolicy.grypeVersion
  assert.match(validateContainerPolicy({ occurrences: validInput.occurrences, policy: floatingPolicy }).join('; '), /must pin an exact Grype version/)

  const untaggedPolicy = structuredClone(policy)
  untaggedPolicy.scannerPolicy.grypeVersion = '0.116.1'
  assert.match(validateContainerPolicy({ occurrences: validInput.occurrences, policy: untaggedPolicy }).join('; '), /must pin an exact Grype version/)

  const driftedWorkflow = protectedWorkflow.replace('grype-version: v0.116.1', 'grype-version: v0.115.0')
  assert.match(validateContainerPolicy({ ...validInput, workflowText: driftedWorkflow }).join('; '), /must use policy Grype v0.116.1/)

  const floatingSbomPolicy = structuredClone(policy)
  delete floatingSbomPolicy.sbomPolicy.syftVersion
  assert.match(validateContainerPolicy({ occurrences: validInput.occurrences, policy: floatingSbomPolicy }).join('; '), /must pin an exact Syft version/)

  const driftedSbomWorkflow = protectedWorkflow.replace('syft-version: v1.50.0', 'syft-version: v1.49.0')
  assert.match(validateContainerPolicy({ ...validInput, workflowText: driftedSbomWorkflow }).join('; '), /must use policy Syft v1.50.0/)
})

test('rejects weak scanner or SBOM policies and missing paired semantic validation', () => {
  const weakPolicy = structuredClone(policy)
  weakPolicy.scannerPolicy.database.sourceOrigin = 'https://example.test/databases/'
  weakPolicy.scannerPolicy.database.maxAgeHours = 720
  weakPolicy.scannerPolicy.database.requireHashValidation = false
  assert.match(
    validateContainerPolicy({ occurrences: validInput.occurrences, policy: weakPolicy }).join('; '),
    /official origin with bounded age, validity, and hash checks/,
  )

  const missingValidation = protectedWorkflow.replace('node mesh/scripts/check-container-scan-evidence.mjs', 'node mesh/scripts/skip-scan-validation.mjs')
  assert.match(
    validateContainerPolicy({ ...validInput, workflowText: missingValidation }).join('; '),
    /must semantically validate and bind the SBOM, exact image, and scanner database evidence/,
  )

  const weakSbomPolicy = structuredClone(policy)
  weakSbomPolicy.sbomPolicy.minimumComponents = 0
  weakSbomPolicy.sbomPolicy.maxScanSkewMinutes = 1_440
  assert.match(
    validateContainerPolicy({ occurrences: validInput.occurrences, policy: weakSbomPolicy }).join('; '),
    /nonempty CycloneDX graph generated in the bounded scan run/,
  )

  const missingSbom = protectedWorkflow.replace('--sbom "r2-container-${{ matrix.name }}.cdx.json"', '--sbom "missing.cdx.json"')
  assert.match(
    validateContainerPolicy({ ...validInput, workflowText: missingSbom }).join('; '),
    /must semantically validate and bind the SBOM/,
  )

  const missingManifestUpload = protectedWorkflow.replace('            r2-container-${{ matrix.name }}-evidence.json\n', '')
  assert.match(
    validateContainerPolicy({ ...validInput, workflowText: missingManifestUpload }).join('; '),
    /must upload the SBOM, scan, and paired evidence manifest/,
  )

  const floatingSbomImage = protectedWorkflow.replace(
    '          image: ${{ matrix.image }}\n          format: cyclonedx-json',
    '          image: example/text-service:1.2.3\n          format: cyclonedx-json',
  )
  assert.match(
    validateContainerPolicy({ ...validInput, workflowText: floatingSbomImage }).join('; '),
    /SBOM action must use the exact matrix image/,
  )

  const floatingScanImage = protectedWorkflow.replace(
    '          image: ${{ matrix.image }}\n          fail-build: true\n          severity-cutoff: high',
    '          image: example/text-service:1.2.3\n          fail-build: true\n          severity-cutoff: high',
  )
  assert.match(
    validateContainerPolicy({ ...validInput, workflowText: floatingScanImage }).join('; '),
    /scanner action must use the exact matrix image/,
  )
})

test('rejects unpinned, wildcard-trusting, raw, or omitted signature discovery', () => {
  const unpinned = protectedWorkflow.replace('cosign-release: v3.0.6', 'cosign-release: v3.0.3')
  assert.match(
    validateContainerPolicy({ ...validInput, workflowText: unpinned }).join('; '),
    /must pin policy Cosign v3.0.6/,
  )

  const wildcard = protectedWorkflow.replace("--certificate-identity-regexp='^.+$'", "--certificate-identity-regexp='.*'")
  assert.match(
    validateContainerPolicy({ ...validInput, workflowText: wildcard }).join('; '),
    /bounded untrusted signature discovery/,
  )

  const omitted = candidateWorkflow.replaceAll('node mesh/scripts/check-container-signature-evidence.mjs', 'node mesh/scripts/skip-signature-normalization.mjs')
  assert.match(
    validateContainerPolicy({ ...validInput, candidateWorkflowText: omitted }).join('; '),
    /must normalize signature discovery without granting release trust/,
  )

  const rawUpload = protectedWorkflow.replace(
    '            r2-container-${{ matrix.name }}-signature.json\n',
    '            r2-container-${{ matrix.name }}-signature.json\n            r2-container-${{ matrix.name }}-signature-raw.json\n',
  )
  assert.match(
    validateContainerPolicy({ ...validInput, workflowText: rawUpload }).join('; '),
    /must not upload arbitrary raw signature annotations/,
  )

  const retainedRaw = protectedWorkflow.replace(
    'rm -f r2-container-${{ matrix.name }}-signature-raw.json r2-container-${{ matrix.name }}-signature-error.txt',
    'true',
  )
  assert.match(
    validateContainerPolicy({ ...validInput, workflowText: retainedRaw }).join('; '),
    /must remove raw signature annotations before artifact upload/,
  )

  const trustingPolicy = structuredClone(policy)
  trustingPolicy.signatureDiscoveryPolicy.trustedForRelease = true
  assert.match(
    validateContainerPolicy({ occurrences: validInput.occurrences, policy: trustingPolicy }).join('; '),
    /remain reviewer-required and release-untrusted/,
  )
})
