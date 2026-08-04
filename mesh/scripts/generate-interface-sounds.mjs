import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SAMPLE_RATE = 48_000
const MAX_SAMPLE = 32_767
const OUTPUT_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../src/assets/sounds',
)

const sounds = {
  'voice-self-join': { durationMs: 180, notes: [[0, 84, 392], [78, 102, 523.25]], gain: 0.27 },
  'voice-self-leave': { durationMs: 150, notes: [[0, 74, 523.25], [68, 82, 392]], gain: 0.25 },
  'voice-peer-join': { durationMs: 110, notes: [[0, 56, 587.33], [50, 60, 659.25]], gain: 0.19 },
  'voice-peer-leave': { durationMs: 100, notes: [[0, 52, 493.88], [46, 54, 392]], gain: 0.17 },
  'message-mention': { durationMs: 160, notes: [[0, 62, 659.25], [97, 63, 880]], gain: 0.3 },
  'message-direct': { durationMs: 220, notes: [[0, 220, 261.63, 0.2], [0, 96, 523.25], [112, 108, 783.99]], gain: 0.3 },
  'message-failed': { durationMs: 140, notes: [[0, 72, 246.94], [65, 75, 220]], gain: 0.29 },
  'connection-recovered': { durationMs: 180, notes: [[0, 88, 329.63], [82, 98, 440]], gain: 0.18 },
}

function envelope(sampleIndex, startSample, endSample) {
  const attack = Math.round(SAMPLE_RATE * 0.005)
  const release = Math.round(SAMPLE_RATE * 0.032)
  const elapsed = sampleIndex - startSample
  const remaining = endSample - sampleIndex
  if (elapsed < 0 || remaining <= 0) return 0
  if (elapsed < attack) return elapsed / attack
  if (remaining < release) return remaining / release
  return 1
}

function triangle(phase) {
  return 2 * Math.abs(2 * (phase - Math.floor(phase + 0.5))) - 1
}

function renderSound({ durationMs, notes, gain }) {
  const sampleCount = Math.round(SAMPLE_RATE * durationMs / 1_000)
  const pcm = Buffer.alloc(sampleCount * 2)
  for (let sampleIndex = 0; sampleIndex < sampleCount; sampleIndex += 1) {
    let sample = 0
    for (const [startMs, noteDurationMs, frequency, noteGain = 1] of notes) {
      const startSample = Math.round(SAMPLE_RATE * startMs / 1_000)
      const endSample = Math.min(sampleCount, startSample + Math.round(SAMPLE_RATE * noteDurationMs / 1_000))
      const amplitude = envelope(sampleIndex, startSample, endSample)
      if (amplitude === 0) continue
      const phase = (sampleIndex - startSample) * frequency / SAMPLE_RATE
      const body = triangle(phase) * 0.72 + Math.sin(phase * Math.PI * 2) * 0.28
      sample += body * amplitude * gain * noteGain
    }
    const bounded = Math.max(-0.35, Math.min(0.35, sample))
    pcm.writeInt16LE(Math.round(bounded * MAX_SAMPLE), sampleIndex * 2)
  }
  return wavFile(pcm)
}

function wavFile(pcm) {
  const header = Buffer.alloc(44)
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + pcm.length, 4)
  header.write('WAVE', 8)
  header.write('fmt ', 12)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(1, 22)
  header.writeUInt32LE(SAMPLE_RATE, 24)
  header.writeUInt32LE(SAMPLE_RATE * 2, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36)
  header.writeUInt32LE(pcm.length, 40)
  return Buffer.concat([header, pcm])
}

await mkdir(OUTPUT_DIR, { recursive: true })
for (const [name, definition] of Object.entries(sounds)) {
  await writeFile(path.join(OUTPUT_DIR, `${name}.wav`), renderSound(definition))
}

console.log(`Generated ${Object.keys(sounds).length} interface sounds in ${OUTPUT_DIR}`)
