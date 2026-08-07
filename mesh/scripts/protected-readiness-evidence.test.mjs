import { createHash } from 'node:crypto'
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  downloadGitHubActionsArtifact,
  parseProtectedArtifactUrl,
  validateProtectedJobPayload,
  verifyProtectedR0Evidence,
} from './protected-readiness-evidence.mjs'

const sourceSha = 'a'.repeat(40)
const treeHash = 'c'.repeat(40)
const manifestUrl = 'https://github.com/dhawal-ss/mesh/actions/runs/123/artifacts/111'
const payloadUrl = 'https://github.com/dhawal-ss/mesh/actions/runs/123/artifacts/222'
const now = new Date('2026-08-02T00:00:00Z')
const collectedAt = '2026-08-01T00:00:00.000Z'
const expiresAt = '2026-09-01T00:00:00.000Z'

function archive(label) {
  return Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from(label)])
}

function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function artifactMetadata(bytes, overrides = {}) {
  return {
    id: 111,
    expired: false,
    size_in_bytes: bytes.length,
    archive_download_url: 'https://api.github.com/repos/dhawal-ss/mesh/actions/artifacts/111/zip',
    created_at: '2026-08-01T00:05:00Z',
    workflow_run: {
      id: 123,
      head_sha: sourceSha,
      head_branch: 'main',
    },
    ...overrides,
  }
}

function workflowRunMetadata(overrides = {}) {
  return {
    id: 123,
    name: 'CI',
    path: '.github/workflows/ci.yml@refs/heads/main',
    event: 'push',
    status: 'completed',
    conclusion: 'success',
    head_sha: sourceSha,
    head_branch: 'main',
    run_attempt: 1,
    run_started_at: '2026-08-01T00:00:00Z',
    updated_at: '2026-08-01T00:10:00Z',
    repository: { full_name: 'dhawal-ss/mesh' },
    head_repository: { full_name: 'dhawal-ss/mesh' },
    ...overrides,
  }
}

function makeFixture() {
  const manifestArchive = archive('manifest')
  const payloadArchive = archive('payload')
  const payload = {
    schemaVersion: 1,
    sourceSha,
    results: { matrixRust: 'success', legacyRust: 'success', frontend: 'success' },
  }
  const manifest = {
    schemaVersion: 1,
    manifestId: 'mesh-protected-ci-evidence',
    sourceCommit: sourceSha,
    sourceTreeHash: treeHash,
    workflow: {
      name: 'CI',
      runId: '123',
      runAttempt: 1,
      uri: 'https://github.com/dhawal-ss/mesh/actions/runs/123',
    },
    runner: { os: 'linux', arch: 'x64', toolVersions: { node: 'v22.0.0' } },
    commands: [{
      command: 'matrix-rust + legacy-rust + check-frontend protected jobs',
      status: 'pass',
      passed: 1,
      failed: 0,
      ignored: 0,
      ignoredTests: [],
      durationMs: 1,
    }],
    artifacts: [{
      name: `ci-r0-payload-${sourceSha}`,
      uri: payloadUrl,
      sha256: digest(payloadArchive),
      sizeBytes: payloadArchive.length,
    }],
    build: { mode: 'matrix-voice', features: ['matrix-voice', 'legacy-p2p'] },
    collectedAt,
    expiresAt,
    reviewer: null,
  }
  const evidence = {
    testedCommit: sourceSha,
    testedTreeHash: treeHash,
    command: 'protected CI evidence',
    artifactPath: null,
    artifactUri: manifestUrl,
    artifactSha256: digest(manifestArchive),
    environment: 'GitHub Actions protected main',
    collectedAt,
    expiresAt,
  }
  const gate = {
    id: 'r0.frontend-tests',
    milestone: 'R0',
    required: true,
    releaseStatus: 'local-pass',
    status: 'local-pass',
    evidence,
    owner: 'Mesh client',
    capability: 'Run protected tests',
    blockReason: null,
    nextAction: 'retain evidence',
    waiver: null,
  }
  const ledger = {
    schemaVersion: 2,
    ledgerId: 'mesh-production-readiness',
    sourceCommit: sourceSha,
    sourceTreeHash: treeHash,
    updatedAt: collectedAt,
    gates: [gate],
  }
  return { ledger, manifest, payload, manifestArchive, payloadArchive }
}

function dependencies(fixture, { missing = new Set() } = {}) {
  const downloads = new Map([
    [manifestUrl, fixture.manifestArchive],
    [payloadUrl, fixture.payloadArchive],
  ])
  const downloadCounts = new Map()
  return {
    downloadCounts,
    downloadArtifact: async (url) => {
      downloadCounts.set(url, (downloadCounts.get(url) ?? 0) + 1)
      if (missing.has(url) || !downloads.has(url)) throw new Error('artifact does not exist')
      return downloads.get(url)
    },
    extractSingleJson: async (_bytes, { artifactUrl }) => {
      if (artifactUrl === manifestUrl) {
        return { entryName: 'ci-protected-evidence-manifest.json', value: structuredClone(fixture.manifest) }
      }
      if (artifactUrl === payloadUrl) {
        return { entryName: 'ci-run-results.json', value: structuredClone(fixture.payload) }
      }
      throw new Error('unexpected archive')
    },
  }
}

describe('protected R0 readiness evidence verifier', () => {
  it('verifies manifest and payload archives and caches duplicate artifact URLs', async () => {
    const fixture = makeFixture()
    fixture.ledger.gates.push({
      ...structuredClone(fixture.ledger.gates[0]),
      id: 'r0.rust-matrix',
    })
    const injected = dependencies(fixture)
    assert.deepEqual(await verifyProtectedR0Evidence(fixture.ledger, { now, ...injected }), [])
    assert.equal(injected.downloadCounts.get(manifestUrl), 1)
    assert.equal(injected.downloadCounts.get(payloadUrl), 1)
  })

  it('fails closed when a referenced artifact does not exist', async () => {
    const fixture = makeFixture()
    const injected = dependencies(fixture, { missing: new Set([manifestUrl]) })
    const errors = await verifyProtectedR0Evidence(fixture.ledger, { now, ...injected })
    assert.ok(errors.some((error) => error.includes('artifact does not exist')))
  })

  it('fails closed when archive extraction is unavailable', async () => {
    const fixture = makeFixture()
    const injected = dependencies(fixture)
    injected.extractSingleJson = async () => { throw new Error('system unzip is unavailable') }
    const errors = await verifyProtectedR0Evidence(fixture.ledger, { now, ...injected })
    assert.ok(errors.some((error) => error.includes('system unzip is unavailable')))
  })

  it('rejects a wrong readiness-ledger archive digest', async () => {
    const fixture = makeFixture()
    fixture.ledger.gates[0].evidence.artifactSha256 = '0'.repeat(64)
    const errors = await verifyProtectedR0Evidence(fixture.ledger, { now, ...dependencies(fixture) })
    assert.ok(errors.some((error) => error.includes('archive SHA-256 does not match the readiness ledger')))
  })

  it('rejects a manifest bound to another source snapshot', async () => {
    const fixture = makeFixture()
    fixture.manifest.sourceCommit = 'b'.repeat(40)
    const errors = await verifyProtectedR0Evidence(fixture.ledger, { now, ...dependencies(fixture) })
    assert.ok(errors.some((error) => error.includes('sourceCommit/sourceTreeHash does not match')))
  })

  it('rejects a protected payload containing a failed job', async () => {
    const fixture = makeFixture()
    fixture.payload.results.legacyRust = 'failure'
    const errors = await verifyProtectedR0Evidence(fixture.ledger, { now, ...dependencies(fixture) })
    assert.ok(errors.some((error) => error.includes('legacyRust must be success')))
  })

  it('rejects a payload archive whose digest does not match its manifest', async () => {
    const fixture = makeFixture()
    fixture.manifest.artifacts[0].sha256 = '0'.repeat(64)
    const errors = await verifyProtectedR0Evidence(fixture.ledger, { now, ...dependencies(fixture) })
    assert.ok(errors.some((error) => error.includes('payload archive SHA-256 does not match')))
  })

  it('does not let Security evidence satisfy a CI gate', async () => {
    const fixture = makeFixture()
    fixture.manifest.workflow.name = 'Security'
    const errors = await verifyProtectedR0Evidence(fixture.ledger, { now, ...dependencies(fixture) })
    assert.ok(errors.some((error) => error.includes('must use CI protected evidence')))
  })

  it('rejects a foreign artifact URL before downloading it', async () => {
    const fixture = makeFixture()
    fixture.ledger.gates[0].evidence.artifactUri = 'https://github.com/example/mesh/actions/runs/123/artifacts/111'
    const injected = dependencies(fixture)
    const errors = await verifyProtectedR0Evidence(fixture.ledger, { now, ...injected })
    assert.ok(errors.some((error) => error.includes('dhawal-ss/mesh')))
    assert.equal(injected.downloadCounts.size, 0)
  })

  it('accepts only the exact passing protected Security payload contract', () => {
    const securityPayload = {
      schemaVersion: 1,
      sourceSha,
      results: {
        codeql: 'success',
        dependencyReview: 'skipped',
        featureMatrix: 'success',
        dependencyAudit: 'success',
        sbom: 'success',
        r2Containers: 'success',
      },
    }
    assert.deepEqual(validateProtectedJobPayload(securityPayload, {
      workflowName: 'Security',
      sourceCommit: sourceSha,
    }), [])

    securityPayload.results.codeql = 'failure'
    assert.ok(validateProtectedJobPayload(securityPayload, {
      workflowName: 'Security',
      sourceCommit: sourceSha,
    }).some((error) => error.includes('codeql must be success')))
  })
})

describe('bounded GitHub Actions artifact download', () => {
  it('uses the canonical artifact API and GITHUB_TOKEN without putting it in the URL', async () => {
    const bytes = archive('download')
    const requests = []
    const actual = await downloadGitHubActionsArtifact(manifestUrl, {
      token: 'test-token-value',
      expectedSourceCommit: sourceSha,
      expectedWorkflowName: 'CI',
      fetchImpl: async (url, options) => {
        requests.push({ url, options })
        if (url.endsWith('/actions/runs/123')) {
          return new Response(JSON.stringify(workflowRunMetadata()), { status: 200 })
        }
        if (!url.endsWith('/zip')) {
          return new Response(JSON.stringify(artifactMetadata(bytes)), { status: 200 })
        }
        return new Response(bytes, {
          status: 200,
          headers: { 'content-length': String(bytes.length) },
        })
      },
    })
    assert.deepEqual(actual, bytes)
    assert.deepEqual(requests.map((request) => request.url), [
      'https://api.github.com/repos/dhawal-ss/mesh/actions/artifacts/111',
      'https://api.github.com/repos/dhawal-ss/mesh/actions/runs/123',
      'https://api.github.com/repos/dhawal-ss/mesh/actions/artifacts/111/zip',
    ])
    assert.ok(requests.every((request) => request.options.headers.Authorization === 'Bearer test-token-value'))
    assert.ok(requests.every((request) => !request.url.includes('test-token-value')))
  })

  it('rejects foreign URLs, missing artifacts, and oversized responses', async () => {
    assert.equal(parseProtectedArtifactUrl(manifestUrl)?.artifactId, '111')
    await assert.rejects(
      downloadGitHubActionsArtifact('https://github.com/example/mesh/actions/runs/123/artifacts/111'),
      /dhawal-ss\/mesh/u,
    )
    await assert.rejects(
      downloadGitHubActionsArtifact(manifestUrl, {
        expectedSourceCommit: sourceSha,
        expectedWorkflowName: 'CI',
        fetchImpl: async () => new Response(null, { status: 404 }),
      }),
      /GITHUB_TOKEN/u,
    )
    await assert.rejects(
      downloadGitHubActionsArtifact(manifestUrl, {
        maxBytes: 4,
        expectedSourceCommit: sourceSha,
        expectedWorkflowName: 'CI',
        fetchImpl: async () => new Response(JSON.stringify(artifactMetadata(archive('too-large'))), { status: 200 }),
      }),
      /download limit/u,
    )
  })

  it('binds artifact metadata to the URL run, main branch, and expected source SHA', async () => {
    const bytes = archive('metadata')
    await assert.rejects(
      downloadGitHubActionsArtifact(manifestUrl, {
        expectedSourceCommit: sourceSha,
        expectedWorkflowName: 'CI',
        fetchImpl: async () => new Response(JSON.stringify(artifactMetadata(bytes, {
          workflow_run: { id: 999, head_sha: 'b'.repeat(40), head_branch: 'pull-request' },
        })), { status: 200 }),
      }),
      /does not bind the requested main-branch run and source commit/u,
    )
  })

  it('rejects the wrong workflow identity, event, conclusion, repository, or rerun attempt', async () => {
    const bytes = archive('workflow-run')
    const invoke = (runOverrides, options = {}) => downloadGitHubActionsArtifact(manifestUrl, {
      expectedSourceCommit: sourceSha,
      expectedWorkflowName: 'CI',
      ...options,
      fetchImpl: async (url) => {
        if (url.includes('/actions/runs/123')) {
          return new Response(JSON.stringify(workflowRunMetadata(runOverrides)), { status: 200 })
        }
        if (url.endsWith('/zip')) return new Response(bytes, { status: 200 })
        return new Response(JSON.stringify(artifactMetadata(bytes)), { status: 200 })
      },
    })

    await assert.rejects(invoke({ path: '.github/workflows/release-beta.yml@main' }), /successful protected CI push/u)
    await assert.rejects(invoke({ event: 'workflow_dispatch' }), /successful protected CI push/u)
    await assert.rejects(invoke({ conclusion: 'failure' }), /successful protected CI push/u)
    await assert.rejects(invoke({ repository: { full_name: 'attacker/mesh' } }), /successful protected CI push/u)
    await assert.rejects(invoke({ run_attempt: 2 }, { expectedRunAttempt: 1 }), /successful protected CI push/u)
  })
})
