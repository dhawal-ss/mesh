import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { analyzeAiBoundary } from './check-ai-boundary-lib.mjs'

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url))
const fixtureRoot = path.join(scriptDirectory, 'fixtures', 'ai-boundary')

test('accepts a feature-gated local model with explicit resource and download boundaries', () => {
  assert.deepEqual(analyzeAiBoundary(path.join(fixtureRoot, 'allowed-local')), [])
})

test('rejects a network AI SDK and third-party inference endpoint', () => {
  const violations = analyzeAiBoundary(path.join(fixtureRoot, 'blocked-provider'))
  const rules = new Set(violations.map((violation) => violation.rule))

  assert.ok(rules.has('network-ai-dependency'))
  assert.ok(rules.has('network-ai-import'))
  assert.ok(rules.has('network-ai-endpoint'))
  assert.ok(rules.has('ai-network-access'))
})

test('rejects hyphenated and renamed network AI crates in Cargo manifests', () => {
  const violations = analyzeAiBoundary(path.join(fixtureRoot, 'blocked-cargo-provider'))
  const dependencyNames = violations
    .filter((violation) => violation.rule === 'network-ai-dependency')
    .map((violation) => violation.message)

  assert.ok(dependencyNames.some((message) => message.includes('anthropic-sdk')))
  assert.ok(dependencyNames.some((message) => message.includes('cohere-rust')))
})

test('rejects send and moderation authority from an otherwise local AI module', () => {
  const violations = analyzeAiBoundary(path.join(fixtureRoot, 'blocked-authority'))

  assert.equal(
    violations.filter((violation) => violation.rule === 'ai-user-authority').length,
    3,
  )
  assert.ok(violations.some((violation) => violation.message.includes('send a message')))
  assert.ok(violations.some((violation) => violation.message.includes('ban a person')))
  assert.ok(violations.some((violation) => violation.message.includes('IPC command')))
})
