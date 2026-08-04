import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const SOUND_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../src/assets/sounds',
)

test('interface sound assets satisfy the bounded PCM contract', async () => {
  const files = (await readdir(SOUND_DIR)).filter((file) => file.endsWith('.wav')).sort()
  assert.equal(files.length, 8)
  let totalBytes = 0
  for (const file of files) {
    const data = await readFile(path.join(SOUND_DIR, file))
    totalBytes += data.length
    assert.equal(data.toString('ascii', 0, 4), 'RIFF')
    assert.equal(data.toString('ascii', 8, 12), 'WAVE')
    assert.equal(data.readUInt16LE(20), 1, `${file} must use PCM`)
    assert.equal(data.readUInt16LE(22), 1, `${file} must be mono`)
    assert.equal(data.readUInt32LE(24), 48_000, `${file} must use 48 kHz`)
    assert.equal(data.readUInt16LE(34), 16, `${file} must use 16-bit samples`)
    const durationMs = (data.readUInt32LE(40) / 2 / 48_000) * 1_000
    assert.ok(durationMs <= 240, `${file} exceeds 240 ms`)
    let peak = 0
    for (let offset = 44; offset < data.length; offset += 2) {
      peak = Math.max(peak, Math.abs(data.readInt16LE(offset)) / 32_767)
    }
    assert.ok(peak <= 0.355, `${file} exceeds -9 dBFS`)
  }
  assert.ok(totalBytes < 200 * 1024, 'interface sound family exceeds 200 KiB')
})
