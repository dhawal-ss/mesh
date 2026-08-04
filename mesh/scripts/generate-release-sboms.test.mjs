import assert from 'node:assert/strict'
import test from 'node:test'
import { validateSbomBoundary } from './generate-release-sboms.mjs'

const component = (name) => ({ name })
const source = { components: [component('react'), component('simple-peer'), component('livekit-client')] }

test('accepts excluded voice packages in source but not the Matrix text artifact', () => {
  assert.deepEqual(validateSbomBoundary(source, { components: [component('react')] }), [])
})

test('fails forbidden P2P or media packages in the artifact inventory', () => {
  const errors = validateSbomBoundary(source, { components: [component('react'), component('simple-peer')] })
  assert.ok(errors.some((error) => error.includes('forbidden simple-peer')))
})

test('does not erase excluded packages from the complete source inventory', () => {
  const errors = validateSbomBoundary({ components: [component('react')] }, { components: [component('react')] })
  assert.ok(errors.some((error) => error.includes('source inventory is missing simple-peer')))
  assert.ok(errors.some((error) => error.includes('source inventory is missing livekit-client')))
})
