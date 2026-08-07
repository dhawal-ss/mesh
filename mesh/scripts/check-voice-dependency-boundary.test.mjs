import assert from 'node:assert/strict'
import test from 'node:test'
import { validateVoiceDependencyGraphs } from './check-voice-dependency-boundary.mjs'

const lock = (...names) => ({ packages: Object.fromEntries(names.map((name) => [`node_modules/${name}`, { version: '1.0.0' }])) })

test('accepts independent text, Matrix voice, and LAN graphs', () => {
  assert.deepEqual(validateVoiceDependencyGraphs({
    rootPackage: { dependencies: { react: '1' } },
    rootLock: lock('react'),
    matrixVoiceLock: lock('livekit-client'),
    legacyLock: lock('simple-peer'),
  }), [])
})

test('rejects dormant voice packages in the text graph and cross-feature contamination', () => {
  const errors = validateVoiceDependencyGraphs({
    rootPackage: { dependencies: { 'simple-peer': '1' } },
    rootLock: lock('simple-peer', 'livekit-client'),
    matrixVoiceLock: lock('simple-peer'),
    legacyLock: lock('livekit-client'),
  })
  assert.ok(errors.some((error) => error.includes('root lock graph installs simple-peer')))
  assert.ok(errors.some((error) => error.includes('Matrix voice lock graph contains simple-peer')))
  assert.ok(errors.some((error) => error.includes('legacy LAN lock graph contains livekit-client')))
})
