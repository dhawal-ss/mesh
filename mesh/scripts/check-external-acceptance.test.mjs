import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import {
  REQUIRED_EXTERNAL_ACCEPTANCE_IDS,
  requiredExternalAcceptanceIdsForMilestone,
  inspectEvidenceContent,
  validateExternalAcceptance,
} from './check-external-acceptance.mjs'

const scriptDirectory = dirname(fileURLToPath(import.meta.url))
const template = JSON.parse(readFileSync(resolve(scriptDirectory, '..', 'release', 'external-acceptance.example.json'), 'utf8'))

function copy(value) {
  return structuredClone(value)
}

describe('external acceptance evidence validator', () => {
  it('accepts the fail-closed tracked template', () => {
    assert.equal(REQUIRED_EXTERNAL_ACCEPTANCE_IDS.length, 62)
    assert.equal(requiredExternalAcceptanceIdsForMilestone('R2').length, 54)
    assert.equal(requiredExternalAcceptanceIdsForMilestone('R4').length, 62)
    assert.ok(!requiredExternalAcceptanceIdsForMilestone('R2').includes('accessibility.voiceover'))
    assert.ok(requiredExternalAcceptanceIdsForMilestone('R4').includes('accessibility.voiceover'))
    assert.deepEqual(validateExternalAcceptance(template, { templateMode: true }), [])
  })

  it('rejects a missing installed or platform case', () => {
    const document = copy(template)
    document.results = document.results.filter((result) => result.id !== 'native-invite.linux-cold-start')
    const errors = validateExternalAcceptance(document)
    assert.ok(errors.some((error) => error.includes('missing required external acceptance result')))
  })

  it('does not accept the template as live evidence', () => {
    const errors = validateExternalAcceptance(template, {
      requireLive: true,
      commitSha: 'a'.repeat(40),
      now: new Date('2026-08-01T00:00:00Z'),
    })
    assert.ok(errors.some((error) => error.includes('document status passed')))
    assert.ok(errors.some((error) => error.includes('requires acceptanceMilestone R2 or R4')))
  })

  it('rejects an expired live campaign', () => {
    const document = copy(template)
    document.status = 'passed'
    document.acceptanceMilestone = 'R2'
    document.sourceSha = 'a'.repeat(40)
    document.releaseTag = 'v0.2.0'
    document.testedAt = '2026-07-01T00:00:00Z'
    document.expiresAt = '2026-07-31T00:00:00Z'
    document.operator = 'release acceptance role'
    const errors = validateExternalAcceptance(document, {
      requireLive: true,
      commitSha: document.sourceSha,
      now: new Date('2026-08-01T00:00:00Z'),
    })
    assert.ok(errors.some((error) => error.includes('expired')))
  })

  it('rejects an unapproved release tag and future-dated live claims', () => {
    const document = copy(template)
    document.status = 'passed'
    document.acceptanceMilestone = 'R2'
    document.sourceSha = 'a'.repeat(40)
    document.releaseTag = 'v0.1.0'
    document.testedAt = '2026-08-02T00:00:00Z'
    document.expiresAt = '2026-09-01T00:00:00Z'
    document.operator = 'release acceptance role'
    const errors = validateExternalAcceptance(document, {
      requireLive: true,
      commitSha: document.sourceSha,
      now: new Date('2026-08-01T00:00:00Z'),
    })
    assert.ok(errors.some((error) => error.includes('approved releaseTag v0.2.0')))
    assert.ok(errors.some((error) => error.includes('testedAt cannot be in the future')))
  })

  it('requires symmetric result and artifact binding', () => {
    const document = copy(template)
    document.artifacts.push({
      id: 'download-log',
      path: 'download.log',
      sha256: '0'.repeat(64),
      bytes: 1,
      mediaType: 'text/plain',
      collectedAt: '2026-08-01T00:00:00Z',
      sanitized: true,
      privacyReviewer: null,
      resultIds: ['windows.download'],
    })
    const errors = validateExternalAcceptance(document)
    assert.ok(errors.some((error) => error.includes('does not reference the artifact')))
  })

  it('does not trust sanitized metadata and rejects encoded or fragmented secrets without echoing them', () => {
    const secret = 'access_token=highly-sensitive-value-1234567890'
    const encoded = Buffer.from(secret).toString('base64')
    const errors = inspectEvidenceContent(Buffer.from(`result=${encoded}`), 'text/plain')
    assert.ok(errors.some((error) => error.includes('credential material')))
    assert.ok(errors.every((error) => !error.includes('highly-sensitive')))

    const fragmented = inspectEvidenceContent(Buffer.from('registration _ token : abcdefghijklmnopqrstuvwxyz'), 'text/plain')
    assert.ok(fragmented.some((error) => error.includes('credential material')))
  })

  it('allows benign operational prose and requires human review for screenshots', () => {
    assert.deepEqual(inspectEvidenceContent(Buffer.from('Access control passed. Token budget stayed bounded.'), 'text/plain'), [])
    assert.ok(inspectEvidenceContent(new Uint8Array([137, 80, 78, 71]), 'image/png').some((error) => error.includes('privacy reviewer')))
    assert.deepEqual(inspectEvidenceContent(new Uint8Array([137, 80, 78, 71]), 'image/png', { privacyReviewer: 'independent privacy reviewer' }), [])
  })
})
