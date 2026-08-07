import assert from 'node:assert/strict'
import test from 'node:test'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { verifyOfflineLegalPayload } from './prepare-installer-payload.mjs'

test('installer configuration retains offline legal and generated evidence resources', async () => {
  const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const resources = await verifyOfflineLegalPayload(projectRoot)
  assert.equal(resources.length, 4)
})
