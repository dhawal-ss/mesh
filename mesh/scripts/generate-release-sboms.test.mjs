import assert from 'node:assert/strict'
import test from 'node:test'
import { npmPackageUrl, validateSbomBoundary } from './generate-release-sboms.mjs'

const component = (name) => ({ name })
const source = { components: [component('react'), component('simple-peer'), component('livekit-client')] }

test('accepts LiveKit in the Matrix voice artifact while keeping legacy P2P excluded', () => {
  assert.deepEqual(validateSbomBoundary(source, {
    components: [component('react'), component('livekit-client')],
  }), [])
})

test('fails legacy P2P in the voice artifact inventory', () => {
  const errors = validateSbomBoundary(source, {
    components: [component('react'), component('simple-peer'), component('livekit-client')],
  })
  assert.ok(errors.some((error) => error.includes('forbidden simple-peer')))
})

test('fails a voice artifact that omits LiveKit', () => {
  const errors = validateSbomBoundary(source, { components: [component('react')] })
  assert.ok(errors.some((error) => error.includes('missing livekit-client')))
})

test('does not erase excluded packages from the complete source inventory', () => {
  const errors = validateSbomBoundary({ components: [component('react')] }, { components: [component('react')] })
  assert.ok(errors.some((error) => error.includes('source inventory is missing simple-peer')))
  assert.ok(errors.some((error) => error.includes('source inventory is missing livekit-client')))
})

test('builds canonical npm Package URLs without flattening scopes', () => {
  assert.equal(npmPackageUrl('react', '18.3.1'), 'pkg:npm/react@18.3.1')
  assert.equal(npmPackageUrl('@angular/animations', '12.3.1'), 'pkg:npm/%40angular/animations@12.3.1')
  assert.equal(npmPackageUrl('@scope/.pkg_name', '1.0.0+build.1'), 'pkg:npm/%40scope/.pkg_name@1.0.0%2Bbuild.1')
  assert.equal(npmPackageUrl('Base64', '1.0.0'), 'pkg:npm/Base64@1.0.0')
  assert.throws(() => npmPackageUrl('@scope/name/extra', '1.0.0'), /invalid scoped npm package name/)
})
