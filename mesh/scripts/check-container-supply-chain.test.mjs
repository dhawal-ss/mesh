import assert from 'node:assert/strict'
import test from 'node:test'
import { collectComposeImages, validateContainerPolicy } from './check-container-supply-chain.mjs'

const r2Image = `example/text-service:1.2.3@sha256:${'a'.repeat(64)}`
const r3Image = `example/voice-service:4.5.6@sha256:${'b'.repeat(64)}`
const policy = {
  schemaVersion: 2,
  scannerPolicy: { candidateOutage: 'fail-closed', developmentOutage: 'blocked-unavailable', grypeVersion: '0.116.1', severityCutoff: 'high', onlyFixable: true },
  requiredUpdateRegressions: ['disposable-federation', 'backup', 'restore', 'health', 'cleanup'],
  images: [
    { name: 'text-service', milestone: 'R2', image: r2Image },
    { name: 'voice-service', milestone: 'R3', image: r3Image },
  ],
  exceptions: [],
}

function scanJob(id, entries, prefix) {
  const matrix = entries.map(({ name, image }) => `          - name: ${name}\n            image: ${image}`).join('\n')
  return `  ${id}:
    strategy:
      matrix:
        include:
${matrix}
    steps:
      - uses: anchore/sbom-action@${'c'.repeat(40)}
      - uses: anchore/scan-action@${'d'.repeat(40)}
        with:
          severity-cutoff: high
          only-fixed: true
          grype-version: 0.116.1
          output-file: ${prefix}-\${{ matrix.name }}-grype.json
      - name: Upload scan evidence
        if: always()
        uses: actions/upload-artifact@${'e'.repeat(40)}
        with:
          path: ${prefix}-\${{ matrix.name }}-grype.json
          if-no-files-found: error
`
}

const r2Entry = policy.images[0]
const r3Entry = policy.images[1]
const protectedWorkflow = `${scanJob('container-supply-chain-r2', [r2Entry], 'r2-container')}
  protected-evidence:
    needs: [codeql, container-supply-chain-r2]
    steps:
      - name: Validate protected results
        env:
          R2_CONTAINERS: \${{ needs.container-supply-chain-r2.result }}
`
const candidateWorkflow = `  quality-gate:
    steps:
      - run: |
          ./scripts/matrixrtc-preflight.ps1
          ./infra/matrixrtc/test-evidence-validation.ps1
          ./scripts/operator-smoke.ps1 -Milestone R3
${scanJob('container-supply-chain-r2', [r2Entry], 'candidate')}
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
          ./scripts/matrixrtc-preflight.ps1
          ./scripts/operator-smoke.ps1 -Milestone R3
${scanJob('container-supply-chain-r3', [r3Entry], 'r3-container')}`

const validInput = {
  occurrences: [{ image: r2Image }, { image: r3Image }],
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

  const coupledProtected = protectedWorkflow
    .replace('container-supply-chain-r2]', 'container-supply-chain-r3]')
    .replace('R2_CONTAINERS: ${{ needs.container-supply-chain-r2.result }}', 'R2_CONTAINERS: ${{ needs.container-supply-chain-r3.result }}')
  assert.match(validateContainerPolicy({ ...validInput, workflowText: coupledProtected }).join('; '), /must depend on R2 containers and not R3 voice/)
})

test('rejects workflows that discard JSON after a failed scan', () => {
  const errors = validateContainerPolicy({
    ...validInput,
    workflowText: protectedWorkflow.replace('if: always()', 'if: success()'),
    candidateWorkflowText: candidateWorkflow.replaceAll('if: always()', 'if: success()'),
    r3WorkflowText: r3Workflow.replace('if: always()', 'if: success()'),
  })

  assert.match(errors.join('; '), /protected R2 container job must retain scanner JSON/)
  assert.match(errors.join('; '), /candidate R2 container job must retain scanner JSON/)
  assert.match(errors.join('; '), /candidate voice container job must retain scanner JSON/)
  assert.match(errors.join('; '), /R3 voice container job must retain scanner JSON/)
})

test('rejects floating or workflow-drifted Grype versions', () => {
  const floatingPolicy = structuredClone(policy)
  delete floatingPolicy.scannerPolicy.grypeVersion
  assert.match(validateContainerPolicy({ occurrences: validInput.occurrences, policy: floatingPolicy }).join('; '), /must pin an exact Grype version/)

  const driftedWorkflow = protectedWorkflow.replace('grype-version: 0.116.1', 'grype-version: 0.115.0')
  assert.match(validateContainerPolicy({ ...validInput, workflowText: driftedWorkflow }).join('; '), /must use policy Grype 0.116.1/)
})
